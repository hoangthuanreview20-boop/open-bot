# Composio triggers — live catalog snapshot + delivery report (v0.83b)

Ngày: 2026-11-11. Chỉ đọc (read-only) qua API Composio bằng key project
thật của Huy; không tạo trigger instance nào, không ghi gì lên tài khoản
Composio. Snapshot này là dữ liệu đối chiếu cho code v0.83b.

## Phương pháp

- `GET /api/v3.1/triggers_types` — phân trang toàn bộ catalog (15 trang,
  714 trigger type), lọc client-side theo 22 toolkit của open-bot
  (`toolkit_slug` bị API BỎ QUA — giống `/tools` bỏ qua `toolkit`, đã
  xác nhận ở v0.72).
- File đầy đủ 714 mục (15,8 MB) KHÔNG commit; chỉ commit bản rút gọn
  22 toolkit ở đây: `trigger-types-22.json` — 244 mục, mỗi mục giữ
  `{ slug, name, type, toolkit, requires_webhook_endpoint_setup }`.

## Kết quả — 244 trigger type trên 22 toolkit

| Toolkit | Số trigger | Toolkit | Số trigger |
|---|---|---|---|
| github | 46 | airtable | 6 |
| trello | 43 | asana | 6 |
| clickup | 21 | googlecalendar | 6 |
| jira | 17 | outlook | 5 |
| monday | 17 | gmail | 2 |
| googlesheets | 16 | hubspot | 2 |
| linear | 12 | zendesk | 2 |
| zoom | 11 | discord | 1 |
| slack | 9 | telegram | **0** |
| notion | 8 | dropbox | **0** |
| googledrive | 7 | | |
| salesforce | 7 | **Tổng** | **244** |

- **Telegram 0, Dropbox 0**: Composio không có trigger nào cho 2 toolkit
  này — automation Composio không nối được sự kiện từ chúng (chỉ gọi tool
  chủ động được).
- Phân phối theo `type` trong catalog: **140 webhook / 104 poll**.
  Poll trigger (vd: Gmail mới — Composio poll hộp thư thay vì push)
  vẫn đi qua cùng một webhook URL của open-bot: Composio nhận event
  (dù bằng poll) rồi push tới URL đã đăng ký.

## Định dạng webhook Composio (docs "Receiving events" + "Triggers")

Envelope V3:

```json
{
  "id": "msg_...",
  "type": "composio.trigger.message",
  "metadata": {
    "log_id": "...",
    "trigger_slug": "GITHUB_ISSUE_CREATED",
    "trigger_id": "ti_...",
    "connected_account_id": "ca_...",
    "auth_config_id": "ac_...",
    "user_id": "..."
  },
  "data": { "...": "event payload của app" },
  "timestamp": "2026-11-11T00:00:00Z"
}
```

- Chữ ký: `HMAC-SHA256(${webhook-id}.${webhook-timestamp}.${rawBody}, secret)`,
  header `webhook-id` / `webhook-timestamp` /
  `webhook-signature: v1,<base64>`, dung sai replay 300s.
- Một project Composio chỉ có MỘT webhook URL — mọi trigger của project
  đều gửi về cùng URL đó; open-bot phân biệt bằng `metadata.trigger_slug`.

## open-bot nhận trigger như thế nào (v0.83b)

- Route Local API: `POST /v1/automations/:id/composio-trigger`
  (KHÔNG cần Bearer token — Composio không gửi được token đó; chữ ký
  HMAC hoặc `?token=` CHÍNH là auth; sai/thiếu auth → 401).
- Mỗi automation Composio có `triggerSlug` riêng; event tới mà slug
  khác thì không ghi run (400).
- Secret: user dán `COMPOSIO_WEBHOOK_SECRET` của project vào UI
  (Vault namespace `composio-trigger-keys/`, không bao giờ đọc lại);
  token URL `?token=` là fallback tuỳ chọn (tạo/xoay hiện đúng 1 lần).
- Trigger instance KHÔNG do open-bot tạo: user tạo trong dashboard /
  CLI / SDK của Composio, trỏ webhook URL của project về Local API
  của open-bot.
- **Giới hạn triển khai**: Local API chỉ nghe loopback (127.0.0.1) nên
  Composio cloud KHÔNG gọi trực tiếp được — cần tunnel
  (`composio dev triggers listen --forward http://127.0.0.1:<port>/v1/automations/<id>/composio-trigger`,
  hoặc cloudflared/ngrok). Test thật end-to-end từ Composio cloud
  chưa chạy (cần tunnel + trigger thật); test hiện tại dùng mock
  payload đã ký + nút "Gửi sự kiện thử" trong UI.
- 50 trigger đã đối chiếu kỹ thành defs trong code
  (`COMPOSIO_TRIGGER_DEFS`): xem `packages/core/src/composio/triggers.ts`.
