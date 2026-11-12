# Cài đặt & chạy open-bot

## Yêu cầu

- **Node.js 24+** (core khai `engines: node >=24` trong `packages/core/package.json`) và npm đi kèm.
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

## Cấu hình nâng cao (v0.7) — file trong thư mục userData

Thư mục userData: Linux `~/.config/open-bot`, macOS
`~/Library/Application Support/open-bot`, Windows
`%APPDATA%/open-bot`.

### Policy của máy (`policy.json`) — ghim backend cho môi trường doanh nghiệp

```json
{
  "backendBaseUrl": "https://llm.cong-ty.local/v1",
  "allowedProviders": ["xai", "ollama"],
  "disableTelemetry": true
}
```

- `backendBaseUrl`: baseUrl mặc định cho provider được phép (trừ
  Ollama local, luôn giữ `localhost`). BaseUrl người dùng đã gõ tay
  trong Settings luôn thắng policy.
- `allowedProviders`: provider không có trong danh sách sẽ bị chặn ở
  mọi chỗ (kể cả bot cũ còn trỏ tới).
- Không có file → mọi thứ như cũ. File sai JSON/sai kiểu → bỏ qua +
  log lỗi, app không crash.

### OAuth cho MCP server (`mcp-oauth.json`) — tool `mcp_auth`

```json
{
  "servers": {
    "notion": {
      "authorizationEndpoint": "https://api.notion.com/v1/oauth/authorize",
      "tokenEndpoint": "https://api.notion.com/v1/oauth/token",
      "clientId": "oauth-client-id-cua-ban",
      "scope": "read write"
    }
  },
  "allowedSystemTools": ["notion-search", "notion-create-page"]
}
```

- `servers.<tên>`: endpoint + client id của MCP server (phần công
  khai). Client secret — khi provider cần — KHÔNG ghi vào file này:
  lưu vào Vault namespace `mcp-oauth-client`, key = tên server (mục
  Vault trong Settings).
- `allowedSystemTools`: tên các tool của MCP server `system` (khai
  trong `.open-bot/mcp.json` của workspace) mà `mcp_system_exec`
  được phép chạy. Mặc định rỗng = không tool nào được chạy.
- Token sau khi authorize được lưu vào Vault namespace `mcp-oauth`
  (key = tên server), không nằm trong file này.

### Token cho tool git / tích hợp (Vault)

| Tool | Nguồn token | Ghi chú |
|---|---|---|
| Git (`pr_*`, `git_host_connect`) | Vault namespace `github`, key `token` | GitHub personal access token; chưa có thì tool báo rõ thay vì gọi API |
| Slack / Gmail / Teams | Vault namespace `connector`, key `slack` / `gmail` / `teams` | Lưu dạng TokenSet JSON (qua `vaultTokenStore`); token tự refresh qua `callWithAutoRefresh` (refresh sớm 5 phút trước hạn, `REFRESH_BEFORE_MS` trong `packages/core/src/connectors/framework.ts`, từ v0.9) |
| X search | Vault namespace `x`, key `bearer` | Không có thì `x_search` fallback sang web search có ghi nhãn |

Đặt token: mở app → **Settings → Vault** (mục Vault) hoặc dùng IPC
`vault:set` với đúng namespace/key trên. Token không bao giờ nằm
trong `settings.json` hay file cấu hình plaintext.

### Đăng nhập OAuth (Google) — Settings → Tài khoản & đăng nhập

Chỉ Google hỗ trợ OAuth từ desktop app (xAI không có OAuth công khai
cho desktop app nên chỉ dùng API key). Người dùng tự tạo Google OAuth
client (loại Desktop app) rồi nhập client id/secret trong Settings;
refresh token lưu Vault namespace `oauth-refresh`.

### API local: WebSocket streaming + webhook HMAC (v0.8)

- **WebSocket**: `GET /v1/bots/:id/run/stream?text=...` (loopback,
  Bearer token + `X-Open-Bot-Team` như route HTTP, kiểm tra trước
  handshake). Mỗi message là JSON `{kind, data}` với kind
  `delta`/`toolcall`/`toolresult`/`summary`/`error`; socket đóng khi
  run xong (1000) hoặc lỗi (1011). Run qua WS trả lời được
  approval/ask-user (two-way từ v0.9a): client gửi message
  `{type: "approval-response", callId, approved}` hoặc
  `{type: "ask-user-response", requestId, answer}` — xem
  `packages/core/src/api/server.ts` (control message hai chiều).
- **Webhook HMAC**: secret ký webhook lưu trong Vault namespace
  `webhook`, key `hmac-secret` (đặt qua Settings → Vault). Mỗi webhook
  POST mang header `X-Open-Bot-Signature: sha256=<hex>` (HMAC-SHA256
  của `"<timestamp>.<body>"`) và `X-Open-Bot-Timestamp` (epoch giây).
  App ngoài verify bằng `verifyWebhookSignature` (core) và từ chối
  timestamp lệch > 5 phút. Chưa đặt secret thì webhook gửi không ký.

### Plugin: bật/tắt trong Settings (v0.8)

Settings → Plugin: liệt kê plugin đã cài (tên, version, mô tả, tool),
toggle bật/tắt (lưu `enabled.json`). Toggle áp dụng ngay cho bot đang
chạy (từ v0.14: `setPluginEnabled` gọi `rebuildPluginTools`,
`appliedToRunning: true` — không cần tạo lại bot; run đang chạy dở
giữ tool cũ, run kế tiếp dùng danh sách mới).

## Sự cố thường gặp

| Vấn đề | Cách xử lý |
|---|---|
| `node: command not found` | Cài lại Node.js 24+ từ https://nodejs.org, mở lại terminal |
| `npm install` lỗi mạng | Kiểm tra mạng, thử `npm cache clean --force` rồi cài lại |
| Báo key không hợp lệ / 401 | Kiểm tra key copy đủ, không thừa khoảng trắng; key đã bị thu hồi thì tạo key mới |
| Hết quota / 429 | Nạp thêm credit cho provider đó, hoặc đổi sang provider/model khác |
| Ollama không kết nối được | Kiểm tra Ollama đang chạy (`ollama list`), đúng port `11434` |
