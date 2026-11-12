# ROADMAP — open-bot

> Tài liệu này mô tả hướng phát triển của open-bot. Mọi nội dung được viết
> mới hoàn toàn, tóm tắt kiến trúc bằng lời của nhóm phát triển; không sao
> chép code, text hay tài sản của xAI/Cursor. Checklist "đầy đủ" dưới đây
> được suy ra từ bản phân tích tĩnh Grok Bot 0.79.3, xem
> [GROK-BOT-ANALYSIS.md](GROK-BOT-ANALYSIS.md).
>
> **Định vị:** open-bot là agent chuẩn chung như Grok Bot, phục vụ nhiều
> người dùng với đủ loại công việc — code, nghiên cứu, viết lách, tự động
> hoá — chứ không phải tool ngách cho riêng một loại việc.

## Tầm nhìn "KHỔNG LỒ" — platform lớn hơn Grok Bot

76 tool của Grok Bot chỉ là **sàn, không phải trần**. Đích dài hạn của
open-bot là một **platform** lớn hơn Grok Bot, chứ không dừng ở một app
desktop đơn lẻ:

- **Tool vượt 76, không giới hạn số lượng:** hệ tool mở rộng được qua
  tool registry + plugin/MCP marketplace — cộng đồng và team tự thêm tool
  mới mà không cần sửa code lõi (xem mục 2f).
- **Platform, không chỉ app:** kiến trúc platform — đa người dùng/team,
  API cho bên thứ ba, marketplace plugin/template — để sản phẩm lớn lên
  thành nền tảng.
- **Đa ngôn ngữ đầy đủ:** i18n toàn bộ giao diện ngay từ đầu (bắt đầu
  tiếng Việt + tiếng Anh, thêm ngôn ngữ mới chỉ cần thêm file locale);
  agent làm việc được mọi ngôn ngữ qua model của provider.
- **Siêu mạnh mẽ:** kiến trúc hiệu năng cao, chạy local mượt — job queue,
  worker pool, cache kết quả tool — không ì ạch khi nhiều bot chạy song song.

> **Nguyên tắc:** tầm nhìn khổng lồ là **đích dài hạn, không chặn mốc 1**.
> Mốc 1 (v0.1: agent shell chạy được + đẩy GitHub) vẫn đi trước như cũ.
> Điều tầm nhìn này thay đổi là **thiết kế kiến trúc ngay từ đầu để chứa
> được nó**: tool registry mở, i18n, plugin system — để sau này mở rộng
> mà không phải đập đi làm lại.

## 1. Hướng đi: "não" và "thân"

- **Não = model của provider.** Cắm key Grok thì não là Grok 4.7, cắm key
  OpenAI thì não là GPT, cắm Ollama thì não là model local. open-bot không
  sở hữu model, không huấn luyện model, không làm trung gian bán credit.
- **Thân = open-bot.** Cái thân là toàn bộ phần còn lại: vòng lặp agent,
  bộ tool, sandbox, bộ nhớ, giao diện, tự động hoá, tích hợp. Cái thân càng
  tốt thì cùng một bộ não càng làm được nhiều việc.
- **Mục tiêu: làm cái thân đến đỉnh.** Đạt đầy đủ tính năng của Grok Bot
  (theo checklist ở mục 2), rồi mở rộng thêm theo hướng Huy muốn (mục 2e)
  và theo tầm nhìn platform khổng lồ (mục 2f).

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

Mỗi mục là một checkbox. Checklist gồm 140 mục: 76 kiểu tool call ở mục 2b
và 64 mục tính năng, bảo mật và mở rộng ở các mục 2a, 2c–2f. Mục nào đã có
ở v0.1 được ghi chú rõ; còn lại là việc cần làm ở các mốc sau.

### 2a. Mô hình tiến trình

- [x] Main process khởi động 2 giai đoạn: core nhẹ chạy trước, phần app nặng nạp sau khi core báo sẵn sàng — v0.7: `bootstrap()` chia giai đoạn 1 (Vault + settings + machineId + policy + profile + migration credential) rồi splash tối giản, giai đoạn 2 (registry, automations/dream, Local API, IPC, cửa sổ chính); đo thật dưới xvfb: tổng ~96–172ms (2026-11-08)
- [x] Renderer là ứng dụng React, giao tiếp với main qua IPC kênh hẹp có kiểm chứng — v0.7: `packages/core/src/ipc/validate.ts` (requireString/requireId/requireText/requireInt/requireBoolean/requireHttpUrl/requireBase64/resolveWithin/validateWorkspaceDir), gắn vào gần như mọi handler trong main.ts; preload chỉ expose `window.openBot`, không có ipcRenderer thô (2026-11-08)
- [x] Daemon thực thi local tách riêng khỏi main: chạy lệnh dài không treo giao diện, daemon crash không kéo sập app — v0.3 wave 2: `local-exec-daemon` (tiến trình cháu của Electron, NDJSON-RPC, spawn trực tiếp không qua shell, kill/timeout/list/ping/shutdown), `shell_exec` chạy qua daemon (sandbox check vẫn ở tool, env chỉ allowlist, kill cả process group); coordinator sở hữu 1 daemon, lazy + tự tạo lại khi chết; đã nối + xác minh Ollama shell e2e (2026-11-08)
- [x] Coordinator riêng điều phối các agent con (chạy song song, theo dõi trạng thái, dừng khi cần) — v0.3 wave 2: `node-agent-coordinator` (tiến trình con, NDJSON-RPC qua stdio, sở hữu BotMemory), main thành proxy mỏng; round-trip approval/ask-user, saveMessage/getHistory/listTasks, plugin tools nạp trong con; đã nối main + xác minh Ollama e2e qua coordinator (2026-11-08)
- [x] Cơ chế cache bytecode (V8 code-cache) để lần mở sau khởi động nhanh hơn — v0.7: cờ Chromium `v8-cache-options=code` + escape hatch `OPEN_BOT_NO_CODE_CACHE=1`; đo thật dưới xvfb: cold 573ms → warm 367ms (có cờ) vs 365ms (không cờ) — cờ không tạo khác biệt đo được trên máy này (bundle renderer 347KB), giữ làm mặc định vô hại (2026-11-08)
- [x] Hỗ trợ ghim backend/website qua policy của máy (môi trường doanh nghiệp tự host backend riêng) — v0.7: `packages/core/src/auth/policy.ts` đọc `<userData>/policy.json` (`backendBaseUrl`, `allowedProviders`, `disableTelemetry`); file sai → bỏ qua + log, không crash; baseUrl người dùng gõ tay luôn thắng policy; ollama local không bị ghim (2026-11-08)

### 2b. Đủ 76 kiểu tool call

#### File & code (12 kiểu)

- [x] Đọc nội dung file — _v0.1: đã có dạng `read_file`_
- [x] Sửa file theo diff/chỉ định — _v0.1: đã có dạng `write_file`_
- [x] Xoá file
- [x] Tìm file theo pattern (glob)
- [x] Tìm kiếm nội dung trong code (grep)
- [x] Tìm kiếm ngữ nghĩa trong codebase (semantic search) — _v0.2: xếp hạng từ khoá TF-IDF, chưa phải embedding thật_
- [x] Liệt kê thư mục — _v0.1: đã có dạng `list_files`_
- [x] Áp dụng bản diff do agent tạo
- [x] Xem lịch sử/blame theo file
- [x] Đọc lỗi lint/chẩn đoán của code
- [x] Đọc lại lịch sử hội thoại
- [x] Lấy dữ liệu của agent chạy trên cloud (khi có chế độ cloud) — v0.7 BẢN TƯƠNG ĐƯƠNG LOCAL: `agent_export`/`agent_import` (bundle BotMemory + canvases, checksum SHA-256, không lấy gì từ server vì không có cloud); đã nối registry + test round-trip qua coordinator con (2026-11-08)

#### Shell / thực thi trên máy (5 kiểu)

- [x] Chạy lệnh shell — _v0.1: đã có dạng `shell_exec`; v0.6: đã xác minh chạy thật qua daemon + fallback, denylist + timeout 60s_
- [x] Thực thi lệnh/tác vụ (dạng tổng quát, có theo dõi tiến trình) — v0.6: `exec_task`/`exec_task_status`/`exec_task_stop` qua daemon, cap 8 exec song song, output stream cap 200k ký tự_
- [x] Ghi vào stdin của shell đang chạy — v0.6: `shell_session_start`/`write`/`read`/`close` (shell tương tác bền, tối đa 8 session, idle timeout 10 phút; không có PTY nên app cần TTY như vim không chạy tương tác được)_
- [x] Chuẩn bị môi trường máy ảo/sandbox cho agent — v0.6: `sandbox_prepare` tạo workspace tách biệt từ template + env allowlist + metadata giới hạn (ghi chú trung thực: chỉ là thư mục tách biệt, KHÔNG phải VM/container, giới hạn CPU/RAM chỉ là metadata chưa enforce bằng cgroup)_
- [x] Tool local trên máy người dùng (nhóm computer-local) — v0.6: `system_info`, `list_processes`, `kill_process` (chỉ pid do daemon chạy), `open_path`_

#### Computer-use — điều khiển máy như người dùng (2 kiểu)

- [x] Điều khiển máy tính (chuột, bàn phím, màn hình) — v0.6: `computer_mouse_move`/`computer_click`/`computer_key`/`computer_type` qua xdotool, `computer_screenshot` qua ImageMagick (v0.86: thêm tham số `window` — chụp 1 cửa sổ theo tiêu đề/id, fail-closed khi không/trùng nhiều cửa sổ); Linux + X11 only, chưa Wayland/macOS/Windows_
- [x] Ghi/quay màn hình (kèm xem trước màn hình trong giao diện) — v0.6: `computer_record_start`/`computer_record_stop` qua ffmpeg x11grab (tối đa 10 phút / 200 MB), preview thumbnail trong ChatView_

#### Web (4 kiểu)

- [x] Tìm kiếm web — _v0.1: đã có dạng `web_search`; v0.6: đã xác minh chạy thật (Bing fallback) + sửa `unwrapBingRedirect` cho dạng redirect mới `u=a1<base64>` của Bing_
- [x] Tìm kiếm trên X — v0.6: `x_search` (X API + fallback có ghi nhãn) — xem mục v0.6 dưới; `packages/tools/src/webMedia.ts` (X API khi có bearer token, fallback web search có ghi nhãn khi không có)_
- [x] Tải/đọc nội dung URL — _v0.1: đã có dạng `web_fetch`; v0.6: đã xác minh chạy thật_
- [x] Fetch tài nguyên web chung — _v0.1: đã có dạng `http_get`; v0.6: đã xác minh chạy thật_

#### Tạo sinh media & canvas (4 kiểu)

- [x] Sinh ảnh (qua API của provider) — v0.6: `image_generate` (OpenAI `gpt-image-1`, xAI `grok-2-image`, lưu vào workspace); v0.87d thêm Gemini Nano Banana qua `generateContent` (mặc định `gemini-nano-banana-2.1`) + mọi provider OpenAI-compatible có `imageModel` đều dùng được `/images/generations`; chưa test live với key thật_
- [x] Sinh video (qua API của provider) — v0.6: `video_generate` (gọi API khi provider khai videoEndpoint — hiện chưa provider nào có API video công khai) + `video_from_images` (ffmpeg slideshow thật)_
- [x] Đọc "canvas" (bảng vẽ/tài liệu tương tác trong app) — v0.6: CanvasStore (lưu bền theo bot, có phiên bản) + `canvas_read`/`canvas_list`_
- [x] Ghi "canvas" — v0.6: `canvas_write` (tạo/ghi đè, optimistic concurrency qua expectedVersion)_

#### Quản lý dự án / kế hoạch / task (16 kiểu)

- [x] Lập kế hoạch (plan)
- [x] Tạo tracked task
- [x] Cập nhật tracked task
- [x] Xoá tracked task
- [x] Liệt kê tracked task
- [x] Cập nhật trạng thái tracked task
- [x] Cập nhật tag của tracked task
- [x] Tạo goal/mục tiêu
- [x] Cập nhật goal/mục tiêu
- [x] Đọc danh sách việc cần làm (todos)
- [x] Cập nhật danh sách việc cần làm (todos)
- [x] Tạo project
- [x] Bật cập nhật định kỳ về project — _v0.2: mới lưu cờ updatesEnabled, chưa có kênh gửi thật_
- [x] Tắt cập nhật định kỳ về project — _v0.2: mới lưu cờ updatesEnabled, chưa có kênh gửi thật_
- [x] Lập kế hoạch cho chế độ làm việc dài hơi ("grind")
- [x] Thực thi chế độ làm việc dài hơi ("grind") — v0.6: `grind_start`/`grind_status`/`grind_stop` + GrindSession (plan → lát cắt → checkpoint bền trong BotMemory, resume được); các lát chạy khi model/host gọi advance_

#### Agent-to-agent & điều phối (15 kiểu)

- [x] Giao việc cho agent con (subagent)
- [x] Tạo agent mới — v0.6: tool `create_agent` (tạo bot in-process trong coordinator, kế thừa provider của bot gọi; event `agent.created` để main lưu bền vào settings.json + UI tải lại danh sách)_
- [x] Gửi message cho agent khác — v0.6: tool `message_agent` (qua coordinator run; bot bận thì trả queued)_
- [x] Kiểm tra trạng thái agent
- [x] Dừng agent
- [x] Nhắn tin (gửi message chung)
- [x] Gửi message cho người dùng
- [x] Gửi tóm tắt cuối khi xong việc
- [x] Gửi cập nhật tiến độ
- [x] Hỏi người dùng (đặt câu hỏi, chờ trả lời rồi tiếp tục)
- [x] Đổi chế độ làm việc của agent — v0.6: tool `set_agent_mode` (chat/plan/grind/review, lưu trong BotMemory; run() chèn gợi ý chế độ vào system prompt)_
- [x] Tự phản tư (reflect) trước khi hành động tiếp — v0.6: tool `reflect` (reflectOnProgress + lưu note trong memory; loop không tự gọi)_
- [x] Chờ (await) một điều kiện/sự kiện
- [x] Tìm trong các hội thoại khác — v0.6: tool `search_conversations` (tìm theo từ khoá qua toàn bộ lịch sử các bot của user)_
- [x] Đọc transcript của agent khác — v0.6: tool `read_agent_transcript` (chính sách mặc định: cùng user được đọc, khác team từ chối; chưa có xác thực thật)_

#### MCP & tích hợp ngoài (12 kiểu)

- [x] Gọi tool của MCP server
- [x] Lấy danh sách tool của MCP server
- [x] Liệt kê resource của MCP server
- [x] Đọc resource của MCP server
- [x] Xác thực MCP (OAuth cho MCP server) — v0.7: `packages/core/src/mcp/oauth.ts` (OAuth2 + PKCE, callback localhost, refresh, store qua host) + tool `mcp_auth`/`mcp_auth_status`; vòng đầy đủ đã xác minh end-to-end qua coordinator con với mock OAuth server (event `mcp.open-url` mở trình duyệt + `mcp.oauth-token` về Vault) (2026-11-08)
- [x] Thực thi tool MCP của hệ thống (sand MCP tool) — v0.7: tool `mcp_system_exec` (allowlist, mặc định rỗng = không tool nào được chạy; `allowedSystemTools` đọc từ `<userData>/mcp-oauth.json`); coordinator gọi tool của MCP server tên `system` trong `.open-bot/mcp.json` qua MCP client thật (2026-11-08)
- [x] Kết nối hệ quản lý source (git host) — v0.7: `GitHubClient` (`packages/core/src/git/host.ts`) + tool `git_host_connect`; token GitHub đọc từ Vault namespace `github` (2026-11-08)
- [x] Quản lý pull request — v0.7: tool `pr_list`/`pr_create`/`pr_update` qua GitHub API (2026-11-08)
- [x] Xem code tour của pull request — v0.7: tool `pr_code_tour_view` (2026-11-08)
- [x] Cập nhật code tour của pull request — v0.7: tool `pr_code_tour_update` (2026-11-08)
- [x] Sửa label của pull request — v0.7: tool `pr_label_set` (2026-11-08)
- [x] Đặt branch đang làm việc (active branch) — v0.7: tool `set_active_branch` (checkout branch có sẵn trong repo của workspace; test checkout thật trên repo tạm) (2026-11-08)

#### Khác (6 kiểu)

- [x] Quản lý quyền truy cập agent — v0.6: AgentPermissions (allowlist/denylist tool theo bot, chính sách allow/ask/deny), nối vào AgentRunner.executeCall trước bước phê duyệt_
- [x] Ghi lại kết quả điều tra lỗi CI — v0.7: tool `ci_investigate` (đọc log file/URL, đoán nguyên nhân OOM/timeout/missing module, ghi record) (2026-11-08)
- [x] Báo bug — v0.7: tool `bug_report` (ghi file bug có cấu trúc) (2026-11-08)
- [x] Báo cáo kết quả sửa bug — v0.7: tool `bug_fix_report` (đánh dấu bug đã sửa) (2026-11-08)
- [x] Ghi nhận nguồn/attribution của AI — v0.7: tool `ai_attribution` (ghi entry, từ chối khi không có model — không bịa nguồn) (2026-11-08)
- [x] Đánh dấu tool call bị cắt ngắn khi output quá dài (cơ chế giới hạn độ dài)

### 2c. Tính năng ngoài bộ tool

- [x] Tạo agent mới (đặt tên, mô tả, hướng dẫn, tool được phép dùng)
- [x] Nhân bản (clone) agent có sẵn — v0.3 wave 1: `cloneAgent`, IPC `agents:clone`, UI nút nhân bản (2026-11-08)
- [x] Publish agent để người khác dùng — v0.3 wave 1: publish local vào `<userData>/marketplace/agents.json`, `sanitizeConfig` không rò key (2026-11-08)
- [x] Template agent (mẫu dựng sẵn theo việc: code, viết lách, nghiên cứu…) — v0.3 wave 1: 6 template (Code, Research, Writing, Data, Automation, General) (2026-11-08)
- [x] Marketplace agent local (duyệt, cài, gỡ agent/template) — v0.3 wave 1: `AgentMarketplaceView`, IPC `marketplace:*` (2026-11-08)
- [x] Chia sẻ agent theo team, kèm phân quyền (mời, cấp quyền truy cập) — v0.3 wave 1, BẢN LOCAL: `team.json`, role admin/member/viewer, `canUseBot`/`canEditBot`, IPC `team:*`, main chặn sửa/xoá bot khi không có quyền; UI quản lý team (`TeamView`: thêm/xoá/đổi role, share/unshare bot) xong 2026-11-08; chưa có server trung tâm/xác thực thật (2026-11-08)
- [x] Chạy agent bằng tài khoản dịch vụ (service account) — v0.5: `team.json` + token sinh ở main (32 byte base64url), lưu Vault namespace `service-account`, trả về DUY NHẤT 1 lần lúc tạo; UI TeamView tạo/xoá/copy token; scope `run`/`admin` mới chỉ là ghi chú trong record, chưa enforce ở API (2026-11-08)
- [x] Phiên chạy trong hộp cát phía server ("session box") — khi có chế độ cloud/từ xa — v0.7 BẢN TƯƠNG ĐƯƠNG LOCAL: `packages/core/src/session/box.ts` (workspace riêng + snapshot sha256) + 5 tool `session_box_*`; đã nối registry + test round-trip qua coordinator con (2026-11-08)
- [x] Tích hợp Slack (nhận/gửi tin, gắn workspace) — v0.7: `packages/core/src/connectors/slack.ts` + tool `slack_send`/`slack_list_channels`/`slack_read`; token đọc từ Vault namespace `connector` (2026-11-08)
- [x] Tích hợp email (đọc inbox/thread, gửi/nhận) — v0.7: `packages/core/src/connectors/email.ts` (Gmail API, không IMAP) + tool `email_read`/`email_send`; token từ Vault namespace `connector` (2026-11-08)
- [x] Tích hợp Microsoft Teams — v0.7: `packages/core/src/connectors/teams.ts` (Graph API) + tool `teams_send`/`teams_list_teams`; token từ Vault namespace `connector` (2026-11-08)
- [x] Tích hợp iMessage (soạn/gửi nháp) — v0.7: `packages/core/src/connectors/imessage.ts` + tool `imessage_draft`; CHỈ soạn nháp, không bao giờ gửi (Linux ghi file nháp) (2026-11-08)
- [x] Tham gia meeting, lấy transcript và tóm tắt cuộc họp — v0.7: `packages/core/src/connectors/meeting.ts` (parse transcript txt/vtt/srt/json + tóm tắt rule-based, không gọi model) + tool `meeting_transcript`/`meeting_summarize`; chưa tự tham gia meeting thật (2026-11-08)
- [x] Skills (bộ kỹ năng nạp thêm cho agent theo từng lĩnh vực) — v0.4: SkillRegistry (markdown + frontmatter, 3 skill built-in: code-review, research-brief, writing-vi), match theo nhiệm vụ, chèn vào system prompt theo lượt chạy; UI SkillsView bật/tắt/tải lại (2026-11-08)
- [x] Plugins (mở rộng tính năng bằng plugin) — v0.3 wave 1: `PluginManager` + loader (manifest, quyền khai báo fs/shell/network/mcp, quét source tĩnh fail-closed, truncate output 20.000 ký tự, enable/disable qua `enabled.json`), nối vào ToolRegistry lúc tạo runtime; plugin chạy IN-PROCESS, chưa sandbox process riêng (wave 2) (2026-11-08)
- [x] Connectors (tích hợp dịch vụ bên thứ ba qua OAuth) — v0.7: `packages/core/src/connectors/framework.ts` (ConnectorRegistry + vaultTokenStore) — OAuth delegate sang `mcp/oauth.ts` (bộ triển khai chuẩn duy nhất; hoà giải trùng lặp 2026-11-08); Slack/Gmail/Teams đã nối tool (2026-11-08)
- [x] Vault secret: kho secret tách riêng, mã hoá bằng khoá của hệ điều hành — v0.4: Vault (safeStorage chính, fallback LocalEncryptor AES-256-GCM khi OS không có keychain), migration API key từ settings.json, IPC vault:* + UI Vault trong Settings (2026-11-08)
- [x] Voice call realtime (qua API realtime của provider) — v0.4: RealtimeClient (chuẩn mở dạng OpenAI Realtime API, WebSocket, reconnect 3 lần), UI nút gọi thoại + transcript trực tiếp; chưa test live với key thật (2026-11-08)
- [x] Voice memo (ghi âm ngắn để giao việc bằng giọng nói) — v0.4: MediaRecorder webm/opus → STT qua /v1/audio/transcriptions, text chèn vào ô nhập; Ollama không có STT thì báo lỗi rõ (2026-11-08)
- [x] Bộ nhớ dài hạn: memories, tóm tắt ngữ cảnh theo team, transcript lưu trữ — v0.7: `packages/core/src/memory/longterm.ts` (LongTermMemory, file JSON `.open-bot/memories.json` mode 0600) + tool `memory_remember`/`memory_recall`/`memory_forget`, `team_context_summary`, `transcript_archive` (2026-11-08)
- [x] Automations (tự động hoá theo điều kiện/sự kiện) — v0.4: AutomationScheduler (trigger interval/cron/event/manual, cooldown, chính sách chạy lỡ skip không chạy bù), chạy qua coordinator RPC runTool/createTask + run silent; UI AutomationsView tạo/quản lý/chạy ngay/xem lịch sử (2026-11-08)
- [x] Routines (chuỗi việc lặp lại theo kịch bản) — _v0.1: đã có routines cơ bản_
- [x] Scheduled tasks (task chạy theo lịch, kiểu cron) — v0.4: scheduler tick 60s, cron tối giản 5 trường tự viết, lưu bền automations.json (2026-11-08)
- [x] "Dream": tác vụ nền chạy khi rảnh (tự rà soát, chuẩn bị, đề xuất việc) — v0.4: DreamEngine (idle 15 phút mặc định, không ngắt chat, kết quả lưu thành task + notify), bật/tắt trong Settings (2026-11-08)
- [x] Giới hạn chi tiêu (spend limit) cho API key — v0.4: UsageTracker + MeteredProvider (limit ngày/tháng/tổng + per-bot, bảng giá built-in, chặn bằng SpendLimitError), form đặt limit trong Settings (2026-11-08)
- [x] Hiển thị mức sử dụng/quota (usage banner) — v0.4: usage banner trong Settings (chi hôm nay/tháng, % giới hạn ngày, cảnh báo model chưa có giá) (2026-11-08)

### 2d. Xác thực, bảo mật & cấu hình model

- [x] Đăng nhập đa tầng: tài khoản chính + định danh provider (ví dụ tài khoản xAI) tách riêng — v0.7: `packages/core/src/auth/identity.ts` (profile local `profile.json` mode 0600, userId ổn định; identity provider trong Vault `identity:<provider>`, chỉ id/displayName/email, không token); IPC `auth:*` + mục "Tài khoản & đăng nhập" trong Settings (2026-11-08)
- [x] Token gồm access token kèm định danh máy (machineId) và định danh team (teamId, nếu có) — v0.5: `machine-id` (mode 0600, không log/không expose) + `teamId` ổn định (tự sinh cho file cũ); token API/service account lưu Vault; chưa gắn header team/kiểm tra token ↔ team ở request vì API mới chỉ loopback + 1 token (2026-11-08)
- [x] Mọi request gắn header `Authorization: Bearer` + header team; kiểm tra tính nhất quán token ↔ team trước khi dùng — v0.7: Local API yêu cầu `Authorization: Bearer` (so sánh timing-safe) VÀ `X-Open-Bot-Team` khớp teamId đã bind (thiếu/sai → 403, không rò chi tiết); không bind team → header không bắt buộc (tương thích ngược) (2026-11-08)
- [x] Token mã hoá bằng kho lưu trữ an toàn của hệ điều hành (safeStorage/DPAPI/keychain), lưu dạng mã hoá, không lưu plaintext — v0.4 Vault (safeStorage chính, fallback LocalEncryptor); v0.5: token API local + token service account cũng lưu Vault, không plaintext (2026-11-08)
- [x] Không bao giờ log token (lọc chuỗi `Bearer …` thành `<redacted>` trong log) — v0.5: `redactBearer`/`redactSecrets` (core `util/`), áp ở `chat:send` + `settings:test` (lỗi provider có thể chứa `?key=…`); audit console.* v0.5: 5 dòng main + 0 dòng core, đều an toàn; R3/R4/R5 (provider body lỗi, daemon stderr, MCP stderr) vẫn là việc mốc sau (2026-11-08)
- [x] Tách 3 loại credential: token phiên, OAuth refresh token, API key — không trộn lẫn — v0.7: `packages/core/src/auth/credentials.ts` (`session` / `oauth-refresh` / `provider`, `migrateCredentials` idempotent, đích đã có thì skip không ghi đè); chạy ở startup sau migration API key; MCP OAuth giữ namespace riêng `mcp-oauth` theo từng server (2026-11-08)
- [x] Chế độ riêng tư không lưu trữ (NO_STORAGE): bật thì token không được lưu bền — v0.5: Vault `setNoStorage` (bật: chỉ giữ trong bộ nhớ; tắt: flush bền), toggle trong Settings mục Vault + lưu lựa chọn `settings.vaultNoStorage`, TeamView cảnh báo khi tạo service account lúc NO_STORAGE đang bật (2026-11-08)
- [x] Đăng nhập OAuth qua trình duyệt/callback (custom protocol + callback localhost) — v0.7: `packages/core/src/auth/oauth.ts` (RFC 8252, callback server tạm 127.0.0.1, kiểm tra state; chỉ refresh token lưu Vault `oauth-refresh`); chỉ Google hỗ trợ (`isOAuthSupported('xai') = false` — xAI không có OAuth công khai cho desktop app); người dùng tự tạo Google OAuth client và nhập client id/secret trong Settings; chưa test live với Google thật (2026-11-08)
- [x] MCP là cổng mở rộng chính: chuẩn hoá tool/resource/auth/callback của MCP thay vì tích hợp cứng từng dịch vụ
- [x] Model registry: server (hoặc file cấu hình từ xa) trả về danh sách model khả dụng + model mặc định + model dự phòng theo từng tính năng — v0.5: registry local (`<userData>/models.json`, chỉ ghi delta user; file hỏng không crash) thay cho server cấu hình từ xa, đúng định vị local-first; IPC `models:list/set-feature/set-default/set-fallback/set-flag`, UI Settings (default/fallback/feature/flag + Ollama pull) (2026-11-08)
- [x] Client không hard-code tên model; chỉ lưu lựa chọn của người dùng — v0.5: bot mặc định + `bots:create` + BotForm lấy model từ registry; 6 template built-in đã sửa ở v0.8 — template lấy model từ registry, không hard-code tên model (xem mục v0.8 dưới + `packages/core/src/agent/templates.ts`: "Templates never hard-code a model name") (2026-11-08)
- [x] Feature flag (bật/tắt tính năng, thử nghiệm model) mà không cần phát hành bản mới — v0.5: registry `featureFlags` (voice/vision/long-context) + IPC `models:set-flag` + checkbox trong Settings, lưu bền vào models.json (2026-11-08)
- [x] Cơ chế tự cập nhật (kiểm tra/tải bản mới theo kênh stable) — v0.7: `packages/core/src/update/checker.ts` (check GitHub releases `hoangthuanreview20-boop/open-bot`, so semver); IPC `update:check` + `update:open-download` (chỉ mở link releases của repo, chặn URL lạ); MỨC THỰC TẾ: check + thông báo + nút tải, KHÔNG tự ghi đè app đang chạy (cần code-signing/autoUpdater); chưa chạy tự động lúc khởi động, chỉ nút bấm trong Settings (2026-11-08)

### 2e. Mở rộng theo hướng Huy muốn

- [x] Thêm provider khác qua chuẩn OpenAI-compatible (đã có khung `openaiCompatible` ở v0.1; chỉ cần thêm preset từng nhà cung cấp) — v0.5: 6 preset (DeepSeek, Qwen, Mistral, Together, Groq, OpenRouter) với baseUrl + defaultModel, `PROVIDERS` mang `presets` (2026-11-08)
- [x] Model local chạy hoàn toàn trên máy (Ollama đã có ở v0.1; mở rộng thêm model local khác)
- [x] Giao diện tiếng Việt đầy đủ (mọi màn hình, thông báo, lỗi) — xem
  thêm mục 2f, i18n đầy đủ thay cho riêng tiếng Việt

### 2f. Mở rộng vượt 76 tool — tầm nhìn platform khổng lồ

76 tool ở mục 2b chỉ là sàn. Nhóm này là đích dài hạn: tool không giới
hạn số lượng, sản phẩm lớn lên thành platform, đa ngôn ngữ đầy đủ, hiệu
năng cao. Không mục nào trong nhóm này được phép chặn mốc 1 (v0.1); kiến
trúc v0.1 chỉ cần thiết kế để chứa được chúng (registry mở, i18n, plugin
system), còn triển khai đầy đủ rải theo v0.2–v0.5.

#### Tool registry & plugin system

- [x] Tool registry: đăng ký/gỡ tool động lúc chạy, không cần sửa code lõi hay build lại app
- [x] Plugin system: plugin nạp thêm tool/kỹ năng cho agent, bật/tắt từng plugin trong Settings — v0.3 wave 1: loader + manager + nối registry + test tích hợp; bật/tắt qua `enabled.json` (UI Settings chưa có) (2026-11-08); v0.8: UI bật/tắt trong Settings (`plugins:list` / `plugins:toggle` IPC + preload, `SettingsView` liệt kê plugin + toggle, persist qua `enabled.json`; toggle áp dụng cho bot tạo mới, bot đang chạy giữ nguyên tool) (2026-11-09)
- [x] MCP marketplace: duyệt, cài, gỡ MCP server/plugin/template từ marketplace (local trước, mở rộng sau) — v0.3 wave 1: 8 server mẫu thật (filesystem, memory, fetch, sqlite, git, brave-search, github, postgres qua `npx -y`), cài vào workspace `mcp.json`, không ghi key, IPC `mcp-marketplace:*` + preload; UI duyệt/cài (`McpMarketplaceView`, hiện `nextSteps` sau khi cài) xong 2026-11-08; form sửa args lúc cài đã có ở v0.84e (textarea một tham số mỗi dòng trong `McpMarketplaceView`, IPC `mcp-marketplace:install` nhận `args?` qua validator mới `requireStringArray`, core `install()` đã hỗ trợ `InstallOverrides.args` từ trước; chỉ gửi overrides khi user thật sự sửa, không thì cài đúng như catalog). Env/key vẫn tự sửa `mcp.json` theo thiết kế (core install không bao giờ ghi credential — xem `buildServerConfig`). (2026-11-08; cập nhật 2026-11-11)
- [x] Template plugin: tạo/chia sẻ template cấu hình plugin để người khác dùng lại — v0.8: `packages/core/src/plugins/templates.ts` (`PluginTemplate { id, name, description, manifest, config, createdAt }`, lưu 1 file JSON/template vào `<userData>/plugin-templates/`, save/list/get/delete/apply, export/import 1 file JSON kèm validate + chặn secret qua `validatePluginTemplate`; apply ghi `manifest.json` + `config.json` và `config.entrySource` → file entry nên plugin cài xong tải được ngay qua loader thường) (2026-11-09)

#### API cho bên thứ ba & đa người dùng/team

- [x] API local cho bên thứ ba (HTTP/WebSocket): app/script ngoài gọi được agent, gửi nhiệm vụ, đọc kết quả — v0.5: HTTP xong (loopback 127.0.0.1, Bearer token Vault, `GET /v1/health|bots`, `POST /v1/bots/:id/run` → 202 + poll, history, tasks; đã smoke test curl + Ollama run thật); v0.8: WebSocket streaming xong — `GET /v1/bots/:id/run/stream?text=...`, framing RFC 6455 tự viết (Node không có WS server, không thêm dependency), auth Bearer + team check TRƯỚC handshake, event `{kind, data}` (delta/toolcall/toolresult/summary/error), main nối `runBotStream` thật (fallback `runBot` khi handler vắng); lưu ý: run qua WS không trả lời được approval/ask-user (2026-11-09)
- [x] Webhook/sự kiện: app ngoài nhận thông báo khi agent xong việc, gặp lỗi, hoặc cần phê duyệt — v0.5: `WebhookDispatcher` (store `webhooks.json` mode 0600, timeout 5s, best-effort), 4 kind (`run.done`, `run.error`, `approval.needed`, `automation.notify`), móc vào `chat:send` + API run + approval + automation notify; đã nhận webhook thật ở mock listener; v0.8: ký HMAC-SHA256 xong — `X-Open-Bot-Signature: sha256=<hex>` của `"<timestamp>.<body>"` + `X-Open-Bot-Timestamp`, secret từ Vault namespace `webhook` key `hmac-secret` (main đã nối), `verifyWebhookSignature` (timing-safe, từ chối timestamp lệch > 5 phút); thiếu secret thì gửi không ký + cảnh báo 1 lần (2026-11-09)
- [x] Workspace team: nhiều người dùng chung một workspace, phân quyền (admin/member/viewer) — v0.5: `workspaceDir` + `teamId` trong `team.json`, UI TeamView (hiện/copy teamId, lưu thư mục dùng chung); phân quyền role đã có từ v0.3; chưa có server trung tâm/xác thực thật (2026-11-08)
- [x] Chia sẻ bot/agent theo team kèm phân quyền chi tiết (mở rộng từ mục 2c: ai được dùng, ai được sửa) — v0.5: mở rộng bằng workspace team + service account (token riêng cho app/script ngoài); role admin/member/viewer + share/unshare đã có từ v0.3; scope service account chưa enforce (2026-11-08)

#### Đa ngôn ngữ đầy đủ (i18n)

- [x] i18n toàn bộ giao diện: mọi màn hình, thông báo, lỗi đều qua file locale, không hard-code chuỗi hiển thị
- [x] Locale tiếng Việt + tiếng Anh có sẵn từ đầu; chuyển ngôn ngữ trong Settings
- [x] Thêm ngôn ngữ mới chỉ cần thêm một file locale, không sửa code UI
- [x] Agent làm việc được mọi ngôn ngữ qua model của provider (prompt/ngữ cảnh đa ngôn ngữ, không ép tiếng Anh)

#### Hiệu năng — siêu mạnh mẽ

- [x] Job queue: nhiệm vụ/agent chạy qua hàng đợi, không chặn giao diện — v0.4: JobQueue (FIFO có ưu tiên, concurrency, timeout/cancel), chat:send đi qua WorkerPool ở main (2026-11-08)
- [x] Worker pool: nhiều worker chạy song song, có giới hạn tài nguyên từng worker — v0.4: WorkerPool (size 4, maxConcurrentToolExecs 4, maxJobTimeMs), số liệu hiện ở Settings (2026-11-08)
- [x] Cache kết quả tool: kết quả giống nhau không gọi lại, có thời hạn và nút xoá cache — v0.4: ToolResultCache (key = tên tool + hash args, TTL 5 phút, LRU 200 entry, chỉ tool read-only), RPC cache.stats/clear, số liệu ở Settings (2026-11-08)
- [x] Nhiều bot chạy song song không ì ạch: giới hạn số bot đồng thời, ưu tiên tác vụ, giao diện vẫn mượt — v0.8: hàng đợi run trong coordinator (tối đa 4 run đồng thời, cấu hình qua `CoordinatorOptions.maxConcurrentRuns`; FIFO, 1 bot không chạy 2 turn cùng lúc, run sau của cùng bot chờ run trước, run bot khác được vượt lên tránh tắc đầu hàng; `stopBot`/`destroyBot`/`shutdown` huỷ cả run đang xếp hàng); test 6 run mock delay 300ms → 2 đợt, stopBot huỷ run xếp hàng (2026-11-09)

---

## 3. Lộ trình theo mốc

### v0.1 — Agent shell chạy được (hoàn thành)

- Agent loop + 6 provider (Grok, OpenAI, Anthropic, Gemini, Ollama,
  OpenAI-compatible) + 10 tool (đọc/ghi/liệt kê file, shell, tìm web,
  fetch web, http, git status/diff/commit) + sandbox.
- UI: chat, danh sách bot, quản lý task, phê duyệt, cài đặt.
- Memory SQLite, routines cơ bản.
- Đẩy lên GitHub, build chạy được trên máy.

### v0.2 — Mở rộng mặt tool + nền tảng i18n & tool registry (hoàn thành 2026-11-08)

- Nền tảng i18n: toàn bộ chuỗi giao diện qua file locale, locale tiếng
  Việt + tiếng Anh có sẵn; thêm ngôn ngữ mới chỉ cần thêm file locale.
- Tool registry: đăng ký/gỡ tool động lúc chạy (nền tảng cho plugin
  system ở v0.3); tool mới không cần sửa code lõi.
- Mở rộng bộ tool theo checklist 2b, ưu tiên theo thứ tự:
  1. File/code search: glob, grep, semantic search, diff, blame, lint.
  2. Plan/task/todo: plan, tracked task (CRUD + trạng thái/tag), goal,
     todos, project, chế độ làm việc dài hơi.
  3. Agent-to-agent/subagent: giao việc cho agent con, gửi message giữa
     các agent, hỏi người dùng, tóm tắt cuối.
  4. MCP client: gọi tool/resource của MCP server, xác thực MCP.
- Mỗi nhóm tool xong đều có kiểm thử và được phê duyệt như tool hiện có.

### v0.3 — Mô hình tiến trình, hệ sinh thái agent & plugin system/MCP marketplace

- Tách local-exec-daemon và node-agent-coordinator ra khỏi main process
  (theo checklist 2a). — XONG CẢ HAI + ĐÃ NỐI 2026-11-08 (61/140);
  v0.3 chỉ còn: plugin bật/tắt trong Settings UI, template plugin.
  Skills đã xong ở v0.4.
- Tạo/nhân bản/publish agent, template agent, marketplace local.
  — WAVE 1 XONG 2026-11-08 (59/140).
- Plugin system: plugin nạp thêm tool/kỹ năng, bật/tắt từng plugin;
  MCP marketplace (duyệt, cài, gỡ MCP server/plugin/template).
  — WAVE 1 XONG 2026-11-08 (chưa có UI duyệt MCP marketplace / quản lý team).
- Chia sẻ agent theo team (bản local trước: nhiều người dùng chung qua
  cấu hình, chưa cần server trung tâm). — WAVE 1 XONG 2026-11-08 (local).

### v0.4 — Vault, skills, tự động hoá, voice & hiệu năng (queue/worker/cache)

- Vault secret mã hoá bằng khoá hệ điều hành; credential connector/MCP
  lưu riêng trong vault, không trộn vào cấu hình app hay lịch sử chat.
  — XONG 2026-11-08 (73/140).
- Skills/plugins/connectors (mở rộng qua MCP là chính). — Skills XONG
  2026-11-08; connectors OAuth chưa làm.
- Automations/routines nâng cao, scheduled task, "dream" chạy nền.
  — XONG 2026-11-08.
- Giới hạn chi tiêu (spend limit) và hiển thị mức sử dụng. — XONG 2026-11-08.
- Voice realtime qua API realtime của provider; voice memo. — XONG
  2026-11-08 (chưa test live với key thật).
- Hiệu năng: job queue, worker pool, cache kết quả tool — nhiều bot chạy
  song song không ì ạch. — XONG 2026-11-08.

### v0.5 — Model registry, API bên thứ ba & đa người dùng/team (hướng platform dài hạn)

- Model registry: default + fallback + per-feature, bỏ hard-code tên
  model trong client; feature flag. — XONG 2026-11-08.
- Mở rộng provider (thêm preset OpenAI-compatible), cải thiện model local.
  — XONG 2026-11-08.
- API cho bên thứ ba (HTTP/WebSocket) + webhook/sự kiện để app/script
  ngoài gọi được agent. — XONG 2026-11-08 (HTTP + webhook; WebSocket chưa).
- Chia sẻ theo team hoàn chỉnh hơn (workspace team, phân quyền, service
  account). — XONG 2026-11-08 (chưa có server trung tâm/xác thực thật).

> Hướng platform dài hạn (mục 2f): v0.5 là bước đầu của platform, chưa
> phải đích cuối. **Local-first vẫn là mặc định** — dữ liệu ở trên máy
> người dùng, key của ai người đó giữ; API/team là lớp mở rộng trên nền
> local-first đó, không thay thế nó.

### v0.6 — Hoàn thiện bộ tool còn lại: shell, computer-use, web/media, agent-to-agent (108/140)

- Shell & thực thi: `exec_task` có theo dõi tiến trình, shell session
  tương tác (ghi stdin), `sandbox_prepare`, tool computer-local
  (`system_info`, `list_processes`, `kill_process`, `open_path`); daemon
  cap 8 exec song song + stream output cap 200k ký tự.
- Computer-use: screenshot (ImageMagick), quay màn hình (ffmpeg x11grab),
  chuột/bàn phím (xdotool), preview thumbnail trong ChatView. Linux +
  X11 only.
- Web & media: `x_search` (X API + fallback có ghi nhãn, thay bản
  fallback-only cũ trong CODE_TOOLS), `image_generate`, `video_generate`
  + `video_from_images` (ffmpeg), CanvasStore + tool canvas; sửa
  `unwrapBingRedirect` cho dạng redirect mới của Bing.
- Agent-to-agent: `create_agent`, `message_agent`, `set_agent_mode`,
  `reflect`, `search_conversations`, `read_agent_transcript`, grind có
  checkpoint; AgentPermissions (allow/deny/ask) nối vào agent loop;
  event `agent.created` để main lưu bot mới bền + UI tải lại danh sách.
- Registry đầy đủ: 82 tool. Xác minh: build + typecheck xanh, test
  293/293 pass, e2e mock 17/17 (exec task, shell session, canvas,
  screenshot, message_agent, create_agent), app desktop chạy 25s dưới
  xvfb không lỗi JS. Ollama local xác minh thật (qwen2.5:0.5b): đường
  tool-calling hoạt động — model gọi `system_info` và báo đúng dữ liệu
  máy; lưu ý model 0.5b cần chỉ thị trực tiếp mới gọi tool và chạy chậm
  (~4 phút/lượt với 82 tool trong context) — dùng model local lớn hơn
  hoặc provider frontier để gọi tool đáng tin cậy. Chưa test live với
  key thật (image/x_search API).
- Còn lại 32 mục: mô hình tiến trình (2a), tích hợp (Slack/email/Teams/
  iMessage/meeting), connectors OAuth, bộ nhớ dài hạn, xác thực/bảo mật
  (2d), template plugin, nhiều bot song song, và 2 mục phụ thuộc cloud
  (dữ liệu agent cloud, session box — làm bằng bản tương đương local).

### v0.7 — MCP & git/PR & CI, tích hợp & bộ nhớ dài hạn, tiến trình & xác thực & cập nhật (138/140)

- Mô hình tiến trình & xác thực (W7): khởi động 2 giai đoạn (~131ms đo
  thật dưới xvfb), IPC kênh hẹp có kiểm chứng (`ipc/validate.ts`),
  V8 code-cache (cờ không tạo khác biệt đo được — giữ làm mặc định vô
  hại), policy ghim backend (`policy.json`), đăng nhập đa tầng
  (`auth/identity.ts`), header Authorization + team check cho Local API
  (timing-safe), tách 3 loại credential (`auth/credentials.ts`),
  OAuth qua trình duyệt (chỉ Google, RFC 8252), tự cập nhật (check
  GitHub releases + thông báo + nút tải, không tự cài).
- MCP & git/PR & CI (W5): `mcp/oauth.ts` (OAuth2 + PKCE, callback
  localhost), `GitHubClient` + 8 tool git/PR (`git_host_connect`,
  `pr_*`, `set_active_branch`), 4 tool CI/bug (`ci_investigate`,
  `bug_report`, `bug_fix_report`, `ai_attribution`), `agent_export`/
  `agent_import` (bản tương đương local cho dữ liệu agent cloud).
- Tích hợp & bộ nhớ dài hạn (W6): session box local + 5 tool,
  ConnectorRegistry + OAuth framework (delegate sang `mcp/oauth.ts` —
  hoà giải trùng lặp), Slack/Gmail/Teams/iMessage-nháp/meeting +
  20 tool, LongTermMemory + `memory_*`/`team_context_summary`/
  `transcript_archive`.
- Nối wave 2 (điều phối viên): registry 119 tool (82 + 37, không trùng
  tên); token đi từ Vault qua `createBot` (GitHub, connector, MCP
  OAuth seed/config, allowlist hệ thống); event `mcp.oauth-token`
  (main persist vào Vault) + `mcp.open-url` (main mở trình duyệt, chỉ
  http(s)); `callSystemTool` gọi tool của MCP server tên `system`.
  Xác minh: build + typecheck xanh, test 360/360 pass (gồm 3 test nối
  mới — vòng OAuth MCP đầy đủ qua con với mock server), app desktop
  chạy 25s dưới xvfb không lỗi JS. Sửa 2 lỗi thật phát hiện lúc xác
  minh: /tmp đầy (Ollama models 469MB đã dời — hoá ra server đọc từ
  `/home/ollama/.ollama/models`, /tmp chỉ là bản copy) và flake
  CanvasStore sort (timestamp đơn điệu + tie-break).
- Còn lại 2 mục: template plugin, nhiều bot chạy song song (W8).

### v0.8 — Template plugin, nhiều bot song song, WebSocket, HMAC (140/140 — ROADMAP HOÀN THÀNH)

- Template plugin (W8a): `packages/core/src/plugins/templates.ts`
  (`PluginTemplate`, lưu 1 file JSON/template vào
  `<userData>/plugin-templates/`, save/list/get/delete/apply,
  export/import kèm validate + chặn secret); sửa 6 template built-in
  hard-code `model: 'grok-4.7'` (lấy từ model registry, fallback `''`).
- Plugin bật/tắt trong Settings UI (W8a): IPC `plugins:list` /
  `plugins:toggle`, `SettingsView` liệt kê + toggle, persist qua
  `enabled.json`; toggle áp dụng cho bot tạo mới, bot đang chạy giữ
  nguyên tool.
- Nhiều bot song song (W8b): hàng đợi run trong coordinator (tối đa 4
  run đồng thời, FIFO, 1 bot không chạy 2 turn cùng lúc, `stopBot`
  huỷ cả run xếp hàng).
- WebSocket streaming (W8b): `GET /v1/bots/:id/run/stream?text=...`,
  framing RFC 6455 tự viết, auth trước handshake, main nối
  `runBotStream` thật.
- HMAC webhook signing (W8b): `X-Open-Bot-Signature` + timestamp,
  secret từ Vault `webhook`/`hmac-secret` (main đã nối),
  `verifyWebhookSignature` chống replay (5 phút).
- Xác minh: build + typecheck xanh, test 380/380 pass, app desktop
  chạy 25s dưới xvfb không lỗi JS (khởi động 185ms).
- Còn thiếu: test live với key thật; WS chỉ nhận `?text=` qua query,
  chưa có message điều khiển (vd: stop) qua socket; template plugin
  chưa có UI tạo/chia sẻ (chỉ API core).

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
| v0.1 | Agent shell + 6 provider + 10 tool + sandbox + UI + phê duyệt + memory SQLite + routines cơ bản + đẩy GitHub | **Hoàn thành** |
| v0.2 | Mở rộng tool (48 tool) + nền tảng i18n & tool registry + plan/subagent + MCP client | **Hoàn thành 2026-11-08** |
| v0.3 | Mô hình tiến trình (daemon, coordinator), tạo/nhân bản/publish agent, template, marketplace local, plugin system/MCP marketplace | Wave 1 + wave 2 xong (61/140); chỉ còn vài mục nhỏ (plugin Settings UI, template plugin, skills) |
| v0.4 | Vault secret, skills/plugins/connectors, automations + "dream", giới hạn usage, voice realtime, hiệu năng (queue/worker/cache) | **Hoàn thành 2026-11-08 (73/140)** — chưa test voice live với key thật; tool call trong voice call chưa thực thi; plugin vẫn in-process |
| v0.5 | Model registry, mở rộng provider, API bên thứ ba, đa người dùng/team (hướng platform dài hạn) | **Hoàn thành 2026-11-08 (86/140)** — registry + 6 preset + API local HTTP + webhook + workspace/service account + NO_STORAGE; chưa có WebSocket/streaming, HMAC webhook, server trung tâm/xác thực thật; chưa test với key thật |
| v0.6 | Hoàn thiện bộ tool: shell/exec, computer-use, web/media, agent-to-agent, grind, permissions | **Hoàn thành 2026-11-08 (108/140)** — 82 tool, e2e mock 17/17, app chạy xvfb 25s không lỗi; chưa test live key thật; còn 32 mục (tiến trình, tích hợp, auth, template plugin, song song, 2 mục cloud) |
| v0.7 | MCP & git/PR & CI, tích hợp & bộ nhớ dài hạn, tiến trình & xác thực & cập nhật | **Hoàn thành 2026-11-08 (138/140)** — 119 tool, test 360/360, vòng OAuth MCP end-to-end qua con với mock server, app chạy xvfb 25s không lỗi; chưa test live key thật (GitHub/Slack/Gmail/Google OAuth); còn 2 mục (template plugin, nhiều bot song song) |
| v0.8 | Template plugin, nhiều bot song song, WebSocket streaming, HMAC webhook | **Hoàn thành 2026-11-09 (140/140 — ROADMAP HOÀN THÀNH)** — 119 tool, test 380/380, app chạy xvfb 25s không lỗi; chưa test live key thật; WS chưa có message điều khiển qua socket; template plugin chưa có UI tạo/chia sẻ |

---

## Tài liệu liên quan

- [GROK-BOT-ANALYSIS.md](GROK-BOT-ANALYSIS.md) — phân tích tĩnh Grok Bot 0.79.3 (nguồn của checklist)
- [ARCHITECTURE.md](ARCHITECTURE.md) — kiến trúc hiện tại của open-bot
- [SETUP.md](SETUP.md) — hướng dẫn cài đặt & chạy
