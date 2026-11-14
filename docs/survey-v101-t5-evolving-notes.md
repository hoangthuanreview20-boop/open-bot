# Survey — Evolving Notes + Memory Benchmark Harness (v1.01, Đội T5)

Base: `a37b4d6` (v0.98). Phạm vi: chỉ trong worktree `open-bot-v101-t5`, branch `v101-t5`.

## 1. Memory hiện có trong repo (đã đọc, không viết lại)

| Thành phần | File | Điểm dùng được / giới hạn |
|---|---|---|
| Long-term memory | `packages/core/src/memory/longterm.ts` | Entry `{key, value, tags, confidence, botId, userId, embedding?}`; file `.open-bot/memories.json`, ghi atomic 0600; recall từ khoá + ngữ nghĩa (Ollama embed, fallback BM25-từ-khoá). **Không có versioning, không có link giữa các entry, không có lịch sử thay đổi.** |
| Memory blocks (Letta-style) | `packages/core/src/memory/blocks.ts` | Block có label/description/content/charLimit, attach nhiều bot, audit append-only. **Nội dung là một khối phẳng, không link, không version nội dung cũ.** |
| Temporal knowledge graph | `packages/core/src/memory/graph/{types,store,extract,consolidateGraph,bm25,hybridSearch}.ts` | Episode → Entity → Fact, bi-temporal (`validFrom/validUntil`, `superseded/supersededBy`), quarantine cho fact mâu thuẫn, BM25 + hybrid search, `normalizeGraphText` (bỏ dấu TV). **Đây là tầng fact có cấu trúc; note là tầng khác — văn bản tự do, dài hơn, có link tay/máy.** |
| Consolidation / sleep agent | `packages/core/src/memory/consolidate.ts`, `sleepAgent.ts`, `memory/graph/sleepAgent.ts` | Rút fact từ turn, gom nhóm, chạy nền. Chưa có khái niệm "revisit một note cũ khi thông tin mới tới". |
| Turn context | `packages/core/src/memory/turnContext.ts` | Ghép memory + block vào system prompt. Note sẽ có hàm render tương tự. |

Kết luận: **bổ sung, không thay thế.** Note system dùng chung:
- chuẩn hoá text + tokenize của graph (`normalizeGraphText`, BM25) — không viết lại tokenizer;
- scope `{userId, botId, runId}` của graph;
- pattern lưu file JSON atomic (temp + rename, mode 0600) như longterm/blocks/graph;
- pattern quarantine/soft-delete của graph cho conflict.

## 2. Ý tưởng học được (chỉ ý tưởng, không copy code/text/tài sản)

- **Zettelkasten / evergreen notes**: mỗi mẩu tri thức là một note độc lập, có tiêu đề,
  nội dung, tag; note liên kết tới note khác bằng link có hướng + có loại quan hệ
  (`related`, `supports`, `contradicts`, `supersedes`, `part-of`); giá trị nằm ở
  mạng link, không ở từng note riêng lẻ. Học: link là dữ liệu hạng nhất, có
  backlink, có graph view.
- **Evolving / living notes**: note không phải "ghi một lần rồi quên" — khi thông
  tin mới tới, note cũ được *revisit*: bổ sung, sửa, hoặc ghi đè có version.
  Lịch sử version được giữ (không xoá), giống bi-temporal của graph nhưng ở mức
  văn bản: version cũ vẫn đọc được, note hiện tại trỏ `supersedes` version cũ.
- **LongMemEval (ý tưởng benchmark, không dùng dataset của họ)**: đo memory bằng
  nhiệm vụ hỏi–đáp trên tài liệu dài do chính mình tạo: câu hỏi cần nhớ một fact
  (single-hop), cần nối hai fact (multi-hop), fact đã bị thay thế (temporal — đáp
  án đúng là bản mới nhất), và câu hỏi có distractor (fact gần giống nhưng sai).
  Đo **Recall@k** (gold note có trong top-k recall không), **accuracy** (đáp án
  đúng), **MRR**. Tự tạo dữ liệu synthetic bằng PRNG có seed → chạy lại cho cùng
  kết quả, không phụ thuộc dataset có bản quyền, không tin số vendor.
- **A-MEM (ý tưởng)**: memory tự tổ chức thành mạng: note mới được gắn vào mạng
  hiện có bằng similarity, và mạng được "evolve" theo thời gian (link mới, note
  cũ được cập nhật). Học: auto-link khi tạo + revisit định kỳ, không chỉ search.

## 3. Thiết kế của đội T5

### 3.1 Note schema — `packages/core/src/memory/notes/types.ts`

```ts
interface EvolvingNote {
  id, title, body, kind: 'fact'|'preference'|'event'|'project'|'person'|'place'|'idea'|'other',
  tags: string[], status: 'active'|'superseded'|'archived'|'deleted',
  scope: { userId, botId, runId },
  links: NoteLink[] /* {targetId, kind, weight, auto, createdAt} */,
  versions: NoteVersion[] /* {version, title, body, tags, reason, createdAt, createdBy} */,
  version: number, confidence: number, sourceEpisodeId?, sourceFactId?,
  lastRevisitedAt, createdAt, updatedAt
}
```

- Mọi lần sửa nội dung → push version cũ vào `versions`, tăng `version`, không xoá
  lịch sử. `status='superseded'` khi note bị note khác thay thế (giữ lại để hỏi
  "trước đây thì sao").
- Link có `weight` 0..1 (độ mạnh) và `auto` (máy gợi ý) vs tay tạo; xoá link không
  xoá note.

### 3.2 Auto-link — `autolink.ts`

- Điểm tương đồng = hỗn hợp: TF-IDF cosine trên token đã chuẩn hoá (bỏ dấu TV,
  stopword VI+EN) + Jaccard trên tag + trùng keyword hiếm (IDF cao).
- Khi tạo note mới: quét note active cùng scope, gợi ý top-N link vượt ngưỡng
  (mặc định 0.35), tự gắn link `auto` nếu ≥ 0.45, chỉ gợi ý nếu 0.35–0.45.
- Backlink suy ra từ link hai chiều khi đọc; orphan = note active không có link
  nào; hub = note có nhiều link nhất.

### 3.3 Revisit / update — `revisit.ts`

- `revisitNote(note, newText, origin)`: phân loại — `append` (thông tin mới, không
  mâu thuẫn), `merge` (trùng lặp cao → gộp, giữ cả hai version), `contradiction`
  (phát hiện phủ định / antonym / cùng chủ thể–vị ngữ khác tân ngữ → tạo
  `NoteConflict` chờ duyệt, note cũ KHÔNG tự đổi), `supersede` (thông tin mới
  thay thế hẳn → version cũ, status note cũ = superseded khi thay bằng note mới).
- Phát hiện mâu thuẫn: mẫu phủ định VI+EN (`không còn`, `không thích`, `no longer`,
  `not anymore`, `đã đổi`, `chuyển sang`...) + cặp antonym nhỏ (`thích/ghét`,
  `ở Hà Nội/ở Sài Gòn` qua so sánh tân ngữ khác nhau cùng chủ thể) — heuristic
  local, ghi rõ là heuristic, không giả vờ là NLI model.
- Staleness: điểm "cần revisit" = tuổi note × (1 − số lần revisit) × độ quan
  trọng (hub/link nhiều = quan trọng hơn). Hàng đợi revisit trả top-N.

### 3.4 Graph export — `graphExport.ts`

- Export JSON `{nodes: [{id, title, kind, tags, status, degree, ...}], edges:
  [{from, to, kind, weight, auto}]}` + timeline events (tạo/sửa/link/supersede)
  + thống kê (số note, link, orphan, hub, mật độ). Thêm export DOT (Graphviz)
  dạng text để user tự vẽ.

### 3.5 Benchmark harness — `packages/core/src/memory/notes/benchmark/`

- `generator.ts`: PRNG có seed (mulberry32). Sinh synthetic: persona (tên, thành
  phố, sở thích, công việc...), N "document" (mỗi document = vài fact), câu hỏi
  4 loại: `single-hop`, `multi-hop`, `temporal` (fact bị supersede — đáp án là
  bản mới), `distractor` (fact gần giống). Mỗi task có `goldNoteIds` + đáp án.
  Toàn bộ nội dung là tên/địa danh/sở thích bịa — không lấy dataset có sẵn.
- `runner.ts`: adapter `MemoryRecallAdapter` (`recall(query, k)` → note id) —
  mặc định dùng `EvolvingNoteStore.search`. Chạy toàn bộ task, ghi lại top-k.
- `metrics.ts`: Recall@k (k=1,3,5,10), Precision@k, MRR, accuracy (so đáp án
  chuẩn hoá), breakdown theo loại task, khoảng tin cậy Wilson cho accuracy.
- `report.ts`: report JSON + Markdown (bảng theo loại, top lỗi sai).

### 3.6 Tools + UI

- Tools (`packages/tools/src/memoryNotesTools.ts`): `notes_create`, `notes_update`,
  `notes_search`, `notes_links`, `notes_graph`, `notes_revisit`, `notes_benchmark_run`.
- UI (`apps/desktop/src/renderer/components/MemoryNotesView.tsx`): danh sách note,
  chi tiết (version history + link), graph (SVG adjacency đơn giản + danh sách
  kề), timeline, panel benchmark (chạy, xem bảng R@k/accuracy). i18n EN+VI+4 locale
  còn lại.

## 4. Giới hạn đã biết trước

- Similarity là TF-IDF/BM25 local, không phải embedding ngữ nghĩa sâu (có hook
  nhận embedder optional nếu sau này cần, nhưng mặc định không cần model).
- Phát hiện mâu thuẫn là heuristic từ khoá — sẽ có false positive/negative; vì
  vậy mọi contradiction đều vào hàng chờ duyệt, không tự áp dụng.
- Benchmark synthetic đo được *recall của chính hệ thống trên dữ liệu mình tạo*,
  không phải chất lượng memory trên hội thoại thật — ghi rõ trong report.
- Graph UI là SVG tĩnh (layout vòng tròn + lực đơn giản), không phải canvas
  WebGL cho hàng nghìn node.
