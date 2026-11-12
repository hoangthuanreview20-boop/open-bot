# UI parity review — open-bot renderer vs hướng Grok Bot (v0.50)

- **Ngày:** 2026-11-09
- **Baseline:** repo `~/workspace/open-bot`, branch `main`, HEAD v0.50 (`bfd66d6`, M1–M8 xong)
- **Phạm vi:** CHỈ rà soát + tài liệu. Không sửa code UI trong sóng này.
- **Phương pháp:** đọc toàn bộ renderer (`apps/desktop/src/renderer/`: `App.tsx` 737 dòng +
  23 component + `styles.css` 106 dòng, tổng ~7.627 dòng), đối chiếu với hướng Huy đã chốt
  (xem §1) và với code thật của core (tool registry, slash registry, WS `stopRun`,
  `plans:list`…). Không chạy app, không chụp màn hình — các nhận xét đều ghi rõ file/dòng
  đối chiếu để sóng sau kiểm chứng bằng smoke Electron thật (CDP) trước khi sửa.

## 1. Mục tiêu parity (hướng đã chốt)

Huy chốt: layout quen thuộc để user Grok Bot chuyển qua dùng ngay (chat, danh sách bot,
duyệt tool, settings), tính năng nâng cao nằm sau panel/menu (progressive disclosure),
giao diện thoáng, KHÔNG dày đặc. Tham chiếu:

- `docs/GROK-BOT-ANALYSIS.md` (phân tích tĩnh installer Grok Bot 0.79.3): cho biết Grok Bot
  là Electron + React, có marketplace/template agent, vault, voice call/memo, automations/
  dream, usage/spend limit, MCP per-agent và per-team — nhưng phân tích tĩnh **không có
  screenshot hay chi tiết layout** của Grok Bot, nên không thể đối chiếu pixel-by-pixel.
  Các mục “thiếu” dưới đây vì vậy được đánh giá theo (a) hướng Huy đã chốt, (b) mẫu
  OpenMausBot trong `docs/research-openmausbot.md` §9 (app chat kiểu Telegram: sidebar là
  danh sách bot, approval card trong chat), và (c) quy ước chung của app agent
  (Claude Code/Cursor). Chỗ nào là suy luận thì ghi rõ là suy luận.
- Nguyên tắc đo: một màn hình đạt parity khi user Grok Bot mở lên là dùng được ngay
  không cần học lại; một tính năng nâng cao đạt progressive disclosure khi nó không
  chiếm chỗ trên màn hình chính mà vẫn tìm thấy trong ≤ 2 click.

## 2. Bản đồ renderer hiện tại

| Vùng | File | Dòng | Ghi chú |
|---|---|---|---|
| Shell + routing theo `view` | `App.tsx` | 737 | 11 view, chuyển bằng state (không có router/URL) |
| Sidebar: danh sách bot + nav | `components/Sidebar.tsx` | 57 | 260px cố định, 8 nút nav ở đáy |
| Chat | `components/ChatView.tsx` | 429 | streaming, tool-call cards, voice call + memo |
| Tạo/sửa bot | `components/BotForm.tsx` | 176 | modal: template, provider/model, prompt, workspace, approval level |
| Đổi model giữa chừng | `components/ModelPicker.tsx` | 261 | provider rail 3 nhóm (subscription/api/custom), dim khi không dùng được |
| Duyệt tool | — | — | **Không có màn hình riêng** (xem §3.5) |
| Settings | `components/SettingsView.tsx` | 2.226 | ~20 section trong 1 trang cuộn dài |
| Marketplace agent | `components/AgentMarketplaceView.tsx` | 215 | template + publish |
| Marketplace MCP | `components/McpMarketplaceView.tsx` | 198 | liệt kê server, install/uninstall |
| Skills | `components/SkillsView.tsx` | 83 | liệt kê skill |
| Automations | `components/AutomationsView.tsx` | 497 | cron + trigger, form tạo automation |
| Plan review | `components/PlanReviewView.tsx` | 324 | duyệt plan (approve/reject/request-changes) |
| Traces | `components/TraceView.tsx` | 292 | timeline span của run |
| Tasks panel | `components/TaskPanel.tsx` | 40 | panel phải 340px, bật/tắt |
| Team | `components/TeamView.tsx` | 543 | workspace, service account, members, bots |
| Group chat bot-bot | `components/GroupView.tsx` | 220 | tạo nhóm, @mentions, delegation 1 hop |
| A2A client | `components/A2aClientView.tsx` | 193 | trust agent ngoài + gửi task thử |
| Approval / permission | `components/ApprovalCard.tsx`, `PermissionCard.tsx` | 133/56 | thẻ inline trong chat (M8) |
| Hỏi user / elicitation | `components/AskUserCard.tsx`, `ElicitationModal.tsx` | 55/243 | thẻ + modal |
| Styling | `styles.css` | 106 | light/dark theo `prefers-color-scheme`, không có toggle tay |

Điểm mạnh chung (đã đạt): bố cục chat-first đúng hướng; sidebar bot list giống mẫu
Telegram của OpenMausBot; model picker + provider rail 3 nhóm đã ngang mẫu tham chiếu;
approval card inline trong chat (M8) đúng triết lý “mọi hành động rủi ro là một quyết
định, không phải thứ audit sau”; i18n vi/en đầy đủ; spacing thoáng (font 14px,
padding 12–20px, bubble tối đa 78%); tool-call card dạng `<details>` gập được là
progressive disclosure đúng chỗ; panel Tasks bật/tắt thay vì luôn hiện.

## 3. Từng màn hình — đã đạt / còn thiếu

### 3.1. Chat (`ChatView.tsx` + `App.tsx`)

Đã đạt: streaming theo delta; header hiện tên bot + provider/model + nguồn model
(account/API key/local) + cờ auto-approve; nút đổi model giữa chừng không mất thread;
voice call (realtime) + voice memo (ghi âm → transcript chèn vào ô nhập); tool-call card
gập/mở, có thumbnail screenshot cho `computer_screenshot`; trạng thái thinking/tool;
approval/permission/ask-user hiện inline dưới chat; notices tóm tắt/progress.

Còn thiếu:

| # | Thiếu | Mức | Vì sao quan trọng |
|---|---|---|---|
| C1 | **Tin nhắn render plain text, không markdown/code highlight** — `ChatView.tsx` render `{m.text}` thô, không có thư viện markdown nào trong renderer (grep toàn `renderer/` không thấy). Agent trả code, bảng, danh sách đều thành một khối text. | P0 | Chat là màn hình chính; user Grok Bot quen đọc câu trả lời có định dạng. Đây là gap nhìn thấy ngay trong 30 giây đầu dùng app. |
| C2 | **Không có nút Stop/Dừng run** — khi `status !== 'idle'` thì ô nhập + nút gửi bị disable, không có nút dừng nào trong renderer. Trong khi WS đã có `stopRun` theo run (v0.9) và core có abort signal. User chỉ có cách chờ run chạy hết hoặc tắt app. | P0 | Mất kiểm soát run đang chạy; run lỗi/lặp thì user bó tay. Lỗi này “đau” hơn cả thiếu markdown khi chạy agent dài. |
| C3 | **Không hiện token/usage của turn** — không chỗ nào trong chat hiện số token in/out hay chi phí; usage chỉ có trong Settings (`settings.usageTitle`). | P1 | Grok Bot có usage banner + spend limit; user không biết một câu hỏi tốn bao nhiêu cho tới khi mở Settings. |
| C4 | **Không có slash-command menu / @-mention autocomplete trong ô nhập** — core đã có slash registry (`packages/core/src/agent/slash.ts`, lệnh nạp từ Markdown, mô tả cắt 200 ký tự “đủ cho menu `/`”) và @-mentions (`@files`, `@docs`, v0.16), nhưng ô nhập chat là `<textarea>` trơn, chỉ có Enter-gửi. | P1 | Tính năng đã có ở core mà UI không lộ ra = user không bao giờ phát hiện. |
| C5 | **Không đính kèm file / kéo-thả / dán ảnh** — grep `renderer/` không có attach/drop/paste. Muốn agent đọc file thì phải gõ đường dẫn hoặc dùng @-mention (mà @-mention cũng không có autocomplete). | P1 | Thao tác cơ bản của app chat/agent; thiếu thì onboarding user mới rất vấp. |
| C6 | **Không có danh sách hội thoại/thread + tìm kiếm** — sidebar chỉ có danh sách *bot*; mỗi bot chỉ có 1 thread, history nạp 50 tin gần nhất (`getHistory(botId, 50)`), không tìm kiếm, không tạo thread mới, không resume thread cũ theo tên. | P0 | Xem §3.2. |
| C7 | **Approval card của MỌI bot dồn vào khung chat đang mở** — `App.tsx` (v0.50) cố tình giữ card mọi bot để khỏi mất card khi run chờ timeout, nhưng card hiện dưới chat của bot đang chọn, user dễ duyệt nhầm ngữ cảnh (dù card có ghi tên bot). | P1 | Đúng vấn đề M8 đã biết; cần khoang riêng (vd badge ở sidebar + khay approval) thay vì dồn vào chat. |
| C8 | **Không có phím tắt** ngoài Enter-gửi (Shift+Enter xuống dòng). Không có Cmd/Ctrl+K (tìm/đổi bot), Cmd+N (bot mới), Esc (đóng modal). | P2 | User power-user của Grok Bot/Cursor sẽ thấy thiếu ngay. |
| C9 | **Voice surface selector chỉ hiện khi đang gọi**; không có chỉ báo mic/đang nghe rõ ràng ngoài dòng transcript. | P2 | Nhỏ; chỉ cần một trạng thái “đang nghe…” cố định khi `voiceOn`. |

### 3.2. Danh sách bot / Sidebar (`Sidebar.tsx`, 57 dòng)

Đã đạt: tạo bot (+), sửa/clone/xoá từng bot (icon ✏️/📋/🗑️), hiện provider · model
dưới tên bot, bot đang chọn highlight, ghi chú “local-first” ở đáy, 8 nút nav gom ở đáy.

Còn thiếu:

| # | Thiếu | Mức | Vì sao quan trọng |
|---|---|---|---|
| S1 | **Không có danh sách hội thoại** — xem C6. Sidebar = bot list, không có thread list. User Grok Bot quen mỗi bot có nhiều cuộc trò chuyện; ở đây chuyển bot là mất ngữ cảnh thread cũ (history chỉ nạp lại 50 tin gần nhất của bot đó, không chọn được thread). | P0 | Đây là khác biệt cấu trúc lớn nhất với app chat kiểu Telegram/Grok Bot. Cần quyết định sản phẩm trước khi làm UI: thread có phải là thực thể riêng (lưu bền, đặt tên, xoá) hay vẫn 1-thread/bot. |
| S2 | **Không có tìm kiếm bot** — danh sách dài ra là phải cuộn tay; không lọc theo tên/provider. | P1 | Rẻ để làm, đau khi có >10 bot. |
| S3 | **Không có trạng thái bot trong sidebar** — không chấm running/idle, không badge số approval đang chờ / tin nhắn mới. Bot đang chạy nền thì sidebar im lặng. | P1 | Liên quan C7: badge approval ở sidebar là cách đúng để gom card mọi bot mà không dồn vào chat. |
| S4 | **Xoá bot dùng `window.confirm` native** (`App.tsx` `deleteBot`) — hộp thoại hệ thống, không khớp ngôn ngữ/thiết kế app, không nhắc rõ “history trong bộ nhớ sẽ mất”. | P2 | Nhỏ nhưng lộ vẻ “chưa xong” ngay thao tác nguy hiểm. |
| S5 | **Sidebar 260px cố định, không thu gọn/kéo giãn**; 8 nút nav xếp dọc ở đáy chiếm ~1/3 chiều cao sidebar. | P2 | Khi bot nhiều, nav đẩy danh sách bot lên; nên gom nav vào menu “⋯ / More” hoặc icon rail (xem §4). |

### 3.3. Tạo/sửa bot (`BotForm.tsx`)

Đã đạt: chọn template, tên, provider (rail) + model free-text, system prompt, workspace,
checkbox auto-approve (legacy), approval level 3 mức (ask-always / ask-for-writes /
auto-approve-safe), nút mở Engines trong Settings.

Còn thiếu: không có avatar/màu bot (nhận diện trong sidebar/group chat chỉ bằng tên);
không có mô tả ngắn/personality hiển thị ở sidebar; không có chọn tool/skill cho bot
ngay lúc tạo (phải vào màn hình khác sau); không validate workspace tồn tại trước khi lưu
(chỉ placeholder); không có “dùng thử”/test prompt sau khi tạo. Mức P1–P2 — form đã đủ
dùng, chỉ thiếu polish.

### 3.4. Model picker (`ModelPicker.tsx` + provider rail)

Đã đạt parity với mẫu OpenMausBot (§8 research-openmausbot): rail chia 3 nhóm
subscription/api/custom, provider không dùng được thì mờ kèm lý do, đổi model giữa chừng
giữ thread, có custom CLI/engine toggle, nút mở Engines. Còn thiếu nhỏ: không hiện giá/
context window/token limit của model trong picker (user chọn model mù về chi phí);
không có “model mặc định cho bot mới” nhanh trong picker. Mức P2.

### 3.5. Duyệt tool — màn hình CHƯA CÓ

Đây là gap lớn thứ ba sau markdown và stop. Hiện tại tool chỉ lộ ra ở 3 chỗ rời rạc:

- Tool-call card trong chat: chỉ tool *đã gọi*, hiện JSON args thô (`<pre>` dump toàn bộ
  `call.args`), không mô tả, không phân loại, không cho bật/tắt.
- MCP marketplace (`McpMarketplaceView.tsx`): chỉ liệt kê *server* (tên, transport,
  command, tags, needsKey), không liệt kê tool của từng server, không cho bật/tắt từng tool.
- Connected apps trong Settings (§3.6): danh sách tool của 5 app nằm trong `<details>`
  gập, chôn sâu trong trang Settings dài.

Không có chỗ nào trả lời “bot này có những tool gì, tool nào đang bật, tool nào tốn
nhiều token”. Trong khi core đã có đủ dữ liệu: 137 tool/bot (đo lại 2026-11-11;
v0.59 đã là 137 — xem §5 UI-3),
tool-filter + cap theo app (v0.10/v0.49), annotation read-only. **Nhiệm vụ cho sóng sau:
màn “Tools” riêng cho từng bot — tìm kiếm + lọc theo nhóm (file/shell/web/plan/agent…),
mô tả + schema gọn, bật/tắt theo bot, hiện ước lượng token/def — đặt sau một nút/tab
trong chat header hoặc sidebar, không nhồi thêm vào chat.** Mức P0.

### 3.6. Settings (`SettingsView.tsx`, 2.226 dòng — vi phạm progressive disclosure lớn nhất)

Đã đạt (về mặt tính năng): đủ hết — small-model guard, auto-approve rules, usage,
ngôn ngữ, auth/profile, connectors OAuth, connected apps (M7: trạng thái auth, connect/
disconnect, tool list trong `<details>`, cap tool/turn), cập nhật, vault, dream,
performance, models (feature/flags/Ollama pull), plugins, hooks, Local API + token +
webhooks, engines (detected CLI + custom CLI), provider API key, limits, usage reset.
i18n đầy đủ vi/en.

Còn thiếu — toàn bộ là cấu trúc, không phải tính năng:

| # | Thiếu | Mức |
|---|---|---|
| T1 | **~20 section xếp dọc trong 1 trang cuộn dài** — không tab, không nhóm, không tìm kiếm setting. User mở Settings để đổi API key phải cuộn qua auto-approve, usage, auth, connectors, vault, dream, perf, models… Đây là vi phạm rõ nhất của nguyên tắc “nâng cao nằm sau panel/menu”. | P0 |
| T2 | **Connected apps (M7) chôn trong Settings** thay vì có màn hình riêng — user muốn xem “Gmail đã kết nối chưa” phải mở Settings rồi cuộn tới đúng section. | P1 |
| T3 | **Không có tìm kiếm trong Settings** (vd gõ “vault”, “webhook”). | P1 |
| T4 | **Không có toggle theme tay** — dark/light chỉ theo `prefers-color-scheme` của hệ thống. | P2 |
| T5 | Một số section để trống khi IPC chưa sẵn (ghi chú trong code: “section stays empty”) mà không có trạng thái loading/error rõ ràng. | P2 |

Nhiệm vụ sóng sau: chia Settings thành tab/nhóm (vd: Chung · Bot & Model · Kết nối & Apps ·
Bảo mật & Vault · Nâng cao), mỗi tab cuộn riêng; ô tìm kiếm setting; tách Connected apps
thành màn hình riêng có link từ sidebar; giữ nguyên toàn bộ logic — chỉ tái cấu trúc render.

### 3.7. Các màn hình khác

| Màn hình | Đã đạt | Còn thiếu (mức) |
|---|---|---|
| Marketplace agent (`AgentMarketplaceView.tsx`) | Template + publish + cài bot, quay về chat sau khi cài | Không có đánh giá/rating, không preview template trước khi cài (P2); publish không có xác nhận quyền chia sẻ (P2) |
| Marketplace MCP (`McpMarketplaceView.tsx`) | Liệt kê server, install/uninstall, next-steps sau khi cài, báo cần key | Không liệt kê tool từng server (xem §3.5, P0); không tìm kiếm/lọc theo tag (P1); màn hình trống khi chưa chọn bot thì chỉ báo “select bot first” (P2) |
| Skills (`SkillsView.tsx`, 83 dòng) | Liệt kê skill + version + builtin | Không có bật/tắt skill theo bot, không xem nội dung skill, không cài skill mới từ UI (P1) |
| Automations (`AutomationsView.tsx`, 497 dòng) | Tạo automation (cron/event, run agent/tool/notify), liệt kê theo bot | Form tạo dài, cron phải gõ tay (có placeholder ví dụ nhưng không có builder trực quan); không có log/lịch sử chạy của automation (P1) |
| Plan review (`PlanReviewView.tsx`) | Approve/reject/request-changes, gọi RPC trực tiếp, gửi message thực thi sau khi duyệt | **Chỉ thấy plan tạo trong session hiện tại** — `App.tsx` ghi rõ: chưa có `plans:list` IPC nên plan từ session trước không hiện (P1); không có diff xem plan thay đổi gì so với lần trước (P2) |
| Traces (`TraceView.tsx`) | Danh sách trace + timeline span, nút mở từ chat | Nút “Traces” nằm ở hàng nút phụ dưới chat, dễ lẫn với Tasks/Plans; nên gom vào menu “⋯” (P2) |
| Tasks panel (`TaskPanel.tsx`) | Panel phải 340px bật/tắt, refresh | Tốt — là mẫu progressive disclosure đúng; chỉ thiếu badge số task đang chạy trên nút toggle (P2) |
| Team (`TeamView.tsx`, 543 dòng) | Workspace, service account + token, members, bots theo team | Dài và nhiều form trong 1 trang (giống bệnh Settings thu nhỏ); chưa có trạng thái “ai đang online/dùng bot nào” (P2) |
| Group chat (`GroupView.tsx`) | Tạo nhóm, @mentions, delegation 1 hop, history bền vững | Không hiện trạng thái từng bot trong nhóm (đang gõ/đang chạy), không có avatar/màu phân biệt bot (P1) |
| A2A client (`A2aClientView.tsx`) | Trust agent ngoài, gửi task thử, hiện streaming/skills | Form trust agent thô (nhập URL tay); không có khám phá agent trong mạng local (P2) |
| Voice | Call + memo + surface selector + earcon | Không có transcript bền vững của voice call trong chat (transcript chỉ chèn vào ô nhập khi final) (P2) |

### 3.8. Toàn app — onboarding, lỗi, responsive

- **Không có onboarding/first-run**: user mới mở app khi chưa có bot chỉ thấy dòng
  `chat.noBotSelected` (“chưa chọn bot”) + sidebar trống. Không có màn chào, không gợi ý
  tạo bot đầu tiên, không mẫu bot mặc định, không tour tính năng. Đây là khoảnh khắc
  “aha” bị bỏ trống. Mức P1 (P0 nếu tính cho user Grok Bot chuyển qua: họ cần thấy ngay
  một bot chạy được trong 1 phút).
- **Lỗi hiện bằng dòng chữ đỏ cố định góc dưới-phải** (`App.tsx`: `<p className="error"
  style="position: fixed; bottom: 8; right: 12">`) — dễ bị che, không có nút đóng, không
  phân biệt lỗi nặng/nhẹ. Mức P2.
- **Không có responsive/cửa sổ nhỏ**: layout flex 2 cột, sidebar 260px cố định; cửa sổ
  hẹp thì chat bị bóp, không có breakpoint thu sidebar thành icon rail. Mức P2 (desktop
  app nên ưu tiên thấp hơn, nhưng cần trước khi làm Windows/macOS QA).
- **Không có breadcrumb/tiêu đề view**: các màn phụ chỉ có nút “← Back to chat”, không có
  tiêu đề nhất quán hay đường dẫn đang ở đâu. Mức P2.
- **A2A persist banner** (v0.28) là mẫu tốt: banner lỗi hiện ở mọi view, có nút đóng —
  nên dùng cùng mẫu cho các lỗi khác thay vì dòng chữ góc màn hình.

## 4. Top 5 gap ưu tiên cao nhất (cho sóng sau)

| Hạng | Gap | Màn hình | Vì sao P0 | Việc cụ thể |
|---|---|---|---|---|
| 1 | **Tin nhắn không render markdown/code** | Chat | Màn hình chính; user thấy ngay trong 30 giây đầu | Thêm renderer markdown an toàn (sanitize, không `dangerouslySetInnerHTML` thô) + highlight code; render cả tin nhắn cũ đã lưu; test: code block, bảng, link, ảnh; kiểm chứng không rò secret qua markdown |
| 2 | **Không dừng được run đang chạy** | Chat | Mất kiểm soát agent; WS `stopRun` đã có sẵn từ v0.9 | Nút Stop trong chat header/khung nhập khi `status !== 'idle'` → gọi `stopRun` theo runId; trạng thái “đã dừng” rõ ràng; test: dừng giữa tool-call thì run kết thúc sạch, không kẹt `running` |
| 3 | **Không có màn duyệt tool** | Mới | 137 tool/bot đang vô hình; user không quản lý được tool | Màn Tools theo bot: tìm kiếm + nhóm + mô tả + bật/tắt + ước lượng token; nối dữ liệu có sẵn (tool registry, filter, cap M7); không viết lại registry |
| 4 | **Settings 2.226 dòng / ~20 section trong 1 trang** | Settings | Vi phạm progressive disclosure rõ nhất | Chia tab/nhóm + ô tìm kiếm setting; tách Connected apps ra màn riêng; chỉ tái cấu trúc render, giữ nguyên logic/IPC |
| 5 | **Không có thread/conversation list + tìm kiếm** | Sidebar | Khác biệt cấu trúc lớn nhất với app chat | Quyết định sản phẩm trước: thread là thực thể riêng (lưu bền, đặt tên, xoá, resume) hay giữ 1-thread/bot; sau đó mới làm UI list + search. Không làm UI khi chưa chốt model dữ liệu |

Tiếp theo (P1, làm sau top 5): slash/`@` autocomplete trong ô nhập; đính kèm file/kéo-thả;
hiện token/usage mỗi turn; khay approval riêng + badge ở sidebar (thay vì dồn card mọi
bot vào chat); tìm kiếm bot; onboarding/first-run (bot mẫu + gợi ý tạo bot đầu tiên);
`plans:list` IPC để plan session trước hiện lại; tách nav sidebar (gom 8 nút đáy thành
menu “More”/icon rail); builder cron trực quan + log chạy automation; bật/tắt skill
theo bot.

## 5. Nhiệm vụ UI cụ thể cho sóng sau (checklist)

- [x] UI-1 (P0): Markdown + code highlight trong `ChatView.tsx` — sanitize, giữ i18n,
  không vỡ layout bubble 78%; kiểm chứng bằng CDP smoke + test renderer. ✅ XONG v0.59:
  `markdown.ts` (marked lexer → AST an toàn, không `dangerouslySetInnerHTML`) +
  `Markdown.tsx` + highlight tự viết; test 16/16, smoke CDP 1/1.
- [x] UI-2 (P0): Nút Stop run — nối WS `stopRun` đã có (v0.9) ra renderer; trạng thái
  dừng rõ ràng; không kẹt `running` (hồi quy v0.37). ✅ XONG v0.59: nút Stop qua IPC
  `chat:stop` → `coordinator.stopBot` (chat desktop không đi WS); sửa luôn race mất
  abort trong local-exec-daemon (Stop giữa `sleep 10` nay kết thúc sau ~264ms thay vì
  10.9s); test 16/16, smoke CDP 1/1.
- [x] UI-3 (P0): Màn Tools theo bot — tìm kiếm/nhóm/bật-tắt/ước lượng token; dùng dữ
  liệu registry + filter + cap đã có; đặt sau 1 nút/tab, không nhồi vào chat. ✅ XONG
  v0.59: `ToolsView.tsx` + RPC `listBotTools`/`setBotToolEnabled` (deny thắng qua
  filter đã có); 137 tool, 20.613 token khi bật hết; test 6/6, smoke CDP 9/9 bước.
- [x] UI-4 (P0): Tái cấu trúc Settings thành tab/nhóm + tìm kiếm; tách Connected apps
  ra màn riêng; giữ nguyên IPC/logic. ✅ XONG v0.59: 5 tab (Chung · Bot & Model ·
  Kết nối & Apps · Bảo mật & Vault · Nâng cao), tìm kiếm không phân biệt dấu,
  Connected apps thành view riêng; SettingsView 2.422 → ~1.512 dòng (v0.59;
  đo lại 2026-11-11: 1.910 dòng — `wc -l
  apps/desktop/src/renderer/components/SettingsView.tsx`), đủ 26 section;
  test 8/8, smoke CDP 1/1.
- [x] UI-5 (P0, cần quyết định sản phẩm trước): Thread/conversation — chốt model dữ
  liệu (thread riêng lưu bền vs 1-thread/bot) rồi mới làm list + search ở sidebar.
  ✅ XONG v0.59: đã chốt thread là thực thể riêng trong SQLite `BotMemory`
  (bảng `threads` + `messages.threadId`, migrate message cũ vào thread mặc định,
  tự đặt tên từ tin nhắn đầu); sidebar list + tìm kiếm + đổi tên inline + xoá bằng
  modal; test 6/6, smoke CDP 1/1. Tích hợp v0.59 sửa thêm race loadHistory muộn
  xoá tin vừa gửi (sequence guard) + nhớ bot dùng lần cuối qua localStorage.
- [x] UI-6 (P1): Autocomplete `/` (slash) + `@` (mentions) trong ô nhập chat — lộ
  tính năng core đã có (slash registry, @files/@docs v0.16). ✅ XONG v0.60:
  `composer.ts` (logic thuần) + `ComposerAutocomplete.tsx` (popup, ↑/↓/Enter/Esc/click);
  mentions @files/@docs đầy đủ; slash đã có IPC `slash:list` ở v0.60d (coordinator tái
  dùng registry, chỉ trả tên + mô tả); test 21/21 + 7 test slash-list; popup với
  registry thật trong app chưa bấm thử trực tiếp. ✅ KIỂM CHỨNG v0.61:
  `tests/ui-13-verify-smoke.test.mjs` (CDP, app thật): gõ `/` hiện popup với lệnh
  thật từ registry (`/hello`, `/review` seed trong workspace bot); chọn bằng chuột
  chèn `/hello `, chọn bằng bàn phím (`/rev` + ↓ + Enter) chèn `/review `.
- [x] UI-7 (P1): Đính kèm file / kéo-thả / dán ảnh vào chat. ✅ XONG v0.60: nút 📎 +
  kéo-thả + dán ảnh (chip, tối đa 5 file/tin); file workspace qua @files, file ngoài
  inline dạng fenced block; ảnh chỉ hiện chip + ghi chú (chưa có kênh vision); test
  21/21 (chung file với UI-6); smoke CDP thấy nút 📎 trong DOM.
- [x] UI-8 (P1): Token/usage mỗi turn trong chat (nối usage đã có trong Settings).
  ✅ XONG v0.60: footer usage dưới bubble assistant (diff snapshot `usage:get`,
  renderer-only vì `RunResult`/`chat:send` chưa trả usage); tiền ẩn khi chưa có giá;
  test 16/16 (chung file UI-8/9/11); chưa kiểm chứng turn live. ✅ KIỂM CHỨNG v0.61:
  `tests/ui-13-verify-smoke.test.mjs` (CDP): turn thật với bot Ollama local
  `qwen2.5:0.5b` ("Say hi in exactly 3 words.") — footer `[data-testid="turn-usage"]`
  dưới bubble assistant hiện số token thật (input + output > 0), đối chiếu `usage:get`
  cũng > 0.
- [x] UI-9 (P1): Khay approval riêng + badge sidebar (số approval chờ theo bot);
  không dồn card mọi bot vào khung chat nữa. ✅ XONG v0.60: `ApprovalTray` dock phải
  (cả 3 loại card) + badge sidebar theo bot; bỏ `setApprovals([])` khi đổi bot;
  test 16/16; smoke CDP thấy nút "Duyệt" trong DOM.
- [x] UI-10 (P1): Onboarding first-run — bot mẫu + gợi ý tạo bot đầu tiên trong 1 phút.
  ✅ XONG v0.60: màn chào 3 bước + bot mẫu 1 click + cờ localStorage (không hiện lại);
  test 16/16 (chung file onboarding/plans); chưa smoke trực tiếp (app trên máy đã có
  bot nên onboarding không hiện trong smoke). ✅ KIỂM CHỨNG v0.61:
  `tests/ui-13-verify-smoke.test.mjs` (CDP, profile mới hoàn toàn): màn chào 3 bước
  hiện, 1 click "Tạo bot mẫu" tạo đúng 1 bot "Trợ lý mẫu", `open-bot:onboardingDone =
  '1'`, reload không hiện lại và bot còn đó. Phát hiện khi kiểm chứng: onboarding
  KHÔNG tới được trong production vì `ensureDefaultBot()` tự tạo bot "Trợ lý" lúc
  khởi động — đã xoá hàm này ở v0.61 (lần chạy đầu nay hiện onboarding thay vì bot
  lặng); kèm sửa `bots:create`/`bots:delete` phát `bots:changed` (bot tạo qua IPC
  trước đây vô hình tới khi reload).
- [x] UI-11 (P1): Tìm kiếm bot ở sidebar; trạng thái running/idle + badge trong bot list.
  ✅ XONG v0.60: tìm kiếm không phân biệt dấu + chấm running/idle + badge approval;
  test 16/16; smoke CDP thấy ô "Tìm bot theo tên, provider…" trong DOM.
- [x] UI-12 (P1): IPC `plans:list` — plan session trước hiện lại trong PlanReviewView.
  ✅ XONG v0.60: hóa ra đã có sẵn từ v0.11/v0.18 — chỉ tách reader sang `plans.ts`
  để test được + sửa comment cũ sai trong App.tsx; test round-trip core
  write/parse/update status; test 16/16.
- [x] UI-13 (P2): Gom 8 nút nav đáy sidebar thành menu/icon rail; thay `window.confirm`
  xoá bot bằng modal xác nhận trong app; toggle theme tay; phím tắt (Cmd/Ctrl+K, Esc);
  banner lỗi thống nhất theo mẫu A2A persist banner; cron builder + log automation;
  bật/tắt skill theo bot; avatar/màu bot. ✅ XONG v0.62 (trừ 2 mục ghi ở cuối):
  - Nav menu: 10 nút đáy sidebar → 1 nút "⋯ Menu" + dropdown (10 đích, Esc đóng,
    chọn là đóng); `Sidebar.tsx` + CSS `.sidebar-nav-dropdown`.
  - Xoá bot: modal xác nhận trong app thay `window.confirm` (`App.tsx`,
    `delete-bot-modal`/`delete-bot-confirm`, Esc huỷ, xác nhận xoá); các
    `window.confirm` khác (A2A, marketplace, automations, group, MCP, settings) còn
    lại — để sóng sau.
  - Theme tay: Sáng / Tối / Hệ thống trong Settings → Chung → Giao diện
    (`theme.ts` thuần, `open-bot:theme` trong localStorage, áp ngay, giữ sau reload;
    media query hệ thống chỉ chạy khi chưa chọn tay); thêm section `appearance` vào
    Settings (tìm được bằng "theme/giao diện/dark/light").
  - Phím tắt: Ctrl/Cmd+K mở command palette (`CommandPalette.tsx`: tìm bot, lệnh
    slash, màn hình; ↑/↓/Enter/Esc/click); Esc đóng theo thứ tự palette → modal xoá
    → form → model picker; chèn slash từ palette vào composer qua `externalInsert`
    (đã kiểm chứng bằng smoke với lệnh thật `/hello` từ registry).
  - Banner lỗi: `AppErrorBanner.tsx` thống nhất theo mẫu A2A persist banner
    (`role="alert"`, nút "Đã hiểu"); `A2aPersistAlert` dùng chung class `.app-alert`;
    bỏ banner lỗi cố định góc dưới-phải cũ.
  - Cron builder: builder trực quan trong Automations (`cronBuilder.ts` thuần:
    preset Hằng ngày / Ngày làm việc / Hằng giờ / Hằng tuần, chọn giờ-phút-ngày
    trong tuần, tóm tắt tiếng Việt) + đồng bộ 2 chiều với ô nhập cron text.
  - Avatar/màu bot: `BotConfig.color` (8 màu, core + main `bots:create` lưu,
    `sanitizeConfig` giữ màu khi clone) — picker swatch trong `BotForm.tsx`, avatar
    tròn chữ cái đầu ở sidebar + chat header (`botColors.ts`, màu lạ → màu mặc định).
  - CHƯA LÀM: bật/tắt skill theo bot (không có core support — cần
    `BotConfig.denySkills` + lọc ở coordinator + IPC, là việc core, không làm trong
    sóng UI này); log automation (chưa có màn log — chưa làm).
  - Kiểm chứng: `tests/ui-13.test.mjs` 18/18 (renderer, gồm hồi quy React #310: effect
    `externalInsert` phải đứng trước `if (!bot)`), `tests/ui-13-smoke.test.mjs` 1/1 CDP
    (nav menu, theme + giữ sau reload, palette + chèn slash, cron builder, màu bot,
    modal xoá), `tests/ui-13-verify-smoke.test.mjs` 3/3 (UI-6/8/10); build +
    typecheck xanh. Full suite cuối sóng: 1982/1985 pass, 2 skip, 1 fail duy nhất là
    smoke Stop (UI-1+UI-2, lỗi "stopped state must be visible after Stop") — fail
    theo tải đã biết từ v0.60, chạy riêng file đó pass 1/1 ngay sau đó. Sửa kèm 2 hồi
    quy do nav menu gây ra ở test cũ:
    `vault-confirm-l5-click.test.mjs` + `settings-ui4-smoke.test.mjs` (mở Menu trước
    rồi mới bấm "Cài đặt" / "App đã kết nối").

## 7. Rà soát lại 2026-11-11 (v0.76–v0.77, đối chiếu từng gap với code hiện tại)

Bản review này viết ở v0.50; nhiều gap đã đóng ở các sóng sau mà §5 chưa ghi.
Đối chiếu ngày 2026-11-11 (HEAD v0.76 `7f9dcb6`):

**Đã đóng ở sóng sau (xác minh bằng code, không làm lại):**
- Bật/tắt skill theo bot (UI-13 còn dở): xong v0.64 — `BotConfig.denySkills` +
  `AgentPermissions` lọc skill mỗi turn + IPC `setBotSkillEnabled` + toggle ở
  `SkillsView.tsx` (xem `packages/core/src/agent/permissions.ts`, `coordinator/client.ts`).
- Log/lịch sử chạy automation (UI-13 còn dở): xong v0.66 — tab run-history trong
  `AutomationsView.tsx` (runs đã lưu + hàng in-flight, tối đa 100 run).
- MCP marketplace tìm kiếm/lọc tag + liệt kê tool từng server (§3.5/§3.7): xong
  v0.67a — `McpMarketplaceView.tsx` (search không phân biệt dấu + chip tag +
  panel "View tools" qua `mcp-marketplace:tools`).
- `window.confirm` còn lại (UI-13): xong v0.71 — `ConfirmModal.tsx` dùng chung;
  renderer không còn gọi `window.confirm` (chỉ còn nhắc trong comment), ép bởi
  `tests/confirm-modal.test.mjs`.
- Skills: xem nội dung + cài skill mới từ UI (§3.7): xong v0.66b — `SkillsView.tsx`
  (panel SKILL.md đầy đủ + form cài từ text dán vào).
- Validate workspace tồn tại (§3.3): KHÔNG còn đúng như review viết —
  `workspaceDirFor` ở main tự tạo thư mục (`mkdirSync recursive`) khi bot chạy,
  nên thư mục chưa có không phải lỗi; `validateWorkspaceDir` chỉ kiểm tra đường
  dẫn nằm trong root cho phép. Không làm thêm.

**Còn đúng thật, đã làm ở v0.77 (xem UI-14–UI-16 dưới đây):**
- Mô tả ngắn/personality của bot (§3.3, P1) — chưa hề có field mô tả.
- Badge số task đang chạy trên nút toggle Tasks (§3.7, P2).
- Preview template trước khi cài (§3.7, P2) — marketplace chỉ hiện mô tả ngắn.

**Còn đúng thật, CHƯA làm (ghi rõ lý do, để sóng sau):**
- Giá/context window/token limit trong ModelPicker (§3.4, P2): **không có nguồn
  dữ liệu** — core không lưu giá hay context window cho model nào; bịa số là
  sai, nên chưa làm cho tới khi có catalog metadata thật.
- Trạng thái từng bot trong group chat — đang gõ/đang chạy (§3.7, P1): **xong ở
  v0.79a** (xem UI-17 dưới đây).
- Diff plan so với lần trước (§3.7, P2): **xong ở v0.79b** (xem UI-18 dưới đây).
- Responsive/cửa sổ nhỏ — breakpoint thu sidebar (§3.8, P2): **xong ở v0.79c**
  (xem UI-19 dưới đây); breadcrumb/tiêu đề view nhất quán (§3.8, P2); trạng thái "ai đang online" ở Team (§3.7, P2);
  khám phá agent A2A trong mạng local (§3.7, P2); transcript voice call bền vững
  trong chat (§3.7, P2); "dùng thử"/test prompt sau khi tạo bot (§3.3, P2);
  chọn tool/skill cho bot ngay lúc tạo (§3.3, P2).

- [x] UI-14 (P1, §3.3): Mô tả ngắn của bot — `BotConfig.description?` (tối đa
  500 ký tự, `BOT_DESCRIPTION_MAX_LENGTH`): core `types.ts` + `sanitizeConfig`
  giữ/cắt khi clone/publish/install; main `bots:create`/`bots:update` nhận +
  cắt (chuỗi rỗng = xoá); `BotConfigLike.description?`; `BotForm.tsx` thêm ô
  nhập (prefill từ template khi chọn mẫu, `maxLength={500}`) + gửi kèm lúc lưu;
  `Sidebar.tsx` hiện mô tả dưới tên bot (class `.desc`, ellipsis 1 dòng) +
  tooltip `tên — mô tả`; i18n `botForm.descriptionLabel/Placeholder/Hint` đủ
  6 locale (1165 → 1168 key/file). ✅ XONG v0.77: test core
  `tests/bot-description-v077.test.mjs` 5/5 (giữ/trim/cắt 500/bỏ rỗng/bỏ field
  lạ) + renderer `tests/bot-description-v077-renderer.test.mjs` 3/3 dưới xvfb
  (sidebar hiện đúng 1 mô tả, form tạo lưu đúng, form sửa prefill + template
  prefill); typecheck 4 workspace xanh; i18n 13/13.
- [x] UI-15 (P2, §3.7): Badge số task đang chạy trên nút toggle Tasks —
  component mới `TasksToggleButton.tsx` (badge `.badge.running` +
  `data-testid="tasks-running-badge"`, chỉ hiện khi > 0, title
  `app.runningTasks`); `App.tsx` dùng component này với
  `tasks.filter(status === 'running').length`. ✅ XONG v0.77: renderer
  `tests/tasks-badge-marketplace-preview-v077-renderer.test.mjs` (badge "2"
  khi chạy 2, không badge khi 0); i18n `app.runningTasks` đủ 6 locale.
- [x] UI-16 (P2, §3.7): Preview template/agent trước khi cài —
  `AgentMarketplaceView.tsx`: nút "Xem trước" ở mỗi card template + published;
  modal (backdrop + Esc, theo mẫu `ConfirmModal`) hiện mô tả đầy đủ, provider ·
  model, suggestedTools (template) / tác giả + lượt cài (published) và toàn bộ
  system prompt; nút hành động trong modal cài/dùng mẫu rồi đóng modal.
  ✅ XONG v0.77: renderer cùng file test trên (preview template hiện system
  prompt + cài từ preview thành công + modal đóng; preview published hiện
  tác giả, đóng thì không cài gì); i18n `marketplace.preview/previewClose/
  previewSystemPrompt` đủ 6 locale (1168 → 1172 key/file).
- [x] UI-17 (P1, §3.7): Trạng thái từng bot trong group chat —
  `GroupBotStatusTracker` (in-memory, chỉ entry `running`, `since` ISO) trong
  `packages/core/src/groupchat/groupchat.ts`; coordinator đánh dấu `running`
  trước mỗi delegation run và `idle` trong `finally` (run lỗi cũng không kẹt),
  xoá trạng thái khi nhóm bị xoá; RPC mới `getGroupBotStatus` (+ IPC
  `group:status`, preload, `global.d.ts`, `CoordinatorClient`); `GroupView.tsx`
  poll mỗi 2s khi có nhóm đang mở (poll lỗi giữ trạng thái cũ, không báo lỗi)
  + chấm trạng thái từng thành viên (xanh `running` / xám `idle`, cùng quy ước
  sidebar) + dòng "đang trả lời…" (`data-testid="group-typing"`) dưới khung tin.
  ✅ XONG v0.79a: core `tests/group-bot-status-v079.test.mjs` 3/3 (tracker +
  coordinator: thấy `running` GIỮA run mock delay 800ms, về `[]` sau run, nhóm
  xoá thì throw) + renderer `tests/group-status-v079-renderer.test.mjs` 2/2 dưới
  xvfb (typing line + chip running/idle; không typing khi rảnh); i18n
  `group.botRunning/botIdle/typing` đủ 6 locale (1176 → 1179 key/file);
  `tests/i18n.test.mjs` 13/13. Giới hạn: trạng thái là poll 2s (không phải
  push theo event) và chỉ phản ánh delegation trong group — run thường của bot
  vẫn chỉ hiện ở sidebar.
- [x] UI-18 (P2, §3.7): Diff plan so với bản trước — `writePlanFile`
  (`packages/core/src/agent/planning.ts`) snapshot bản cũ vào
  `.open-bot/plans/.history/<projectId>-<timestamp>-<rand>.md` trước mỗi lần ghi
  đè, giữ tối đa 5 bản mới nhất (`PLAN_HISTORY_MAX_VERSIONS`, sắp theo mtime —
  không theo tên file vì nhiều snapshot có thể cùng millisecond); hàm diff
  `diffStringLists`/`diffPlanVersions` (khớp chuỗi chính xác, trùng tính một
  lần); `plans:list` (`apps/desktop/src/main/plans.ts`) đọc bản trước mới nhất
  (`readPreviousPlan`, snapshot hỏng chỉ mất diff) + tính `diff` bằng core để
  renderer chỉ render; `PlanReviewView.tsx` hiện mục `<details>`
  `data-testid="plan-diff"` (tiêu đề + tóm tắt "N thêm · N bớt · N giữ nguyên",
  bước/quyết định thêm màu xanh "+", bớt gạch ngang "−", không đổi thì báo
  "Không thay đổi"). ✅ XONG v0.79b: core `tests/plan-diff-v079.test.mjs` 4/4
  (snapshot + prune 5 + diff + snapshot hỏng chỉ mất diff; chạy lại 3 lần đều
  xanh — lỗi sắp xếp theo tên file lúc đầu đã sửa thành sắp theo mtime) +
  renderer `tests/plan-diff-v079-renderer.test.mjs` 2/2 dưới xvfb (có diff hiện
  đủ thêm/bớt, không diff thì không có mục); i18n `plan.diff*` 7 key mới đủ 6
  locale (1179 → 1186 key/file); `tests/i18n.test.mjs` 13/13;
  `tests/planning.test.mjs` 6/6 + `tests/ui-onboarding-plans-v060.test.mjs`
  16/16 không hồi quy. Giới hạn: diff so khớp chuỗi chính xác (sửa một chữ
  trong bước tính là xoá + thêm, không phải sửa tại chỗ); history chỉ giữ 5 bản.
- [x] UI-19 (P2, §3.8): Responsive/cửa sổ nhỏ — breakpoint 1100/900/720px trong
  `styles.css` (tray 360 → 300px rồi xếp dưới main; sidebar 260 → 220px; bubble
  78% → 92% → 100%; tool-card tương tự; padding/panel thu lại; chat-header/input
  wrap; modal 94vw; cột group-chat xếp chồng); sidebar gập thành icon rail 64px
  (`Sidebar.tsx` prop `collapsed` + nút «/» `data-testid="sidebar-collapse-toggle"`,
  avatar thành nút chọn bot khi gập, dropdown nav rộng 220px để vẫn dùng được;
  `App.tsx` giữ state `sidebarCollapsed`, cửa sổ < 760px bắt đầu ở trạng thái gập,
  không auto-flip khi resize để không chống lại lựa chọn của user; `GroupView`
  bỏ style inline 260px sang class `group-layout/group-side/group-main`).
  ✅ XONG v0.79c: `tests/responsive-v079.test.mjs` 3/3 (breakpoint + class +
  wiring) + renderer `tests/sidebar-collapse-v079-renderer.test.mjs` 2/2 dưới
  xvfb (tên bot hiện khi mở / `display:none` khi gập, rail đúng 64px, avatar
  bấm được khi gập); i18n `sidebar.collapse/expand` đủ 6 locale (1186 → 1188
  key/file; đo lại 2026-11-11: 1.250 key/file × 6 locale — đếm bằng
  python `json.load`, đủ 6 file `apps/desktop/src/renderer/i18n/locales/*.json`);
  `tests/i18n.test.mjs` 13/13; GroupView cũ
  `tests/group-view-v073-renderer.test.mjs` 2/2 + `tests/group-status-v079-renderer.test.mjs`
  2/2 không hồi quy. Giới hạn: chưa có virtualization cho danh sách dài; các view
  panel dài vẫn cuộn dọc như cũ (không đổi layout trong).

### 7.1. Cập nhật số đo hiện tại (đo lại 2026-11-11, HEAD v0.84)

- **Tool/bot: 137** — `tests/coordinator.test.mjs` assert
  `toolCount` 137 (không đổi từ v0.59); các số "~129–134 tool/bot" ở
  §3.5/§4 trên đã sửa thành 137.
- **SettingsView: 1.910 dòng** — `wc -l
  apps/desktop/src/renderer/components/SettingsView.tsx` (v0.59 là
  ~1.512 dòng; tăng do thêm section/tính năng sau v0.59).
- **i18n: 1.250 key/file × 6 locale** — đếm bằng python `json.load`
  trên 6 file `apps/desktop/src/renderer/i18n/locales/*.json`
  (vi/en/zh/ja/es/fr đều đủ 1.250 key; v0.79c là 1.188 key/file).

## 6. Giới hạn của review này

- Chỉ đọc code renderer + docs, không chạy app, không có screenshot Grok Bot thật để
  đối chiếu trực quan. Mọi “thiếu” đều có file/dòng đối chiếu; sóng sau phải kiểm chứng
  bằng smoke Electron thật (CDP) trước khi sửa, đúng quy trình các sóng trước.
- Không đánh giá hiệu năng render (danh sách dài, virtualization) — cần đo thật với
  history dài trước khi kết luận.
- Không rà main-process/menu hệ thống (tray, menu bar, shortcut toàn cục) — ngoài
  phạm vi renderer; nên có một review riêng nếu Huy muốn parity ở mức đó.
