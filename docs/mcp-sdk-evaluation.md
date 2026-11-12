# Đánh giá: migrate sang MCP SDK chính thức? (v0.13, mục 14)

- **Ngày:** 2026-11-09
- **Phạm vi:** client MCP tự viết (`packages/core/src/mcp/client.ts`,
  `types.ts`) + server MCP tự viết mới (`packages/core/src/mcp/server.ts`)
  so với MCP SDK chính thức cho TypeScript.
- **Đây là ĐÁNH GIÁ, không phải migrate.** Chưa tự migrate khi chưa
  được duyệt — code hiện tại không đổi vì tài liệu này.
- **Nguồn:** SDK docs chính thức (ts.sdk.modelcontextprotocol.io, đọc
  ngày 2026-11-09) + `docs/research-mcp-2025-11.md` + code open-bot
  hiện tại. SDK có 2 dòng cùng tồn tại: **v1.x** (package duy nhất
  `@modelcontextprotocol/sdk`, maintenance line, implement spec tới
  **2025-11-25**) và **v2** (stable hiện tại, tách thành các package
  riêng `@modelcontextprotocol/server` / `client` / `core`, theo spec
  **2026-07-28**). v1.x chỉ còn nhận bug fix + security update tối
  thiểu 6 tháng sau ngày v2 release (2026-07-27).

## 1. SDK chính thức làm được gì (theo docs của nó)

| Tính năng | SDK v1.x | SDK v2 |
|---|---|---|
| `McpServer` / `Client` high-level (đăng ký tool/resource/prompt bằng hàm) | ✅ | ✅ |
| Transport stdio + Streamable HTTP (stateful/stateless) + HTTP+SSE legacy | ✅ | ✅ |
| Session management + resumability (`Last-Event-ID`) cho Streamable HTTP | ✅ | ✅ |
| Protocol negotiation, capability, ping, progress, cancellation, pagination | ✅ | ✅ |
| Elicitation (form + URL mode), tasks, sampling, logging | ✅ (example server đầy đủ: sessions, logging, tasks, elicitation, auth hooks) | ✅ |
| OAuth 2.1 / authorization (server-side auth hooks) | ✅ (example có) | ✅ |
| Spec 2025-11-25 (icons, elicitation URL-mode, tasks experimental, JSON Schema 2020-12) | ✅ (LATEST) | ✅ |
| Spec 2026-07-28 (stateless, `server/discover`, tasks thành extension, bỏ `initialize`) | ❌ (không có kế hoạch) | ✅ |
| Peer dependency `zod` (bắt buộc, để validate schema tool) | ✅ bắt buộc | ✅ bắt buộc |
| Cộng đồng / test / cập nhật theo spec | Lớn nhất trong hệ MCP | Lớn nhất |

## 2. Client tự viết hiện tại làm được gì (đối chiếu thật với code)

| Tính năng | Client tay (`client.ts`, ~540 dòng) | Ghi chú |
|---|---|---|
| stdio (spawn, NDJSON, timeout 30s, kill SIGTERM→SIGKILL) | ✅ tốt | Khớp SDK |
| Streamable HTTP POST + parse SSE `data:` + `Mcp-Session-Id` | ✅ khá | Thiếu GET SSE stream / resume / DELETE session (mục v0.13 khác làm) |
| `initialize` + protocol version 2025-11-25 + fallback version cũ | ✅ tốt | SDK cũng làm vậy |
| OAuth: token qua `authProvider`, 401 → refresh 1 lần → retry | ✅ (v0.9 nối xong) | SDK client không tự làm OAuth flow này — app vẫn phải viết provider; SDK chỉ gắn header |
| SEP-1303: lỗi validate input là tool error, không phải protocol error | ✅ | SDK cũng có (theo spec) |
| `tools/list`/`call`, `resources/list`/`read`, `ping` | ✅ | Khớp SDK ở mặt cơ bản |
| Connection pool giữ session sống giữa các tool call | ✅ (tầng tools) | SDK client giữ 1 connection/transport — pool vẫn phải tự viết |
| Prompts, subscribe/templates, completion, elicitation, sampling, roots, tasks, progress | ❌ chưa có | Đây là phần SDK hơn hẳn: mỗi tính năng là tự implement lại một phần SDK |
| Parse `structuredContent`, `annotations`, `outputSchema`, `icons`, `resource_link` | ❌ (bỏ qua khi parse) | SDK giữ đầy đủ, type-safe |
| Bảo mật: không log token/header, validate URL http(s), stderr tail giới hạn | ✅ tốt | SDK không tự làm hết — app vẫn phải tự giữ guard |
| Kích thước / dependency | 0 dependency ngoài, ~540 dòng client + ~90 dòng types | SDK + zod + transitive deps (vài MB, phải audit) |
| Server phía open-bot (`mcp/server.ts`, mới ở v0.13) | ✅ tự viết (stdio + Streamable HTTP, tools/resources/prompts, allowlist, workspace confinement) | SDK `McpServer` + `StreamableHTTPServerTransport` làm sẵn phần này, kèm session/resume |

## 3. Cái gì SDK làm tốt hơn

1. **Độ phủ spec:** elicitation (form + URL), tasks, progress,
   completion, prompts, subscribe, logging, sampling — SDK có sẵn,
   đã test bởi cộng đồng. Tự viết từng cái là mỗi lần viết lại một
   phần SDK + tự test tương thích với client/server khác.
2. **Theo kịp spec mới:** v2 đã theo 2026-07-28 (stateless,
   `server/discover`, tasks extension). Tự viết theo 2025-11-25 thì
   khi nâng cấp phải tự migrate tasks/elicitation (research đã cảnh
   báo tasks 2025-11-25 không tương thích ngược với extension
   2026-07-28).
3. **Type-safety + validation:** schema tool qua zod — sai schema
   thì lỗi ngay lúc đăng ký thay vì lúc client gọi. Code tay dùng
   `Record<string, unknown>` + parse thủ công, dễ sót field.
4. **Tương thích hệ sinh thái:** Inspector, Claude Desktop, Cursor
   và server khác đều test với SDK — dùng SDK thì lỗi tương thích
   (framing SSE, session, header) gần như bằng 0. Code tay đã đúng
   với client của chính mình (test v0.13 chứng minh client tay ↔
   server tay chạy được), nhưng chưa test với client ngoài.
5. **Bảo trì dài hạn:** spec đổi thì SDK đổi theo; code tay đổi theo
   thì phải có người đọc changelog spec mỗi revision.

## 4. Cái gì tự viết đang làm tốt hơn (hoặc SDK không hơn)

1. **Nhẹ, không dependency:** 0 dependency, không zod, không lo
   supply-chain / audit dependency lạ — đúng chính sách local-first
   và "không dependency lạ" của dự án. SDK kéo theo zod +
   transitive deps, phải đưa vào audit bảo mật cuối (v0.15).
2. **OAuth nối Vault đã xong theo cách riêng:** token lấy qua
   `getValidAccessToken`, refresh + retry 401, lưu Vault mã hoá —
   SDK không làm thay phần này; migrate vẫn giữ nguyên
   `authProvider` + `oauth.ts`, chỉ đổi lớp transport/protocol.
3. **Kiểm soát hành vi lỗi theo ý mình:** SEP-1303, timeout 30s,
   kill process group, stderr tail không log secret, message lỗi
   tiếng Việt rõ ràng cho user — SDK throw lỗi của nó, phải wrap
   lại mới có message như hiện tại.
4. **Server tay đã gắn allowlist + workspace confinement** theo đúng
   chính sách an toàn của open-bot (tool chỉ-đọc mặc định, chặn
   `..`/symlink). SDK `McpServer` expose tool nào đăng ký — phần
   allowlist/confinement vẫn phải tự viết y như hiện tại, SDK
   không cho không.
5. **Client tay đã đủ cho nhu cầu hiện tại:** tools/resources +
   OAuth + pool đã chạy tốt cho 8 server marketplace; các tính năng
   spec còn thiếu (elicitation/tasks/progress) là các mục v0.13
   riêng (W5a–W5c đang làm trên client tay) — chưa có bằng chứng
   client tay là nút thắt.
6. **Chi phí chuyển đổi không hề nhỏ** (xem §5) trong khi lợi ích
   lớn nhất (theo spec 2026-07-28) lại nằm ở v2 — mà v2 đổi cả
   handshake (`server/discover`, bỏ `initialize`), tức migrate
   sang v1.x hôm nay thì mai vẫn phải migrate tiếp sang v2.

## 5. Chi phí migrate (ước tính, 1 dev quen codebase)

| Hạng mục | Ước tính |
|---|---|
| Thêm `@modelcontextprotocol/sdk` (+ `zod` peer dep) vào `packages/core`, audit dep | 0,5 ngày |
| Viết lại client: `StdioMcpClient` + `StreamableHttpMcpClient` → SDK `Client` + transport, giữ `authProvider` (401 refresh/retry), giữ `McpError`/message tiếng Việt, giữ pool ở `mcpTools.ts` | 2–3 ngày |
| Viết lại server: `mcp/server.ts` → SDK `McpServer` + transport, giữ allowlist + workspace confinement + tool/resource/prompt mặc định | 1–2 ngày |
| Chuyển schema tool sang zod (mọi `inputSchema` hiện là JSON Schema thuần) | 1 ngày |
| Test lại: `tests/mcp.test.mjs`, `tests/mcp-server-a2a-v013.test.mjs`, fake server, tương thích Claude Desktop/Inspector | 2 ngày |
| Sửa doc + wiring coordinator (nơi nào import `connectMcp`/`McpClient`) | 0,5–1 ngày |
| **Tổng (sang v1.x)** | **~7–10 ngày** |
| **Phụ thêm nếu sang thẳng v2** (handshake `server/discover`, stateless, tasks extension) | **+5–7 ngày** (và phải đợi/bám spec 2026-07-28 ổn định trong hệ sinh thái — client ngoài phần lớn vẫn nói 2025-11-25) |

Rủi ro migrate:
- **Hồi quy tương thích ngược:** server/client ngoài chỉ biết
  2024-11-05 vẫn phải chạy — SDK hỗ trợ danh sách version cũ,
  nhưng fallback + `authProvider` tự viết là chỗ dễ vỡ nhất.
- **Zod là dependency bắt buộc:** mọi schema tool phải viết lại
  bằng zod; schema JSON Schema có sẵn (vd tool của plugin) phải
  convert — dễ sai lệch.
- **Mất kiểm soát message lỗi:** lỗi SDK (tiếng Anh, kỹ thuật) lọt
  ra user nếu wrap không kín.
- **v1.x là maintenance line:** migrate sang v1.x hôm nay là
  migrate sang dòng sắp hết hỗ trợ chủ động (bug fix + security
  tối thiểu 6 tháng sau 2026-07-27); migrate sang v2 thì đổi cả
  handshake, tốn thêm gần gấp đôi.
- **Không giải quyết được phần việc còn lại:** allowlist,
  confinement, OAuth Vault, pool, message tiếng Việt vẫn phải tự
  giữ — migrate không xóa được code "riêng" của open-bot, chỉ đổi
  lớp protocol.

## 6. QUYẾT ĐỊNH: KHÔNG MIGRATE (tại thời điểm này)

**Không migrate sang MCP SDK chính thức — giữ client + server tự
viết, ít nhất tới hết v0.13.**

Lý do (ngắn gọn):
1. Code tay đã đủ tốt cho nhu cầu hiện tại (tools/resources +
   OAuth + pool + server mới v0.13) và nhẹ hơn hẳn (0 dependency).
2. Lợi ích lớn nhất của SDK (elicitation/tasks/progress/completion)
   đang được làm dần trên code tay ở v0.13 (W5a–W5c); migrate giữa
   chừng sẽ vứt đi công việc đó và tốn 7–10 ngày.
3. Migrate sang v1.x là đi vào dòng maintenance sắp hết hỗ trợ;
   migrate sang v2 thì phải đổi cả handshake và hệ sinh thái client
   ngoài chưa theo kịp — cả hai thời điểm đều xấu.
4. Phần "riêng" của open-bot (allowlist, workspace confinement,
   OAuth Vault, message tiếng Việt) SDK không làm thay, nên migrate
   không giảm được bao nhiêu code riêng.

**Khi nào xem lại quyết định này (trigger rõ ràng):**
- Khi bắt đầu làm elicitation/tasks/progress mà thấy code tay phình
  to (ước tính > 500 dòng mới chỉ để bắt kịp SDK), hoặc
- Khi cần tương thích với một client/server ngoài quan trọng mà code
  tay nói chuyện không được (lỗi framing/session thực tế, không
  phải nghi ngờ), hoặc
- Khi hệ sinh thái (Claude Desktop/Cursor/Inspector) chuyển hẳn
  sang spec 2026-07-28 và v2 SDK ổn định — lúc đó đánh giá lại
  migrate **thẳng sang v2**, bỏ qua v1.x.

**Việc nên làm thay vì migrate (rẻ hơn, giữ được code tay):**
- Test tương thích server tay với MCP Inspector + một client ngoài
  (Claude Desktop/Cursor) khi nối server vào Local API — nếu chạy
  được thì code tay đã đủ chuẩn.
- Giữ `McpClient`/`McpServer` sau abstraction (interface như hiện
  tại) để sau này thay implementation bằng SDK mà không sửa caller.
- Ghi lại quyết định này ở `docs/BEYOND-ROADMAP.md` khi điều phối
  viên tổng kết v0.13 (file này không thuộc ranh giới của worker
  W5d nên không tự sửa).
