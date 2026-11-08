# ROADMAP — open-bot

> Tài liệu này mô tả hướng phát triển của open-bot. Mọi nội dung được viết
> mới hoàn toàn, tóm tắt kiến trúc bằng lời của nhóm phát triển; không sao
> chép code, text hay tài sản của xAI/Cursor. Checklist "đầy đủ" dưới đây
> được suy ra từ bản phân tích tĩnh Grok Bot 0.79.3, xem
> [GROK-BOT-ANALYSIS.md](GROK-BOT-ANALYSIS.md).

## 1. Hướng đi: "não" và "thân"

- **Não = model của provider.** Cắm key Grok thì não là Grok 4.7, cắm key
  OpenAI thì não là GPT, cắm Ollama thì não là model local. open-bot không
  sở hữu model, không huấn luyện model, không làm trung gian bán credit.
- **Thân = open-bot.** Cái thân là toàn bộ phần còn lại: vòng lặp agent,
  bộ tool, sandbox, bộ nhớ, giao diện, tự động hoá, tích hợp. Cái thân càng
  tốt thì cùng một bộ não càng làm được nhiều việc.
- **Mục tiêu: làm cái thân đến đỉnh.** Đạt đầy đủ tính năng của Grok Bot
  (theo checklist ở mục 2), rồi mở rộng thêm theo hướng Huy muốn (mục 2e).

### Nguyên tắc

- **Viết code mới hoàn toàn.** Không copy code, text, hình ảnh hay tài sản
  của xAI/Cursor; chỉ học ý tưởng kiến trúc rồi tự thiết kế lại.
- **Local-first, bring your own key.** Dữ liệu ở trên máy người dùng; key
  của ai người đó giữ; không có backend cloud của riêng open-bot.
- **An toàn mặc định.** Hành động nhạy cảm phải qua phê duyệt; tool chạy
  trong sandbox; token không bao giờ bị log.
- **Làm theo mốc, mốc nào cũng build/test được.** Không làm dở dang rồi
  nhảy mốc; mỗi mốc kết thúc bằng một bản chạy được, có kiểm thử và được
  đẩy lên GitHub.

---

## 2. Checklist "đầy đủ" — đích cần đạt

Mỗi mục là một checkbox. Mục nào đã có ở v0.1 được ghi chú rõ; còn lại là
việc cần làm ở các mốc sau.

### 2a. Mô hình tiến trình

- [ ] Main process khởi động 2 giai đoạn: core nhẹ chạy trước, phần app nặng nạp sau khi core báo sẵn sàng
- [ ] Renderer là ứng dụng React, giao tiếp với main qua IPC kênh hẹp có kiểm chứng
- [ ] Daemon thực thi local tách riêng khỏi main: chạy lệnh dài không treo giao diện, daemon crash không kéo sập app
- [ ] Coordinator riêng điều phối các agent con (chạy song song, theo dõi trạng thái, dừng khi cần)
- [ ] Cơ chế cache bytecode (V8 code-cache) để lần mở sau khởi động nhanh hơn
- [ ] Hỗ trợ ghim backend/website qua policy của máy (môi trường doanh nghiệp tự host backend riêng)

### 2b. Đủ 76 kiểu tool call

#### File & code (12 kiểu)

- [ ] Đọc nội dung file — _v0.1: đã có dạng `read_file`_
- [ ] Sửa file theo diff/chỉ định — _v0.1: đã có dạng `write_file`_
- [ ] Xoá file
- [ ] Tìm file theo pattern (glob)
- [ ] Tìm kiếm nội dung trong code (grep)
- [ ] Tìm kiếm ngữ nghĩa trong codebase (semantic search)
- [ ] Liệt kê thư mục — _v0.1: đã có dạng `list_files`_
- [ ] Áp dụng bản diff do agent tạo
- [ ] Xem lịch sử/blame theo file
- [ ] Đọc lỗi lint/chẩn đoán của code
- [ ] Đọc lại lịch sử hội thoại
- [ ] Lấy dữ liệu của agent chạy trên cloud (khi có chế độ cloud)

#### Shell / thực thi trên máy (5 kiểu)

- [ ] Chạy lệnh shell — _v0.1: đã có dạng `shell_exec`_
- [ ] Thực thi lệnh/tác vụ (dạng tổng quát, có theo dõi tiến trình)
- [ ] Ghi vào stdin của shell đang chạy
- [ ] Chuẩn bị môi trường máy ảo/sandbox cho agent
- [ ] Tool local trên máy người dùng (nhóm computer-local)

#### Computer-use — điều khiển máy như người dùng (2 kiểu)

- [ ] Điều khiển máy tính (chuột, bàn phím, màn hình)
- [ ] Ghi/quay màn hình (kèm xem trước màn hình trong giao diện)

#### Web (4 kiểu)

- [ ] Tìm kiếm web — _v0.1: đã có dạng `web_search`_
- [ ] Tìm kiếm trên X — _v0.1: chưa có (web_search hiện tại chỉ tìm web chung)_
- [ ] Tải/đọc nội dung URL — _v0.1: đã có dạng `web_fetch`_
- [ ] Fetch tài nguyên web chung — _v0.1: đã có dạng `http_get`_

#### Tạo sinh media & canvas (4 kiểu)

- [ ] Sinh ảnh (qua API của provider)
- [ ] Sinh video (qua API của provider)
- [ ] Đọc "canvas" (bảng vẽ/tài liệu tương tác trong app)
- [ ] Ghi "canvas"

#### Quản lý dự án / kế hoạch / task (16 kiểu)

- [ ] Lập kế hoạch (plan)
- [ ] Tạo tracked task
- [ ] Cập nhật tracked task
- [ ] Xoá tracked task
- [ ] Liệt kê tracked task
- [ ] Cập nhật trạng thái tracked task
- [ ] Cập nhật tag của tracked task
- [ ] Tạo goal/mục tiêu
- [ ] Cập nhật goal/mục tiêu
- [ ] Đọc danh sách việc cần làm (todos)
- [ ] Cập nhật danh sách việc cần làm (todos)
- [ ] Tạo project
- [ ] Bật cập nhật định kỳ về project
- [ ] Tắt cập nhật định kỳ về project
- [ ] Lập kế hoạch cho chế độ làm việc dài hơi ("grind")
- [ ] Thực thi chế độ làm việc dài hơi ("grind")

#### Agent-to-agent & điều phối (15 kiểu)

- [ ] Giao việc cho agent con (subagent)
- [ ] Tạo agent mới
- [ ] Gửi message cho agent khác
- [ ] Kiểm tra trạng thái agent
- [ ] Dừng agent
- [ ] Nhắn tin (gửi message chung)
- [ ] Gửi message cho người dùng
- [ ] Gửi tóm tắt cuối khi xong việc
- [ ] Gửi cập nhật tiến độ
- [ ] Hỏi người dùng (đặt câu hỏi, chờ trả lời rồi tiếp tục)
- [ ] Đổi chế độ làm việc của agent
- [ ] Tự phản tư (reflect) trước khi hành động tiếp
- [ ] Chờ (await) một điều kiện/sự kiện
- [ ] Tìm trong các hội thoại khác
- [ ] Đọc transcript của agent khác

#### MCP & tích hợp ngoài (12 kiểu)

- [ ] Gọi tool của MCP server
- [ ] Lấy danh sách tool của MCP server
- [ ] Liệt kê resource của MCP server
- [ ] Đọc resource của MCP server
- [ ] Xác thực MCP (OAuth cho MCP server)
- [ ] Thực thi tool MCP của hệ thống (sand MCP tool)
- [ ] Kết nối hệ quản lý source (git host)
- [ ] Quản lý pull request
- [ ] Xem code tour của pull request
- [ ] Cập nhật code tour của pull request
- [ ] Sửa label của pull request
- [ ] Đặt branch đang làm việc (active branch)

#### Khác (6 kiểu)

- [ ] Quản lý quyền truy cập agent
- [ ] Ghi lại kết quả điều tra lỗi CI
- [ ] Báo bug
- [ ] Báo cáo kết quả sửa bug
- [ ] Ghi nhận nguồn/attribution của AI
- [ ] Đánh dấu tool call bị cắt ngắn khi output quá dài (cơ chế giới hạn độ dài)

### 2c. Tính năng ngoài bộ tool

- [ ] Tạo agent mới (đặt tên, mô tả, hướng dẫn, tool được phép dùng)
- [ ] Nhân bản (clone) agent có sẵn
- [ ] Publish agent để người khác dùng
- [ ] Template agent (mẫu dựng sẵn theo việc: code, viết lách, nghiên cứu…)
- [ ] Marketplace agent local (duyệt, cài, gỡ agent/template)
- [ ] Chia sẻ agent theo team, kèm phân quyền (mời, cấp quyền truy cập)
- [ ] Chạy agent bằng tài khoản dịch vụ (service account)
- [ ] Phiên chạy trong hộp cát phía server ("session box") — khi có chế độ cloud/từ xa
- [ ] Tích hợp Slack (nhận/gửi tin, gắn workspace)
- [ ] Tích hợp email (đọc inbox/thread, gửi/nhận)
- [ ] Tích hợp Microsoft Teams
- [ ] Tích hợp iMessage (soạn/gửi nháp)
- [ ] Tham gia meeting, lấy transcript và tóm tắt cuộc họp
- [ ] Skills (bộ kỹ năng nạp thêm cho agent theo từng lĩnh vực)
- [ ] Plugins (mở rộng tính năng bằng plugin)
- [ ] Connectors (tích hợp dịch vụ bên thứ ba qua OAuth)
- [ ] Vault secret: kho secret tách riêng, mã hoá bằng khoá của hệ điều hành
- [ ] Voice call realtime (qua API realtime của provider)
- [ ] Voice memo (ghi âm ngắn để giao việc bằng giọng nói)
- [ ] Bộ nhớ dài hạn: memories, tóm tắt ngữ cảnh theo team, transcript lưu trữ
- [ ] Automations (tự động hoá theo điều kiện/sự kiện)
- [ ] Routines (chuỗi việc lặp lại theo kịch bản) — _v0.1: đã có routines cơ bản_
- [ ] Scheduled tasks (task chạy theo lịch, kiểu cron)
- [ ] "Dream": tác vụ nền chạy khi rảnh (tự rà soát, chuẩn bị, đề xuất việc)
- [ ] Giới hạn chi tiêu (spend limit) cho API key
- [ ] Hiển thị mức sử dụng/quota (usage banner)

### 2d. Xác thực, bảo mật & cấu hình model

- [ ] Đăng nhập đa tầng: tài khoản chính + định danh provider (ví dụ tài khoản xAI) tách riêng
- [ ] Token gồm access token kèm định danh máy (machineId) và định danh team (teamId, nếu có)
- [ ] Mọi request gắn header `Authorization: Bearer` + header team; kiểm tra tính nhất quán token ↔ team trước khi dùng
- [ ] Token mã hoá bằng kho lưu trữ an toàn của hệ điều hành (safeStorage/DPAPI/keychain), lưu dạng mã hoá, không lưu plaintext
- [ ] Không bao giờ log token (lọc chuỗi `Bearer …` thành `<redacted>` trong log)
- [ ] Tách 3 loại credential: token phiên, OAuth refresh token, API key — không trộn lẫn
- [ ] Chế độ riêng tư không lưu trữ (NO_STORAGE): bật thì token không được lưu bền
- [ ] Đăng nhập OAuth qua trình duyệt/callback (custom protocol + callback localhost)
- [ ] MCP là cổng mở rộng chính: chuẩn hoá tool/resource/auth/callback của MCP thay vì tích hợp cứng từng dịch vụ
- [ ] Model registry: server (hoặc file cấu hình từ xa) trả về danh sách model khả dụng + model mặc định + model dự phòng theo từng tính năng
- [ ] Client không hard-code tên model; chỉ lưu lựa chọn của người dùng
- [ ] Feature flag (bật/tắt tính năng, thử nghiệm model) mà không cần phát hành bản mới
- [ ] Cơ chế tự cập nhật (kiểm tra/tải bản mới theo kênh stable)

### 2e. Mở rộng theo hướng Huy muốn

- [ ] Thêm provider khác qua chuẩn OpenAI-compatible (đã có khung `openaiCompatible` ở v0.1; chỉ cần thêm preset từng nhà cung cấp)
- [ ] Model local chạy hoàn toàn trên máy (Ollama đã có ở v0.1; mở rộng thêm model local khác)
- [ ] Giao diện tiếng Việt đầy đủ (mọi màn hình, thông báo, lỗi)
- [ ] Tích hợp phục vụ làm nội dung Facebook: soạn bài, lên lịch đăng, theo dõi hiệu quả
- [ ] Tích hợp phục vụ làm nội dung Instagram: soạn caption/reel, lên lịch đăng
- [ ] Agent chuyên làm nội dung (template agent viết bài, làm video ngắn, làm phụ đề)

---

## 3. Lộ trình theo mốc

### v0.1 — Agent shell chạy được (đang làm)

- Agent loop + 6 provider (Grok, OpenAI, Anthropic, Gemini, Ollama,
  OpenAI-compatible) + 10 tool (đọc/ghi/liệt kê file, shell, tìm web,
  fetch web, http, git status/diff/commit) + sandbox.
- UI: chat, danh sách bot, quản lý task, phê duyệt, cài đặt.
- Memory SQLite, routines cơ bản.
- Đẩy lên GitHub, build chạy được trên máy.

### v0.2 — Mở rộng mặt tool

- Mở rộng bộ tool theo checklist 2b, ưu tiên theo thứ tự:
  1. File/code search: glob, grep, semantic search, diff, blame, lint.
  2. Plan/task/todo: plan, tracked task (CRUD + trạng thái/tag), goal,
     todos, project, chế độ làm việc dài hơi.
  3. Agent-to-agent/subagent: giao việc cho agent con, gửi message giữa
     các agent, hỏi người dùng, tóm tắt cuối.
  4. MCP client: gọi tool/resource của MCP server, xác thực MCP.
- Mỗi nhóm tool xong đều có kiểm thử và được phê duyệt như tool hiện có.

### v0.3 — Mô hình tiến trình & hệ sinh thái agent

- Tách local-exec-daemon và node-agent-coordinator ra khỏi main process
  (theo checklist 2a).
- Tạo/nhân bản/publish agent, template agent, marketplace local.
- Chia sẻ agent theo team (bản local trước: nhiều người dùng chung qua
  cấu hình, chưa cần server trung tâm).

### v0.4 — Vault, skills, tự động hoá & voice

- Vault secret mã hoá bằng khoá hệ điều hành; credential connector/MCP
  lưu riêng trong vault, không trộn vào cấu hình app hay lịch sử chat.
- Skills/plugins/connectors (mở rộng qua MCP là chính).
- Automations/routines nâng cao, scheduled task, "dream" chạy nền.
- Giới hạn chi tiêu (spend limit) và hiển thị mức sử dụng.
- Voice realtime qua API realtime của provider; voice memo.

### v0.5 — Model registry, mở rộng provider & nội dung

- Model registry: default + fallback + per-feature, bỏ hard-code tên
  model trong client; feature flag.
- Mở rộng provider (thêm preset OpenAI-compatible), cải thiện model local.
- Tích hợp nội dung Facebook/Instagram (soạn bài, lên lịch, template
  agent làm nội dung).
- Chia sẻ theo team hoàn chỉnh hơn (phân quyền, service account).

> Không hứa ngày hoàn thành cụ thể cho các mốc v0.2–v0.5. Mỗi mốc chỉ được
> coi là xong khi build chạy được, kiểm thử qua và đã đẩy lên GitHub.

---

## 4. Giới hạn thật — những thứ KHÔNG thể làm lại local được

Trung thực về giới hạn giúp tránh làm sai hướng. Những thứ dưới đây thuộc
về phía server/hạ tầng của xAI/Cursor, không có trong bản cài desktop và
không thể tái tạo bằng code local:

| Không làm lại được | Vì sao | Cách thay thế thực tế |
|---|---|---|
| Dữ liệu X thời gian thực (firehose của X) | Luồng dữ liệu nội bộ của X, chỉ server của họ mới có | Dùng API công khai của X (search/timeline) qua key của người dùng; tìm kiếm web làm nguồn phụ |
| Hạ tầng cloud của Cursor (chạy agent trên server, session box, đồng bộ) | Máy chủ, hàng đợi, lưu trữ phía server không có trong installer | Chạy agent local trên máy người dùng; chia sẻ file/cấu hình qua Git hoặc thư mục đồng bộ thay cho cloud |
| Định tuyến model phía server (chọn model theo tính năng, thử nghiệm A/B, model mới như Grok 4.7 chưa có trong client cũ) | Quyết định nằm ở server, client chỉ nhận cấu hình | Gọi thẳng API của provider bằng key của người dùng và tự chọn model trong Settings; model registry local thay cho cấu hình server |
| Quota/giá/kiểm duyệt phía server | Chính sách và số liệu nằm ở backend của họ | Dùng quota và bảng giá công khai của provider; giới hạn chi tiêu (spend limit) tự đặt trong app |
| Tích hợp Slack/Teams/email ở độ sâu của app gốc | Cần app đăng ký chính thức, OAuth app-level và server trung gian | Tích hợp qua MCP server hoặc API công khai của từng dịch vụ, bằng tài khoản/key của người dùng |
| Voice realtime qua hạ tầng riêng của xAI | Endpoint realtime nội bộ, cần hạ tầng gọi thoại của họ | Dùng API realtime công khai của provider (OpenAI/Grok realtime API) bằng key của người dùng |

---

## 5. Bảng trạng thái mốc

| Mốc | Nội dung chính | Trạng thái |
|---|---|---|
| v0.1 | Agent shell + 6 provider + 10 tool + sandbox + UI + phê duyệt + memory SQLite + routines cơ bản + đẩy GitHub | **Đang làm** |
| v0.2 | Mở rộng tool: file/code search, plan/task/todo, agent-to-agent/subagent, MCP client | Chưa bắt đầu |
| v0.3 | Mô hình tiến trình (daemon, coordinator), tạo/nhân bản/publish agent, template, marketplace local | Chưa bắt đầu |
| v0.4 | Vault secret, skills/plugins/connectors, automations + "dream", giới hạn usage, voice realtime | Chưa bắt đầu |
| v0.5 | Model registry, mở rộng provider, tích hợp nội dung Facebook/Instagram, chia sẻ theo team | Chưa bắt đầu |

---

## Tài liệu liên quan

- [GROK-BOT-ANALYSIS.md](GROK-BOT-ANALYSIS.md) — phân tích tĩnh Grok Bot 0.79.3 (nguồn của checklist)
- [ARCHITECTURE.md](ARCHITECTURE.md) — kiến trúc hiện tại của open-bot
- [SETUP.md](SETUP.md) — hướng dẫn cài đặt & chạy
