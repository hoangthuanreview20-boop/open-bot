# Survey v1.01 — Đội T4: Verbatim local memory (học ý tưởng MemPalace)

> CHỈ HỌC Ý TƯỞNG từ các mô tả công khai của MemPalace (website/review
> công khai, không đọc/copy code, text hay tài sản của repo đó, của
> xAI/Cursor hay bất kỳ repo nào). Mọi code trong sóng này là code gốc
> của open-bot, viết mới hoàn toàn, theo quy ước sẵn có của repo.

## 1. Ý tưởng học được (mức khái niệm)

MemPalace là hệ memory local-first cho agent lập trình, khác hướng với
Mem0/Letta ở điểm cốt lõi: **lưu nguyên văn (verbatim), không tóm tắt,
không trích xuất, không diễn giải lại** — text gốc là tầng memory có
thẩm quyền; mọi tầng cấu trúc (graph, phân loại, nhật ký) chỉ là chỉ
mục/phụ trợ, không thay thế bản gốc. Các ý tưởng cụ thể áp dụng được:

1. **Verbatim-first**: lưu đúng câu chữ user/agent đã nói (kèm nguồn,
   thời điểm, ngữ cảnh), vì tóm tắt là nơi mất thông tin nhiều nhất.
   Con số benchmark công khai của họ (96.6% R@5 LongMemEval ở chế độ
   raw) là bằng chứng cho hướng này — ta không claim lại con số đó,
   chỉ học nguyên tắc.
2. **Tổ chức phân cấp điều hướng được**: "cung điện" — wing (người/
   dự án) → hall (loại memory) → room (chủ đề) → drawer (chunk
   nguyên văn). Không phải để trưng: phân cấp là bộ lọc metadata cho
   recall, giúp thu hẹp tập ứng viên trước khi chấm điểm.
3. **Backend cắm được**: mặc định local (họ dùng ChromaDB), có thể đổi
   sang SQLite-exact / Qdrant / pgvector / Milvus mà không đổi API
   gọi. Bài học: định nghĩa interface backend hẹp và ổn định trước,
   backend cụ thể chỉ là implementation.
4. **Hybrid recall**: vector search + BM25 rerank + metadata filter +
   fallback FTS/SQLite khi không có vector. Không phụ thuộc duy nhất
   vào embedding: khi không có embedder, BM25 vẫn phải cho kết quả
   tốt.
5. **MCP server**: memory expose qua MCP tools để mọi agent/MCP
   client (Claude Code, Codex CLI, Cursor, Gemini CLI…) dùng chung
   một kho memory, không phải mỗi agent một kho riêng.
6. **Auto-save hooks**: hook cuối session của các CLI agent tự lưu
   transcript nguyên văn, không cần user nhớ phải lưu. Hook chạy
   rule-based (không bắt buộc LLM) để không tốn model call.
7. **Local-first, không cần key**: mọi đường mặc định chạy offline;
   LLM rerank / remote embedding chỉ là tuỳ chọn.

## 2. Memory đã có trong open-bot (đọc kỹ, không viết lại)

| Module hiện có | Vai trò | Quan hệ với sóng này |
|---|---|---|
| `packages/core/src/memory/longterm.ts` | `LongTermMemory`: key/value + confidence + embedding Ollama, lưu JSON `.open-bot/memories.json` | Lưu **fact đã rút gọn** (key/value), không phải verbatim. Sóng này BỔ SUNG tầng verbatim bên cạnh, và có migration import từ đây. |
| `packages/core/src/memory/blocks.ts` | Memory blocks kiểu Letta (v0.96) | Block là đoạn text có chủ đích, do user/agent quản lý tay. Verbatim record khác: sinh tự động từ hội thoại, giữ nguyên văn. |
| `packages/core/src/memory/graph/*` | Temporal KG + `Bm25` + hybrid search + extract rule-based + sleep agent (v0.97–v0.98) | **Tái dùng**: `Bm25` cho recall từ khoá; pattern extractor rule-based VI+EN làm tham khảo cho extractor verbatim (không copy regex). |
| `packages/core/src/memory/embeddings.ts` | `Embedder` interface + `OllamaEmbeddings` (nomic-embed-text, local) | **Tái dùng**: embedder cho recall ngữ nghĩa; vắng Ollama → fallback BM25. |
| `packages/core/src/memory/turnContext.ts`, `profile.ts` | Context turn + user profile | Không đụng; autosave hook đọc transcript qua callback host cung cấp. |
| `packages/tools/src/memoryTools.ts` | Tools `memory_save/search/list/delete` trên LongTermMemory | Sóng này thêm tool riêng `verbatim_memory_*` trên store mới, giữ nguyên tool cũ. |
| `packages/core/src/mcp/server.ts` | `McpServer` hand-rolled (stdio + HTTP), `handleJsonRpc` public | **Tái dùng**: MCP memory server dựng trên `McpServer` này, chỉ đăng ký thêm 5 tool. |
| `packages/core/src/hooks/*` | `HookRegistry`, event `SessionEnd`/`Stop` | Autosave hook đăng ký đúng event này; transcript lấy qua callback inject, không đọc lén state. |
| `packages/core/src/agent/memory.ts` | `BotMemory` SQLite qua `node:sqlite` | **Tái dùng pattern**: SQLite backend dùng `node:sqlite` (Node 24, có sẵn, không thêm dependency). File riêng `verbatim.db`, không chung bảng với BotMemory. |
| Desktop `MemoryView.tsx` + IPC `memory:*` | UI quản lý long-term memory | Thêm tab "Verbatim" + IPC `verbatim-memory:*`, không sửa tab cũ. |

**Kết luận survey**: không có store verbatim nào trong repo. Cần xây mới
hoàn toàn tầng verbatim, nhưng tái dùng `Bm25`, `Embedder`/`OllamaEmbeddings`,
`McpServer`, hook registry và pattern `node:sqlite` sẵn có.

## 3. Thiết kế của sóng này (code gốc)

```
packages/core/src/memory/verbatim/
  types.ts        — VerbatimRecord, VerbatimBackend interface, options, stats
  backends/
    index.ts      — openVerbatimBackend(): sqlite (mặc định) → jsonl fallback
    sqlite.ts     — SQLiteBackend (node:sqlite, WAL, verbatim.db)
    jsonl.ts      — JsonlBackend (append-only .jsonl, compact khi xoá)
  chunker.ts      — chẻ transcript dài thành chunk verbatim (giữ span nguồn)
  recall.ts       — hybrid recall: BM25 + cosine embedding + recency, fusion
  extract.ts      — rule-based extractor (lệnh "nhớ…" + câu khẳng định user)
  store.ts        — VerbatimMemoryStore (save/search/list/delete/stats,
                    dedup theo hash, backfill embeddings, import/export)
  migrate.ts      — import từ LongTermMemory + transcript file → verbatim
  autosave.ts     — VerbatimAutosave + hook SessionEnd/Stop (rule-based,
                    LLM extractor là callback tuỳ chọn)
  mcp.ts          — createVerbatimMemoryMcpServer(): tools memory.save /
                    memory.search / memory.list / memory.delete /
                    memory.stats trên McpServer có sẵn + serveStdio

packages/tools/src/verbatimMemoryTools.ts
  — Tool[] verbatim_memory_save/search/list/delete/stats cho agent loop.

apps/cli/src/cli.ts — subcommand `memory-mcp` (stdio MCP server).

apps/desktop — VerbatimMemoryView.tsx (tab mới trong MemoryView) +
  IPC verbatim-memory:* (main.ts + preload.ts) + i18n verbatim.* × 6 locale.
```

### 3.1 Record schema (verbatim)

```ts
interface VerbatimRecord {
  id: string;                 // uuid
  text: string;               // NGUYÊN VĂN, không tóm tắt/diễn giải
  source: 'user' | 'agent' | 'tool' | 'import' | 'autosave' | 'manual';
  wing: string;               // người/dự án (mặc định 'default')
  room: string;               // chủ đề (mặc định 'general')
  drawer?: string;            // nhóm con tuỳ ý
  tags: string[];
  botId: string;              // '' = chung
  userId?: string;
  createdAt: string;          // ISO
  sessionId?: string;
  turnIndex?: number;
  embedding?: number[];       // đã chuẩn hoá L2, optional
  embeddingModel?: string;
  hash: string;               // sha256 của text chuẩn hoá → dedup
}
```

### 3.2 Backend interface (hẹp, để sau cắm Chroma/Qdrant/pgvector)

`insert(record)`, `get(id)`, `list(filter, pagination)`,
`delete(id)`, `searchByText` (backend tự chọn: LIKE/FTS/không),
`count(filter)`, `allIds()` (cho backfill), `close()`.
Backend KHÔNG biết gì về embedding scoring — recall engine làm việc
đó trên record đã load, nên backend mới chỉ cần CRUD + list.

### 3.3 Recall

1. Lọc metadata trước (wing/room/tags/botId/userId).
2. BM25 trên text (tái dùng `Bm25` của graph) → điểm từ khoá.
3. Nếu có embedder + record có vector: cosine similarity query–record.
4. Fusion: `0.6 * cosine_norm + 0.4 * bm25_norm` khi có vector,
   ngược lại BM25 thuần; cộng boost recency nhẹ (mới hơn hơi cao hơn).
5. Không có embedder / không có vector → BM25 thuần, báo rõ
   `usedFallback: true` + lý do (như `longterm.ts` đã làm).

### 3.4 Auto-save (privacy)

- Mặc định TẮT (opt-in): chỉ chạy khi host bật + user đồng ý; hook
  không tự ghi lén. Ghi chú rõ trong description.
- Chỉ lưu turn của **user** khớp pattern (lệnh nhớ rõ ràng, hoặc câu
  khẳng định sở thích/quyết định/sự kiện), tối đa N record/session,
  dedup theo hash, bỏ câu quá ngắn/quá dài, bỏ text giống secret
  (key/token) theo heuristic đơn giản.
- LLM extraction là callback tuỳ chọn (`llmExtractor?: (turns) =>
  Promise<candidate[]>`); không có thì rule-based vẫn chạy.

### 3.5 MCP server

Dùng `McpServer` có sẵn: `allowedTools` = đúng 5 tool memory.*,
`workspaceDir` không cần (store mở theo đường dẫn riêng). Stdio qua
`serveStdio()`; log chỉ ra stderr (quy ước của McpServer). Tool
`memory.save`/`memory.delete` annotate `destructiveHint: true`,
search/list/stats `readOnlyHint: true`. Output không bao giờ kèm
vector embedding.

## 4. Rủi ro / giới hạn đã biết trước

- `node:sqlite` là API Node 24 (repo yêu cầu Node ≥ 24) — backend
  SQLite chỉ mở được khi runtime hỗ trợ; nếu không, factory fallback
  JSONL và ghi rõ lý do vào stats.
- Recall embedding cần Ollama chạy + model `nomic-embed-text`; vắng
  thì BM25 — recall vẫn đúng, chỉ kém ngữ nghĩa.
- Verbatim lưu nhiều text thô → dung lượng tăng; có `stats` + giới
  hạn `maxRecords` (mặc định 50.000) + lệnh delete/list để dọn.
- UI desktop chỉ quản lý (list/search/delete), không sửa text trực
  tiếp — sửa verbatim là sửa lịch sử, phải xoá + lưu mới.
