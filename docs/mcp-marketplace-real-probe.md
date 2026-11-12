# MCP marketplace — probe server HTTP thật (v0.71, mốc 2)

Ngày probe: 2026-11-10 (giờ Asia/Saigon). Người probe: worker sóng v0.71.
Script: `scripts/probe-public-mcp-server.mjs` (dùng đúng
`StreamableHttpMcpClient` của repo, `packages/core/dist/mcp/client.js`).
Repo HEAD lúc probe: `8ad7255` (v0.70), core đã build lại trước khi probe
(`npm run build --workspace=@open-bot/core`, sạch, không lỗi).
Lưu ý: lúc build, working tree có thay đổi chưa commit của worker khác
ở `packages/core/src/mcp/client.ts` (v0.71 SEP-1303 follow-up: thêm
callback `onWarning` cho `-32602` ở `tools/list`/`resources/list`) nên
`dist` probe dùng được build từ cây đó, không phải HEAD thuần. Thay đổi
này không chạm đường probe (`postRpcOnce`, `res.text()`,
`parseRpcResponse`, `initialize`, transport đều giữ nguyên) nên không
ảnh hưởng kết quả đo hay bug §5; ghi rõ ở đây để điều phối viên kiểm
chứng không nhầm.

## Kết luận ngắn

**Đã probe thành công server thật: 8/9 endpoint trả `initialize` +
`tools/list` qua client của repo, không cần key/đăng nhập, không gửi
credential nào.** Trước mốc này, probe HTTP của marketplace chỉ test với
server mẫu local (`tests/mcp-marketplace-probe-fake-http-server.mjs`).

- 8 server streamable-HTTP công khai, no-auth: Microsoft Learn,
  Cloudflare Docs, DeepWiki, Context7, GitMCP, Hugging Face, Astro Docs,
  EdgeOne Pages — đều liệt kê được tool thật.
- 1 endpoint thất bại đúng như dự kiến: DeepWiki `/sse` (legacy SSE) —
  client của repo **không hỗ trợ legacy SSE** (ghi rõ trong
  `packages/core/src/mcp/client.ts`), server trả HTTP 405 (POST) / 410
  (GET). Đây là giới hạn đã biết của client, không phải lỗi mới.
- **Phát hiện 1 bug/limitation thật của client** (xem §5):
  `postRpcOnce` đợi toàn bộ body (`await res.text()`) nên server nào giữ
  stream SSE mở sau khi đã gửi response sẽ làm mỗi request chậm theo thời
  gian giữ stream (GitMCP: ~10s/request dù response đến sau <1s).
  Chưa sửa trong sóng này (cần đọc stream tăng dần, không phải sửa nhỏ)
  — báo cáo chi tiết bên dưới để sóng sau xử lý.

## 1. Ứng viên từ nghiên cứu

Tìm bằng web search ngày 2026-11-10. Nguồn chính:
`freeapi.watch/free-mcp-servers` ("last verified November 2026",
tự nhận monitor hourly bằng handshake `initialize` thật), docs chính
thức của vendor (Devin docs cho DeepWiki MCP), và các bài viết độc lập
(octomind.run, continuumcode.ai, chatforest.com). Ba ứng viên trong brief
đều được xác minh lại, cộng thêm 5 ứng viên no-auth khác từ cùng danh
sách (Microsoft Learn, Cloudflare Docs, Hugging Face, Astro Docs,
EdgeOne). Tất cả đều được ghi là "no auth / no signup" ở thời điểm
nghiên cứu; kết quả probe dưới đây là bằng chứng đo thật, không tin mù.

Không probe server nào cần tài khoản/key (GitHub MCP, Notion, Sentry,
Linear, Neon, Supabase, Vercel, Stripe, Atlassian, PayPal, Globalping,
Semgrep — đều cần account theo cùng nguồn). Không gọi `api.github.com`
hay `x.ai`. Chỉ gọi `initialize` + `tools/list` (read-only); không gọi
bất kỳ tool nào — kể cả `deploy-html` của EdgeOne (tool ghi, chỉ liệt kê
tên).

## 2. Cách chạy lại

```bash
npm run build --workspace=@open-bot/core   # dist phải mới
node scripts/probe-public-mcp-server.mjs            # probe cả 9 endpoint
node scripts/probe-public-mcp-server.mjs deepwiki context7   # chỉ 1 vài
```

Script probe tuần tự (một server tại một thời điểm, không dồn request),
mỗi server tối đa 75s. In một JSON object/server ra stdout (chi tiết đầy
đủ: `serverInfo`, tên tool, latency từng bước, lỗi, diagnostic GET khi
lỗi) và tóm tắt ra stderr. Exit 0 ngay cả khi vài server lỗi (server lỗi
là kết quả đo, không phải lỗi script). **Không phải test trong suite —
không chạy trong `npm test` / CI** (phụ thuộc mạng ngoài).

## 3. Kết quả đo

### Lần chạy 2 (đáng tin — chạy ngay sau lần 1, toàn bộ 30s)

| Server | Endpoint | initialize | tools/list | Tools (số lượng) |
|---|---|---|---|---|
| Microsoft Learn MCP | `https://learn.microsoft.com/api/mcp` | 982 ms | 233 ms | 3 — `microsoft_docs_search`, `microsoft_code_sample_search`, `microsoft_docs_fetch` |
| Cloudflare Docs MCP | `https://docs.mcp.cloudflare.com/mcp` | 637 ms | 142 ms | 2 — `search_cloudflare_documentation`, `migrate_pages_to_workers_guide` |
| DeepWiki MCP | `https://mcp.deepwiki.com/mcp` | 718 ms | 112 ms | 3 — `ask_wiki_question`, `read_wiki_contents`, `read_wiki_structure` |
| DeepWiki legacy SSE | `https://mcp.deepwiki.com/sse` | — | — | **FAIL: HTTP 405 sau 156 ms** (xem §4) |
| Context7 | `https://mcp.context7.com/mcp` | 910 ms | 70 ms | 2 — `resolve-library-id`, `query-docs` |
| GitMCP | `https://gitmcp.io/modelcontextprotocol/typescript-sdk` | 11 343 ms | 10 124 ms | 4 — `fetch_typescript_sdk_docs`, `search_typescript_sdk_docs`, `search_typescript_sdk_code`, `fetch_generic_url_content` |
| Hugging Face MCP | `https://hf.co/mcp` | 1 050 ms | 244 ms | 4 — `hf_whoami`, `hub_repo_search`, `hub_repo_details`, `hf_fs` |
| Astro Docs MCP | `https://mcp.docs.astro.build/mcp` | 620 ms | 44 ms | 1 — `search_astro_docs` |
| EdgeOne Pages MCP | `https://mcp-on-edge.edgeone.site/mcp-server` | 1 693 ms | 184 ms | 1 — `deploy-html` (chỉ liệt kê, không gọi) |

Tổng lần 2: **8/9 OK trong 30s**. `serverInfo` đo được:
Microsoft Learn MCP Server 1.0.0; docs-ai-search 0.5.0; DeepWiki 4.0.2;
Context7 4.5.0; GitMCP 1.1.0; huggingface.co/mcp 0.4.34; Astro Docs
server 1.0.0; edgeone-pages-deploy-mcp-server 1.0.0. Protocol thương
lượng: `2025-11-25` cho tất cả trừ EdgeOne (`2024-11-05`, vẫn được chấp
nhận — client hỗ trợ cả hai).

### Lần chạy 1 (đo được 4/9 OK trong 206s — kết quả nhiễu, xem giải thích)

Lần 1: ms-learn, cloudflare-docs, deepwiki, deepwiki-sse, context7 đều
timeout đúng 30 000 ms ở `initialize` (`MCP request to "<id>" timed out
after 30000ms`); gitmcp OK nhưng chậm (init 19 584 ms, tools/list
10 583 ms); hf/astro/edgeone OK (init 5,4–8,3s). Ngay sau đó, kiểm tra
độc lập bằng `curl` và `fetch` thô của Node cho thấy cả 5 server lỗi đều
trả `initialize` trong <1s (DeepWiki 0,66s, Context7 0,40s, ms-learn
0,72s, Cloudflare 0,35s; `notifications/initialized` trả 202 trong
0,3–0,5s), và chạy lại client thật trên DeepWiki riêng lẻ cũng OK trong
~1s. Lần chạy 2 ngay sau đó: cả 5 đều OK trong <1,4s. **Kết luận: 5
timeout ở lần 1 là nhiễu mạng nhất thời trên đường egress của VM lúc đó,
không phải hành vi của server hay bug client** — bằng chứng là cùng
script + cùng client + cùng endpoint, vài phút sau, cho kết quả khác hẳn.
Vì vậy chỉ lấy lần chạy 2 làm số liệu chính; lần 1 được ghi lại ở đây để
không giấu lần đo lỗi.

Log thô hai lần chạy (JSONL, một object/server — lưu ngoài repo vì là
bản ghi đo một lần, không phải artifact của repo):
`/tmp/probe-public-mcp-20261110.jsonl` (lần 1),
`/tmp/probe-public-mcp-20261110-run2.jsonl` (lần 2).
`/tmp` có thể mất khi VM thay mới — số liệu chính đã chép vào bảng trên.

## 4. Ghi chú từng server

- **Context7 — anonymous vẫn hoạt động, không 401.** Một nguồn
  (anchorterminal.com, nghiên cứu 10/2026) cảnh báo từ 4.2.0 server HTTP
  mặc định có thể đòi credential; probe đo thật ngày 2026-11-10 với
  Context7 4.5.0: `initialize` + `tools/list` OK không header auth
  (910 ms / 70 ms), 2 tool `resolve-library-id`, `query-docs`. Hạn mức
  ẩn danh không công bố — dùng nhiều có thể chạm rate limit, khi đó mới
  cần key (không thuộc phạm vi probe này).
- **GitMCP — chậm thật phía server (~10s/request), xem §5.** Repo dùng
  để probe: `modelcontextprotocol/typescript-sdk` (public). Mỗi POST:
  response frame đến sau 0,3–0,6s nhưng server giữ stream SSE mở thêm
  ~10s rồi mới đóng (đo bằng curl: `initialize` TTFB 0,61s / tổng
  10,64s; `tools/list` TTFB 0,32s / tổng 10,34s). Client vì thế mất
  11,3s (init) + 10,1s (tools/list) ở lần 2 (lần 1: 19,6s + 10,6s).
  Đây là hành vi của server + limitation của client (§5), không phải
  lỗi mạng. Ngoài ra GitMCP trả `protocolVersion: 2025-03-26`
  (không nằm trong danh sách client hỗ trợ) — client rơi về
  `2025-11-25` theo đúng thiết kế của `negotiateProtocolVersion`
  (không fail handshake); tương tự MS Learn trả `2025-06-18`.
- **DeepWiki `/sse` — legacy SSE không được hỗ trợ (đã biết).**
  POST `/sse` → HTTP 405 sau 156 ms; GET diagnostic → HTTP 410.
  Client chỉ hỗ trợ streamable HTTP (xem header `client.ts`:
  "The legacy SSE transport ... is NOT supported"). Dùng `/mcp` thay
  thế — endpoint này OK (718 ms / 112 ms).
- **EdgeOne — tool duy nhất là `deploy-html` (ghi).** Probe chỉ liệt kê
  tool, không gọi, nên không deploy gì cả. Nếu đưa vào catalogue thì
  phải ghi rõ đây là server ghi (deploy ra URL công khai).
- **Hugging Face** — `hf_whoami` cho thấy server có khái niệm auth
  context, nhưng `initialize` + `tools/list` ẩn danh vẫn OK (4 tool).
  Các tool user-specific có thể cần token khi gọi thật — ngoài phạm vi
  probe (chỉ liệt kê).

## 5. Bug/limitation thật phát hiện trong client của repo — ĐÃ SỬA ở v0.73a (kiểm chứng lại ở v0.88c)

> Cập nhật 2026-11-11 (v0.88c): bug dưới đây **đã được sửa ở sóng v0.73a** (commit `0220330`: `readRpcBody` đọc SSE theo luồng, resolve ngay khi frame khớp id rồi `reader.cancel()`; test `tests/mcp-post-rpc-once-streaming-v073.test.mjs` 2/2) và **kiểm chứng lại ở v0.88c** (test mới `tests/mcp-client-streaming-v088c.test.mjs` 7/7: server quan sát được client ngắt kết nối < 2s sau frame, JSON thường đúng, frame lỗi/sai id/timeout giữ đúng hành vi cũ; chi tiết xem mục v0.88c trong `docs/BEYOND-ROADMAP.md`). Phần còn lại của mục này giữ nguyên như lúc probe (2026-11-10) để lưu vết đo gốc — các câu "chưa sửa" bên dưới chỉ đúng ở thời điểm probe, không còn đúng nữa.

**Vấn đề:** `StreamableHttpMcpClient` đợi toàn bộ response body mới xử
lý, nên server giữ stream SSE mở sẽ làm request chậm (hoặc timeout) dù
response đã đến.

- **File/dòng:** `packages/core/src/mcp/client.ts:1773`,
  trong `postRpcOnce()` (bắt đầu dòng 1741):
  `const text = await res.text();` — `res.text()` chỉ resolve khi
  server đóng stream. Chỉ sau đó `parseRpcResponse()` (dòng 1807) mới
  tách các frame SSE `data:` và chọn frame đúng `id`. Logic chọn frame
  đã có sẵn, nhưng không bao giờ được chạy sớm vì body đã bị buffer hết.
- **Bằng chứng đo thật:**
  - GitMCP (curl, không qua client): `initialize` TTFB 0,61s, tổng
    10,64s; `tools/list` TTFB 0,32s, tổng 10,34s — frame JSON-RPC đến
    trong <1s, stream giữ mở thêm ~10s. Qua client: init 11 343 ms,
    tools/list 10 124 ms (lần 2); 19 584 ms / 10 583 ms (lần 1).
    Hai lần chạy đều ~10s/request — ổn định, không phải nhiễu.
  - Các server đóng stream ngay sau response (DeepWiki, Context7, …)
    thì client nhanh như curl (<1,5s) — chứng tỏ chậm là do giữ stream,
    không phải do client chậm chung.
  - Hệ quả xấu nhất: server giữ stream mở vô thời hạn cho cả session
    (hợp lệ theo spec streamable HTTP) sẽ làm mọi request của client
    chạm timeout 30s (`MCP_REQUEST_TIMEOUT_MS`) dù server đã trả lời —
    đúng mẫu lỗi thấy ở lần chạy 1 (dù lần 1 cụ thể là nhiễu mạng).
- **Cách tái hiện:**
  ```bash
  npm run build --workspace=@open-bot/core
  node scripts/probe-public-mcp-server.mjs gitmcp
  # initializeMs ~11000-20000, toolsListMs ~10000 (dù curl cho thấy
  # frame trả về sau <1s — xem lệnh curl ở §4 GitMCP).
  ```
- **Hướng sửa (đề xuất cho sóng sau, không làm ở sóng này):** đọc body
  dạng stream tăng dần trong `postRpcOnce` (vd `res.body.getReader()`,
  parse frame SSE khi đủ một frame `data:` hoàn chỉnh), resolve ngay
  khi frame có `id` trùng request đến rồi hủy reader — thay vì
  `await res.text()`. Đây là thay đổi vừa (đụng đường HTTP lõi, cần test
  với fake server giữ stream mở + server trả JSON thường + server SSE
  nhiều frame), nên không sửa vội trong sóng probe này theo brief.
- **Không phát hiện bug nào khác.** Các lỗi còn lại trong quá trình
  probe đều là phía server/mạng (timeout nhất thời lần 1, 405/410 ở
  `/sse`, protocol fallback có chủ đích). Test hiện có của probe HTTP
  vẫn xanh sau khi build lại: `node --test
  tests/mcp-marketplace-probe-http-v068a.test.mjs
  tests/mcp-marketplace-probe-http-v069b.test.mjs` → 23/23 pass.

## 6. Giới hạn của kết quả này

- Đo tại một thời điểm (2026-11-10); endpoint, chính sách auth và rate
  limit của các server công khai thay đổi nhanh — freeapi.watch cũng
  cảnh báo "lists rot". Trước khi đưa endpoint nào vào catalogue chính
  thức, nên probe lại.
- Chỉ đo `initialize` + `tools/list`, không gọi tool nào (kể cả tool
  đọc) — chất lượng tool thật, quota ẩn danh và hành vi khi gọi tool
  chưa được kiểm chứng.
- Không gửi và không ghi bất kỳ credential nào trong script, log hay
  docs này. Không dùng server cần key/đăng nhập.
- `probeMarketplaceServerTools` (marketplace.ts) chỉ probe entry trong
  catalogue — script lần này dùng `StreamableHttpMcpClient` trực tiếp
  (cùng client mà hàm probe dùng) vì các server thật chưa nằm trong
  catalogue; việc thêm entry catalogue là quyết định riêng của điều phối
  viên (file docs này không sửa `BEYOND-ROADMAP.md`).
