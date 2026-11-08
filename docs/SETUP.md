# Cài đặt & chạy open-bot

## Yêu cầu

- **Node.js 20+** (khuyên dùng Node 20 LTS trở lên) và npm đi kèm.
  - Kiểm tra: `node --version` và `npm --version`.
  - Chưa có Node? Tải tại https://nodejs.org — chọn bản LTS.
- Hệ điều hành: Windows, macOS hoặc Linux.
- Một API key của ít nhất một provider bên dưới (hoặc Ollama chạy local, không cần key).

## Cài đặt

```bash
git clone <repo-url> open-bot
cd open-bot
npm install
```

> `npm install` cài dependencies cho workspace gốc và tất cả workspace con (`apps/*`, `packages/*`).

## Chạy dev

```bash
npm run dev
```

Lệnh này chạy ứng dụng desktop (Electron) ở chế độ development, có hot-reload.

Các lệnh khác:

```bash
npm run build       # build tất cả workspace
npm run typecheck   # kiểm tra kiểu (tsc --noEmit) ở từng workspace
npm test            # chạy test (node --test)
```

## Lấy API key từng provider

API key **chỉ lưu trên máy của bạn** (file `.env` hoặc nhập trong Settings của app). Không bao giờ commit file `.env` — file này đã có trong `.gitignore`. Nếu key bị lộ, thu hồi ngay trên trang của provider và tạo key mới.

### OpenAI

1. Vào https://platform.openai.com/api-keys (cần tài khoản OpenAI).
2. Bấm **Create new secret key**, đặt tên gợi nhớ (ví dụ `open-bot`), copy key — key chỉ hiện một lần.
3. Nạp credit / bật billing nếu model bạn dùng yêu cầu (một số model cần tài khoản trả phí).
4. Cấu hình: `OPENAI_API_KEY=<key>`; model gợi ý: `gpt-5` hoặc model bạn muốn dùng.

### Anthropic (Claude)

1. Vào https://console.anthropic.com/settings/keys (cần tài khoản Anthropic).
2. Bấm **Create Key**, copy key.
3. Nạp credit nếu cần (Anthropic tính phí theo usage).
4. Cấu hình: `ANTHROPIC_API_KEY=<key>`; model gợi ý: `claude-sonnet-4-5` hoặc model bạn muốn dùng.

### Gemini (Google AI)

1. Vào https://aistudio.google.dev/apikey (cần tài khoản Google).
2. Bấm **Create API key**, chọn Google Cloud project (tạo mới nếu chưa có), copy key.
3. Có gói miễn phí với giới hạn nhất định; vượt giới hạn cần bật billing trong Google Cloud.
4. Cấu hình: `GEMINI_API_KEY=<key>` (hoặc `GOOGLE_API_KEY=<key>`); model gợi ý: `gemini-2.5-pro` hoặc model bạn muốn dùng.

### xAI Grok

1. Vào https://console.x.ai (cần tài khoản xAI).
2. Vào mục **API Keys**, bấm tạo key mới, copy key.
3. Nạp credit trong mục billing của xAI console (API của xAI tính phí theo usage).
4. Cấu hình: `XAI_API_KEY=<key>`; model gợi ý: `grok-4` hoặc model bạn muốn dùng.
5. Lưu ý: endpoint API của xAI là `https://api.x.ai/v1`, tương thích định dạng OpenAI.

### Ollama (chạy model local, không cần key)

1. Tải và cài Ollama tại https://ollama.com (Windows / macOS / Linux).
2. Tải một model về máy, ví dụ:
   ```bash
   ollama pull llama3.1
   ```
3. Chạy Ollama (mặc định ở `http://localhost:11434`).
4. Cấu hình trong open-bot: chọn provider **Ollama**, base URL `http://localhost:11434`, model `llama3.1` (hoặc model bạn đã pull).
5. Không cần API key. Model chạy hoàn toàn trên máy bạn — riêng tư nhất, nhưng chất lượng và tốc độ phụ thuộc vào phần cứng của bạn.

## Cấu hình API key trong open-bot

Cách 1 — file `.env` ở thư mục gốc:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
XAI_API_KEY=xai-...
```

Cách 2 — mở app, vào **Settings → Providers**, nhập key và chọn provider/model mặc định.

Chỉ cần cấu hình provider bạn thực sự dùng; các provider khác có thể để trống.

## Sự cố thường gặp

| Vấn đề | Cách xử lý |
|---|---|
| `node: command not found` | Cài lại Node.js 20+ từ https://nodejs.org, mở lại terminal |
| `npm install` lỗi mạng | Kiểm tra mạng, thử `npm cache clean --force` rồi cài lại |
| Báo key không hợp lệ / 401 | Kiểm tra key copy đủ, không thừa khoảng trắng; key đã bị thu hồi thì tạo key mới |
| Hết quota / 429 | Nạp thêm credit cho provider đó, hoặc đổi sang provider/model khác |
| Ollama không kết nối được | Kiểm tra Ollama đang chạy (`ollama list`), đúng port `11434` |
