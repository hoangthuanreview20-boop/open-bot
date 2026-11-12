# Nghiên cứu: A2A protocol, Claude Code / Cursor, LangGraph, OpenAI Agents SDK — đối chiếu & danh sách tích hợp cho open-bot

- **Ngày:** 2026-11-09
- **Phạm vi:** nghiên cứu web (A2A, Claude Code, Cursor, LangGraph, OpenAI Agents SDK) + đọc kiến trúc open-bot hiện tại (`docs/ARCHITECTURE.md`, `docs/ROADMAP.md` — ROADMAP đã 140/140, v0.8; code `packages/core/src`, `packages/tools/src`).
- **Mục tiêu:** pattern nào nên học/thêm vào open-bot, theo thứ tự giá trị. Không sửa code trong tài liệu này; chỉ đề xuất.
- **Nguồn web chính:** a2a-protocol.org (qua các bài tổng hợp spec 1.0), agentskills.io (chuẩn Agent Skills), docs Anthropic về Claude Code (skills/hooks/subagents/plan mode/MCP), tài liệu Cursor (agent modes, rules, background agent), LangChain/LangGraph docs, OpenAI Agents SDK docs.
- **Lưu ý trung thực:** open-bot là app **local-first, bring-your-own-key**, không có cloud. Mọi pattern "cloud" (Background Agent của Cursor, session box phía server) chỉ lấy bản tương đương local, không sao chép hạ tầng server của người khác.

---

## 1. Tóm tắt điều hành

| Bên ngoài có | open-bot đã có (tương đương) | open-bot thiếu / kém hơn | Mức ưu tiên |
|---|---|---|---|
| A2A: Agent Card, task lifecycle, SSE streaming, push notification | `message_agent`/`create_agent` nội bộ qua coordinator; Local API HTTP + WS stream một chiều; webhook HMAC | Không có Agent Card, không discovery, không wire protocol chuẩn — agent ngoài không gọi được open-bot và ngược lại | P0–P1 |
| Claude Code: Agent Skills chuẩn mở (progressive disclosure) | Skill riêng (frontmatter + body, 3 skill built-in, match theo từ khoá, chèn vào system prompt) | Chưa theo chuẩn agentskills.io; nạp **toàn bộ body** vào prompt (không progressive disclosure); không có `scripts/`/`references/`, không `allowed-tools` thực thi, không `context: fork` | **P0** |
| Claude Code: Hooks lifecycle (Pre/PostToolUse…) | Phê duyệt tương tác (approval) + `AgentPermissions` allow/ask/deny + denylist trong sandbox | Không có hook xác định nào: không chặn `rm -rf` tự động, không auto-format/typecheck sau edit, không hook SessionStart/Stop | **P0** |
| Claude Code: Plan mode (chỉ đọc → plan file → duyệt rồi mới làm) | Mode `plan` (trong `chat/plan/grind/review`) + `PlanService` (project + task) + grind checkpoint | Mode `plan` chỉ là gợi ý trong system prompt, **không ép chỉ đọc**, không ghi plan file, không có bước duyệt plan trước khi thực thi | **P0** |
| Claude Code: Subagent chuyên biệt (`.claude/agents/`, tool riêng, context riêng) | Subagent cùng process (`runSubagent`), timeout + AbortSignal, trả về tóm tắt (không làm ô nhiễm context chính) | Subagent con **dùng chung** provider + toàn bộ tool + systemPrompt của bot cha — không có instructions riêng, không giới hạn tool riêng, không model riêng | P1 |
| Claude Code: `CLAUDE.md`/`AGENTS.md` + slash commands | Bot có `systemPrompt` riêng; template agent (6 mẫu) | Không có file quy tắc tự nạp theo workspace; không có slash command | P1 |
| Cursor: Ask / Edit / Agent / Background Agent; `.cursor/rules/*.mdc`; `@codebase`/`@files`/`@docs`; shadow workspace | Mode chat/plan/grind/review; automations + dream (nền); `search_conversations`; semantic search TF-IDF | Không có mode chỉ-đọc thật; không có rules theo file/glob; `@codebase` chỉ là TF-IDF, không phải embedding/vector; không có shadow workspace/worktree; `autoApprove` là bật/tắt toàn cục, không whitelist theo lệnh | P1 |
| LangGraph: graph (node/edge), checkpoint từng bước, interrupt/resume, time-travel | Agent loop tuyến tính ReAct; grind có checkpoint bền trong `BotMemory`; approval chờ 10 phút | Không có graph/workflow khai báo; không checkpoint giữa lượt chạy (crash giữa turn là mất trạng thái giữa chừng); không resume sau khi dừng; không supervisor/swarm | P1–P2 |
| OpenAI Agents SDK: handoff (`transfer_to_X`), guardrails, session, tracing | `message_agent` (giao việc agent khác), `ask_user`, `UsageTracker`/spend limit, log phê duyệt | Handoff không kế thừa hội thoại (chỉ trả tóm tắt); **không có guardrail** (input/output/tool) và **không có tracing** (không xem lại được một run gồm những span nào) | **P0** (guardrails + tracing), P1 (handoff) |
| Chung: 119 tool trong mọi request | ToolRegistry + cache kết quả tool + job queue/worker pool | 119 tool definitions chiếm ~5.500 token/request (ghi chú trong ARCHITECTURE.md); model local context nhỏ sẽ lỗi 400. Chưa có lọc tool theo ngữ cảnh | **P0** |

**Kết luận một câu:** open-bot đã có "thân" rất đầy đủ theo checklist Grok Bot (140/140), nhưng còn thiếu lớp **kỷ luật vận hành** mà Claude Code/LangGraph/OpenAI Agents SDK đã chuẩn hoá: skills chuẩn mở, hooks xác định, plan mode thật, guardrails, tracing, checkpoint/resume — và thiếu lớp **tương tác chuẩn** (A2A) để agent open-bot nói chuyện được với thế giới bên ngoài.

---

## 2. A2A protocol (Google → Linux Foundation, spec 1.0)

### 2.1. Nó là gì

- A2A (Agent-to-Agent) là **wire protocol, không phải framework**: quy định cách một agent tìm thấy agent khác, giao việc, và theo dõi việc đó — bất kể hai agent viết bằng framework nào.
- Google công bố tháng 4/2025, tặng cho Linux Foundation tháng 6/2025; hiện nằm trong Agentic AI Foundation cùng MCP, spec ổn định **1.0** (có bản 1.0.1), 150+ tổ chức ủng hộ.
- Quan hệ với MCP (câu nói chuẩn của Google/Salesforce/Microsoft): **"MCP cho capability (agent ↔ tool), A2A cho collaboration (agent ↔ agent)"** — hai chuẩn bổ sung, không cạnh tranh.

### 2.2. Các khái niệm lõi

- **Agent Card** — file JSON mô tả agent, publish tại `/.well-known/agent-card.json`: tên, mô tả, danh sách skill (mỗi skill có id, tên, mô tả, ví dụ), endpoint (`supportedInterfaces`: URL + protocol binding + version), input/output media types mặc định, `capabilities` (`streaming`, `pushNotifications`), và `securitySchemes`/`securityRequirements` (cách xác thực). Client đọc card trước khi giao việc — đó là discovery.
- **Task** — đơn vị công việc có trạng thái, có id duy nhất, lifecycle chuẩn: `submitted → working → input-required / auth-required → completed / failed / canceled` (và `rejected`). Trạng thái `input-required` là điểm mấu chốt: agent đang chờ người hoặc agent khác làm rõ — tương đương `ask_user` của open-bot nhưng được chuẩn hoá thành trạng thái task.
- **Message** — payload hội thoại (JSON-RPC), nhiều part: text, file, dữ liệu có cấu trúc (form…).
- **Artifact** — kết quả task trả về: text, JSON có cấu trúc, ảnh, video, audio; mỗi part có `mediaType` riêng.
- **Transport** — HTTP(S) + **JSON-RPC 2.0** là chính; spec 1.0 thêm binding gRPC và HTTP+JSON/REST. Mọi request REST mang header `A2A-Version: 1.0`.
- **Tương tác 3 chế độ:** đồng bộ (một request/response); bất đồng bộ polling (`tasks/get`); **streaming qua SSE** (`message:stream` trả về event `task` → `statusUpdate`/`artifactUpdate`, đóng stream khi task tới trạng thái cuối; `/tasks/{id}:subscribe` để bám lại task đang chạy) và **push notification** tới webhook đã đăng ký cho task dài.
- **Tính mờ (opacity):** logic nội bộ của agent phía server cố tình không lộ — client chỉ thấy card + task + artifact. Đúng triết lý local-first của open-bot (key/model của ai người đó giữ).

### 2.3. Đối chiếu với open-bot

| A2A có | open-bot hiện tại | Đánh giá |
|---|---|---|
| Agent Card + discovery tại `/.well-known/agent-card.json` | Không có. Bot chỉ được biết qua `settings.json` local và `marketplace/agents.json` local | **Thiếu hoàn toàn.** Agent ngoài không thể phát hiện open-bot |
| Task lifecycle chuẩn (submitted/working/input-required/completed/…) | Task nội bộ (`BotMemory`: pending/in_progress/done/cancelled) + grind state; `ask_user` là cơ chế hỏi người nhưng không phải trạng thái task chuẩn | Tương đương một phần; thiếu `input-required`/`auth-required` như trạng thái công khai |
| `message:send` / `message:stream` (JSON-RPC, SSE) | Local API: `POST /v1/bots/:id/run` (202 + poll) và WS stream `GET /v1/bots/:id/run/stream` (framing RFC 6455 tự viết, event `delta/toolcall/toolresult/summary/error`) | WS của open-bot là **một chiều, không có message điều khiển** (ROADMAP v0.8 tự ghi: chưa stop được qua socket; run qua WS không trả lời được approval/ask-user). A2A chuẩn hoá đúng chỗ này |
| Push notification qua webhook | Webhook dispatcher đã có (`run.done`, `run.error`, `approval.needed`, `automation.notify`) + ký HMAC-SHA256 + chống replay 5 phút (v0.8) | **Đã tương đương.** Webhook của open-bot có thể làm transport cho A2A push notification |
| Auth theo từng agent (securitySchemes) | Local API: Bearer token Vault + header `X-Open-Bot-Team` (timing-safe); service account token | Đã có nền auth; thiếu khai báo auth theo chuẩn trong card |
| Đa binding (JSON-RPC/gRPC/REST) | NDJSON-RPC riêng qua stdio giữa main ↔ coordinator ↔ daemon (không phải chuẩn ngoài) | RPC nội bộ tốt cho local, nhưng không ai ngoài gọi được |

**Nên học:** Agent Card + task lifecycle + SSE/push là phần có giá trị nhất; không cần gRPC ngay. A2A biến Local API của open-bot từ "API riêng của app" thành "agent nói được chuẩn chung" — đây là bước đưa open-bot từ app desktop thành node trong hệ sinh thái agent.

---

## 3. Claude Code (Anthropic) — skills, hooks, subagents, plan mode, MCP

### 3.1. Sáu primitive mở rộng (theo docs Anthropic)

`CLAUDE.md` (memory file) · Skills · Subagents · Slash commands · Hooks · MCP servers. Plugin = gói đóng gói cả 6 thứ lại (skills + subagents + hooks + MCP config + commands), phân phối qua marketplace.

### 3.2. Agent Skills — nay là chuẩn mở (agentskills.io)

- Một skill là **thư mục** chứa `SKILL.md` (bắt buộc) + `scripts/` + `references/` + `assets/` (tuỳ chọn).
- `SKILL.md` = YAML frontmatter (`name`, `description` — bắt buộc; thêm `license`, `compatibility`, `metadata`, `allowed-tools`) + thân Markdown hướng dẫn. Quy tắc: `name` 1–64 ký tự, lowercase + gạch ngang, **trùng tên thư mục**; `description` 1–1024 ký tự, phải nói **khi nào dùng** skill (đó là trigger); thân nên < 500 dòng / < 5.000 token.
- **Progressive disclosure (3 tầng)** — điểm thiết kế quan trọng nhất:
  1. *Metadata* (lúc khởi động, mọi skill): chỉ `name` + `description`, ~100 token/skill.
  2. *Instructions* (khi task khớp mô tả, hoặc user gọi `/tên-skill`): đọc toàn bộ thân `SKILL.md`.
  3. *Resources* (chỉ khi thân trỏ tới): đọc file `references/`, chạy `scripts/` — trước đó tốn 0 token.
- Claude Code có thêm field riêng: `disable-model-invocation` (chỉ user được gọi), `user-invocable: false` (ẩn khỏi menu `/`), `context: fork` (chạy skill trong subagent riêng).
- Chuẩn công bố tháng 12/2025, tháng 10/2026 tặng cho Agentic AI Foundation; 40+ client hỗ trợ (Claude Code, Codex, Cursor, GitHub Copilot, OpenCode…). Một skill viết một lần dùng được nhiều agent — tính tương tác này là lý do nên theo chuẩn thay vì giữ format riêng.
- Rủi ro đã biết (nghiên cứu 2026): 99%+ file `SKILL.md` cộng đồng có lỗi tác giả; 36% có lỗi bảo mật — skill là **dữ liệu hướng dẫn, có thể bị nhét lệnh độc** nếu cài bừa. Cần validate + quét secret (open-bot đã có `looksLikeSecret` — tốt, giữ lại).

### 3.3. Hooks — automation xác định (deterministic)

- Hook là script chạy **chắc chắn** tại điểm cố định trong vòng đời, ngoài vòng quyết định của model (model có thể "quên" instruction trong prompt, nhưng hook thì luôn chạy). Các event chuẩn: `PreToolUse` (trước tool — validate/chặn/sửa tool call, vd chặn `rm -rf`, chặn refund vượt hạn mức), `PostToolUse` (sau tool — chuẩn hoá output, log, trigger thông báo), `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`, `PreCompact`, `Notification`.
- Hook nhận JSON (tool name, input…) qua stdin, trả JSON quyết định (cho qua / chặn kèm lý do / sửa input). Đây là **lớp an toàn xác định**, khác với approval của open-bot (phụ thuộc người bấm nút mỗi lần).

### 3.4. Subagents

- Một subagent là agent instance riêng: **context window riêng, instructions riêng, tool cho phép riêng**. Làm việc xong trả về **một tóm tắt**, không đổ toàn bộ file đã đọc vào context chính. Dùng cho: explore codebase, review, research song song.
- Định nghĩa trong `.claude/agents/<tên>.md` (frontmatter: tên, mô tả, model, tools cho phép). Pattern tổ chức: **coordinator** chia việc cho các subagent chuyên biệt (search / code / test / docs) + **git worktree** để mỗi agent làm trên bản sao repo riêng, không xung đột file.

### 3.5. Plan mode

- Bật bằng `/plan` hoặc Shift+Tab. Agent **chỉ đọc** (explore codebase, suy nghĩ hướng làm), viết plan ra file, nêu các lựa chọn cần người quyết, rồi **đợi phê duyệt tường minh** mới được sửa code. Đây là "cuộc họp kickoff" trước khi làm — khác hẳn chế độ làm ngay.
- Kèm theo: permission modes (default hỏi trước mỗi lần ghi file/chạy shell; accept-edits; plan; auto — bản research preview dùng classifier Sonnet 4.6 duyệt từng action).

### 3.6. MCP & memory

- MCP client: `.mcp.json` (project) / `~/.claude.json` (user); MCP server là tool ngoài (GitHub, DB, browser…). Claude Code coi MCP là cách agent truy cập hệ thống thật thay vì bản copy paste vào context.
- Memory: `CLAUDE.md` nạp vào context mỗi session (quy ước, lệnh thường dùng) — file, không phải DB. Không nhớ hội thoại cũ theo mặc định.

### 3.7. Đối chiếu với open-bot

| Claude Code có | open-bot hiện tại | Đánh giá |
|---|---|---|
| Skills chuẩn agentskills.io, 3 tầng progressive disclosure | `packages/core/src/skills/`: `types.ts` (frontmatter `name/description/version/when-to-use/tools`), `loader.ts` (parse frontmatter phẳng tự viết, chặn secret, `MAX_SKILL_BODY_CHARS = 4000`), `registry.ts` (3 skill built-in, load user + plugin, enable/disable, match theo **từ khoá** trên tên/when-to-use/description, `applySkills` **chèn toàn bộ body** vào system prompt) | **Gần nhưng kém ở 3 điểm lớn:** (1) không progressive disclosure — skill nào khớp là cả body (tới 4.000 ký tự) vào prompt, càng nhiều skill càng nặng; (2) không có `scripts/`/`references/`/`assets/` — skill chỉ là text, không chạy được script kèm; (3) `tools:` chỉ là gợi ý (types.ts ghi rõ "advisory only — it never grants a tool"), không có `allowed-tools` để giới hạn thật; thiếu field chuẩn `license`/`compatibility`/`metadata`, thiếu `context: fork`, `disable-model-invocation`. Parser frontmatter tự viết chỉ hiểu `key: value`/`[a, b]` — skill chuẩn có YAML lồng nhau sẽ rớt |
| Hooks lifecycle | **Không có hook nào.** Chỉ có: approval tương tác (`onApprovalNeeded`, timeout 10 phút), `AgentPermissions` (allow/ask/deny theo bot), denylist + cwd confinement trong `sandbox.ts` | Approval là "hỏi người mỗi lần", hook là "luật chạy luôn". open-bot không chặn được xác định (vd `rm -rf` trong thư mục làm việc vẫn phải chờ người bấm; không có auto-format/typecheck sau khi sửa file; không có hook lúc SessionStart để nạp context) |
| Plan mode (chỉ đọc + plan file + duyệt) | Mode `plan` (`coordination.ts`: `AGENT_MODES = ['chat','plan','grind','review']`, `set_agent_mode` lưu vào `BotMemory` key `agent:mode`, `run()` chèn gợi ý mode vào system prompt); `PlanService` tạo project + task theo từng bước; grind có checkpoint | **Mode `plan` chỉ là gợi ý prompt, không ép buộc gì:** loop vẫn gọi tool ghi file/shell bình thường; không có plan file; không có bước "duyệt plan rồi mới thực thi". PlanService chỉ lưu trữ plan, không thực thi theo plan |
| Subagent chuyên biệt hoá | `loop.ts runSubagent()`: chạy `AgentRunner` con cùng process, cùng provider + **cùng toàn bộ tools** + cùng `bot` (systemPrompt), timeout 120s mặc định, AbortSignal, kết quả truncate 20.000 ký tự; `subagentStatus()`; tool `delegate`/`ask_user`/… trong `subagentTools.ts` | Tốt ở chỗ context riêng + tóm tắt (đúng tinh thần Claude Code). **Kém ở:** con không có instructions/tool/model riêng — không thể có "reviewer chỉ được đọc" hay "researcher chỉ được web_search"; chạy tuần tự (await), không chạy song song nhiều subagent rồi gộp kết quả |
| `CLAUDE.md` / `AGENTS.md` nạp theo workspace | Không có file quy tắc tự nạp theo workspace. Hướng dẫn nằm trong `BotConfig.systemPrompt` (cấu hình từng bot) | Thiếu: mở workspace mới là agent không biết quy ước repo (lệnh test, style…) trừ khi user gõ tay vào systemPrompt |
| Slash commands | Không có | Thiếu: mọi workflow lặp lại phải gõ lại câu dài |
| Plugin = bundle skills + subagents + hooks + MCP + commands | Plugin (`packages/tools/src/plugins/`): manifest (`id`, version, `main`, `permissions` fs/shell/network/mcp, allowlist `tools`), quét source tĩnh fail-closed, truncate output 20.000 ký tự; skill của plugin chỉ là quy ước thư mục `skills/*.md` (loader.ts ghi rõ manifest **không có field `skills`**) | Plugin open-bot **chỉ mang tool** (+ skill theo quy ước ngầm). Không bundle được subagent/hook/command; chạy in-process, chưa sandbox process riêng (ARCHITECTURE.md tự ghi: obfuscate có thể lách quét text) |
| MCP client | MCP client tự viết (JSON-RPC 2.0, stdio + streamable HTTP, config `.open-bot/mcp.json`, OAuth2 + PKCE + refresh, marketplace 8 server mẫu) | **Ngang hoặc hơn** ở mặt client; thiếu MCP resources/prompts dùng đầy đủ? (đã có tool `mcp_list_resources`/`mcp_read_resource` — đủ dùng) |

---

## 4. Cursor — agent modes, rules, composer, background agent

### 4.1. Các pattern chính (theo tài liệu & thực hành cộng đồng 2026)

- **4 mặt AI:** Composer Agent mode (ReAct loop: sinh action → chạy tool → quan sát → lặp), `@Codebase` semantic retrieval, multi-file session dài, **Background Agent** chạy trên cloud.
- **3 mode + YOLO:** Chat/Ask (chỉ đọc — chẩn đoán, lập plan), Edit/Cmd+K (sửa 1 file, 1–3 tool call), Agent (đa file, chạy terminal, tự lặp tới khi test pass; giới hạn 25 tool call/lượt, 200 ở Max), **YOLO mode** (bỏ mọi hộp thoại xác nhận — chỉ dùng khi đã tin tưởng). Quyết định mode = quyết định mức rủi ro.
- **Rules:** `.cursorrules` cũ (1 file) → `.cursor/rules/*.mdc` mới: Markdown + YAML frontmatter (`description`, `globs`, `alwaysApply`) — rule theo điều kiện, theo phạm vi file, version-control được. Thêm `agents.md` làm file quy tắc chuẩn chung mà nhiều IDE cùng đọc.
- **@-mentions (kiểm soát context):** `@codebase` (tìm vector ngữ nghĩa toàn repo), `@files` (ghim file chính xác), `@docs` (tài liệu bên thứ ba đã ingest: Stripe, Supabase, Tailwind, docs nội bộ), `@past chats` (tham chiếu session cũ thay vì paste lại), `@branch` (lấy trạng thái WIP). Anti-pattern: paste cả codebase vào prompt.
- **Terminal an toàn:** lệnh thường (`npm test`, `tsc`, `git status`) whitelist sẵn; `sudo`/`rm -rf` chặn trừ khi user cho phép tường minh.
- **Background Agent** (từ Cursor 0.50): giao việc rồi làm việc khác; chạy trong môi trường cloud tách biệt, đọc GitHub issue → mở branch → commit → draft PR; cập nhật qua Slack/mobile app; có **spend cap riêng theo task** (Settings → Background Agent → Spend Limits). Rủi ro đã biết: nhiều Background Agent chạy song song = mỗi agent tự upload toàn bộ context repo (repo 150k dòng ≈ 600k token/agent) — cần giới hạn số agent đồng thời + tốc độ khởi chạy.
- **Composer diff view + Shadow Workspace:** agent làm trên bản sao code; hỏng thì file thật không sao. **BugBot:** GitHub App review PR tự động.
- **MCP:** GUI thêm server + `~/.cursor/mcp.json` (global) / `.cursor/mcp.json` (project). **Hooks** (2026): Cursor cũng đã có hooks riêng.
- **Chi phí:** Agent mode đọc lại file + output terminal trước mỗi action; context tích luỹ theo session dài — cần circuit breaker (giới hạn vòng lặp, token, số agent song song).

### 4.2. Đối chiếu với open-bot

| Cursor có | open-bot hiện tại | Đánh giá |
|---|---|---|
| Ask (chỉ đọc) / Edit / Agent / Background Agent | Mode `chat/plan/grind/review`; automations (cron/interval/event) + dream (chạy khi rảnh 15 phút) + grind (làm dài hơi có checkpoint) | **Thiếu mode chỉ-đọc thật** (Ask): `chat` vẫn gọi được mọi tool. Dream/automation là bản tương đương local tốt của Background Agent (không cloud, không tốn tiền upload context) — nhưng dream chỉ "rà soát, chuẩn bị, đề xuất", chưa giao việc dài rồi nhận PR/kết quả như Background Agent |
| Rules theo file/glob (`.cursor/rules/*.mdc`) | Không có rules file | Thiếu; systemPrompt của bot là global, không đổi theo file đang sửa |
| `@codebase` semantic search (vector index) | Semantic search **TF-IDF xếp hạng từ khoá** (v0.2, ARCHITECTURE.md ghi rõ "chưa phải embedding thật"); `search_conversations` (tìm theo từ khoá qua lịch sử các bot) | **Kém hẳn:** TF-IDF không hiểu nghĩa; không có `@files`/`@docs` ghim context; không có vector index của workspace |
| YOLO + whitelist lệnh terminal | `autoApprove` boolean theo bot (bật là duyệt hết, tắt là hỏi hết) + denylist shell trong sandbox | **Thô hơn:** không có mức giữa (whitelist `npm test`/`tsc` chạy ngay, `rm -rf` luôn hỏi). Đây là cải tiến nhỏ mà giá trị lớn |
| Shadow workspace / worktree | `session/box.ts` (workspace riêng + snapshot SHA-256) + `sandbox_prepare` (thư mục tách biệt — ARCHITECTURE.md ghi trung thực: "KHÔNG phải VM/container") | Có nền (session box); chưa dùng worktree git để agent song song không giẫm file nhau |
| Spend cap theo task | Spend limit ngày/tháng/tổng + per-bot (`UsageTracker`, `MeteredProvider`) + usage banner | **Ngang/hơn** ở mặt giới hạn chi tiêu; thiếu cap theo từng task/run |
| Diff review UI (Composer) | Chat UI + approval hiển thị tool + tham số | Không thấy diff view để duyệt thay đổi file trước khi áp (cần kiểm chứng ở renderer; nếu chưa có thì là gap UI) |
| BugBot (review PR tự động) | `code-review` skill + tool `pr_*` (list/create/update/label/code tour) + `ci_investigate` | Có mảnh ghép; chưa có luồng "mở PR → agent review tự động → comment" hoàn chỉnh |

---

## 5. LangGraph (LangChain) — workflow dạng graph có trạng thái

### 5.1. Khái niệm lõi

- **Graph, không phải chain:** workflow là đồ thị có hướng gồm **State** (dict/Pydantic có type, mang dữ liệu qua các bước), **Node** (hàm/agent: LLM call, tool call, quyết định route), **Edge** (chuyển bước, tĩnh hoặc có điều kiện — cho phép **cycle**, tức lặp lại: plan → edit → test → sửa → test lại cho tới khi pass).
- **Reducer:** nhiều node cùng cập nhật một key thì reducer gộp (vd `Annotated[..., operator.add]` để append thay vì ghi đè) — tránh mất dữ liệu khi chạy song song.
- **Checkpointer (persistence):** lưu snapshot state **sau mỗi node**, kèm `thread_id` + `checkpoint_id`. Cho 3 thứ: (1) **resume** — chạy tiếp sau nhiều giờ/ngày, kể cả sau khi restart server; (2) **human-in-the-loop** — `interrupt_before`/`interrupt_after` (dừng trước/sau node nhạy cảm như gửi email, thu tiền) hoặc `interrupt()` giữa node để hỏi người một câu cụ thể, rồi `update_state()` (người sửa cả plan trước khi resume); (3) **time-travel debugging** — quay lại checkpoint cũ, thử hướng khác. Backend: SQLite (dev), Postgres (production, 5–20ms/checkpoint), Redis/DynamoDB (quy mô lớn). In-memory chỉ dùng cho dev.
- **Multi-agent:** 2 pattern — **supervisor** (một agent điều phối, route việc cho specialist) và **swarm** (peer handoff: agent nào cũng có thể chuyển quyền cho agent khác). Khuyến nghị hiện tại của LangChain: build supervisor bằng tool call trực tiếp thay vì dùng gói `langgraph-supervisor` có sẵn.
- **Quy tắc production:** state phải có type (không dict tự do); luôn đặt `recursion_limit` (agent lặp vô hạn sẽ đốt hết quota); checkpoint là bắt buộc nếu có HITL.

### 5.2. Đối chiếu với open-bot

| LangGraph có | open-bot hiện tại | Đánh giá |
|---|---|---|
| Graph có cycle (lặp tới khi xong) | `loop.ts`: vòng lặp tuyến tính `for step < maxSteps (25)` — gọi provider → chạy tool → lặp. Không có node/edge, không có route theo điều kiện, không có cycle có tên | Loop hiện tại đủ cho ReAct đơn giản; **không biểu diễn được** workflow nhiều bước có rẽ nhánh (vd: research → viết → review → sửa → duyệt) mà không nhét hết vào prompt |
| Checkpoint sau mỗi bước + resume | `BotMemory` (SQLite) lưu messages/tasks/goals/projects; grind lưu checkpoint bền + resume được; approval chờ qua RPC (timeout 10 phút) | **Thiếu checkpoint giữa turn:** nếu app/coordinator chết giữa một lượt chạy (đang ở step 7/25), trạng thái giữa chừng mất — chỉ còn lại lịch sử chat. Không resume được một run đang dở; không time-travel |
| Interrupt trước/sau node nhạy cảm + sửa state rồi resume | Approval: dừng cả lượt ngay khi user từ chối; không sửa được tham số tool call rồi cho chạy tiếp | Approval của open-bot là **duyệt/từ chối nhị phân**, không cho sửa. LangGraph cho người sửa state rồi resume — mạnh hơn hẳn cho task dài |
| State có type + reducer | `ChatMessage`/`ToolCall`/`ToolResult` có type; nhưng không có state chung của workflow, không có reducer gộp kết quả song song | Thiếu ở tầng workflow; chưa phải vấn đề ở tầng loop đơn |
| Supervisor / swarm | Coordinator chạy nhiều bot song song (tối đa 4 run, FIFO, 1 bot không chạy 2 turn cùng lúc — v0.8); `message_agent` giao việc; `create_agent` tạo bot mới | Có điều phối song song ở tầng process; **thiếu ở tầng logic**: không có supervisor agent route việc theo năng lực, không có swarm handoff ngang hàng |
| Long-term store (nhớ qua nhiều run) | `LongTermMemory` (`.open-bot/memories.json`, mode 0600) + `memory_remember/recall/forget`, `team_context_summary`, `transcript_archive` | **Đã tương đương** ở mặt lưu trữ; thiếu retrieval theo embedding (recall hiện là từ khoá) |

---

## 6. OpenAI Agents SDK (kế thừa Swarm) — handoff, guardrails, session, tracing

### 6.1. Năm primitive (nhỏ cố ý — chỉ ~4 khái niệm + 2 phần hỗ trợ)

1. **Agent** — LLM + instructions + tools + handoffs. Khai báo, `Runner` sở hữu vòng lặp (chạy tới khi có final output hoặc guardrail chặn).
2. **Handoff** — delegation: model thấy handoff như một **tool call thường** tên `transfer_to_<tên_agent>`; khi gọi, runtime đổi agent giữa chừng (instructions mới, tool mới, **cùng hội thoại**) và chạy tiếp — không cần code routing. Pattern chuẩn: **triage agent** (không có tool, chỉ có handoff) → specialist (instructions chặt, tool hẹp). Có `nest_handoff_history` (gộp lịch sử khi handoff) và cần **hop counter** chống A→B→A lặp vô hạn.
3. **Guardrail** — 3 loại: **input** (chạy trên agent đầu tiên, trước mọi LLM call — chặn yêu cầu ngoài phạm vi/độc hại), **output** (chạy trên agent cho ra kết quả cuối — chặn rò PII, vi phạm policy, sai format), **tool** (chạy mỗi lần gọi function tool — validate tham số, kiểm tra quyền, audit). Chế độ: **parallel** (mặc định — chạy cùng lúc với LLM chính, nhanh nhưng nếu chặn thì phí token đã sinh) hoặc **blocking** (chạy trước, chặn thì không tốn token LLM). Chặn thì ném `InputGuardrailTripwireTriggered` / `OutputGuardrailTripwireTriggered`.
4. **Session** — lưu hội thoại bền qua nhiều turn (`SQLiteSession` có sẵn, `RedisSession` cho production). Lưu ý: session chỉ lưu **theo turn**, không checkpoint giữa chừng tool call — chết giữa chuỗi 5 tool thì resume từ turn cuối, không phải tool cuối.
5. **Tracing** — bật mặc định: mọi LLM generation, tool call, handoff, quyết định guardrail đều thành **span** trong một trace; xem trên dashboard hoặc export qua OpenTelemetry (Logfire, AgentOps, Braintrust…). Có thể gắn thêm processor để fan-out về backend riêng.

### 6.2. Đối chiếu với open-bot

| Agents SDK có | open-bot hiện tại | Đánh giá |
|---|---|---|
| Handoff `transfer_to_X`, kế thừa hội thoại | `message_agent` (qua coordinator run; bot bận thì queued) + `create_agent` + subagent (trả tóm tắt) | **Kém ở điểm cốt lõi:** handoff thật giữ nguyên hội thoại cho agent nhận; open-bot chỉ chuyển "nhiệm vụ" rồi nhận lại tóm tắt — agent nhận không thấy ngữ cảnh đầy đủ. Không có triage pattern, không có hop counter (subagent timeout 120s là giới hạn duy nhất) |
| Guardrails 3 loại, parallel/blocking | **Không có guardrail.** Chỉ có: approval (người duyệt), `AgentPermissions` (allow/ask/deny theo tên tool), `redactBearer`/`redactSecrets` (không log token), `looksLikeSecret` (chặn secret trong skill), denylist shell | Đây là **lỗ hổng lớn nhất về an toàn vận hành**: không có lớp nào kiểm tra *nội dung* input/output (PII, prompt injection trong web_fetch, output chứa secret) một cách tự động. Approval chỉ kiểm tra *hành động*, không kiểm tra *nội dung* |
| Session (SQLite/Redis) | `BotMemory` SQLite (messages + tasks + …) — lưu bền theo bot | **Đã tương đương** cho single-machine; thiếu Redis/multi-worker (không cần vì local-first) |
| Tracing (span cho mọi bước) | **Không có tracing.** Chỉ có log phê duyệt/từ chối + log thường (v0.5 đã audit `console.*`: 5 dòng main + 0 dòng core) | **Thiếu hoàn toàn.** Khi một run sai, không có cách nào xem lại "model đã gọi tool nào, với tham số nào, guardrail nào đã chạy, handoff nào đã xảy ra" dưới dạng trace có cấu trúc. Debug hiện tại dựa vào log rời rạc + lịch sử chat |
| Structured output | Không thấy trong code đã đọc (provider trả `text` + `toolCalls` tự do) | Thiếu: kết quả cuối không ép được schema (vd bắt buộc trả JSON `{verdict, fixes[]}` cho code-review) |

### 6.3. Ghi chú thêm: CrewAI / AutoGen (đã xem xét, không chọn làm framework chính)

- **CrewAI:** mạnh ở khái niệm role-based crew (agent có role/goal/backstory, task có output xác định, crew chạy tuần tự/hierarchical) — nhưng pattern này open-bot đã có gần đủ qua template agent (6 mẫu) + PlanService; giá trị học thêm thấp.
- **AutoGen (Microsoft):** mạnh ở multi-agent conversation (nhiều agent trò chuyện với nhau, code executor, group chat) — nhưng thiên về nghiên cứu, nặng nề; pattern group-chat ít phù hợp app desktop local-first hơn handoff của OpenAI SDK.
- **Kết luận chọn:** LangGraph (graph + checkpoint) và OpenAI Agents SDK (handoff + guardrails + tracing) là hai framework cho pattern đáng học nhất cho open-bot.

---

## 7. Bảng đối chiếu tổng hợp — open-bot đã có / thiếu / kém hơn

| Lĩnh vực | Đã có (tốt) | Thiếu / kém hơn |
|---|---|---|
| Agent loop | ReAct loop, maxSteps 25, approval, permissions, subagent tóm tắt | Không có graph, không checkpoint giữa turn, không resume, không compaction khi context dài |
| Tools | 119 tool, ToolRegistry validate + chống trùng tên, cache read-only, sandbox + denylist | 119 tool nạp hết mỗi request (~5.500 token); không lọc theo ngữ cảnh; semantic search chỉ TF-IDF |
| Skills | Format gần giống Agent Skills, chặn secret, enable/disable, match từ khoá | Không chuẩn agentskills.io; không progressive disclosure; không scripts/references; `tools:` không thực thi |
| Hooks | — (không có) | Toàn bộ lifecycle hook xác định |
| Plan mode | Mode `plan` + PlanService + grind checkpoint | Plan mode không ép chỉ đọc, không plan file, không duyệt plan |
| Subagent | Context riêng, timeout, abort, tóm tắt | Không chuyên biệt hoá (chung tool/prompt/model), không chạy song song + gộp |
| Agent-to-agent | `message_agent`, `create_agent`, `read_agent_transcript`, coordinator song song (4 run) | Không có chuẩn A2A; không handoff kế thừa hội thoại; không supervisor/swarm |
| Memory | SQLite + LongTermMemory + team summary + transcript archive | Recall theo từ khoá (không embedding); không compaction/tóm tắt tự động |
| An toàn | Approval, permissions, Vault mã hoá, NO_STORAGE, redact secret, spend limit | Không guardrail nội dung; không tracing; plugin in-process (chưa sandbox OS) |
| Tích hợp ngoài | MCP client + OAuth, Local API HTTP + WS, webhook HMAC, Slack/Gmail/Teams, GitHub PR | WS một chiều (không control message); không Agent Card/discovery |
| Quy tắc workspace | Template agent, systemPrompt theo bot | Không file `AGENTS.md` tự nạp; không rules theo glob; không slash command; không `@`-mention |

---

## 8. Danh sách tích hợp — ưu tiên theo giá trị

Độ khó: **S** = nhỏ (≤ 1–2 ngày, sửa ít file, ít rủi ro) · **M** = vừa (vài ngày, thêm module mới hoặc đổi wiring) · **L** = lớn (thiết kế lại một tầng, cần test kỹ). Thứ tự trong mỗi nhóm là thứ tự nên làm.

### P0 — Làm trước (giá trị cao nhất, nền cho mọi thứ khác)

| # | Tên | Tóm tắt | Độ khó | File cần sửa / thêm |
|---|---|---|---|---|
| P0-1 | **Skills theo chuẩn Agent Skills (agentskills.io)** | Đổi format skill sang đúng chuẩn mở: frontmatter `name`/`description` (+ `license`, `compatibility`, `metadata`, `allowed-tools`), thư mục skill có `scripts/` + `references/` + `assets/`; **progressive disclosure 3 tầng** (chỉ nạp `name`+`description` lúc khởi động, đọc body khi khớp, đọc/chạy resource chỉ khi cần); thêm `context: fork` (skill chạy trong subagent) và `disable-model-invocation`. Lợi ích kép: giảm token prompt (skill không dùng tốn ~100 token thay vì 4.000 ký tự) và skill open-bot dùng được ở Claude Code/Cursor/Codex. | M | `packages/core/src/skills/types.ts`, `loader.ts` (parser YAML thật thay cho parser phẳng; hỗ trợ thư mục skill thay vì chỉ file `.md` lẻ), `registry.ts` (match + nạp theo tầng), wiring nạp skill trong coordinator/main (hiện `applySkillsForTask` chèn toàn bộ body) |
| P0-2 | **Hooks lifecycle xác định** | Thêm hệ hook chạy chắc chắn ngoài vòng quyết định của model: `PreToolUse` (chặn/sửa tool call — vd chặn `rm -rf`, chặn ghi ngoài workspace), `PostToolUse` (auto-format sau sửa file, chạy typecheck/lint, log), `SessionStart` (nạp context), `SessionEnd`/`Stop`. Hook là script JS/TS khai báo trong settings hoặc plugin; nhận JSON, trả quyết định cho qua/chặn/sửa. Đây là lớp an toàn mà approval (hỏi người) không thay thế được. | M | Mới: `packages/core/src/hooks/` (`types.ts`, `registry.ts`, `runner.ts`); sửa `packages/core/src/agent/loop.ts` (`executeCall`: gọi Pre/PostToolUse), `packages/tools/src/sandbox.ts` (denylist hiện tại chuyển thành hook mặc định); nối IPC + Settings UI bật/tắt hook |
| P0-3 | **Plan mode thật (chỉ đọc → plan file → duyệt)** | Mode `plan` phải **ép chỉ đọc**: loop chặn mọi tool ghi/shell khi ở plan mode; agent viết plan ra file (Markdown trong workspace, có các bước + lựa chọn cần quyết); user duyệt plan (duyệt/sửa/từ chối) rồi mới chuyển sang mode `chat` để thực thi. Tận dụng `PlanService` đã có để lưu plan. | S–M | `packages/core/src/agent/coordination.ts` (mode `plan` + trạng thái plan), `packages/core/src/agent/loop.ts` (chặn tool ghi khi plan mode), `packages/tools/src/planTools.ts` (tool ghi/duyệt plan), renderer (màn hình duyệt plan) |
| P0-4 | **Lọc tool theo ngữ cảnh (giải quyết 119 tool / ~5.500 token)** | Đừng gửi cả 119 tool mỗi request: lọc theo bot (tool allowlist đã có ở `AgentPermissions`), theo skill đang bật (`allowed-tools`), theo mode (plan mode chỉ cần tool đọc), và/hoặc gom tool theo nhóm (vd `file.*` thành một tool điều phối). Ghi chú trong ARCHITECTURE.md đã cảnh báo model local context 4.096 token sẽ lỗi 400 — đây là lỗi đang chờ xảy ra với user dùng Ollama. | M | `packages/tools/src/registry.ts` (thêm `filter`/nhóm tool), `packages/core/src/agent/loop.ts` (chọn tool theo turn), `packages/core/src/coordinator/coordinator.ts` (dựng registry theo bot/mode), `packages/core/src/agent/permissions.ts` (mở rộng allowlist thành filter mặc định) |
| P0-5 | **Guardrails (input / output / tool)** | Thêm lớp kiểm tra nội dung tự động, chạy trước/sau LLM và trước mỗi tool call: input (chặn prompt injection trong `web_fetch`/paste, chặn yêu cầu ngoài phạm vi), output (chặn rò PII/secret/token trong câu trả lời cuối), tool (validate tham số, kiểm tra quyền — bổ sung cho approval). Hỗ trợ 2 chế độ: blocking (rẻ, chạy trước) và parallel (nhanh). Bắt đầu bằng guardrail **không dùng model**: regex/quy tắc (secret, PII, đường dẫn ngoài workspace); sau đó mới thêm guardrail dùng model nhỏ. | M | Mới: `packages/core/src/guardrails/` (`types.ts`, `registry.ts`, `builtin.ts`); sửa `packages/core/src/agent/loop.ts` (gọi guardrail ở đầu/cuối turn + trước tool), `packages/core/src/util/redact.ts` (tận dụng hàm redact đã có) |
| P0-6 | **Tracing nội bộ cho mỗi run** | Ghi mỗi run thành một trace có cấu trúc (JSONL local): span cho LLM call, tool call (tên + tham số + thời gian), handoff, quyết định guardrail/approval, lỗi. Có màn hình xem lại run (timeline) trong renderer. Không gửi đi đâu (local-first). Đây là nền để debug mọi tính năng khác. | S–M | Mới: `packages/core/src/tracing/` (`tracer.ts`, `store.ts` — JSONL trong userData); sửa `packages/core/src/agent/loop.ts` (emit span), `packages/core/src/coordinator/coordinator.ts` (gắn traceId theo run); renderer (màn hình xem trace) |

### P1 — Làm tiếp (mở rộng năng lực rõ rệt)

| # | Tên | Tóm tắt | Độ khó | File cần sửa / thêm |
|---|---|---|---|---|
| P1-1 | **A2A server tối thiểu (Agent Card + task + SSE)** | Publish Agent Card tại `/.well-known/agent-card.json` trên Local API (mô tả bot, skill, capabilities, auth); thêm endpoint `message:send` / `message:stream` (SSE: `task` → `statusUpdate`/`artifactUpdate`) và `tasks/get`; task có lifecycle chuẩn (`submitted/working/input-required/completed/failed/canceled`). Tận dụng webhook HMAC đã có làm push notification. Không cần gRPC ở bước này. | L | Mới: `packages/core/src/a2a/` (`card.ts`, `server.ts`, `tasks.ts`, `types.ts`); sửa `packages/core/src/api/server.ts` (thêm route), `packages/core/src/api/types.ts` |
| P1-2 | **A2A client (gọi agent ngoài)** | Tool + client đọc Agent Card của agent khác, gửi task qua JSON-RPC, theo dõi qua SSE/polling, nhận artifact về. Mở ra: open-bot giao việc cho agent chuyên biệt bên ngoài (và ngược lại). Cần UI nhập URL agent + lưu card đã tin tưởng. | M–L | Mới: `packages/core/src/a2a/client.ts`; mới: `packages/tools/src/a2aTools.ts` (tool `a2a_send`/`a2a_status`…); sửa `packages/tools/src/registry.ts` (đăng ký tool A2A) |
| P1-3 | **Handoff chuẩn kiểu OpenAI Agents SDK** | Thêm tool `transfer_to_<tên_bot>` do runtime sinh tự động từ danh sách bot; khi model gọi, đổi agent giữa chừng **giữ nguyên hội thoại** (không chỉ gửi nhiệm vụ + nhận tóm tắt như `message_agent` hiện tại); thêm hop counter chống lặp A→B→A; pattern triage (bot điều phối không tool, chỉ handoff) làm template mới. | M | `packages/tools/src/agentTools.ts` / `subagentTools.ts` (sinh handoff tool), `packages/core/src/agent/loop.ts` (chuyển agent giữa turn, giữ messages), `packages/core/src/agent/templates.ts` (template triage) |
| P1-4 | **Subagent chuyên biệt hoá** | Cho phép định nghĩa subagent riêng (như `.claude/agents/`): instructions riêng, tool allowlist riêng, model riêng, timeout riêng; coordinator chạy nhiều subagent **song song** rồi gộp kết quả. Hiện subagent con dùng chung mọi thứ của cha. | M | `packages/core/src/agent/templates.ts` (định nghĩa subagent), `packages/core/src/agent/loop.ts` (`runSubagent` nhận config riêng), `packages/tools/src/subagentTools.ts` (tool delegate theo tên subagent), `packages/core/src/coordinator/coordinator.ts` (chạy song song) |
| P1-5 | **Checkpoint / resume giữa turn (kiểu LangGraph)** | Lưu snapshot trạng thái run (messages + tool calls đã xong + step hiện tại) vào SQLite **sau mỗi bước** của loop; khi app/coordinator chết hoặc user dừng, resume được từ đúng bước đó thay vì làm lại từ đầu. Kèm `interrupt_before` cho tool nhạy cảm: dừng, cho người sửa tham số, rồi resume. | L | `packages/core/src/agent/loop.ts` (checkpoint sau mỗi step), `packages/core/src/agent/memory.ts` (bảng `run_checkpoints`), `packages/core/src/coordinator/coordinator.ts` (RPC resume/listRuns) |
| P1-6 | **File quy tắc workspace (`AGENTS.md`) + @-mentions** | Tự nạp `.open-bot/AGENTS.md` (hoặc `AGENTS.md` ở root workspace) vào system prompt mỗi turn; thêm `@files` (ghim file), `@docs` (tài liệu đã ingest), `@past-chats` (đã có `search_conversations` — chỉ cần nối vào UI). Đây là pattern rẻ nhất để agent hiểu quy ước từng repo. | S–M | `packages/core/src/agent/loop.ts` (`run()`: nạp AGENTS.md), `packages/core/src/agent/memory.ts` hoặc mới `packages/core/src/rules/` (load + cache file quy tắc), renderer (gợi ý @-mention trong ô chat) |
| P1-7 | **Rules theo file/glob + auto-approve theo lệnh (kiểu Cursor)** | Thay `autoApprove` boolean toàn cục bằng 3 mức: whitelist lệnh an toàn (`npm test`, `tsc`, `git status`…) chạy ngay; lệnh nhạy cảm luôn hỏi; còn lại theo policy bot. Thêm rules theo glob (vd rule "mọi file `*.ts` phải chạy typecheck sau khi sửa"). Gắn với P0-2 (hooks) — rule là cấu hình, hook là thực thi. | S–M | `packages/core/src/agent/permissions.ts` (mở rộng thành rule engine nhỏ), `packages/tools/src/sandbox.ts` (whitelist/denylist theo lệnh), Settings UI |
| P1-8 | **Workflow graph khai báo (kiểu LangGraph, bản nhẹ)** | Thêm module workflow: định nghĩa workflow bằng các node (agent call / tool call / điều kiện / phê duyệt) + edge, có cycle (lặp tới khi test pass), chạy trên cùng loop hiện tại. Bắt đầu với 2 workflow mẫu: research → brief và plan → edit → test → fix. Không cần port LangGraph — tự viết bản nhẹ đúng nhu cầu local. | L | Mới: `packages/core/src/workflow/` (`types.ts`, `graph.ts`, `runner.ts`, `builtins.ts`); sửa `packages/core/src/coordinator/coordinator.ts` (chạy workflow như một run) |
| P1-9 | **Semantic search bằng embedding thật** | Thay TF-IDF trong semantic search bằng embedding local (Ollama `nomic-embed-text` hoặc tương đương) + lưu vector trong SQLite (hoặc file riêng); dùng cho `@codebase` và `memory_recall`. Đây là điều kiện để `@codebase` của Cursor hoạt động thật. | M | `packages/tools/src/codeTools.ts` (semantic search), `packages/core/src/memory/longterm.ts` (recall theo embedding), `packages/core/src/providers/ollama.ts` (endpoint embedding) |
| P1-10 | **WS control messages (stop/pause) + trạng thái `input-required`** | WS stream hiện một chiều: thêm message điều khiển từ client (`{type: "stop"}`, `{type: "answer", ...}` cho approval/ask-user) và event `input-required` khi agent chờ người. Đóng gap mà ROADMAP v0.8 đã ghi ("WS chưa có message điều khiển; run qua WS không trả lời được approval/ask-user"). | S–M | `packages/core/src/api/server.ts` (parse message client, nối vào run), `packages/core/src/coordinator/coordinator.ts` (stop/answer qua RPC đã có `respondApproval`/`respondAskUser`) |

### P2 — Làm sau (giá trị thật nhưng tốn kém hoặc chờ P0/P1)

| # | Tên | Tóm tắt | Độ khó | File cần sửa / thêm |
|---|---|---|---|---|
| P2-1 | **Plugin bundle kiểu Claude Code (skills + subagents + hooks + MCP + commands)** | Mở rộng manifest plugin: một plugin được mang skill, định nghĩa subagent, hook, MCP server config, slash command — cài một lần là có cả bộ. Cần P0-1 (skills chuẩn) và P0-2 (hooks) xong trước. | M–L | `packages/tools/src/plugins/types.ts` + `loader.ts` + `manager.ts` (manifest mở rộng, load từng loại), `packages/core/src/skills/loader.ts` (bỏ quy ước ngầm `skills/`) |
| P2-2 | **Slash commands** | Lệnh `/tên` gọi workflow/skill có sẵn (vd `/review-pr`, `/brief`); định nghĩa bằng file Markdown trong workspace hoặc plugin; hỗ trợ tham số. Rẻ, nhưng chỉ có giá trị khi đã có nhiều skill/workflow (P0-1, P1-8). | S | Mới: `packages/core/src/commands/`; sửa renderer (gợi ý `/` trong ô chat), coordinator (chạy command như một turn) |
| P2-3 | **Shadow workspace / git worktree cho agent song song** | Mỗi agent song song làm trên worktree/branch riêng (git worktree) hoặc session box riêng, gộp lại sau; tránh giẫm file nhau. Cần P1-4 (subagent song song) xong trước. | M–L | `packages/core/src/session/box.ts` (mở rộng thành worktree), `packages/tools/src/gitTools.ts` (worktree create/merge), `packages/core/src/coordinator/coordinator.ts` |
| P2-4 | **Compaction / tóm tắt ngữ cảnh tự động** | Khi lịch sử turn vượt ngưỡng token, tự tóm tắt phần cũ thành bản ghi nhớ (giữ lại quyết định + file đã đổi), rồi tiếp tục với bản tóm tắt — thay vì chạm trần context rồi lỗi. Có thể dùng model rẻ/local để tóm tắt. | M | `packages/core/src/agent/loop.ts` (kiểm tra độ dài trước mỗi step), `packages/core/src/memory/longterm.ts` (lưu bản tóm tắt), `packages/core/src/agent/memory.ts` |
| P2-5 | **Structured output cho kết quả cuối** | Cho phép bot/tool khai báo JSON Schema cho output cuối (vd code-review bắt buộc trả `{verdict, findings[]}`); provider ép model trả đúng schema; validate trước khi giao cho user. | S | `packages/core/src/types.ts` (thêm `outputSchema` vào BotConfig/Provider), `packages/core/src/providers/*.ts` (truyền schema — OpenAI/Anthropic/Gemini đều hỗ trợ), `packages/core/src/agent/loop.ts` (validate) |
| P2-6 | **Supervisor / swarm (đa agent có điều phối)** | Một supervisor agent route việc cho các specialist theo năng lực (dựa trên mô tả skill/Agent Card của từng bot); hoặc swarm handoff ngang hàng. Chỉ nên làm sau P1-3 (handoff) và P1-1 (Agent Card để mô tả năng lực bot). | L | Mới: `packages/core/src/workflow/supervisor.ts`; sửa `packages/core/src/agent/templates.ts`, `packages/core/src/coordinator/coordinator.ts` |
| P2-7 | **Skill marketplace / cài skill từ URL/git** | Cho phép cài skill từ repo git/URL (như marketplace agent đã có), kèm xác minh (hash + quét secret + xem trước nội dung trước khi cài). Cảnh báo: 36% skill cộng đồng có lỗi bảo mật (nghiên cứu 2026) — phải có bước duyệt nội dung, không cài mù. | M | `packages/core/src/agent/marketplace.ts` (mở rộng sang skill), `packages/core/src/skills/loader.ts` (validate trước khi cài) |
| P2-8 | **Sandbox process riêng cho plugin (out-of-process)** | Chuyển plugin từ in-process sang tiến trình riêng (như daemon/coordinator đã làm) để code plugin độc không đọc được bộ nhớ app/key. ARCHITECTURE.md đã ghi đây là wave 2; làm sau P2-1. | L | `packages/tools/src/plugins/` (runner process riêng + RPC, theo mẫu `packages/tools/src/daemon/`), `packages/core/src/coordinator/coordinator.ts` |

---

## 9. Những thứ KHÔNG nên sao chép

| Pattern | Vì sao không làm theo |
|---|---|
| Background Agent chạy trên cloud của Cursor (upload cả repo lên server họ) | Trái local-first; open-bot đã có dream/automation + grind chạy trên máy user — đủ cho bản local, không cần server |
| Session box phía server của Grok Bot | Đã có bản tương đương local (`session/box.ts`); VM/container thật chỉ là metadata, không cố giả vờ là cloud |
| Định tuyến model / thử nghiệm A/B phía server | Model registry local (`models.json`) đã thay thế; quyết định model là của user |
| Port nguyên LangGraph / OpenAI Agents SDK vào open-bot | Hai framework đó là Python-first, thiên server; open-bot là TypeScript + Electron local. Chỉ lấy **pattern** (graph, checkpoint, handoff, guardrail, tracing), tự viết bản nhẹ đúng kiến trúc hiện tại |
| Cài skill/plugin từ nguồn lạ không kiểm chứng | Skill là hướng dẫn model tin tưởng; skill độc = prompt injection. Luôn xem trước nội dung + quét secret trước khi cài (P2-7) |

---

## 10. Đề xuất thứ tự triển khai (gợi ý cho coordinator)

1. **Đợt 1 (nền an toàn + tiết kiệm token):** P0-4 (lọc tool) → P0-2 (hooks) → P0-5 (guardrails) → P0-6 (tracing). Bốn mục này làm open-bot **an toàn hơn và rẻ hơn ngay**, không đổi UX.
2. **Đợt 2 (năng lực làm việc):** P0-1 (skills chuẩn) → P0-3 (plan mode thật) → P1-6 (AGENTS.md) → P1-7 (auto-approve theo lệnh).
3. **Đợt 3 (đa agent):** P1-3 (handoff) → P1-4 (subagent chuyên biệt) → P1-5 (checkpoint/resume) → P1-8 (workflow graph).
4. **Đợt 4 (chuẩn mở):** P1-1 + P1-2 (A2A server + client) → P1-10 (WS control) → P1-9 (embedding thật).
5. **Đợt 5 (mở rộng):** các mục P2 theo nhu cầu thực tế; ưu tiên P2-4 (compaction) và P2-5 (structured output) vì rẻ.

## Nguồn tham khảo

- A2A spec & tổng hợp: a2a-protocol.org; github.com/a2aproject/A2A; các bài giải thích spec 1.0 (Agent Card tại `/.well-known/agent-card.json`, task lifecycle, SSE `message:stream`, push notification).
- Agent Skills: agentskills.io (chuẩn mở, 12/2025; về Agentic AI Foundation 10/2026); Anthropic "Equipping agents for the real world with Agent Skills".
- Claude Code: docs Anthropic (skills, hooks, subagents, plan mode, MCP, plugins); các guide thực hành 2026 (operational patterns, workflow mastery).
- Cursor: docs & guide 2026 (Agent/Edit/Chat mode, `.cursor/rules/*.mdc`, `@codebase`/`@files`/`@docs`, Background Agent, YOLO, Shadow Workspace, spend limits).
- LangGraph: LangChain docs (StateGraph, checkpointer, `interrupt_before`/`interrupt_after`/`interrupt()`, supervisor/swarm); các guide production 2026 (checkpointing, HITL, time-travel).
- OpenAI Agents SDK: docs OpenAI (Agent/Handoff/Guardrail/Session/Tracing; `transfer_to_<agent>`; `InputGuardrailTripwireTriggered`); các bài production 2026 (handoff-first, guardrail parallel/blocking, tracing/OTel).
- Code open-bot đã đọc: `packages/core/src/agent/loop.ts`, `coordination.ts`, `planning.ts`, `memory.ts`, `permissions.ts`; `packages/core/src/skills/{types,loader,registry}.ts`; `packages/core/src/api/server.ts`; `packages/core/src/memory/longterm.ts`; `packages/tools/src/registry.ts`, `subagentTools.ts`, `sandbox.ts`; `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`.
