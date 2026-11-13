# UI + Planning — v0.96 (Team T6)

## Làm gì

- **Command palette v2** (`CommandPalette.tsx` + `fuzzySearch.ts` +
  `paletteRecent.ts`): fuzzy search tự viết, không dependency —
  subsequence match, chấm điểm word-start / consecutive / start-of-text,
  không dấu (tiếng Việt), xếp hạng tốt nhất lên đầu. Nhóm mới:
  **actions** (tạo bot, mở tool, đổi model, mở settings, chạy
  automation, mở chat nhóm) + **recent** (8 lệnh gần nhất, localStorage,
  chỉ hiện khi chưa gõ gì). Keyboard cũ giữ nguyên (↑/↓/Enter/Esc);
  palette mở thêm 2 màn mới: Dashboard, Planner.
- **Dashboard** (`DashboardView.tsx` + `dashboardStats.ts`): 9 card
  (bot, runs hôm nay, token ước tính, tool calls, lỗi, memory blocks,
  router decisions, Composio connected, automations) + top 5 tool hôm
  nay + bảng theo từng bot. Chỉ đọc store đã có (harness thread log,
  `usage:get`, `memory:status`, `composio:get-state`,
  `automations:list`) — không gọi mạng, không IPC mới. Nguồn nào
  chưa có thì card hiện "—" chứ không vỡ màn hình.
- **Bot management** (`botManager.ts`, nối vào `Sidebar.tsx` +
  `App.tsx`): pin (lên đầu, theo thứ tự ghim), unread (chấm xanh khi
  bot stream trong lúc user đang ở bot khác, mở bot thì hết),
  duplicate (id mới + " (copy)"), hide/unhide, copy conversation ID
  (thread id, fallback bot id). Meta lưu localStorage
  (`open-bot:bot-meta`), không đụng bot config.
- **Planning flow** (`packages/core/src/planning/` +
  `planStore.ts` + `PlanView.tsx`): plan = các step có trạng thái
  pending/running/done/failed/skipped; dispatch multi-agent (giao bước
  cho bot — bước đã gán cho bot đó trước, rồi bước chưa gán cũ nhất;
  mỗi bot chạy tối đa 1 step, `release` trả step về pending khi bot
  đi mất); **stuck-state detector** — cùng tool call 3 lần liên tiếp
  trong 1 step, hoặc 3 step liên tiếp xong mà không có step nào done
  → banner báo + gợi ý bước tiếp (thử tool khác / hỏi user / bỏ qua
  bước / lập lại). Store không tự dừng run nào — user quyết.
  Plan của UI lưu localStorage (`open-bot:plans-v096`); engine core
  in-memory + `toJSON`/`fromJSON` để coordinator dùng sau.

## Không làm (giới hạn còn lại)

- PlanView chưa nối vào coordinator run thật: dispatch mới đổi trạng
  thái trong UI, chưa gửi step cho bot chạy qua `coordinator.run()`.
  Stuck detector của UI ghi nhận tool call qua `recordUiToolCall`
  nhưng chưa có ai gọi nó từ stream tool-call thật (cần nối
  `onToolCall` của App vào plan đang chạy). Tool-call history đã giữ
  qua reload (`parsePlanStore` khôi phục lại, có test + smoke CDP
  banner kẹt từ plan seed).
- Dashboard đọc tối đa 100 dòng log/bot (`LOG_LIMIT`); bot chạy
  nhiều hơn thì số runs/tool-calls hôm nay là số đếm trong cửa sổ
  đó. Router decisions chỉ đếm entry nào log ghi rõ (`payload.router`
  hoặc lifecycle `decision: 'route'`).
- i18n: key động `planner.status.*` / `planner.suggestion.*` đã khai
  thêm tay trong `tests/i18n.test.mjs` (kiểu TaskPanel).

## Kiểm chứng

- `node --test tests/ui-planning-v096.test.mjs tests/i18n.test.mjs`:
  **34/34 pass** (21 test mới + 13 i18n).
- Smoke CDP `tests/ui-planning-v096-renderer.test.mjs`: **4/4 pass**
  (dashboard cards, mở bot từ bảng, tạo plan → dispatch → hoàn
  thành, banner kẹt từ plan seed). Harness cũ Sidebar 5/5 pass
  (không hồi quy).
- `npm run build` + `npm run typecheck`: xanh (4 workspace).
- i18n: 1678 → **1773 key/locale** (+95, 6/6).

## File chính

- `packages/core/src/planning/engine.ts`, `stuck.ts`, `index.ts`
- `apps/desktop/src/renderer/components/fuzzySearch.ts`,
  `paletteRecent.ts`, `botManager.ts`, `dashboardStats.ts`,
  `planStore.ts`, `DashboardView.tsx`, `PlanView.tsx`,
  `CommandPalette.tsx` (v2), `Sidebar.tsx`, `App.tsx`
- `tests/ui-planning-v096.test.mjs`, `tests/i18n.test.mjs` (key động)
