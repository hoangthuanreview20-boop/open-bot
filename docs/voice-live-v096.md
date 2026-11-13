# Voice live v0.96 (Đội T5)

Nối tiếp D3 v0.95 (adapter mock-only). Mục tiêu: adapter thật sẵn sàng
live, STT/TTS local thật, session lưu được — nhưng live chỉ chạy khi
key đã có trong Vault; không key thì báo rõ và dùng mock.

## Adapter thật + key gate

- `packages/core/src/voice/adapters.ts`: cả 2 transport đều có key gate.
  `connect()` resolve key từ `config.apiKey` hoặc `keyResolver` (closure
  trên Vault ở main, đọc lúc chạy — key không nằm trong code/file/test).
  Không key → `MissingRealtimeKeyError` ("No API key is configured for
  … — Add … in Settings → API keys first"), socket không được mở.
  Ngoại lệ: `openai-compatible` với URL riêng có thể không cần key
  (endpoint local).
- OpenAI Realtime: `session.update` → `input_audio_buffer.append`
  (base64 PCM16 24 kHz) → `response.audio.delta` /
  `response.audio_transcript.*` → `response.function_call_arguments.done`;
  barge-in `response.cancel`. Gemini Live: `setup` (model
  `models/<live-model>`, `responseModalities: ["AUDIO"]`) → đợi
  `setupComplete` → `realtimeInput` mediaChunks 16 kHz →
  `serverContent` (inlineData audio 24 kHz, outputTranscription,
  turnComplete, interrupted) + `toolCall`/`toolResponse`.
- Latency + health (`transportHealth.ts`): mỗi adapter ghi `connect`
  và `first-audio` (ms) vào `LatencyStats` (min/max/mean/p50/p95, tối
  đa 100 mẫu) và báo `getHealth()` — `unknown/healthy/degraded/down`
  theo quy tắc tường minh (không key → down; đã nối + có audio → healthy;
  connect > 5 s hoặc first-audio > 3 s → degraded). `healthCheck` không
  mở socket — chỉ đọc trạng thái đã có. Reconnect backoff giữ nguyên
  (OpenAI: `RealtimeClient` 20 lần; Gemini: session 5 lần, 1 s nhân
  đôi tới 10 s); `Backoff` mới là math chung có jitter, dùng cho
  đường reconnect sau này.
- Mock fallback (`mockTransport.ts`): không key và không có URL riêng
  → main chạy `MockRealtimeTransport` thay vì lỗi — cùng interface
  `RealtimeTransport` nên session/barge-in/UI chạy y hệt, chỉ "model"
  là scripted (commit → transcript + tone sine → `onResponseDone`;
  `cancelResponse` drop reply đang chờ). `getHealth()` báo `mock: true`
  để panel nói rõ đây là mock, không giả làm live. Lưu ý: mock không
  có server VAD nên ở chế độ `server_vad` sẽ không tự trả lời — dùng
  `local_vad` / `push_to_talk` (commit mới trả lời) trong chế độ mock.

## Local STT — whisper thật

- whisper.cpp build từ source: `~/tools/whisper.cpp` (cmake target
  `whisper-cli`), model `ggml-tiny.bin` (~78 MB) ở
  `~/.cache/whisper`. apt không có gói whisper (đã kiểm tra
  `apt-cache search` — không có), nên build từ source là đường duy
  nhất trên máy này. `WhisperCliSttEngine` nay tìm cả
  `~/tools/whisper.cpp/build/bin/whisper-cli` và `$WHISPER_BINARY`,
  model `ggml-tiny[.en].bin` được ưu tiên trước base/small.
- `sttPipeline.ts`: VAD → segment → `engine.transcribe()` → text.
  Chỉ frame có RMS ≥ ngưỡng mới vào segment (silence trong hangover
  không làm phình đoạn — blip 100 ms + hangover 300 ms trước đây
  thành 400 ms và bị transcribe nhầm). Segment < 300 ms bị loại,
  > 30 s bị cắt giữa chừng; transcribe nối tiếp nhau, lỗi báo qua
  `onError` không giết pipeline.
- WER (`wordErrorRate`, Levenshtein cấp từ, không phân biệt
  hoa/thường/dấu câu). Đo live: audio eSpeak NG đọc "hello world"
  → whisper tiny nghe lại **"Hello world." — WER 0**, transcribe
  ~6 s (lần đầu ~21 s do load model), pipeline VAD→STT live cũng
  WER 0. Chưa đo WER tiếng Việt (chưa có audio mẫu tiếng Việt).

## Local TTS — queue + barge-in

- `ttsQueue.ts`: `splitIntoSentences` (bảo vệ viết tắt `Dr./Mr./…`
  bằng placeholder U+E000; câu > 120 ký tự tách thêm ở `, ; :`),
  queue nói từng câu qua `TtsHarness` (eSpeak NG trên máy này).
  `stop()`/`bargeIn()` kill câu đang nói + drop hàng chờ, đo
  `stopLatencyMs` tới lúc `speak()` settle `'stopped'`.
- Đo live eSpeak NG: **stop latency 6 ms** (ngân sách 200 ms).
- `RealtimeSession` nối queue: transcript cuối của model được enqueue
  từng câu; barge-in dừng cả transport lẫn queue. Lưu ý: main KHÔNG
  bật queue mặc định — provider đã stream audio, bật thêm sẽ nói
  chồng 2 giọng. Queue dành cho transport text-only / fallback local.

## Session persistence

- `voicePersistence.ts`: mỗi session một file JSON
  `<userData>/voice-sessions/<sessionId>.json` (ghi atomic tmp +
  rename; file hỏng → null + quarantine `.corrupt-<ts>`; cap 500
  dòng transcript; `prune()` 30 ngày / 50 session; id sanitize
  chống `../`). Chỉ lưu text — không lưu audio.
- `RealtimeSession` (`sessionStore` + `persistSessionId`): lưu sau
  mỗi transcript cuối + khi disconnect (`endedAt`, counters);
  resume khôi phục transcript + `bargeInCount`/`turnCount`, KHÔNG
  khôi phục socket — session mới vẫn dial lại từ đầu.

## UI + IPC

- `RealtimeVoicePanel`: thêm trạng thái từng adapter (status/key/
  latency), transcript live (6 dòng cuối, dòng interim đánh dấu),
  session id đã resume. `ChatView` lấy health qua IPC mới
  `voice:realtime-health` sau connect + sau mỗi turn (lúc first-audio
  latency đã có). `main` truyền `keyResolver` (Vault closure) +
  `sessionStore` vào session; kết quả connect trả kèm health/latency.
- i18n: +14 key `voice.realtime.live.*` × 6 locale (1678 → 1692).

## Kiểm chứng

- `tests/voice-live-v096.test.mjs`: **27/27 pass** (chạy sau build
  core). Gồm: health/backoff/key-gate (mock WS — handshake OpenAI +
  Gemini, audio delta parse, setupComplete gate, interrupted,
  toolCall, dial timeout), STT pipeline (mock) + WER, TTS queue
  (split, thứ tự, barge-in mock), persistence round-trip/quarantine/
  prune, session tích hợp (persist + barge-in dừng cả TTS), mock
  fallback (commit → transcript + audio, cancel drop reply, session
  mock không cần key), live whisper WER 0 + live eSpeak stop 6 ms.
- Hồi quy: `voice.test` + `voice-v059` + `voice-p01` +
  `voice-surface-v056` + `tts-voice-v082` + `i18n` — **xanh**.
- Build + typecheck xanh: core, tools, desktop (renderer + main).

## Lỗi thật bắt được trong sóng này

1. `RealtimeClient.disconnect()` và `GeminiLiveTransport.disconnect()`
   crash (`detachSocket(null)`) khi socket gọi `onclose` đồng bộ
   trong `close()` — handler null `this.socket` giữa chừng. Sửa:
   null field trước khi close (như `supersede()` đã làm). Lỗi v0.95,
   mock WS mới lộ ra (WebSocket thật fire onclose async nên chưa gặp).
2. Pipeline STT tích cả silence trong VAD hangover → blip bị
   transcribe nhầm. Sửa: chỉ tích frame RMS ≥ ngưỡng.
3. `splitIntoSentences` tách sai viết tắt ở đầu câu ("Dr." thành câu
   riêng). Sửa: placeholder thay cho merge tay.

## Giới hạn còn lại

- **Adapter live chưa verify**: không có key OpenAI trên máy; key
  Gemini chỉ ở connector store, không copy — cả 2 adapter mới chỉ
  mock-verified (fake WebSocket). Live call đầu tiên cần key trong
  Vault (Settings → API keys) rồi test lại.
- Live ảnh Gemini KHÔNG thử (key miễn phí quota ảnh = 0, lệnh đứng).
- Whisper chỉ model tiny, mới đo WER tiếng Anh; tiếng Việt chưa có
  audio mẫu để đo. Mic/loa thật + app Electron thật chưa chạy trên
  VM headless (không có sound card).
- TTS queue chưa bật trong main (tránh nói chồng giọng provider).
