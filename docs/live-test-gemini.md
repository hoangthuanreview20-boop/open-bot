# Live test Gemini — open-bot

Ngày: 2026-11-09. Model test chính: `gemini-2.5-flash` (default của provider).
Key: key Gemini miễn phí của Huy, nằm trong vault dưới tên `custom.gemini`.
**Không bao giờ** để key vào file, `.env`, log, hay hỏi lấy giá trị key.

## Cách chạy proxy

Code open-bot gọi API thật **chỉ** qua proxy local — proxy gắn
surrogate từ vault, key thật không chạm file:

```bash
# Terminal 1
python3 ~/workspace/custom-connectors/custom.gemini/bin/gemini_proxy.py --port 8765
# Kiểm tra: curl http://127.0.0.1:8765/  →  {"ok": true}
```

Provider dùng `apiKey: 'via-proxy'` (dummy, proxy bỏ đi) và
`baseUrl: 'http://127.0.0.1:8765/v1beta'`. Dừng proxy khi xong
(`Ctrl+C` ở terminal proxy). Chi tiết đầy đủ:
`~/workspace/custom-connectors/custom.gemini/CONNECTOR.md`.

## Cách chạy test live (gated)

```bash
npm run build                       # dist mới nhất trước khi test live
OPENBOT_LIVE_GEMINI=1 node --test tests/gemini-live.test.mjs
```

Test tự **skip** (không fail) khi `OPENBOT_LIVE_GEMINI != 1` hoặc
proxy không chạy — suite thường (`npm test`) không bao giờ gọi API
live hay tốn quota. Test gồm 4 request: 1 request chat 1 vòng
(echo) + 3 request loop 3 vòng (add → echo → text cuối).

Script thủ công (không nằm trong suite, tối đa 4 vòng / 4 request,
dừng ngay khi gặp 429):

```bash
node scripts/gemini-live-loop.mjs [--model gemini-2.5-flash]
```

## Kết quả đo thật (2026-11-09)

### Chat 1 vòng — `gemini-2.5-flash`

Prompt: gọi tool `echo` với text `'xin chao open-bot'`.

| Lần chạy | Thời gian | Tool call | Usage (in/out) |
| --- | --- | --- | --- |
| 09/11 ~13:27 (lần đầu, `/tmp` script) | 1.7s | `echo {"text": "xin chao open-bot"}` | 60 / 18 |
| 09/11 ~13:45 (test gated) | 1.5s | `echo {"text": "xin chao open-bot"}` | 60 / 18 |

Provider parse đúng: 1 `functionCall`, id có prefix `gemini-`,
usage từ `usageMetadata` (`promptTokenCount` / `candidatesTokenCount`).

### Agent loop 3 vòng — `gemini-2.5-flash`

Prompt: "Tính 17 + 25 bằng tool add, rồi dùng tool echo để nhắc lại
kết quả." Tool `add`/`echo` được "chạy" ở phía client (17+25=42),
trả `functionResponse` về cho model đúng như agent loop làm.

| Vòng | Model trả về | Usage (in/out) |
| --- | --- | --- |
| 1 | `functionCall add {"a": 17, "b": 25}` | 125 / 20 |
| 2 | `functionCall echo {"text": "42"}` | 159 / 14 |
| 3 | text `"Kết quả là 42."`, hết tool call | 187 / 7 |

Tổng: **3 vòng, 2.7s, usage cộng dồn 471 in / 41 out.**
`functionCall` + `functionResponse` parse đúng cả hai chiều, usage
cộng dồn đúng (tổng từng vòng = 471/41).

### Bẫy đã gặp: user message ngay sau functionResponse

Lần chạy đầu của test loop thêm một user message ("Kết quả phép
cộng là 42. Gọi tool echo...") ngay sau `functionResponse`. Model
trả **candidate rỗng** (`finishReason: STOP`, 0 output token, usage
170 in / 0 out) — đã xác minh lại bằng request thô (`gemini.py
--body`). Dạng loop đúng của agent là **không** thêm user message
sau `functionResponse`: chỉ nối `assistant(toolCalls)` +
`tool(result)` rồi gọi tiếp, model sẽ gọi tool kế hoặc trả lời.
Test gated và script thủ công đều dùng dạng đúng này.

## Quota / 429

Free tier có giới hạn rate chưa xác minh con số cụ thể — đừng trích
số từ trí nhớ. Thực tế 09/11: sau ~10 request dồn trong ~15 phút
(list-models + các lần test + 2 probe thô), request tiếp theo trả
**HTTP 429**. Gặp 429 thì **dừng ngay**, chờ rồi thử lại sau; test
gated và script thủ công đều dừng/không retry khi gặp 429 (script
thoát code 3 với thông báo rõ). Mỗi lần live test chỉ vài request,
không spam.

## Model registry — cập nhật 2026-11-09

Live `list-models` 09/11 ~13:30 trả **50 models, HTTP 200**.
`GEMINI_KNOWN_MODELS` (`packages/core/src/providers/gemini.ts`)
đã cập nhật từ list này; `packages/core/src/models/registry.ts`
mirror tự động qua `KNOWN_MODELS_BY_PROVIDER` (không cần sửa tay).

- **Bỏ:** `gemini-2.0-flash` — không còn trong live list.
- **Thêm (ổn định):** `gemini-2.5-flash-lite`, `gemini-3.5-flash`,
  `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`,
  `gemini-flash-latest`, `gemini-flash-lite-latest`,
  `gemini-pro-latest`.
- **Thêm (preview, nhãn `(preview)` trong picker):**
  `gemini-3-flash-preview`, `gemini-3.1-pro-preview`,
  `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`,
  `gemini-4-argon`. (3.6/3.7/3.8-flash và 4-argon không có hậu tố
  `-preview` trong tên nhưng là thế hệ mới chưa ổn định nên vẫn
  đánh dấu preview — xem `GEMINI_PREVIEW_MODELS`.)
- **Giữ default:** `gemini-2.5-flash`. Fallback:
  `gemini-2.5-flash-lite`.
- **Không đưa vào registry:** model chuyên biệt trong live list —
  image (`gemini-2.5-flash-image`, `gemini-3-pro-image`, ...),
  TTS (`...-tts`), embedding (`gemini-embedding-001/2`,
  `embedContent` chứ không phải `generateContent`), computer-use
  preview, deep-research preview, lyria, robotics, antigravity,
  omni, nano-banana, gemma. Chúng không phải model chat
  `generateContent` cho agent loop.

## Live-test image generation (v0.89b, 2026-11-11) — FAIL vì quota

- **Kết quả:** lần kiểm chứng live đầu tiên của `image_generate`
  qua Gemini (`HttpGeminiImageProvider`, `packages/tools/src/
  geminiImage.ts`, v0.87d) **FAIL — HTTP 429 trên cả 3 model**,
  không ảnh nào được tạo: `gemini-nano-banana-2.1` (default,
  1147ms, `generate_content_free_tier_input_token_count, limit:
  0`), `gemini-2.5-flash-image` (514ms, `generate_content_free_
  tier_requests, limit: 0`), `gemini-3.1-flash-image` (579ms,
  input-token/min `limit: 0`). Prompt "a small red square on
  white background", size 1024x1024, qua proxy local port 8766
  (apiKey dummy `via-proxy`), script một lần ở /tmp.
- **Key còn sống:** đối chứng cùng key gọi text `gemini-2.5-flash`
  ngay sau đó HTTP 200 ("key-ok") — chỉ bucket quota sinh ảnh
  free-tier = 0. Cả 3 model đều có trong live `list-models`
  (50 model, HTTP 200) nên không phải 404 sai tên model.
- **Cần để thử lại:** key có billing/quota sinh ảnh (limit 0 là
  mức quota, đợi hồi không giúp). Khi có key đó, chạy lại đúng
  script/proxy trên; nếu một model pass thì đó mới là bằng chứng
  để xem có nên đổi default `gemini-nano-banana-2.1` không.
- **Bằng chứng gián tiếp:** server chấp nhận request shape tới
  bước tính quota (không 400/404), và đường lỗi 429 hiện đúng
  end-to-end (`... failed with HTTP 429: {...}. No image was
  saved.`). Chi tiết đầy đủ: `docs/BEYOND-ROADMAP.md` mục v0.89b.

## Chưa live-test được

- **Grok (x.ai) / OpenAI:** chưa có key nên chưa live-test được
  provider nào ngoài Gemini. Không thử kết nối live tới x.ai.
- **Model mới (3.5/3.6/3.7/3.8/4-argon, preview):** chỉ thêm vào
  registry từ live `list-models`, **chưa** gọi `generateContent`
  live trên từng model — mới chỉ test live `gemini-2.5-flash`.
  Khi cần, chạy `node scripts/gemini-live-loop.mjs --model <tên>`
  (tốn quota từng request, gặp 429 thì dừng).
- **Script thủ công** (`scripts/gemini-live-loop.mjs`): logic loop
  đã đúng dạng (đã chứng minh qua test gated 3 vòng), nhưng lần
  chạy tay đầu tiên trúng 429 ngay vòng 1 nên chưa có một lần chạy
  script hoàn chỉnh — chạy lại sau khi quota hồi.
