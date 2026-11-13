# Repo map (v0.96, Đội T2)

Bản đồ kho code cho agent: file nào quan trọng nhất với lượt chat hiện
tại, và chỉ đưa signature cần thiết vào prompt thay vì cả file.

## Nguyên lý

Học ý tưởng kiểu Aider repo map (tree-sitter → graph → PageRank →
token budget), tự thiết kế + viết lại hoàn toàn từ đầu — KHÔNG đọc,
KHÔNG copy code/text/tài sản của Aider hay bất kỳ repo nào khác.

1. **Trích symbol**: tái dùng parser tree-sitter đã có
   (`packages/tools/src/code/ast.ts`, v0.86) cho TS/TSX/JS/JSX/Python;
   khi tree-sitter lỗi thì regex fallback (`extractSymbolsRegexFallback`).
2. **Đồ thị**: node = file; cạnh A → B khi A tham chiếu symbol do B định
   nghĩa hoặc import trực tiếp B. Trọng số = sqrt(số reference) nhân hệ số:
   file đích đang chat **50x**, ident nhắc trong hội thoại **10x**,
   ident dài (≥ 8 ký tự) **10x**, tên bắt đầu `_` **0.1x**.
3. **Personalized PageRank**: tự viết power iteration (damping 0.85,
   50 vòng). Personalization: mỗi file trong chat nhận khối lượng
   100/len(chatFiles); không có file chat thì đều trên mọi file.
4. **Token budget**: binary search số file top-rank vừa budget (mặc định
   1024 token, cấu hình được; không có file chat thì nhân **8x**).
   Token ≈ chars/4.
5. **Render** kiểu TreeContext: mỗi file chỉ hiện signature + dòng định
   nghĩa, thân elided thành `...`.

## API (`packages/tools/src/repoMap.ts`)

- `buildRepoMap(rootDir, opts)` / `queryRepoMap(rootDir, query)` —
  trả `RepoMapResult` (files, edges, scores, ranked, rendered,
  tokenEstimate, budget, filesScanned/Skipped, cacheHits, buildMs).
- `buildRepoMapSection(rootDir, opts)` / `formatRepoMapSection(map)` —
  section chèn vào system prompt (best-effort: lỗi/trống → `''`).
- `personalizedPageRank`, `buildRepoGraph`, `fitRepoMapToBudget`,
  `renderRepoFile`, `discoverRepoFiles`, `parseRepoFile`,
  `extractMentionedIdents`, `extractSymbolsRegexFallback`,
  `resolveRelativeImport`, `identMultiplier`, `estimateRepoMapTokens`,
  `repoMapCacheStats` / `clearRepoMapCache`.
- Cache parse theo `(đường dẫn, mtimeMs, size)` — file không đổi thì
  turn sau không parse lại.

## Tools mới (read-only, không cần approval)

- `repo_map`: build map cho 1 thư mục/repo, trả top files + token estimate.
- `repo_map_query`: map cá nhân hoá theo file đang chat + ident nhắc tới
  (hoặc `userText` để tự trích ident).

## Nối vào turn context

Coordinator chèn repo map vào system prompt mỗi turn (sau section memory
v0.95d4), mặc định **bật** cho bot có thư mục làm việc; tắt riêng cho bot
trong Settings → Model (`BotConfig.repoMapEnabled`, mặc định `true`;
`repoMapTokenBudget` mặc định 1024). Best-effort: lỗi build không chặn turn.

## Số đo thật (đo trên repo này, 2026-11-13)

- `packages/core/src/coordinator` (4 file): types.ts #1 (0.3341),
  client.ts #2, coordinator.ts #3, index.ts cuối.
- `packages/core/src/agent` (30 file, chatFiles `loop.ts`): loop.ts #1.
- Map fixture 5 file: core > api > main > util > unused (unused cuối).

## Giới hạn trung thực

- Chỉ TS/TSX/JS/JSX/Python (grammar tree-sitter đã cài).
- References đếm bằng token identifier trên toàn source (kể cả trong
  string/comment) nên có thể đếm thừa; import bare (`'react'`) bị bỏ qua.
- Tối đa 2000 file, file > 1 MB bị lược và báo số lượng.
- Signature chỉ lấy dòng định nghĩa đầu tiên.
- Mention chỉ đổi thứ hạng khi file nhắc tới có ≥ 2 cạnh ra (một file
  chỉ có 1 cạnh ra thì xác suất chuyển đổi vẫn là 1.0 dù scale trọng số).
- Lần đầu build trên repo lớn tốn vài giây (parse tree-sitter); các turn
  sau dùng cache mtime.

## Test

`tests/repo-map-v096.test.mjs` — 28 test (PageRank, budget binary search
+ hồi quy không vượt budget, cache mtime, render elision, regex fallback,
2 tool, 2 test live trên chính repo open-bot). Chạy sau khi build tools:

```sh
npm run build --workspace=@open-bot/tools
node --test tests/repo-map-v096.test.mjs
```
