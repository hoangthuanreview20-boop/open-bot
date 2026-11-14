# Survey v1.01 — T6: nested subagents + fan-out/grader + Agent SDK query()

Branch: `v101-t6`, base `a37b4d6` (v0.98). Chỉ học Ý TƯỞNG từ các hệ
thống khác (Claude Code Agent SDK `query()`, mô hình subagent lồng nhau,
fan-out + chấm điểm theo rubric) — không copy code, text hay tài sản nào.

## 1. Cái đã có trong base v0.98 (đọc code, không đoán)

- `packages/core/src/agent/loop.ts` — `AgentRunner.runSubagent()` (private):
  spawn runner con cùng process, cùng provider, `forkDepth + 1`.
  `forkDepth` chỉ chặn fork-skill (`FORK_DEPTH_LIMIT = 0`); còn
  `delegate_task` thì KHÔNG có giới hạn độ sâu — một agent con gọi
  `delegate_task` mãi sẽ lồng vô hạn (chỉ dừng khi timeout/model dừng).
- `packages/core/src/agent/subagent.ts` (v0.12) — subagent chuyên biệt:
  spec riêng (instructions/tool subset/model/timeout), chạy song song
  bằng runner tiêm vào, gộp kết quả + phát hiện xung đột heuristic.
  Pure, không gọi provider trực tiếp — mẫu thiết kế tốt, T6 giữ nguyên
  và xây thêm trên nó thay vì viết lại.
- `packages/core/src/subagents/roles.ts` (v0.37) — role registry
  (researcher/coder/reviewer/planner/tester + custom), con kế thừa
  registry của cha nên role dùng được ở mọi tầng lồng.
- `packages/tools/src/subagentTools.ts` — `delegate_task`,
  `list_subagent_roles`, `agent_status`, `stop_agent`, …; `ToolContext`
  có `runSubagent` / `runSpecializedSubagents` / `subagentStatus`.
- `AgentRunner.runSpecializedSubagents()` — nối runner thật vào
  `runSpecializedSubagentsParallel` rồi gộp bằng `mergeParallelResults`.
- Chưa có: giới hạn depth/spawn budget, theo dõi context budget theo
  cây subagent, grader theo rubric, API `query()` lập trình được.

## 2. Thiết kế của T6 (module mới, bổ sung — không viết lại cái có sẵn)

### (a) Nested subagents — `packages/core/src/subagents/nested.ts` (pure)

- `NestedSubagentPolicy`: `maxDepth` (mặc định 5 — root depth 0, con
  sâu nhất depth 5), `maxSpawnsPerRoot` (mặc định 50 node/cây),
  `maxSpawnsPerBranch` (mặc định 10 con trực tiếp/một cha),
  `contextBudgetTokensPerNode` (mặc định 32_000),
  `contextBudgetTokensTotal` (mặc định 128_000),
  `denyConcurrentDuplicateTasks` (mặc định true).
  Ước lượng token dùng chung `estimateTokens` của `agent/tokens.ts`.
- `SubagentTree`: registry cây — node `{ id, parentId, name, depth,
  status, task, model, tools, tokensUsed, budgetTokens, spawnsUsed,
  startedAt, endedAt, error }`. `requestSpawn(parentId, task, name)`
  trả về `{ ok } | { ok: false, reason }` — MỘT chỗ duy nhất quyết định
  có được spawn không: depth cap, per-root budget, per-branch budget,
  total context budget (ước lượng task mới), task trùng đang chạy
  cùng cha (dấu hiệu vòng lặp spawn). `recordTokens / recordEstimate`,
  `completeNode`, `snapshot()` (cây lồng nhau, cho UI + tool).
  Mỗi node có `budgetTokens` RIÊNG (mặc định = policy per-node,
  spawn ghi đè qua `SubagentOptions.contextBudgetTokens`).
- Loop còn ENFORCE budget: sau mỗi round, node subagent (depth > 0)
  vượt budget riêng thì dừng turn của nó với thông báo `[context
  budget]` rõ ràng (run gốc depth 0 không bị dừng); provider không
  trả usage thì ước lượng token từ text của round để budget vẫn
  được theo dõi.
- Chống vòng lặp = 4 lớp: depth cap + spawn budget (root + branch) +
  context budget tổng + chặn task trùng đang chạy. Không lớp nào dựa
  vào model tự dừng.
- Context isolation: mỗi node có context riêng vì mỗi runner con đã có
  messages riêng; tree chỉ theo dõi ước lượng token (usage thật từ
  provider khi có, ước lượng chars/4 khi không) và gắn cờ `overBudget`.

### (b) Fan-out + rubric grader — `grader.ts` + `fanout.ts` (pure)

- `Rubric { id, name, criteria[], passThreshold }`,
  `RubricCriterion { id, label, description, weight, maxScore }`,
  `GradeResult { totalScore, maxScore, ratio, passed, perCriterion[],
  feedback }`. Điểm = tổng có trọng số; `passed = ratio >= threshold`.
- Grader là hàm tiêm vào `GraderFn(output, rubric) => GradeResult`:
  `createKeywordGrader(rules)` — chấm xác định bằng keyword, dùng cho
  test/CI không cần LLM; `createLlmGrader(callModel)` — gọi model trả
  JSON `{ scores, comments }`, parse fail-closed (không parse được =
  điểm 0 + feedback rõ, không đoán).
- `runFanOutWithGrading(runner, tasks, rubric, { concurrency,
  maxRounds, grader, onEvent })`: chạy song song có giới hạn đồng thời
  (semaphore, mặc định 4), chấm từng kết quả, task chưa đạt được gửi
  lại kèm feedback của grader (task mới = task cũ + feedback), tối đa
  `maxRounds` vòng (mặc định 3). Trả về lịch sử từng vòng + kết quả
  cuối từng task. Dùng lại `runSpecializedSubagent` (timeout + lỗi
  không kéo sập nhóm) thay vì viết executor mới.

### (c) Agent SDK query() — `packages/core/src/sdk/query.ts`

- `query(prompt, options): QueryHandle` — chạy `AgentRunner` trong
  chính process gọi. `options`: `provider` (tiêm sẵn — test dùng fake,
  script dùng mock) hoặc `providerId + apiKey + model` (tạo qua
  `createProvider`), `tools`, `maxTurns`, `systemPrompt`,
  `workspaceDir`, `autoApprove` (mặc định false — fail-closed, tool
  cần duyệt bị từ chối thay vì treo), `signal`, `subagentPolicy`
  (chính sách nested cho run), `onEvent`.
- `QueryHandle` là async iterable của `QueryEvent` (`text` /
  `tool_call` / `tool_result` / `subagent` / `done { text, usage,
  turns }` / `error`) + `.result(): Promise<QueryResult>` + `.abort()`.
  Event được đẩy từ `AgentEvents` của runner vào hàng đợi nội bộ —
  không sửa loop. Dùng được từ script/CI: `scripts/query-sdk-example.mjs`
  (mock provider mặc định, provider thật qua env khi có key).

### (d) Tích hợp loop.ts (tối thiểu, cộng thêm)

- `AgentRunnerOptions` += `subagentPolicy?`,
  `parentSubagent?: { tree, nodeId }`. Runner root tự tạo cây mới;
  runner con nhận cây + node của cha. `runSubagent()` hỏi cây trước
  khi spawn (bị chặn → trả chuỗi lỗi `[subagent …] lỗi: …` như lỗi
  role, không spawn); sau khi con xong thì `completeNode` + ghi token.
  `runLoop` ghi `res.usage` vào node của chính nó mỗi round.
- `ToolContext` += `subagentTree?` (snapshot) và
  `runFanOutWithGrading?`; `AgentRunner.runFanOutWithGrading()` nối
  `runSubagent` thật vào `fanout.ts` (cùng mẫu `runSpecializedSubagents`).
- `packages/tools/src/nestedSubagentTools.ts`: `list_subagent_tree`
  (đọc cây + budget) và `fanout_tasks` (chạy fan-out có chấm điểm qua
  ctx; rubric truyền bằng JSON, grader keyword mặc định, LLM grader
  khi host nối model). Không có wiring thì trả lỗi rõ, không crash.

### (e) UI + i18n + CLI

- `apps/desktop/src/renderer/components/SubagentTreeView.tsx` (+
  `subagentTreeUtils.ts` pure cho test): cây lồng nhau, badge trạng
  thái từng node, depth/token/grade, cảnh báo over-budget. Mọi chuỗi
  qua `t()` — không hard-code tiếng Việt trong component (luật i18n
  test); key mới `subagentTree.*` + `grader.*` thêm đủ 6 locale
  (en/vi/es/fr/ja/zh), placeholder khớp nhau.
- `apps/cli`: subcommand `query` dùng SDK (mock mặc định, provider
  thật qua env `OPENBOT_<PROVIDER>_API_KEY`) + script
  `scripts/query-sdk-example.mjs` (mock + tool demo, provider thật qua
  env `OPENBOT_QUERY_*`).

## 3. Test

- `tests/nested-subagent-v101.test.mjs` — policy/guard (depth, budget
  root/branch, task trùng, context budget), budget riêng từng node,
  tree snapshot, enforcement budget qua loop thật.
- `tests/fanout-grader-v101.test.mjs` — chấm rubric (keyword + LLM
  JSON lỗi), fan-out retry tối đa N vòng, concurrency cap, fan-out qua
  `AgentRunner.runFanOutWithGrading` thật.
- `tests/sdk-query-v101.test.mjs` — query() với fake provider: stream
  event, tool call, abort, maxTurns, autoApprove=false từ chối tool,
  spawn lồng + treeSnapshot.
- `tests/nested-subagent-tools-v101.test.mjs` — 2 tool mới: parse args,
  nối ctx, lỗi rõ khi thiếu wiring.
- `tests/subagent-tree-ui-v101.test.mjs` — key i18n mới đủ 6 locale,
  không có tiếng Việt hard-code trong component, helper flatten cây.
- `tests/cli-query-v101.test.mjs` — CLI `query` thật (mock): text,
  --json, lỗi thiếu prompt/key, --help.
- Loop integration test: spawn lồng qua `AgentRunner` thật với mock
  provider — depth cap chặn ở tầng loop (test riêng trong file nested,
  dùng `createMockProvider`).

## 4. Giới hạn đã biết trước

- Token ước lượng (`estimateTokens` dùng chung) chỉ là ước lượng khi
  provider không trả `usage`; provider trả usage thật thì dùng số thật.
- Grader LLM chỉ tốt bằng model chấm; keyword grader chỉ kiểm tra
  được tiêu chí diễn đạt bằng từ khoá.
- `query()` chạy trong process gọi (như thiết kế) — không phải
  process riêng; cô lập process là việc khác (sandbox đã có).
- UI tree chỉ hiển thị snapshot được truyền vào (host/desktop nối sau);
  component không tự lấy dữ liệu từ main process.
