# Voice realtime — v0.95, Đội D3

Harness voice realtime 2 chiều (nói chuyện trực tiếp với model): duplex
audio, barge-in (ngắt lời), turn-taking, 2 provider (OpenAI Realtime +
Gemini Live), STT/TTS local. Mock-first; live chưa verify (xem
§ "Giới hạn live").

## Kiến trúc

```
Renderer (ChatView + RealtimeVoicePanel)
  │  mic PCM16 16 kHz (AudioWorklet pcm-capture, có sẵn)
  │  IPC voice:realtime-audio / voice:realtime-connect|disconnect|mode|talk|interrupt
  ▼
Main (apps/desktop/src/main/main.ts)
  │  realtimeSessions: Map<botId, RealtimeSession>
  │  key từ Vault (không log, không ra renderer)
  ▼
RealtimeSession (packages/core/src/voice/realtimeSession.ts)
  │  state machine · barge-in · turn-taking · reconnect (Gemini)
  │  chunker 100 ms · resample 16k -> 24k · LocalVad
  ├─► AudioSource / AudioSink (voice/audio.ts) — mic / loa, mock cho test
  ├─► TTS hook (speakFinalTranscript, mặc định OFF)
  ▼
RealtimeTransport (packages/core/src/voice/adapters.ts)
  ├─► OpenAiRealtimeTransport — bọc RealtimeClient có sẵn (voice/realtime.ts)
  └─► GeminiLiveTransport — client WS riêng, dịch wire Gemini Live
        Events -> onEvent sink -> main forward voice:transcript/audio/error
        (tái dùng channel cũ, CallView hiện transcript) +
        voice:realtime-state (state / interrupted / turn) cho panel.
```

Đường voice call cũ (`voice:connect` + `VoiceCallSession`) giữ nguyên, không
đụng. Realtime là đường riêng; mở realtime sẽ disconnect call cũ của cùng
bot (một bot chỉ giữ một đường voice live).

## State machine (RealtimeSession)

```
idle -> connecting -> listening <-> speaking -> closed
                          │  ▲
                          │  └─ interrupted (nhất thời, rồi về listening)
                          └─ reconnecting (rớt mạng, Gemini: session tự redial)
```

- `listening`: đang nghe user (mic stream liên tục, trừ push_to_talk).
- `speaking`: model đang trả audio/transcript.
- `interrupted`: barge-in vừa xử lý xong (cancel + flush loa), rồi về
  `listening` ngay.
- `reconnecting`: xem § "Reconnect".

## Barge-in (ngắt lời)

| Nguồn phát hiện | Điều kiện | Hành động |
|---|---|---|
| Server VAD (`input_audio_buffer.speech_started`, OpenAI) | đang `speaking` | `response.cancel` + flush sink + event `interrupted{source: server_vad}` |
| Server interruption (`serverContent.interrupted`, Gemini) | đang `speaking` | như trên (cancel = gửi `realtimeInput.activityStart`) |
| Local VAD (chế độ `local_vad`) | mic RMS vượt ngưỡng khi đang `speaking` | như trên, `source: local_vad` |
| Nút Interrupt (panel) / `session.interrupt()` | đang `speaking` | như trên, `source: manual` |

Khi không `speaking`, speech event không phải barge-in (không cancel gì).
`getBargeInCount()` đếm số lần ngắt trong session — panel hiển thị.

## Turn-taking

| Chế độ | Mic gửi khi nào | Ai kết thúc lượt user |
|---|---|---|
| `server_vad` (mặc định) | liên tục | Server VAD (OpenAI: tự commit + `response.create`; Gemini: VAD của server) |
| `local_vad` | liên tục | `LocalVad` local (RMS + hangover 300 ms): hết tiếng -> commit + `response.create` (OpenAI) / `activityEnd` (Gemini) |
| `push_to_talk` | chỉ khi giữ nút nói | Nhả nút -> commit + `response.create` / `activityEnd` |

OpenAI ở chế độ `local_vad` / `push_to_talk` cần `turn_detection: null`
trong `session.update` (manual turns) — `RealtimeClient` đã hỗ trợ
`turnDetection: 'none'` (v0.95). Gemini không có field này; activity
events điều khiển lượt.

## Audio

- Mic: PCM16 mono 16 kHz (worklet có sẵn). `Pcm16Chunker` gom frame nhỏ
  thành frame 100 ms; `resamplePcm16` nội suy tuyến tính 16 kHz -> 24 kHz
  cho OpenAI, giữ nguyên 16 kHz cho Gemini.
- Loa: PCM16 mono 24 kHz cả 2 provider, về renderer qua `voice:audio`
  (phát bằng AudioContext 24 kHz, code có sẵn) hoặc qua `AudioSink`.
- `LocalVad`: RMS theo cửa sổ 20 ms, ngưỡng mặc định 0.02, hangover
  300 ms (không ngắt lượt vì ngừng thở ngắn trong câu). `level` cho
  đồng hồ mic ở UI (chưa nối vào panel — future).
- VM headless không có card âm thanh: mic/loa thật không test được ở đây;
  `MockAudioSource` (script speech/silence) + `MockAudioSink` (đếm byte,
  đếm lần flush) là bề mặt test được.

## Giao thức provider (docs công khai, chỉ đọc — không gọi API thật)

### OpenAI Realtime API

- WS: `wss://api.openai.com/v1/realtime?model=<model>` (key: bearer header
  qua socket factory; global WebSocket không gửi header nên key đi qua
  factory của main hoặc query cho endpoint OpenAI-compatible).
- Sau open: `session.update` { model, voice, instructions, tools,
  input/output `pcm16`, `turn_detection: {type:'server_vad'}` }.
- Mic: `input_audio_buffer.append` { audio: base64 PCM16 24 kHz }.
  Server VAD: `speech_started` / `speech_stopped` (tự commit + response).
  Manual: `input_audio_buffer.commit` + `response.create`.
- Model: `response.audio.delta` (base64 PCM16 24 kHz) +
  `response.audio_transcript.delta/.done`; tool:
  `response.function_call_arguments.done` -> trả
  `conversation.item.create` (function_call_output) + `response.create`.
- Barge-in: `response.cancel`. `response.done` kết thúc lượt model.
- Reconnect: `RealtimeClient` giữ nguyên policy cũ (tối đa 20 lần,
  backoff 1s nhân đôi tới 10s, dial timeout 15s, silent-path 3 lần,
  close 1008/4001 là terminal, `disconnect()` thì không redial).

### Gemini Live API (Developer API)

- WS: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<key>`
  (key ở query, KHÔNG phải header).
- Frame đầu: `setup` { model: `"models/<live-model>"`,
  generationConfig: { responseModalities: ["AUDIO"],
  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
  systemInstruction, tools (functionDeclarations) }.
  Chờ `setupComplete` mới gửi tiếp — `connect()` resolve ở đó.
- Mic: `realtimeInput` { mediaChunks: [{ mimeType: "audio/pcm;rate=16000",
  data: base64 }] } (16 kHz). Lượt (local_vad/push_to_talk):
  `realtimeInput.activityStart/activityEnd`.
- Model: `serverContent` { modelTurn: { parts: [{ inlineData:
  { mimeType: "audio/pcm;rate=24000", data } }] },
  outputTranscription, inputTranscription, turnComplete, interrupted }.
- Tool: `toolCall.functionCalls[]` (hoặc `functionCall` part trong
  `modelTurn`) -> trả `toolResponse.functionResponses[]` kèm đúng `id`.
- Barge-in: server gửi `serverContent.interrupted = true`; client gửi
  `activityStart` để ngắt (best-effort theo docs, xem § live limits).
- `goAway` { timeLeft } = server báo sắp đóng session (giới hạn ~15 phút
  audio-only) -> lỗi + session reconnect.
- Model: chỉ model Live/native-audio mới hỗ trợ `bidiGenerateContent`.
  Mặc định: `gemini-live-2.5-flash-native-audio` (GA). Model text thường
  (vd `gemini-2.5-flash`) bị server từ chối — bot phải đặt model Live.
  Lưu ý: Gemini 3.1+ đã bỏ `realtimeInput.mediaChunks` (đổi shape) nên
  adapter này nhắm model 2.5 GA; dùng model 3.1 cần cập nhật frame input.

## STT / TTS local

- TTS: `TtsHarness` (eSpeak NG) có sẵn, dùng qua IPC `tts:speak` như cũ.
  `RealtimeSession` có hook `speakFinalTranscript(text)` — khi bật, mỗi
  transcript cuối của lượt model được đọc lại bằng TTS local. Mặc định
  OFF (provider stream audio thì đọc thêm sẽ thành 2 giọng). Main chưa
  bật hook này — dành cho transport text-only / fallback local sau này.
- STT local (`voice/localStt.ts`): interface `LocalSttEngine` +
  `WhisperCliSttEngine` (CLI whisper.cpp: temp WAV -> `<bin> -m <model>
  -f <wav> -l <lang> -otxt -of <prefix>`, đọc `<prefix>.txt`) +
  `MockLocalSttEngine` + `detectLocalStt()`. **Trên máy này:
  `detectLocalStt()` trả `available: false` — không có binary whisper
  (`whisper-cpp`/`whisper`/`main`) và không có model `ggml-*.bin`.**
  CLI flags chưa live-verify (xem dưới); engine fail loudly thay vì bịa
  transcript. STT streaming thật (whisper.cpp stream mode) là mục tương
  lai, sau khi có binary + model.

## UI

`RealtimeVoicePanel` (`apps/desktop/src/renderer/components/`): hiển thị
khi voice khả dụng, cạnh CallView.

- Start/Stop, trạng thái kết nối (`idle/connecting/listening/speaking/
  interrupted/reconnecting/closed`), chọn provider (OpenAI / Gemini /
  OpenAI-compatible) + chọn turn-taking (server_vad / local_vad /
  push_to_talk), nút Interrupt khi bot đang nói, nút giữ-để-nói ở chế độ
  push_to_talk, số lần ngắt lời trong session.
- Transcript trực tiếp tái dùng CallView (channel `voice:transcript`).
- i18n: 24 key `voice.realtime.*` × 6 locale (vi/en/zh/ja/es/fr),
  parity 1562/1562.

## IPC (main <-> renderer)

| Channel | Hướng | Ghi chú |
|---|---|---|
| `voice:realtime-connect` {botId, provider?, turnMode?} | invoke | Tạo/kết nối session; key từ Vault; Gemini không cần URL (adapter build từ key); OpenAI lấy `realtimeUrl` trong settings, mặc định `wss://api.openai.com/v1/realtime?model=<bot.model>` |
| `voice:realtime-disconnect` | invoke | Ngắt, giữ session (gọi lại được) |
| `voice:realtime-mode` {turnMode} | invoke | Đổi turn-taking giữa session |
| `voice:realtime-talk` {held} | invoke | Giữ/nhả nút nói (push_to_talk) |
| `voice:realtime-interrupt` | invoke | Ngắt model ngay |
| `voice:realtime-audio` {audioBase64} | send | Mic frames riêng (không lẫn `voice:audio` của call cũ) |
| `voice:realtime-state` | push | state / interrupted / turn events cho panel |
| `voice:transcript` / `voice:audio` / `voice:error` / `voice:toolcall` | push | Tái dùng channel cũ |

`realtimeUrl` trong settings trước đây bị `requireHttpUrl` chặn (chỉ cho
http/https) nên URL `wss://` không lưu được — v0.95 thêm `requireWsUrl`
(`packages/core/src/ipc/validate.ts`) và dùng cho `realtimeUrl`
(`ws://` cho endpoint local cũng được).

## Event log

`RealtimeSession` emit mọi event qua sink `onEvent` (transcript, audio,
state, interrupted, turn, toolcall, error). Main forward về renderer như
trên. Ghi vào harness event log NDJSON của coordinator (EventLogView)
chưa nối — coordinator sở hữu log đó; event đã có đủ field (`at`,
`kind`) để nối sau mà không đổi session.

## Giới hạn live (mock-only — chưa live-verify)

- **Cả 2 adapter đều mock-only.** Không có cuộc gọi live nào từ máy này:
  không có key OpenAI; key Gemini chỉ nằm trong connector store, tuyệt
  đối không copy sang code/file/test (test dùng key giả `fake-test-key`).
- OpenAI Realtime: cần key OpenAI (hoặc endpoint OpenAI-compatible +
  `realtimeUrl` wss) — chưa có trên máy này.
- Gemini Live: cần key Gemini trong Vault của app + bot đặt model Live
  (vd `gemini-live-2.5-flash-native-audio`). Chưa thử live: chưa rõ key
  free có quyền `bidiGenerateContent` không, chưa rõ model Live nào
  enable cho key đó (check bằng `GET /v1beta/models?key=...`, lọc
  `supportedGenerationMethods` chứa `bidiGenerateContent`).
- Gemini cancel bằng `activityStart` là best-effort theo docs công khai,
  chưa live-verify; tool response shape (`functionResponses[].id`)
  theo docs + ví dụ cộng đồng, chưa live-verify.
- `WhisperCliSttEngine`: chưa có binary/model nên flags CLI chưa verify.
- Mic/loa thật: VM không có card âm thanh; đường capture/playback ở
  renderer (worklet + AudioContext 24 kHz) tái dùng code call cũ đã có,
  chưa chạy app Electron thật ở sóng này (coordinator smoke sau khi gộp).
- Session audio-only ~15 phút (giới hạn server Gemini); `goAway` đã xử
  lý (báo lỗi + reconnect).

## Test

`tests/realtime-*-v095d3.test.mjs` — 44 test, mock WS + mock audio, không
mạng thật:

| File | Số test | Nội dung |
|---|---|---|
| `realtime-audio-v095d3` | 10 | RMS, resample 16k<->24k, chunker, LocalVad (start/end/hangover), mock source/sink |
| `realtime-adapters-v095d3` | 10 | OpenAI session.update/turn_detection/cancel; Gemini setup gating, realtimeInput, serverContent, toolCall->toolResponse, goAway, activityEnd |
| `realtime-session-v095d3` | 14 | State machine, barge-in (server/local/manual), turn-taking 3 chế độ, resample đường audio, reconnect + hết budget, TTS hook |
| `local-stt-v095d3` | 5 | Mock engine, probe unavailable trên VM, fake binary+model qua runner inject, exit lỗi |
| `realtime-ui-v095d3` | 5 | requireWsUrl, i18n parity 6/6, panel testids, preload/main IPC |

Chạy: `npm run build --workspace=@open-bot/core` rồi
`node --test tests/realtime-audio-v095d3.test.mjs tests/realtime-adapters-v095d3.test.mjs tests/realtime-session-v095d3.test.mjs tests/local-stt-v095d3.test.mjs tests/realtime-ui-v095d3.test.mjs`

## Việc tương lai (không làm ở sóng này)

- Live test OpenAI Realtime + Gemini Live khi có key (cần Huy cấp/quyết).
- Nối event session vào harness event log NDJSON (EventLogView).
- Mic-level meter + hiển thị trạng thái VAD trong panel.
- STT streaming local khi có whisper.cpp + model (verify flags CLI).
- Bật TTS hook cho transport text-only / chế độ fallback local.
- Gemini 3.1 Live (input shape mới, không còn `mediaChunks`).
