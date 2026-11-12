# Composio triggers — live end-to-end feasibility (v0.84b)

Ngày: 2026-11-11. Kết luận: **CHƯA làm được live test end-to-end từ
Composio cloud — dừng lại đúng chỗ, không giả vờ đã test.** Hai rào cản
độc lập, cả hai đều cần Huy. Không ghi gì lên tài khoản thật của Huy:
không tạo connected account, không tạo trigger instance, không đổi
webhook subscription, không chạy `composio login --agent`.

## 1. Rào cản A — không có nguồn event: 0 connected account, 0 trigger instance

Probe chỉ đọc (`scripts/composio-triggers-live-v084/probe.mjs`, chạy qua
`probe.py` — lấy surrogate `hsurr:` từ authd, key thật không vào file/log),
ngày 2026-11-11:

```
GET /api/v3.1/connected_accounts        -> HTTP 200, total=0
GET /api/v3/trigger_instances/active    -> HTTP 200, total=0
```

Một trigger instance bắt buộc phải có một connected account (kết nối
OAuth/API-key tới app như GitHub, Gmail, Slack). Không có connected
account thì không có trigger nào để kích hoạt, và không có event nào để
nhận — bất kể dùng đường nào: CLI `listen --forward`, SDK `subscribe()`
(WebSocket), hay webhook URL công khai qua tunnel. Cả ba đường đều nhận
từ cùng một stream/project trống.

Tạo connected account cần Huy tự làm trong trình duyệt (OAuth consent
của chính chủ): dashboard Composio → connect app (vd GitHub), hoặc
`composio connected-accounts link <toolkit>`. Không tự tạo thay Huy
bằng PAT/token đã lưu — đó là cấp quyền truy cập tài khoản thật của Huy
cho Composio, vượt phạm vi "chỉ bắn 1 event test" của sóng này.

## 2. Rào cản B — CLI không đăng nhập được headless

CLI chính thức 0.6.0 đã cài và chạy được (xem §3), nhưng mọi lệnh đều
đòi phiên `composio login`:

```
$ COMPOSIO_API_KEY=<surrogate> composio whoami
You are not logged in yet. Please run `composio login`.
$ COMPOSIO_API_KEY=<surrogate> composio search "list gmail tools"
You are not logged in yet. Please run `composio login`.
$ COMPOSIO_API_KEY=<surrogate> composio dev connected-accounts list
You are not logged in yet. Please run `composio login`.
```

`COMPOSIO_API_KEY` (dù là key thật hay surrogate) bị CLI 0.6.0 bỏ qua
khi chưa có phiên login — xác minh bằng cả 3 lệnh trên, đều cùng thông
báo. Các đường login đều không làm được từ máy này:

- `composio login` — OAuth trình duyệt, cần Huy.
- `composio login --no-wait` + `login --poll` — in URL cho Huy mở trình
  duyệt, link hết hạn sau 10 phút; vẫn cần Huy.
- `composio login --user-api-key` — cần user API key (`uak_...`), không
  phải project key đã lưu; Huy chưa đưa.
- `composio login --agent` — **KHÔNG phải lối thoát**: theo docs chính
  thức ("Authenticate an unattended agent"), nó tạo một tài khoản agent
  RIÊNG BIỆT, "does not grant access to a human's projects or connected
  apps" — tức là project khác, không thấy project của Huy. Đã KHÔNG
  chạy lệnh này.

## 3. Đã làm được: chân đế kỹ thuật cho live test sau này

- **CLI 0.6.0 đã cài, xác minh checksum**: `composio --version` → `0.6.0`.
  Lấy từ GitHub Releases chính thức (`ComposioHQ/composio`,
  `@composio/cli@0.6.0`, `composio-linux-x64.zip` 54.472.647 byte,
  SHA-256 `33354e86…aea3` khớp `checksums.txt`). Cài theo layout chuẩn
  của docs: bundle ở `~/.composio`, symlink `~/.local/bin/composio`;
  không sửa file khởi động shell, không cài plugin
  (`COMPOSIO_INSTALL_PLUGINS=0` tương đương — cài tay từ bundle).
  Lưu ý: URL cài đặt trong docs (`https://composio.dev/install`) trả
  **404 trên HEAD** từ VM này ngày 2026-11-11 (3 lần GET qua shell còn
  làm treo session exec rồi rớt; HEAD thì trả 404 JSON qua Cloudflare
  ngay). Đường GitHub Releases chạy tốt — dùng đường này khi cài lại.
- **Chân API/REST đã thông**: probe qua surrogate tới
  `backend.composio.dev` trả HTTP 200 cả hai endpoint (§1). Mẫu chạy
  CLI với key qua surrogate giữ trong
  `scripts/composio-triggers-live-v084/run-cli.py` (key không vào
  file/log; chỉ truyền qua env của tiến trình con).
- **Lệnh listen đã rõ cú pháp** (`composio dev triggers listen --help`,
  CLI 0.6.0): `--forward <url> --trigger-slug <slug> --max-events N`
  (+ `--toolkits`, `--json`, `--out`). Event forward được ký bằng
  `COMPOSIO_WEBHOOK_SECRET` nếu set — tức là live test sau này sẽ đi
  đúng path production: CLI ký event thật bằng secret, open-bot verify
  HMAC-SHA256 rồi mới ghi run.
- **Route nhận của open-bot đã sẵn sàng** (v0.83b):
  `POST /v1/automations/:id/composio-trigger` trên Local API
  (chỉ nghe 127.0.0.1, port in lúc khởi động; test HTTP 5/5 đã xanh).

## 4. Các bước để Huy mở khoá live test (khi nào Huy rảnh)

1. **Connect một app** trong dashboard Composio (vd GitHub — OAuth
   2 phút trong trình duyệt). Sau đó tạo trigger instance, vd:
   `composio triggers create GITHUB_ISSUE_CREATED` (hoặc trong
   dashboard, hoặc `POST /api/v3/trigger_instances/<slug>/upsert`).
2. **Login CLI trên máy này**: `composio login` (trình duyệt), hoặc
   `composio login --no-wait` rồi Huy mở URL và chạy
   `composio login --poll` trong 10 phút.
3. Lúc đó chạy live test: tạo automation Composio trong open-bot với
   `triggerSlug` đúng slug vừa tạo + dán signing secret (đặt
   `COMPOSIO_WEBHOOK_SECRET` bằng đúng secret đó khi chạy CLI), rồi:
   ```
   composio dev triggers listen \
     --forward "http://127.0.0.1:<port>/v1/automations/<id>/composio-trigger" \
     --trigger-slug GITHUB_ISSUE_CREATED --max-events 1
   ```
   sau đó kích hoạt 1 event thật (vd tạo 1 issue test) và kiểm tra run
   được ghi nhận. Không cần tunnel công khai cho đường này (CLI stream
   qua WebSocket rồi forward về loopback). Đường tunnel
   (cloudflared/ngrok + webhook subscription của project) chỉ cần nếu
   muốn test đúng kiểu production webhook, và vẫn cần bước 1 trước.

## 5. Ghi chú an toàn

- Không key nào (Gemini, Composio, PAT) vào file/log trong sóng này.
  Surrogate `hsurr:` chỉ đi qua env của tiến trình con và được Sentinel
  đổi thành key thật trên egress tới `backend.composio.dev`.
- Không chạy `composio login --agent` (tạo tài khoản khác, không thấy
  project của Huy) và không tự tạo connected account thay Huy.
- Composio phần ghi (tạo issue/mail/Slack thật) vẫn chờ Huy phê duyệt
  riêng — không liên quan tới live test trigger này.
