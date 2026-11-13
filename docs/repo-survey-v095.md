# Repo survey v0.95 — học ý tưởng từ OpenMausBot + 5 repo agent khác

> Đọc ngày 2026-11-12 (README + bài phân tích công khai). **Ý TƯỞNG ONLY — không
> copy code/text/asset của bất kỳ repo nào; mọi thứ port sang open-bot đều viết
> lại hoàn toàn.** Hướng mới của Huy (19:19 cùng ngày): não = model nào cũng
> được; không cần dữ liệu X; không cần Grok Imagine; bỏ cloud VM / tài khoản /
> thanh toán — miễn phí, local-first, công bố công khai.

## 1. OpenMausBot — milind-soni/OpenMausBot (tham chiếu chính)

- Apache 2.0 (riêng thư mục `enterprise/` là source-available). Tạo 2026-08-11.
  ~21.529 sao, 9.918 commit, 111 release, TS + React 19 + Electron + Vite +
  Tailwind. Trước đây tên OpenGrokBot.
- Kiến trúc: app React (không transport riêng) → HTTP + 1 SSE stream → harness
  server 127.0.0.1:8799 → driver registry (CLI `claude`/`codex`/`grok`:
  stream-JSON / JSON-RPC / ACP) + permission broker + event bus (NDJSON
  per-thread). Dữ liệu `~/.openmausbot`.

### Inventory tính năng (đối chiếu open-bot v0.94)

| Tính năng | Trạng thái ở open-bot | Ghi chú |
|---|---|---|
| Pick a brain per bot: model picker + provider rail, đổi model giữa hội thoại, provider thiếu thì dim + lý do | ĐÃ CÓ tương đương (model picker v0.90a) | — |
| Every bot gets a computer: cloud Linux desktop (Boat), Local VM, host control macOS/Ubuntu Xorg opt-in, Wayland fail-closed | ĐÃ CÓ local VM + host probe | Cloud Boat KHÔNG port (trái hướng mới) |
| Bots ask before they act: approval cards inline Allow/Deny, permission broker | ĐÃ CÓ | — |
| Connected apps: Composio Sessions marketplace 500+ app, OAuth 1 lần | ĐÃ CÓ (22 toolkit) | — |
| Manage bots like chats: pin/unread/duplicate/hide/delete, copy conversation ID | ĐÃ CÓ phần lớn | Kiểm tra pin/unread còn thiếu |
| Keys once: secrets write-only, UI chỉ thấy flag "configured", provider fleet hot-reload | ĐÃ CÓ tương đương (Vault) | Hot-reload provider là ý hay |
| Channels: Work/Personal/project, mỗi channel có transcript + shared instructions + working folder + responder rules + bot roster riêng | CHƯA CÓ | Đáng port v0.96+ |
| Jev — fast decisions: model nhỏ (Cloudflare Workers AI / TypeSafe Jev / OpenRouter) tự chọn bot phù hợp cho tin nhắn trong vài trăm ms, fallback lead | CHƯA CÓ | Ý hay: router rẻ + nhanh, local-first (Ollama qwen2.5:0.5b làm decision model) |
| Install team từ 1 file Markdown (BotMRR): YAML frontmatter + playbook Markdown, review screen trước khi tạo | ĐÃ CÓ portable team bundle JSON (v0.80) | Định dạng Markdown portable là ý hay |
| Share whole department: 1 file, KHÔNG chứa history/key/model/computer, strip secret | ĐÃ CÓ tương đương (team bundle) | — |
| Org library + preset bots | CHƯA CÓ | Fleet đã có; org template là bước tiếp |
| Bots that talk back: TTS ElevenLabs/Fish Audio/Grok/Mac voices/local Chatterbox; "call" 2 chiều; dictation on-device Apple STT / Fish Audio STT; mascot; screenshot gập vào transcript | ĐANG LÀM ở v0.95 D3 + TTS local đã có | — |
| MCP server stdio cho client ngoài: inspect bots/channels, đọc transcript, tạo bot/task, gửi việc, chờ xong, đổi model, interrupt — KHÔNG expose approval/deletion/settings/credentials/computer lifecycle | ĐÃ CÓ MCP marketplace + local API | MCP server cho client ngoài là ý port được |
| CLI cho scripts/CI: team apply, run 1 job, chờ xong, export JSON, exit code | ĐÃ CÓ headless CLI | Mở rộng run/export theo mẫu này |
| Triggers: schedules (1 lần / weekday / mỗi 5–1440 phút, skip khi run trước chưa xong, advanced run limit) + webhooks (receiver riêng 127.0.0.1:8800, secret chỉ hiện 1 lần, Bearer) + app events (Composio → queue → long poll, Gmail poll 15 phút, 500 events/ngày) | ĐÃ CÓ phần lớn | Webhook receiver riêng + app-event long poll là ý hay |
| Desktop-to-desktop companion qua Tailscale; evals/; skills/; usage meter | CHƯA CÓ | Companion qua Tailscale là ý hay cho fleet |
| Bảng Desktop capability status (ma trận năng lực theo OS) | CHƯA CÓ | Ý hay cho docs QA |

## 2. OpenManus — FoundationAgents/OpenManus (~58k sao, MIT, Python)

- Agent = state machine + ReAct loop + tools; BaseAgent (Pydantic) có lifecycle
  idle/running/finished/error + **stuck-state detector** (phát hiện agent lặp lại).
- ToolCallAgent: chuyển model tool-call thành action đã ghi log. Tool collection
  có tên. LLM client đa provider 1 interface.
- Planning flow: phân rã prompt thành step plan có theo dõi, giao cho nhiều
  agent (`run_flow.py`, ghi là unstable, timeout 3600s).
- Sandbox container cho code rủi ro; MCP agent (stdio/SSE); DataAnalysis agent
  (phân tích + vẽ biểu đồ, mặc định tắt); Browser Use CLI làm MCP server mặc định.
- Ý port: stuck-state detector, planning flow đa agent có step tracking,
  DataAnalysis agent, sandbox container (đã có cgroup/VM; container là bổ sung).

## 3. OpenHands — All-Hands-AI/OpenHands (~65k sao, MIT, Python)

- CodeAct: reasoning của model dịch thẳng thành shell action trong Docker
  sandbox (shell + FS + headless browser thật).
- **Event Stream Architecture**: mọi observation/action/tool-call/model-response
  là event stream bất biến → observability đầy đủ + session rollback.
- Micro-agents: Planner / Coder / Execution / Browser chuyên biệt, orchestrator
  điều phối. LiteLLM routing 100+ provider; SWE-bench top open-source; GitHub
  Action mode; ACI (Agent-Computer Interface) — tool có cấu trúc cho file
  edit/lint/shell/diff.
- Ý port: event-stream bất biến + rollback session (open-bot có EventLog NDJSON
  — nâng thành event sourcing thật), micro-agent chuyên biệt, verify loop chạy
  test sau khi sửa code.

## 4. Letta — letta-ai/letta (~24k sao, Apache 2.0; gốc MemGPT, UC Berkeley)

- LLM-as-OS: context window = RAM, external store = disk, agent = kernel quản
  lý paging.
- 3 tầng memory: **Core** (blocks `human`/`persona` ghim vào system prompt,
  agent tự sửa bằng `core_memory_append`/`replace`, attach/detach + share giữa
  agents) → **Recall** (toàn bộ transcript, `conversation_search`) →
  **Archival** (`archival_memory_insert`/`search`, vector).
- Self-editing memory: agent tự quyết nhớ gì (chủ động, khác RAG bị động).
- Đang pivot sang MemFS (git-backed markdown memory FS) + Letta Code + App Server.
- Ý port: memory blocks ghim system prompt + self-editing tools (khớp D4 v0.95),
  memory blocks share giữa bot, MemFS (memory dạng file Markdown trong git —
  rất hợp local-first).

## 5. mem0 — mem0ai/mem0 (~64k sao, Apache 2.0, TS/Python)

- Memory layer: `add()` trích fact bền từ hội thoại (LLM pass, quyết định
  ADD/UPDATE/DELETE) → hybrid store (vector + KV theo user/agent/app/run +
  graph entities) → `search()` xếp hạng theo relevance/importance/recency.
- Thuật toán 04/2026: single-pass ADD-only, entity linking, multi-signal
  retrieval (semantic + BM25 + entity, fused), temporal reasoning.
  Vendor-reported: LoCoMo 92.5, LongMemEval 94.4, ~7K tokens, ~1s p50.
- Multi-level memory: User/Session/Agent, adaptive personalization; self-hosted
  server; tích hợp LangGraph/CrewAI/OpenAI agents.
- Ý port: pipeline extract → reconcile → retrieve (khớp D4), hybrid retrieval
  (semantic + BM25 + entity), temporal reasoning, memory scoping
  user/session/agent (khớp D4).

## 6. Aider — Aider-AI/aider (~44k sao, Apache 2.0, Python)

- **Repo Map**: tree-sitter parse toàn repo → graph file/symbol (nodes=file,
  edges=import/call) → PageRank ranking → top symbol vừa token budget (mặc định
  1024 tokens) chèn vào mọi prompt. Mở rộng động khi chưa có file trong context.
- Edit formats: format text chuyên biệt theo model; Architect mode (model mạnh
  plan + model rẻ edit); git-native: mỗi sửa = 1 commit + message AI, `/undo`;
  self-correction loop (chạy test/lint, đọc stack trace, sửa tới khi xanh);
  voice input; web page/image làm context.
- Ý port: repo map PageRank (open-bot đã có `code_symbols` tree-sitter v0.86 —
  nâng thành repo map có ranking + token budget), architect mode 2 model,
  self-correction loop với test runner (khớp OpenHands verify loop), edit format
  theo model.

## Ưu tiên port cho v0.96+ (xếp theo giá trị/công sức)

- **P1**: Memory blocks kiểu Letta + self-editing tools (nối tiếp D4) — nền đã
  có ở v0.95.
- **P1**: Repo map PageRank kiểu Aider (nâng `code_symbols`) + token budget.
- **P1**: Jev-style fast decision router local (Ollama nhỏ) — rẻ, khác biệt rõ.
- **P2**: Channels kiểu OpenMausBot (context riêng + roster + responder rules).
- **P2**: Event-stream bất biến + rollback kiểu OpenHands — nâng EventLog.
- **P2**: Planning flow đa agent có step tracking kiểu OpenManus + stuck detector.
- **P2**: Hybrid retrieval mem0 (semantic + BM25 + entity) + temporal reasoning.
- **P2**: Micro-agents chuyên biệt (Planner/Coder/Browser) kiểu OpenHands.
- **P3**: Team Markdown portable (BotMRR-style) — bổ sung team bundle JSON.
- **P3**: MCP server cho client ngoài (bounded, không expose approval/credentials).
- **P3**: MemFS (memory = file Markdown trong git) kiểu Letta.
- **P3**: Architect mode 2 model kiểu Aider.
- **KHÔNG port**: cloud VM/Boat, tài khoản/thanh toán, hosted relay (trái hướng
  mới: bỏ cloud, miễn phí, local-first).
