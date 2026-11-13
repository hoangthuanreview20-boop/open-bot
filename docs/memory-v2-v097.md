# Memory v2 — v0.97 (Team T4)

Memory thế hệ mới cho open-bot: sleep-time consolidation, temporal
knowledge graph, hybrid search, provenance + quota. Ý tưởng học từ
Letta (sleep-time agents, agent tự sửa memory bằng tool),
Mem0 v3 (pipeline extraction → consolidation, graph memory) và
Zep/Graphiti (temporal knowledge graph, hybrid search) — CHỈ HỌC Ý
TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của
xAI/Cursor. NỐI VỚI memory blocks v0.96, KHÔNG thay thế chúng.

## Thành phần

| File | Vai trò |
|---|---|
| `packages/core/src/memory/provenance.ts` | Nguồn gốc + quota + phát hiện nghi ngờ/mâu thuẫn + trust score |
| `packages/core/src/memory/graph.ts` | Temporal knowledge graph (entity/relation, bi-temporal) + export/import Markdown |
| `packages/core/src/memory/hybridSearch.ts` | BM25 + semantic (Ollama, fallback keyword) + graph traversal |
| `packages/core/src/memory/sleepAgent.ts` | Sleep-time consolidation agent + hook sau turn |
| `packages/tools/src/memoryV2Tools.ts` | 8 tool mới cho agent tự quản memory |
| `apps/desktop/src/renderer/components/MemoryV2View.tsx` | Tab "Memory v2" trong MemoryView |
| `apps/desktop/src/main/main.ts` | 4 kênh IPC `memory-v2:*` |

## 1. Sleep-time consolidation agent

Agent nền review hội thoại SAU KHI turn kết thúc, không bao giờ chạy
trong turn:

- **Trigger**: sau N bước (`stepsThreshold`, mặc định 20), khi context
  bị compact (`runOnCompact`), hoặc chạy tay (tool `memory_sleep_run`,
  UI "Run now").
- **Mặc định TẮT** (`enabled: false`). Không bật thì không chạy gì.
- **Từ chối mock/CLI**: provider `mock` và provider kind `cli` không
  bao giờ được ghi memory (bài học hồi quy v0.96 — router mặc định
  BẬT route cả bot mock sang Ollama thật). `shouldRunForBot()` là
  cổng chặn duy nhất, dùng chung cho tool, UI và hook coordinator.
- **Trích xuất xác định**: luật regex trên text (tên, thích/không
  thích, sống ở đâu, làm gì, dị ứng, sinh nhật — tiếng Anh + tiếng
  Việt). Không gọi model nên không "sáng tác" fact mới. Bot turn
  không được trích xuất (agent không học "fact" từ câu trả lời của
  chính mình).
- **Một lần chạy**: trích xuất fact → chạy `consolidate()` v0.96
  (dedupe + resolve conflict + promote fact quan trọng lên block
  `human`) → lưu fact mới vào long-term memory (tag `sleep-agent`)
  → xây graph tăng dần (entity + relation từ cùng fact).
- **State per-bot**: cấu hình + đếm bước + report lần chạy cuối lưu
  trong `.open-bot/memory-sleep-<botId>.json` (không dùng chung file
  giữa các bot).
- **Hook coordinator**: `executeRun` gọi `maybeRunSleepAfterTurn`
  sau `runner.run()` thành công; `scheduleSleepAfterTurn` chỉ bump
  counter đồng bộ, khi đủ ngưỡng mới chạy nền fire-and-forget
  (không `await`, không chặn turn, lỗi bị nuốt — memory không bao giờ
  làm hỏng chat). Không probe mạng/Ollama trên đường turn (bài học
  v0.95: probe trong setup turn gây trễ 5–823ms).

## 2. Temporal knowledge graph

Entity + relation có **validity window bi-temporal**:

- `validFrom` / `validTo` — fact ĐÚNG trong thế giới vào lúc nào
  (`null` = mở, chưa biết hết hạn);
- `recordedAt` — open-bot BIẾT fact đó vào lúc nào.

Nhờ đó "đúng vào 2026-06-01" và "đúng bây giờ" là hai câu hỏi khác
nhau, đều trả lời được (`snapshotAt(at)`, `neighbours(id, { at })`).

- **Merge thay vì trùng**: cùng tên chuẩn hoá + type thì gộp
  (alias/description hợp nhất, cửa sổ validity nới rộng); cùng
  (from, label, to) thì nới rộng cửa sổ thay vì nhân đôi cạnh.
- **Supersede, không xoá lịch sử**: `endRelation`/`endEntity` chỉ
  đặt `validTo` — lịch sử vẫn tra được bằng `snapshotAt` thời điểm cũ.
- **Quarantine**: entity/relation bị cách ly vẫn lưu nhưng không bao
  giờ xuất hiện trong query (kể cả hybrid search qua tool).
- **Lưu trữ**: `.open-bot/memory-graph.json`, ghi atomic (temp +
  rename, mode 0600), giống MemoryBlockStore.
- **Export/import Markdown** (`exportGraphToMarkdown` /
  `parseGraphMarkdown`): định dạng ổn định, dòng lạ được ghi vào
  `skipped` thay vì làm hỏng cả file import.
- **`describeEntity`**: tóm tắt 1 dòng cho prompt ("Huy (person):
  likes pho; lives in Hanoi").

## 3. Hybrid search

Kết hợp 3 tín hiệu trên cùng một corpus (long-term memories +
memory blocks + graph), mỗi kết quả kèm **giải thích nguồn**:

1. **Semantic** — cosine trên embedding Ollama (`nomic-embed-text`)
   khi có embedder và embed trong timeout ngắn (mặc định 5s). Ollama
   chưa chạy / embed chậm / không có vector → tín hiệu semantic tắt,
   trọng số dồn sang BM25, kết quả ghi rõ `semanticAvailable: false`
   (không giả vờ có semantic).
2. **BM25** — tự viết, không dependency, luôn khả dụng, xác định.
3. **Graph** — entity được nhắc trong query làm hạt giống, đi 1–2 hop
   (hop 1 = 1.0, hop 2 = 0.5) để lôi fact liên quan mà từ khoá bỏ sót.

Trọng số mặc định: semantic 0.45 / BM25 0.35 / graph 0.20. Điểm cuối
nhân với trust của provenance (fact ít tin cậy xếp thấp hơn).
Embedding KHÔNG BAO GIỜ trả về model/UI (tool và IPC chỉ trả text +
điểm). Quá khứ: item có `validTo` đã qua bị loại khỏi kết quả.

## 4. Provenance + quota (OWASP ASI06 — Memory & Context Poisoning)

- **Mọi memory ghi nguồn**: `source` (user/bot/tool/import/system),
  `botId`, `userId`, `origin` (tool/file/chat), `recordedAt`, `trust`,
  `flags`, `quarantined`.
- **Phát hiện nghi ngờ** (`detectSuspiciousContent`, xác định, không
  model): "ignore previous instructions", imperative nhắm vào agent,
  fake marker `<system>`/`[SYSTEM]`, URL mạo danh thẩm quyền, xin
  secret. Flag `high` hạ trust xuống tối đa 0.2; fact bị flag vẫn lưu
  (gắn tag `flagged`, trust thấp) thay vì tin mù — user xem lại trong
  UI/tool `memory_provenance` (action `flags`).
- **Mâu thuẫn** (`detectContradictions`): cùng key chuẩn hoá, value
  khác nhau → báo cáo cả hai phía, không tự ý xoá bên nào; sleep agent
  lưu bản mới hơn, bản cũ được consolidation archive (v0.96).
- **Trust score** (`trustScore`): theo nguồn (user 0.95, system 0.9,
  bot 0.7, tool 0.6, import 0.5), trừ điểm theo flag, trừ 0.1 khi fact
  cũ hơn 180 ngày, quarantined = 0.
- **Quota** (`checkQuota`, mặc định 2000 item / 500.000 ký tự /
  8000 ký tự/item / 5000 entity / 20000 relation per-bot): sleep run
  vượt quota thì dừng sớm, ghi `quotaBlocked` vào report thay vì ghi
  đè; graph `addEntity`/`addRelation` throw lỗi rõ khi vượt quota.
- **Audit**: `ProvenanceLog` append-only JSONL
  (`.open-bot/memory-provenance.jsonl`), fail-open (ghi log lỗi không
  chặn ghi memory).

## 5. Tool mới (8 tool, registry 187 → 195)

| Tool | Ghi? | Việc |
|---|---|---|
| `memory_sleep_run` | ✓ | Chạy sleep agent ngay với episodes cho trước |
| `memory_sleep_status` | – | Config + report lần chạy cuối |
| `memory_sleep_configure` | ✓ | Bật/tắt + ngưỡng bước + promote/graph |
| `memory_graph_entity` | ✓ | add/get/list/delete/quarantine entity |
| `memory_graph_relation` | ✓ | add/end/delete/list relation |
| `memory_graph_query` | – | neighbours / snapshot-at-time / entity |
| `memory_hybrid_search` | – | Tìm kiếm kết hợp có giải thích nguồn |
| `memory_provenance` | – | Quota + flags + contradictions |

Mọi tool ghi đều `needsApproval: true`. Tool không bao giờ trả
embedding. Sleep run qua tool cũng bị cổng mock/CLI chặn.

## 6. UI + IPC

- Tab **Memory v2** trong MemoryView (cạnh Memories / Memory blocks):
  ô tìm kiếm kết hợp (ghi rõ "keyword only" khi không có semantic),
  sleep agent (bật/tắt, chạy ngay, tóm tắt lần chạy cuối), graph
  (entity + relation, trust, validity, cờ quarantine), quota usage.
- IPC `memory-v2:graph` / `memory-v2:search` / `memory-v2:sleep` /
  `memory-v2:provenance` (main + preload + global.d.ts + types.ts
  mirror đầy đủ). IPC search tự kiểm tra Ollama khả dụng trước khi
  dùng embedder; embedding bị strip trước khi trả về renderer.
- i18n: +34 key/locale, 6/6 locale (1923 → 1957). Không có tiếng Việt
  trong code/comment của renderer (test i18n quét cả comment).

## 7. Giới hạn còn lại

- Trích xuất fact là luật regex (tiếng Anh + tiếng Việt) — không phát
  hiện cách diễn đạt tự do ngoài mẫu (vd "mình khoái phở" không khớp
  mẫu "tôi thích"); không gọi model nên không có trích xuất ngữ nghĩa sâu.
- Sleep agent chạy khi turn kết thúc qua hook coordinator; run tay
  qua UI/tool với episodes rỗng vẫn chạy consolidation + promote
  (không có episode mới thì không trích xuất fact mới).
- Graph traversal trong hybrid search tối đa 2 hop, hạt giống là
  entity có tên xuất hiện nguyên văn trong query.
- Bản dịch 6 locale chưa qua người bản ngữ soát (giới hạn chung).
- Live ảnh Gemini KHÔNG thử lại (key miễn phí quota ảnh = 0, quyết
  cũ từ v0.89b).
- Không dữ liệu X, không Grok Imagine, không cloud VM/tài khoản/thanh
  toán — local-first, miễn phí, như hướng đứng của dự án.

## 8. Test

- `tests/memory-v2-v097.test.mjs` — 32 test: provenance, graph
  (CRUD/merge/validity/quarantine/persistence/Markdown round-trip),
  hybrid search (BM25, semantic fake embedder, graph hop, timeout
  fallback), sleep agent (trích xuất EN/VI, run + promote + graph,
  từ chối mock/CLI, mâu thuẫn + flag, step gate, hook helpers),
  8 tool (round-trip + từ chối mock + placeholder lỗi).
- `tests/memory-v2-ui-v097.test.mjs` — 8 test tĩnh: i18n parity
  6 locale + placeholder, key dùng phải tồn tại, IPC/preload/types
  mirror, data-testid, hook coordinator best-effort.
- Số đếm cứng đã cập nhật: registry 187 → 195
  (`tests/wiring-v07`, `tests/coordinator`, `tests/conversation-history-v085`,
  `tests/v014-integration` — bản 189 → 197 cho 2 plugin/bundle tool);
  i18n 1923 → 1957 key/locale.
