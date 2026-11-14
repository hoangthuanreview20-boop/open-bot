# Survey — v101 T3: Risk budget (risk rating + confirmation policy + conversation budget meter)

Đội T3, sóng v1.01. Base: v0.98 (a37b4d6). Chỉ học Ý TƯỞNG từ OpenHands
(SecurityAnalyzer / ConfirmationPolicy), KHÔNG copy code, text hay tài
sản của bất kỳ repo nào (kể cả xAI/Cursor).

## 1. Ý tưởng học được (mô tả bằng lời của mình)

- **Risk rating trước khi chạy tool:** mỗi tool call được chấm một mức
  rủi ro (low / medium / high) dựa trên *loại tool* + *nội dung args*,
  không chỉ dựa trên tên tool. Đọc file = low; ghi/xoá file = medium;
  chạy shell, gọi mạng ngoài, xoá hàng loạt, thao tác ngoài workspace =
  high. Mức rủi ro là dữ liệu đầu vào cho mọi quyết định duyệt sau đó.
- **Confirmation policy tách khỏi quyền:** quyền (allow/ask/deny theo
  bot, đã có trong `agent/permissions.ts`) trả lời "có ĐƯỢC PHÉP
  không"; policy duyệt trả lời "có cần HỎI NGƯỜI không". Ba mức:
  `AllowAll` (không hỏi thêm), `ConfirmRisky` (chỉ hỏi medium/high),
  `ConfirmAll` (hỏi mọi tool call). Policy không bao giờ nới lỏng một
  lệnh cấm: denylist / hook / guardrail / policy `deny` vẫn chặn trước.
- **Run có trạng thái chờ duyệt:** khi một tool call cần duyệt, run
  chuyển sang trạng thái `WAITING_FOR_CONFIRMATION` (dừng ở biên an
  toàn, không chạy tool, không gọi model tiếp) cho tới khi người dùng
  approve / deny / sửa args. Quyết định được ghi audit log.
- **Budget meter theo conversation:** đếm token + ước tính cost cho
  từng conversation (không phải toàn cục như `usage/` vốn đếm theo
  ngày/tháng/bot), dùng bảng giá theo model đã có (`usage/pricing.ts`),
  cảnh báo khi vượt ngưỡng (vd 80%) và chặn mềm khi vượt cap.

## 2. Hiện trạng trong repo (đã đọc code, không đoán)

- `packages/core/src/approval/`: đã có mức approval theo bot
  (`levels.ts`: ask-always / ask-for-writes / auto-approve-safe),
  rule auto-approve tường minh (`rules.ts`, fail-closed, denylist
  thắng), self-read (`selfRead.ts`).
- `packages/core/src/agent/loop.ts` (`executeCallInner`): thứ tự hiện
  tại là plan-mode guard → tìm tool → PreToolUse hooks (block/modify)
  → permissions (`checkToolCall`, deny thắng, policy `ask`) → nhánh
  hỏi duyệt (gộp `shouldAskForCall` + auto-approve rule + `askApproval`
  qua `events.onApprovalNeeded`) → guardrail tầng tool → `tool.execute`
  → PostToolUse hooks. `askApproval` đã hỗ trợ approve/deny/edit-args
  (`ApprovalDecision`, `types.ts`).
- `packages/core/src/coordinator/coordinator.ts`: `onApprovalNeeded`
  đăng ký pending TRƯỚC khi emit `approval-needed` (tránh race với
  handler trả lời đồng bộ), timeout 10 phút → từ chối; payload đã có
  `reason` + `argsSummary` (đã redact secret). `respondApproval` giải
  quyết pending.
- `packages/core/src/usage/`: `UsageTracker` + `MeteredProvider` đếm
  theo ngày/tháng/tổng, `pricing.ts` có bảng giá USD/1M token cho
  Grok/OpenAI/Anthropic/Gemini + `registerPrice`/`estimateCost`.
  Chưa có meter theo conversation, chưa có cảnh báo ngưỡng.
- `packages/core/src/agent/toolFilter.ts`: `READ_ONLY_TOOLS` (danh
  sách tool chỉ-đọc) + `isReadOnlyTool` — dùng làm nền cho phân loại
  risk theo tool.
- Desktop: `ApprovalCard.tsx` + `ApprovalTray.tsx` hiện thẻ duyệt;
  `types.ts: ApprovalRequest` có `reason`/`argsSummary`, chưa có
  trường risk. i18n 6 locale (en/vi/zh/ja/es/fr), test
  `tests/i18n.test.mjs` bắt buộc mọi locale có đúng cùng key và
  không còn chuỗi Việt hard-code trong renderer.

## 3. Thiết kế của đội T3 (mới, không chạm hành vi cũ)

### 3.1 `packages/core/src/risk/` (module mới, pure + state nhỏ)

- `types.ts` — `RiskLevel`, `RiskAssessment` (level, score 0–100,
  reasons, matchedRuleIds, denied), `RiskRule` (khớp theo tool /
  pattern trên args), `ConfirmationPolicy`, `ConfirmationDecision`,
  `PendingConfirmation`, `BudgetConfig`, `BudgetSnapshot`,
  `BudgetAlert`, `RunState` (`running | waiting-for-confirmation |
  done | ...`).
- `analyzer.ts` — `RiskAnalyzer`:
  - Phân loại nền theo tool: read-only (`isReadOnlyTool`) → low;
    tool ghi file/config/git thường → medium; shell, network egress,
    delete, computer-use, elevate, package-install → high.
  - Rule theo args (bảng built-in, cấu hình được): shell chứa
    `rm -rf`, `sudo`, `mkfs`, `dd`, `curl … | sh`, `chmod 777`,
    ghi/xoá ngoài workspace, xoá hàng loạt (glob/delete nhiều),
    `git push --force` / `reset --hard`, POST ra ngoài, cài package.
  - Cấu hình: `extraRules`, `allowlist` (tool hoặc `tool:pattern` →
    ép low), `denylist` (→ high + `denied: true`). Denylist thắng
    allowlist (fail-closed). Rule không khớp → giữ mức nền.
  - Pure, không I/O, dùng được trong loop/coordinator/CLI/test.
- `policy.ts` — `parseConfirmationPolicy` (lạ/thiếu → `confirm-risky`),
  `decideConfirmation(policy, assessment)`: allow-all → không hỏi;
  confirm-risky → hỏi khi medium/high; confirm-all → hỏi mọi call.
  Policy KHÔNG quyết định cho phép — chỉ quyết định có hỏi không.
- `queue.ts` — `ConfirmationQueue`: state machine cho từng yêu cầu
  duyệt `pending → approved | denied | edited | expired` (edited =
  approved kèm args đã sửa), `create/resolve/expire/listPending`,
  audit log append-only (mỗi quyết định: callId, tool, risk, quyết
  định, thời điểm, actor). Hết hạn mặc định 10 phút → denied.
- `budget.ts` — `ConversationBudgetMeter`: `record(model, in, out)`
  dùng `estimateCost`; `snapshot()` trả token in/out/total, cost
  (null khi model chưa có giá — không bao giờ báo $0 giả), % đã dùng
  so với cap, status `ok | warning | exceeded`, breakdown theo model.
  Ngưỡng cấu hình được (`tokenLimit`, `costLimitUsd`,
  `warnAtRatio` mặc định 0.8); callback `onAlert` bắn đúng một lần
  mỗi lần vượt ngưỡng; `reset()` cho conversation mới.

### 3.2 Tích hợp vào loop (`agent/loop.ts`, `types.ts`)

- `AgentRunnerOptions` thêm: `confirmationPolicy?`,
  `riskAnalyzer?` (mặc định dùng analyzer built-in),
  `confirmationQueue?`, `budgetMeter?`.
- `ToolCall` thêm trường optional `risk?: RiskAssessment` để risk
  theo call tới tận UI.
- Trong `executeCallInner`, sau hooks + permissions, trước nhánh hỏi
  duyệt cũ: phân tích risk; denylist (`denied`) → trả lỗi chặn, không
  hỏi; policy yêu cầu duyệt → ép hỏi dù bot có `autoApprove` hay mức
  approval nói auto (policy là lớp riêng, chỉ siết thêm, không nới).
- Khi chờ duyệt: `runState = 'waiting-for-confirmation'`, bắn qua
  event optional mới `AgentEvents.onRunStateChange` (coordinator/
  CLI không implement vẫn chạy như cũ); sau quyết định trả về
  `running`. Quyết định ghi vào queue audit log (khi có queue).
- Budget: tại chỗ loop đã cộng `tokensUsed` từ `res.usage`, feed
  thêm vào `budgetMeter`; vượt ngưỡng → `onBudgetAlert` (optional).
  `getBudgetSnapshot()` để host/UI đọc.

### 3.3 Tích hợp coordinator (`coordinator/coordinator.ts`)

- Runner của mỗi run nhận: policy từ `bot.confirmationPolicy`
  (field mới trên `BotConfig`, mặc định `confirm-risky`), một
  `RiskAnalyzer` + `ConfirmationQueue` + `ConversationBudgetMeter`
  (cap từ `bot.budgetTokenLimit` / `bot.budgetCostLimitUsd`) riêng
  cho run.
- Payload `approval-needed` thêm `risk` (đánh giá loop đã tính);
  `respondApproval` giải quyết cả queue entry tương ứng.
- Budget alert từ loop → emit event `budget-alert` về renderer.

### 3.4 UI desktop (`apps/desktop/src/renderer/`)

- `ApprovalCard.tsx`: badge risk (màu theo level + lý do) khi
  payload có `risk`; `ApprovalRequest` thêm `risk?`.
- `BudgetMeter.tsx` (mới): progress bar + số token / cost / %
  đã dùng, trạng thái warning/exceeded; nhận snapshot qua event
  `budget-alert`/`budget-update` từ coordinator.
- Settings: policy + cap token/cost cho bot (BotForm / tab bot),
  lưu vào `BotConfig` qua đường lưu bot sẵn có.
- i18n: key mới `risk.*`, `budget.*`, `confirmation.*` đủ 6 locale.

## 4. Rủi ro / giới hạn

- Risk rating là heuristic trên tên tool + args dạng text — không
  thay thế sandbox/guardrail; lệnh shell tinh vi vẫn có thể lọt
  mức medium (ghi rõ trong doc + UI: đây là lớp hỗ trợ duyệt, không
  phải chứng minh an toàn).
- Cost là ước tính từ bảng giá tĩnh; model chưa có giá → cost null.
- Budget meter theo conversation chỉ đếm trong run đang chạy (reset
  mỗi conversation mới); cap ngày/tháng toàn cục vẫn thuộc
  `UsageTracker` cũ, không thay thế.
- Timeout duyệt 10 phút (theo coordinator hiện tại) → deny mặc
  định; queue `expired` ghi audit.
