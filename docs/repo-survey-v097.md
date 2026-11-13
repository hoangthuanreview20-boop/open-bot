# Repo survey v0.97 — 2026-11-13

Nghiên cứu cho sóng v0.97 (base: main 46c1178, 191.126 dòng TS, 187 tool, i18n 1923 key/locale, 3454 test).
CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. MCP 2.0 — spec 2026-07-28 (lớn nhất từ lúc ra mắt 11/2024)

- Core stateless: bỏ `initialize` handshake và header `Mcp-Session-Id`; mọi request tự mang
  protocol version + client capabilities trong `_meta`; thêm `server/discover`.
  Hệ quả: bất kỳ server instance nào cũng trả lời được bất kỳ request nào — scale như web service thường.
- Server-initiated callbacks giữa request (sampling, elicitation, roots) BỊ BỎ, thay bằng
  Multi Round-Trip Requests (SEP-2322): server trả result kèm `resultType` mô tả nhu cầu
  còn thiếu, client gọi follow-up. Mỗi round trip độc lập, stateless.
- Sampling / Roots / Logging bị deprecate (SEP-2577): vẫn chạy, không xóa trước 2027-07-28,
  nhưng implementation mới không nên dùng; server nên gọi LLM API trực tiếp, log ra stderr/OTel.
- Extensions thành cơ chế chính thức: Tasks (long-running: server trả handle, client poll)
  và MCP Apps (server trả interactive HTML render trong sandboxed iframe) — Apps ra mắt
  26/01/2026, là extension chính thức đầu tiên.
- Auth: OAuth issuer (iss) validation bắt buộc; auth chạy trên mọi request, không còn 1 lần/session.
- Governance: MCP về Agentic AI Foundation (Linux Foundation) 12/2025; tháng 10/2026 ecosystem
  vẫn nói 5 revision spec khác nhau cùng lúc — tương thích ngược là vấn đề thật.
- Bảo mật 2026: đa số server public quét được có pattern file-op dễ path traversal; một phần
  dính command injection/SSRF; có case tool description poisoning (tấn công nằm trong text model đọc).
- → v0.97 T1: transport stateless + MRTR + Tasks extension + MCP Apps render + deprecate
  sampling/roots/logging có shim tương thích + quét description poisoning cho tool registry.

## 2. A2A v1.0 — agent-to-agent (Google, Linux Foundation)

- v1.0 stable 03/2026, v1.0.1 05/2026; gia nhập Agentic AI Foundation 17/08/2026 cùng MCP.
  150+ tổ chức hỗ trợ (04/2026). ACP của IBM đã merge vào A2A, repo archive.
- Mỗi agent publish Agent Card (có ký số, version negotiation, multi-tenancy) mô tả skill;
  work chạy dưới dạng Task với state working / input-required / completed / failed;
  binding JSON-RPC 2.0, gRPC, HTTP+JSON; streaming + push notification.
- Nguyên tắc opacity: agent A không cần biết agent B dùng LangGraph hay gì bên trong —
  chỉ gửi task, nhận kết quả. Khác MCP: MCP là agent→tool, A2A là agent→agent.
- → v0.97 T2: Agent Card (ký số) + A2A client (gửi task sang agent ngoài) + A2A server
  endpoint (expose bot open-bot thành agent A2A) + task lifecycle + delegation bot-bot qua A2A,
  mặc định chỉ loopback.

## 3. AG-UI 1.0 — agent-to-user interface (CopilotKit)

- Python + TypeScript packages đạt 1.0 tháng 09/2026. Protocol event-based: backend agent
  emit stream event có type (~16 event chuẩn) qua SSE/WebSocket/webhook, frontend consume.
- Trả lời: user xem và điều khiển agent đang chạy như thế nào — state, bước trung gian,
  component tương tác (generative UI) — thay vì chỉ thấy text cuối.
- Ba giao thức là một stack, không cạnh tranh: MCP agent→tool, A2A agent→agent, AG-UI agent→user.
  Thêm ACP của Zed (agent→editor, JSON-RPC 2.0) và A2UI (agent khai báo cấu trúc UI, host render an toàn).
- → v0.97 T3: AG-UI event bus trong core (định nghĩa event types của open-bot theo chuẩn),
  runtime emit event, renderer consume thành live activity feed + generative UI,
  transport SSE cho frontend ngoài.

## 4. Memory thế hệ mới — Letta / Mem0 v3 / Zep-Graphiti

- Letta (MemGPT): agent TỰ sửa memory của mình bằng tool; core memory = block có label,
  description, value, giới hạn ký tự, biên dịch vào mọi prompt; archival = vector store agent
  tự search/insert; recall = lịch sử hội thoại. Block chia sẻ được giữa các agent, có read-only.
- Sleep-time agents (Letta): agent nền review hội thoại gần đây, consolidate điều quan trọng,
  cập nhật memory ngoài vòng lặp chính — trigger sau N bước hoặc khi context bị compact.
- Mem0 v3 (04/2026): pipeline 2 bước LLM — extraction (fact từ từng turn) rồi consolidation
  (so với memory cũ: add / update / delete từng fact); scope user_id / agent_id / run_id;
  claim LOCOMO +26% accuracy vs OpenAI memory, p95 latency −91%, token −90%.
  Graph memory: facts + entity graph; OpenMemory MCP expose store cho MCP client.
- Zep / Graphiti: temporal knowledge graph — entity + relationship có validity window
  (bi-temporal), build tăng dần từ episode; hybrid search (semantic + BM25 + graph);
  claim +18,5% accuracy trên LongMemEval.
- OWASP ASI06: Memory & Context Poisoning là rủi ro thật — memory phải có provenance + quota.
- → v0.97 T4: sleep-time consolidation + temporal KG (entity/relation/validity window,
  hybrid search) + provenance + quota; nối với memory blocks v0.96 (không thay thế).

## 5. OpenMausBot — harness v2 (ý tưởng, không copy)

- Hai process: app (React+Tailwind) gửi typed command qua HTTP, nhận 1 SSE event stream;
  harness server 127.0.0.1:8799 sở hữu mọi agent process, chuẩn hoá protocol từng provider
  thành 1 canonical runtime event stream, log NDJSON theo thread.
- Driver registry: 1 driver / provider CLI (claude / codex / grok) + custom engine qua Settings.
  Model picker per-bot, đổi model giữa hội thoại.
- Routines + webhooks: schedule và signed hook queue việc khi laptop ngủ; local receiver
  127.0.0.1:8800. Tailscale serve / managed tunnel / Docker+Caddy để expose có kiểm soát.
- Headless `openmausbot run` cho job kiểu CI; MCP server expose control plane có giới hạn
  (không export credential). Per-bot computer: cloud Linux desktop (Boat) / Local VM / own computer
  (macOS, Ubuntu Xorg sau opt-in; Wayland vẫn tắt vì issue #345).
- Cảnh báo upstream: API key trong config là plaintext 0600, không mã hoá at-rest.
- → v0.97 T5: webhook receiver có ký + queue, routines v2, headless CLI mode,
  export NDJSON event bus, health probe per-bot computer.

## 6. Provider còn thiếu (API, đối chiếu packages/core/src/providers)

- Đã có: anthropic, gemini, ollama, openai, openai-compatible, xai + CLI drivers
  (claude, codex, aider, copilot, cursor, kiro, opencode, geminiCli, grok, continue,
  windsurf, amazonQ, ACP).
- Chưa có API provider riêng: DeepSeek, Moonshot/Kimi, Qwen (Alibaba), Mistral, Groq,
  Together, Cohere — đa số tương thích OpenAI API, cần preset riêng (baseURL + model list
  + Vault key namespace + Settings UI + docs), không copy key từ đâu.
- → v0.97 T6: 7 provider preset + tool mới (git workflow, file search sâu, browser automation
  mở rộng) + i18n đầy đủ.

## Ưu tiên sóng v0.97 (6 đội)

| Đội | Hệ thống | Ước lượng |
|-----|----------|-----------|
| T1 | MCP 2.0: stateless + MRTR + Tasks ext + MCP Apps | ~5.000 dòng |
| T2 | A2A v1.0: Agent Card + client + server + delegation | ~5.000 dòng |
| T3 | AG-UI 1.0: event bus + live feed + generative UI | ~5.000 dòng |
| T4 | Memory v2: sleep-time + temporal KG + provenance | ~5.000 dòng |
| T5 | Harness v2: webhook + routines v2 + headless CLI + NDJSON | ~5.000 dòng |
| T6 | Provider mới (7) + tool mới + i18n | ~5.000 dòng |

Mục tiêu chu kỳ: +30.000 dòng TS thật. Nút thắt đã biết: máy 1,5 CPU (v0.96 chỉ +14.401).
Giới hạn đứng: không dữ liệu X, không Grok Imagine, không cloud VM/tài khoản/thanh toán,
local-first, miễn phí, công khai; live ảnh Gemini KHÔNG thử lại (quota ảnh key miễn phí = 0).
