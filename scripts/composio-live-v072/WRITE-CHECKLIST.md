# Checklist phê duyệt — Live test Composio PHẦN GHI (v0.85)

> **ĐÃ ĐIỀN + ĐÃ KÝ (2026-11-11).** Huy phê duyệt test ghi trong
> chat lúc 12:13 ("Cho phép test ghi Composio") và giao tự chọn
> đích test lúc 12:26 ("Cái nào chả được, bạn muốn làm gì thì làm
> theo công việc của bạn ấy"). Đích test dưới đây do Muse chọn theo
> kết quả probe thật cùng ngày (probe-repos-channels, probe
> account-field): repo duy nhất của tài khoản GitHub openbot1,
> hộp thư Gmail của chính Huy, kênh `social` trong workspace Slack
> "open-bot" mới tạo.
>
> Phê duyệt là phê duyệt TRƯỚC: bot live test chạy với
> `autoApprove: true` (`scripts/composio-live-v072/live.mjs:255`)
> nên lúc chạy không có gate hỏi lại nào — cờ
> `needsApproval: true` của `COMPOSIO_MULTI_EXECUTE_TOOL` không
> phải gate trong lúc chạy. Xem `docs/composio-integration.md`
> §8.1.
>
> File này là form trống — không chứa thông tin thật, không chứa
> key. Điền xong thì người chạy live test đối chiếu với env
> §8.1.3 trước khi chạy `python3
> scripts/composio-live-v072/run-live.py`.

## 1. Repo test (bước 4 — tạo 1 issue thật)

- Owner: openbot1
- Repo: open-bot
- (Repo chỉ dùng để test, không phải repo sản phẩm. Issue sẽ được
  đóng ngay sau khi kiểm tra xong.)

## 2. Hộp thư test (bước 5 — gửi 1 mail thật)

- Hộp thư nhận mail test: hoangthuanreview20@gmail.com
- **Lưu ý: mail đã gửi không unsend được.** Trash chỉ xoá bản
  trong Sent/hộp thư của tài khoản đã kết nối; người nhận vẫn giữ
  bản đã nhận. Hộp thư test phải là hộp thư Huy kiểm soát được.

## 3. Kênh Slack test (bước 5 — gửi 1 tin thật)

- Workspace: open-bot (open-botworkspace.slack.com)
- Kênh (tên hoặc ID, không có `#`): social

## 4. Nội dung 3 artifact (bắt buộc có tiền tố `[open-bot live test]`)

- Tiêu đề issue: `[open-bot live test] Kiểm tra tạo issue qua Composio`
- Nội dung issue: Issue test tự động của open-bot qua Composio (live test v0.72, bước 4). Sẽ được đóng ngay sau khi kiểm tra xong.
- Tiêu đề mail: `[open-bot live test] Kiểm tra gửi mail qua Composio`
- Nội dung mail: Mail test tự động của open-bot qua Composio (live test v0.72, bước 5). Không cần trả lời — sẽ được đưa vào trash sau khi kiểm tra xong.
- Nội dung tin Slack: `[open-bot live test] Tin test tự động của open-bot qua Composio (live test v0.72, bước 5). Sẽ được xoá ngay sau khi kiểm tra xong.`

## 5. Điều kiện tiên quyết — đã kết nối đủ 3 app

- [x] GitHub đã connect trong dashboard Composio (openbot1, Active, 2026-11-11 ~12:16)
- [x] Gmail đã connect trong dashboard Composio (hoangthuanreview20@gmail.com, Active, 2026-11-11 ~12:20)
- [x] Slack đã connect trong dashboard Composio (workspace "open-bot", Active, 2026-11-11 ~12:25)

## 6. Xác nhận rủi ro + dọn dẹp

- [x] Đã đọc + chấp nhận rủi ro custody (`docs/composio-integration.md`
      §9: token OAuth nằm phía Composio; sự cố 05/2026)
- [x] Đồng ý dọn dẹp sau test (bắt buộc): đóng issue
      (`GITHUB_CLOSE_ISSUE`) + trash mail (`GMAIL_MOVE_TO_TRASH`)
      + xoá tin Slack (`SLACK_DELETES_A_MESSAGE_FROM_A_CHAT`) +
      revoke connection 3 app trong dashboard Composio
      (làm bằng tay sau khi kiểm tra xong)

## 7. Phê duyệt

- Chữ ký của Huy: Huy (phê duyệt trong chat 2026-11-11 12:13; đích test giao tự chọn 12:26)
- Ngày: 2026-11-11

## 8. User id cho session ghi (bổ sung 2026-11-11)

- `COMPOSIO_WRITE_USER_ID`: pg-test-0d236b17-eece-4031-aae3-e8dbc3d70910
- Đây là user id của các connected account trên dashboard Composio
  (hiển thị công khai trên trang Auth Configs — KHÔNG phải key).
  Session ghi bắt buộc dùng đúng user id này: session với user id
  khác (`local-user`, `local-user-1`) lỗi "No active connection
  found"; field `account` trong MULTI_EXECUTE không dùng được
  ("Multi-account selection is not enabled"). Gap sản phẩm:
  coordinator hardcode `COMPOSIO_LOCAL_USER_ID` ('local-user') nên
  app chưa dùng được connection dashboard — cần cho phép cấu hình
  Composio user id (xem `report.json` → `notes` sau khi chạy).

**Đã sửa ở tầng app (v0.88b + v0.89c, Team E, 2026-11-11):**
v0.88b thêm Composio user id cấu hình được (Vault
`'composio-user-id'`, Settings → Composio, RPC
`composio.setUserId`, đổi id drop session ngay không restart —
`docs/composio-integration.md` §17; probe live READ-ONLY: session
với user id đã cấu hình thấy 3/3 Active). v0.89c thêm trạng thái
connection từng toolkit trong Settings (nút "Kiểm tra trạng thái
kết nối", IPC `composio:get-connection-status`) + session manager
kiểm tra Active trước lần thực thi đầu tiên và báo lỗi rõ
`composio_connection_inactive` khi chưa Active (§18). Test ghi
live 7/7 ngày 2026-11-11 (commit `da495fb`) chạy qua session trực
tiếp trong script, không qua app — đường ghi qua app vẫn chưa
được chạy live lần nào.

Chỉ khi mọi ô trên đã tick + có chữ ký thì mới được đặt env ghi
(`COMPOSIO_WRITE_REPO`, `COMPOSIO_WRITE_ISSUE_TITLE/BODY`,
`COMPOSIO_WRITE_MAIL_TO/SUBJECT/BODY`,
`COMPOSIO_WRITE_SLACK_CHANNEL/TEXT` — xem docs §8.1.3) và chạy
live test.
