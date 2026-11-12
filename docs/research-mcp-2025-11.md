# Nghiên cứu MCP spec 2025-11-25 — đối chiếu với open-bot

Ngày nghiên cứu: 2026-11-09 · Người viết: subagent nghiên cứu (không sửa code, không commit)
Nguồn chính: [modelcontextprotocol.io — changelog 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog),
[Authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
changelog 2026-07-28, và code tại `packages/core/src/mcp/`, `packages/tools/src/mcpTools.ts`,
`packages/tools/src/mcpSystemTools.ts`.

---

## 1. Tóm tắt điều hành

> Đính chính 2026-11-09 (v0.37, theo `docs/rea-grokbot-deep-dive.md` §8.4 — kiểm tra lại code ở commit 23329a7): 3 điểm dưới đây đã lỗi thời, client đã lên MCP 2025-11-25, OAuth token đã được dùng, và đã có MCP server phía open-bot. Các mục còn lại trong tài liệu này vẫn là gap thật (xem §4).

> **Cập nhật P0-4, 2026-11-09 (v0.40)** — reconnect config, auth-tool UX và tasks sau abstraction đã làm xong (xem §7): client có `McpReconnectPolicy` theo đúng số liệu `mcp_reconnect_config` của Grok (fast retry 5s→60s ×5, periodic 5→30 phút, tombstone 404 ×5, keepalive 5 phút ±30s, degraded probe 30s ×3, tool idle 120s / tổng 60 phút, stdio lỗi không retry); mỗi HTTP server có tool `mcp_authenticate_<server>` để model tự gọi khi cần auth; tasks có backend extension 2026-07-28 sau cùng abstraction `TaskHandle`. Elicitation form-mode + URL-mode đã kiểm tra lại coverage thực tế — đủ ở tầng core, còn 2 gap ghi ở §7.

- **open-bot đang chạy MCP ở bản 2025-11-25** (`MCP_PROTOCOL_VERSION = '2025-11-25'` trong `packages/core/src/mcp/client.ts`).
  Client tự viết tay bằng JSON-RPC 2.0, không dùng MCP SDK chính thức.
- **Nền tảng đã có và tốt:** stdio + Streamable HTTP, tools/resources, OAuth 2.0 + PKCE
  đầy đủ (lưu Vault, refresh token), marketplace local 8 server. Đây là phần việc v0.2–v0.7
  đã làm chắc.
- **OAuth token đã được dùng (không còn lỗ hổng "lấy token nhưng không dùng"):** `mcpTools.ts:170` gọi
  `getValidAccessToken(...)`; `client.ts` có `resolveAuth()` / `refreshAuthorization()` gắn header
  `Authorization` khi gọi MCP (dòng ~1055–1130, ~1238–1260).
- **Client capability đã có:** `initialize` gửi capabilities được build từ handler đã đăng ký
  (`buildMcpClientCapabilities(config.clientHandlers)`, `client.ts` ~1436–1443), không còn `{}` rỗng;
  elicitation/roots/sampling đã có handler (`clientHandlers.ts`). Tasks vẫn là mục P1 (experimental,
  implement sau abstraction — xem §4).
- **Đã có MCP server phía open-bot** (`packages/core/src/mcp/server.ts`, v0.13): stdio +
  Streamable HTTP, spec 2025-11-25, allowlist tool chỉ-đọc, lỗi validate → tool error (SEP-1303).
  Claude Desktop / Cursor / app khác có thể gọi ngược tool của open-bot.
- **Marketplace là catalogue tĩnh local**, không theo định dạng MCP Registry
  (`server.json`) và không fetch từ xa.
- **Cảnh báo về tương lai (quan trọng):** bản spec mới nhất hiện nay là **2026-07-28**,
  trong đó sampling / roots / logging bị **deprecated**, tasks chuyển khỏi core thành
  extension `io.modelcontextprotocol/tasks` (không tương thích ngược với bản
  experimental 2025-11-25), và core trở nên stateless. Vì vậy **không nên đầu tư lớn
  vào sampling/roots**, và nên implement tasks/elicitation sau một lớp abstraction để
  đổi được khi spec đổi.

---

## 2. MCP spec 2025-11-25 có gì mới (so với 2025-06-18)

### 2.1 Major changes (changelog chính thức)

| # | Tính năng | Nội dung |
|---|-----------|----------|
| 1 | **OIDC Discovery cho auth** (PR #797) | Authorization server discovery thêm OpenID Connect Discovery 1.0, bên cạnh OAuth 2.0 Authorization Server Metadata (RFC 8414). Client phải thử nhiều well-known endpoint theo thứ tự ưu tiên (path insertion rồi path appending). |
| 2 | **Icons** (SEP-973) | Server được expose icon (metadata) cho tools, resources, resource templates, prompts. |
| 3 | **Incremental scope consent qua `WWW-Authenticate`** (SEP-835) | Server có thể đòi thêm scope giữa chừng bằng header `WWW-Authenticate` (step-up auth); client parse header và xin thêm scope thay vì fail. |
| 4 | **Hướng dẫn đặt tên tool** (SEP-986) | Quy tắc tên tool (độ dài, ký tự, namespace gợi ý) để model gọi đúng. |
| 5 | **Elicitation: `ElicitResult` / `EnumSchema` chuẩn hóa** (SEP-1330) | Enum có titled / untitled, single-select / multi-select theo chuẩn JSON Schema hơn; cộng default values cho mọi primitive (SEP-1034). |
| 6 | **URL-mode elicitation** (SEP-1036) | Ngoài form-mode (server hỏi qua form JSON Schema), server có thể yêu cầu user mở một URL ngoài (out-of-band: đăng nhập, thanh toán, xác minh). Form-mode **MUST NOT** dùng cho password / API key / token / thanh toán — phải dùng URL mode. Client phải hiển thị rõ server nào đang hỏi, có nút decline/cancel. |
| 7 | **Tool calling trong sampling** (SEP-1577) | `sampling/createMessage` thêm `tools` + `toolChoice`: server có thể nhờ model của client gọi tool trong lúc sampling. |
| 8 | **OAuth Client ID Metadata Documents** (SEP-991) | Cơ chế đăng ký client khuyên dùng: client dùng URL HTTPS làm `client_id`, trỏ tới JSON document chứa `client_id`, `client_name`, `redirect_uris`. Giải quyết trường hợp client–server không có quan hệ từ trước (phổ biến nhất với MCP). Thứ tự ưu tiên: pre-registered → Client ID Metadata Document → Dynamic Client Registration (RFC 7591) → hỏi user nhập tay. |
| 9 | **Tasks — experimental** (SEP-1686) | Durable async requests: client gửi request kèm `task`, server trả ngay task handle (`taskId`, `status`, `pollInterval`), client poll `tasks/get`, lấy kết quả qua `tasks/result` (blocking), hủy qua `tasks/cancel`, liệt kê qua `tasks/list`. Áp cho `tools/call` và cả server-initiated `sampling/createMessage` / `elicitation/create`. Trạng thái: `working`, `input_required`, `completed`, `failed`, `cancelled`. |

### 2.2 Minor changes đáng chú ý

- **JSON Schema 2020-12** là dialect mặc định cho mọi schema MCP (SEP-1613).
- **Lỗi validate input → Tool Execution Error, không phải Protocol Error** (SEP-1303):
  để model tự sửa và gọi lại, thay vì fail cả phiên.
- **OAuth Protected Resource Metadata theo RFC 9728** (SEP-985): `WWW-Authenticate`
  optional, fallback sang `.well-known/oauth-protected-resource`; client **phải**
  hỗ trợ cả hai cách discovery (header + well-known).
- **HTTP 403 cho Origin header không hợp lệ** trong Streamable HTTP (PR #1439).
- **Polling SSE stream:** server được disconnect stream tùy ý; client resume qua GET
  với `Last-Event-ID`; event ID nên encode stream identity (SEP-1699 + Issue #1847).
- **`Implementation` thêm field `description`** (khớp format `server.json` của Registry).
- **stderr cho stdio server:** dùng cho mọi loại log, không chỉ lỗi (PR #670).
- **Security Best Practices** cập nhật; governance chính thức hóa; **SDK tiering**
  (SEP-1730: SDK nào hỗ trợ tính năng nào, cam kết bảo trì).

### 2.3 Bối cảnh: các tính năng từ bản cũ hơn mà open-bot cũng chưa có

| Tính năng | Từ bản | Ghi chú |
|---|---|---|
| Streamable HTTP (thay HTTP+SSE) | 2025-03-26 | POST + GET SSE stream, `Mcp-Session-Id`, resumability. |
| OAuth 2.1 (PKCE bắt buộc, resource indicators RFC 8707) | 2025-03-26 | Server là OAuth resource server; client phải gửi `resource` param. |
| Structured tool output (`structuredContent` + `outputSchema`) | 2025-06-18 | Tool trả JSON có schema, model dùng trực tiếp thay vì parse text. |
| Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`) | 2025-06-18 | Client/agent dùng để quyết định approval, hiển thị. |
| Elicitation form-mode | 2025-06-18 | Server hỏi user giữa chừng qua form. |
| Resource links trong tool result | 2025-06-18 | Tool result có thể chứa block `resource_link` trỏ tới resource. |
| Progress notifications (`progressToken`, `notifications/progress`) + `notifications/cancelled` | 2024-11-05 | Server báo tiến độ cho request dài; client hủy request. |
| Roots (`roots/list`) | 2024-11-05 | Client báo cho server biết thư mục/file nào được phép làm việc. |
| Sampling (`sampling/createMessage`) | 2024-11-05 | Server nhờ model của client hoàn thành text. |
| Prompts (`prompts/list`, `prompts/get`) | 2024-11-05 | Server cung cấp prompt template. |
| Resources subscribe + templates (`resources/subscribe`, `resources/templates/list`) | 2024-11-05 | Theo dõi thay đổi resource; URI template. |
| Completion (`completion/complete`) | 2024-11-05 | Gợi ý autocomplete cho argument/resource/prompt. |
| Logging (`logging/setLevel`, `notifications/message`) | 2024-11-05 | Server gửi log về client. |
| **JSON-RPC batching** | — | **Đã bị loại khỏi spec từ 2025-06-18.** Đừng implement batching; gửi từng request. |

### 2.4 Nhìn về phía trước: spec 2026-07-28 (mới nhất tính đến 2026-11-09)

- Core trở nên **stateless**: bỏ handshake `initialize` và session ở tầng protocol,
  thêm `server/discover`, routing header, cacheable list.
- **Tasks** chuyển khỏi core thành extension chính thức `io.modelcontextprotocol/tasks`:
  bỏ `tasks/result` (blocking) và `tasks/list`; `tasks/get` trả luôn kết quả cuối;
  thêm `tasks/update` để client gửi input cho task đang chạy; server được trả task
  handle mà không cần client opt-in từng request. **Không tương thích ngược** với
  tasks experimental 2025-11-25 — ai implement theo 2025-11-25 sẽ phải migrate.
- **Sampling, Roots, Logging bị deprecated** (SEP-2577): vẫn hoạt động trong thời gian
  chuyển đổi (tối thiểu 12 tháng) nhưng implementation mới không nên thêm.
- **Multi Round-Trip Requests (MRTR)** thay cách gửi server-initiated request cũ
  (`roots/list`, `sampling/createMessage`, `elicitation/create`): server trả
  `InputRequiredResult`; client retry request gốc sau khi xử lý xong. Bỏ
  `notifications/elicitation/complete` và field `elicitationId` của URL-mode
  (vốn mới thêm ở 2025-11-25).
- Kết luận: với open-bot, **ưu tiên elicitation + tasks + progress + OAuth discovery**;
  **tránh đầu tư sampling/roots**; thiết kế tasks sau abstraction để đổi sang
  extension 2026-07-28 sau.

---

## 3. Hiện trạng MCP của open-bot (đọc code ngày 2026-11-09)

### 3.1 Kiến trúc tổng thể

- **Client tự viết tay, không dùng SDK** (`@modelcontextprotocol/sdk` không có trong
  bất kỳ `package.json` nào). Chỉ dùng Node stdlib + `fetch`.
- Chỉ là **client**. Không có MCP server nào expose tool của open-bot ra ngoài.
- Cấu hình qua `<workspace>/.open-bot/mcp.json`, format riêng `{ servers: { name:
  { command, args, env, url, headers } } }` — tương thích khái niệm với Claude
  Desktop nhưng không đọc `server.json` của MCP Registry.

### 3.2 Từng file

#### `packages/core/src/mcp/client.ts` (539 dòng) — client JSON-RPC

> Cập nhật P0-4 (v0.40): reconnect đã có config + policy theo số liệu Grok
> (`McpReconnectConfig` / `DEFAULT_MCP_RECONNECT_CONFIG` /
> `McpReconnectPolicy`, xem §7) — không còn retry cố định 3 lần / 1s ở
> GET stream; tool call có timeout giới hạn (idle 120s / tổng 60 phút);
> lỗi kết nối stdio đánh dấu `McpError.nonRetryable`. Các mục dưới đây
> trừ reconnect vẫn đúng ở thời điểm viết.

**Đã có:**
- `StdioMcpClient`: spawn process, NDJSON qua stdin/stdout, pending map theo `id`,
  timeout 30s/request, gom stderr tail (không log nguyên văn), kill SIGTERM→SIGKILL.
- `StreamableHttpMcpClient`: POST JSON-RPC, header `Accept: application/json,
  text/event-stream`, parse SSE `data:` frame, lưu `Mcp-Session-Id` từ response header
  và gửi lại ở request sau. Legacy SSE transport cũ đã bỏ đúng theo spec.
- `initialize` + `notifications/initialized`, `ping`, `tools/list`, `tools/call`,
  `resources/list`, `resources/read`.
- `toolResultToText` / `resourceResultToText`: gộp content block thành text; block
  `image` → placeholder; block `resource` có `uri` → `[resource: <uri>]`.

**Thiếu / kém hơn spec:**
- `MCP_PROTOCOL_VERSION = '2024-11-05'` — khai báo bản cũ 2 revision; server mới có
  thể từ chối hoặc downgrade tính năng.
- `initialize` gửi **`capabilities: {}` rỗng** — không khai roots, sampling, elicitation,
  experimental tasks; server không bao giờ biết client làm được gì.
- **Không xử lý request do server khởi xướng:** `onStdout` chỉ xử lý message có `id`
  là number và nằm trong `pending`; notification/request từ server (sampling,
  elicitation, roots, progress, ping) bị drop lặng lẽ. `StreamableHttpMcpClient`
  cũng không có đường nào nhận server-initiated request.
- **Không có progress:** không gửi `progressToken` trong `_meta`, không xử lý
  `notifications/progress`, không gửi `notifications/cancelled`.
- **Không có `_meta` nói chung** (không `progressToken`, không task params).
- **Streamable HTTP chưa đủ:** chỉ POST; không có GET SSE stream để nhận notification
  / resume sau disconnect, không gửi `Last-Event-ID`, không DELETE để đóng session,
  không validate Origin (phía client không cần, nhưng không kiểm tra 403/401 gì thêm).
- **Không xử lý HTTP 401:** `postRpc` throw `McpError` chung cho mọi `!res.ok` — không
  parse `WWW-Authenticate`, không discovery PRM, không trigger OAuth lại.
- `parseToolDefs` **bỏ qua** `title`, `annotations`, `outputSchema`, `icons`, `_meta`.
  `parseResources` bỏ qua `icons`, `size`, `annotations`.
- `contentBlocksToText` **không hiểu `resource_link`** (block mới từ 2025-06-18):
  rơi vào nhánh `JSON.stringify(block)` — model nhận JSON thô thay vì link đẹp.
  Cũng không giữ `structuredContent` (trả JSON có cấu trúc): `toolResultToText` chỉ
  lấy `content`, bỏ `structuredContent`.
- Không có `prompts/list` / `prompts/get`, `resources/subscribe`,
  `resources/templates/list`, `completion/complete`, `logging/setLevel`.
- Không có tasks (`tasks/get`, `tasks/result`, `tasks/cancel`, `tasks/list`).
- Không có elicitation / sampling / roots ở cả hai chiều.
- Không hỗ trợ JSON-RPC batching — **đúng** (spec đã bỏ batching từ 2025-06-18),
  không cần làm.

#### `packages/core/src/mcp/types.ts` (83 dòng)

- Type tối thiểu: `McpServerConfig { name, command?, args?, env?, url?, headers? }`,
  `McpToolDef { name, description?, inputSchema? }`, `McpResource`,
  `McpContentBlock` (type mở, `[key: string]: unknown`), interface `McpClient`
  chỉ 7 method. Không có type cho prompts, elicitation, sampling, roots, tasks,
  progress, icons, annotations, `structuredContent`, `outputSchema`.

#### `packages/core/src/mcp/config.ts` (129 dòng) — load `mcp.json`

- Validate tốt (URL http(s) only, không echo secret vào error). Chỉ hỗ trợ static
  `headers` (user tự dán `Authorization: Bearer …`). Không có field nào cho OAuth
  (authorization endpoint, client id, scope) — OAuth config nằm ở chỗ khác
  (`<userData>/mcp-oauth.json`, do host quản lý) và **không được nối vào client**.

#### `packages/core/src/mcp/oauth.ts` (594 dòng) — OAuth 2.0 + PKCE, v0.7

**Đã có (khá đầy đủ ở tầng transport/crypto):**
- PKCE S256 (`createPkcePair`), `state` chống CSRF, localhost callback listener
  (127.0.0.1, port ngẫu nhiên, timeout 5 phút), `exchangeCodeForToken`,
  `refreshAccessToken`, `getValidAccessToken` (refresh khi hết hạn, giữ refresh token
  cũ nếu provider không rotate), lưu qua `McpOAuthStore` trừu tượng → Vault namespace
  `mcp-oauth`, không log token.

**Thiếu so với spec 2025-11-25:**
- **Chưa được nối vào client** (xem §1 — lỗ hổng lớn nhất). Token nằm trong Vault
  nhưng request MCP không bao giờ mang nó.
- Không có **Protected Resource Metadata discovery** (RFC 9728): không fetch
  `.well-known/oauth-protected-resource`, không parse `WWW-Authenticate`
  (`resource_metadata`, `scope`) trên 401.
- Không có **Authorization Server Metadata / OIDC Discovery** (RFC 8414 + OIDC):
  endpoint phải do host cấu hình tay (`McpOAuthClientConfig` cần sẵn
  `authorizationEndpoint`/`tokenEndpoint`), không tự discovery từ server URL.
- Không có **Client ID Metadata Documents** (SEP-991) và không có **Dynamic Client
  Registration** (RFC 7591): `clientId` phải có sẵn từ trước.
- Không có **incremental scope / step-up auth** qua `WWW-Authenticate` (SEP-835).
- Không gửi **Resource Indicators** (RFC 8707 `resource` param) khi xin token.
- Không có **token revocation** endpoint; `clearOAuthToken` chỉ xóa local.

#### `packages/core/src/mcp/marketplace.ts` (483 dòng) — marketplace local, v0.3

- Catalogue **tĩnh 8 server** (`filesystem`, `memory`, `fetch`, `sqlite`, `git`,
  `brave-search`, `github`, `postgres` — đều qua `npx -y @modelcontextprotocol/server-*`),
  seed vào `<baseDir>/marketplace/mcp-servers.json`; `install`/`uninstall` chỉ sửa
  `mcp.json`, không ghi credential (đúng, an toàn), trả `nextSteps`.
- **Không phải MCP Registry:** không đọc/ghi format `server.json` chuẩn của Registry
  (registry.modelcontextprotocol.io), không có version, không fetch remote, không
  có checksum/signature, không ratings/downloads, không auto-update, không sync.
  Entry không có `icons`, `repository`, `version` — các field Registry chuẩn.
- Desktop UI đã có (`apps/desktop/src/renderer/components/McpMarketplaceView.tsx`,
  IPC `mcp-marketplace:*`), nhưng chưa có form sửa args/env lúc cài (ghi chú trong
  ROADMAP: user tự sửa `mcp.json`).

#### `packages/tools/src/mcpTools.ts` (310 dòng) — 5 tool agent

> Cập nhật P0-4 (v0.40): đã có auth-tool UX (mỗi HTTP server có thêm tool
> `mcp_authenticate_<server>` để model tự gọi khi cần auth, chạy flow
> OAuth PKCE của `mcp_auth`); lỗi auth ở 4 tool MCP kèm gợi ý gọi tool
> đó thay vì chỉ báo lỗi 401. Các mục dưới đây trừ auth vẫn đúng ở thời
> điểm viết.

- `mcp_list_servers`, `mcp_list_tools`, `mcp_call_tool` (cần approval),
  `mcp_list_resources`, `mcp_read_resource`. Giới hạn 20.000 ký tự kết quả.
- **Fresh connection mỗi lần gọi** (`withMcpClient`: `connectMcp` → 1 operation →
  `close`): mỗi `mcp_call_tool` là một `initialize` handshake + spawn process mới
  (stdio) hoặc session HTTP mới. Tốn kém, mất session, và là lý do tasks/progress
  khó làm ở tầng này. Không có connection pool / session cache.
- Không expose prompts, không expose elicitation/sampling, không có timeout hủy
  giữa chừng (chỉ timeout tổng 60s), không retry.
- Ghi chú trong file vẫn nói "NO OAuth flow" — đã lỗi thời so với `mcpSystemTools.ts`
  (có `mcp_auth`) nhưng đúng ở nghĩa "tool này không dùng OAuth".

#### `packages/tools/src/mcpSystemTools.ts` (376 dòng) — `mcp_auth`, `mcp_auth_status`, `mcp_system_exec`

- `mcp_auth` chạy đủ flow PKCE qua `oauth.ts`, mở browser qua event `mcp.open-url`,
  lưu token vào Vault (event `mcp.oauth-token`), do coordinator nối
  (`packages/core/src/coordinator/coordinator.ts:279-385`).
- `mcp_auth_status` chỉ `loadOAuthToken` + `isTokenExpired` — **không refresh**
  (không gọi `getValidAccessToken` dù đã import nó; chỉ re-export ở cuối file).
- `mcp_system_exec`: gọi tool của MCP server tên `system` trong `mcp.json` qua client
  thật, có allowlist (mặc định rỗng). Đây là cầu nối "MCP server của hệ thống" duy
  nhất, nhưng server `system` là server ngoài do user tự cấu hình — không phải
  server do open-bot expose.

#### Những thứ hoàn toàn chưa có

- **MCP server phía open-bot** (không có code nào implement `tools/list` phía server,
  không endpoint MCP nào trong `packages/core/src/api/server.ts`).
- Prompts, resources subscribe/templates, completion, logging.
- Icons, tool annotations, structured output, resource links.
- Elicitation / sampling / roots / tasks / progress / cancellation.
- Test: `tests/mcp.test.mjs` (12 test) chỉ cover config + stdio client + 5 tool với
  `tests/fixtures/fake-mcp-server.mjs`; không có test cho Streamable HTTP OAuth,
  elicitation, tasks.

### 3.3 Bảng đối chiếu nhanh

| Tính năng (spec) | Spec | open-bot | Đánh giá |
|---|---|---|---|
| Protocol version | 2025-11-25 | 2024-11-05 | Lỗi thời 2 bản |
| stdio transport | ✅ | ✅ | Tốt |
| Streamable HTTP (POST) | ✅ | ✅ (POST + SSE parse) | Khá |
| Streamable HTTP (GET stream, resume, DELETE session) | ✅ | ❌ | Thiếu |
| tools/list, call | ✅ | ✅ | Tốt |
| resources/list, read | ✅ | ✅ | Tốt |
| Structured output / outputSchema | 2025-06-18 | ❌ (bỏ `structuredContent`) | Thiếu |
| Tool annotations / title / icons | 2025-06-18 / 2025-11-25 | ❌ (parse bỏ qua) | Thiếu |
| Resource links | 2025-06-18 | ❌ (stringify thô) | Thiếu |
| Prompts | ✅ | ❌ | Thiếu |
| Resources subscribe / templates | ✅ | ❌ | Thiếu |
| Completion | ✅ | ❌ | Thiếu |
| Logging | ✅ (deprecated 2026-07-28) | ❌ | Không cần làm |
| Progress / cancellation | ✅ | ❌ | Thiếu |
| Roots | ✅ (deprecated 2026-07-28) | ❌ | Không nên làm |
| Sampling (+tool calling) | ✅ (deprecated 2026-07-28) | ❌ | Không nên làm |
| Elicitation form-mode | 2025-06-18 | ❌ | Thiếu — nên làm |
| Elicitation URL-mode | 2025-11-25 | ❌ | Thiếu — nên làm |
| Tasks (experimental) | 2025-11-25 | ❌ | Thiếu — nên làm, sau abstraction |
| OAuth 2.1 + PKCE (flow tay) | 2025-03-26 | ✅ (oauth.ts) | Tốt nhưng chưa nối vào client |
| OAuth discovery (PRM / OIDC / WWW-Authenticate) | 2025-11-25 | ❌ | Thiếu |
| Client ID Metadata Documents / DCR | 2025-11-25 | ❌ | Thiếu |
| Incremental scope (step-up) | 2025-11-25 | ❌ | Thiếu |
| MCP Registry (`server.json`) | ✅ | ❌ (catalogue local riêng) | Thiếu |
| MCP server (expose open-bot) | ✅ | ❌ | Thiếu |
| JSON-RPC batching | ❌ đã bỏ (2025-06-18) | ❌ (không có) | Đúng, không làm |
| JSON Schema 2020-12 | 2025-11-25 | Không khai báo | Nhỏ |

---

## 4. Danh sách tích hợp — ưu tiên theo giá trị

Thứ tự: P0 = làm trước (lỗi chức năng / nền tảng), P1 = giá trị cao, P2 = mở rộng,
P3 = chiến lược. Độ khó: S < 1 ngày, M = vài ngày, L = 1–2 tuần (ước lượng cho 1 dev
quen codebase; chưa tính review/test).

### P0 — Sửa lỗi chức năng hiện có

1. **Nối OAuth token vào MCP HTTP client (401 → refresh → retry)**
   - `mcp_auth` đã lấy được token nhưng `mcp_call_tool` không bao giờ dùng → mọi
     server OAuth đều chết ở bước gọi. Thêm `authProvider` (callback lấy token hợp lệ
     qua `getValidAccessToken`) vào `StreamableHttpMcpClient` / `connectMcp`; khi gặp
     401 thì refresh 1 lần rồi retry request.
   - Độ khó: **M** · File: `packages/core/src/mcp/client.ts`,
     `packages/tools/src/mcpTools.ts` (`withMcpClient` truyền `oauthStore` +
     `getOAuthConfig` từ coordinator), `packages/core/src/coordinator/coordinator.ts`
     (nối store đã có sẵn ở `createMcpSystemTools` sang `createMcpTools`).
2. **Nâng protocol version lên `2025-11-25` + khai capabilities thật**
   - Đổi `MCP_PROTOCOL_VERSION`, gửi `capabilities` theo đúng khả năng client sẽ hỗ trợ
     (sau khi làm elicitation/tasks), giữ fallback khi server trả version cũ hơn.
   - Độ khó: **S** · File: `packages/core/src/mcp/client.ts`
     (`MCP_PROTOCOL_VERSION`, `initialize()` ở cả 2 client).
3. **Giữ session MCP sống giữa các tool call (connection pool)**
   - Bỏ "fresh connection mỗi lần gọi": cache client theo `(workspace, server)` trong
     coordinator/tool runtime, đóng khi idle/timeout hoặc khi server chết. Giảm spawn
     process + handshake, và là tiền đề bắt buộc cho tasks/progress/subscribe.
   - Độ khó: **M** · File: `packages/tools/src/mcpTools.ts` (`withMcpClient` →
     pool), `packages/core/src/coordinator/coordinator.ts` (vòng đời pool),
     test mới trong `tests/mcp.test.mjs`.
4. **Xử lý lỗi theo SEP-1303: lỗi validate input là tool error, không phải protocol error**
   - Hiện `toolResultToText` throw `McpError` khi `isError === true`, biến lỗi tool
     thành exception ở tầng agent thay vì text để model tự sửa. Trả về text lỗi thay
     vì throw (giữ throw cho lỗi transport/protocol thật).
   - Độ khó: **S** · File: `packages/core/src/mcp/client.ts` (`toolResultToText`).

### P1 — Tính năng spec giá trị cao

5. **Elicitation form-mode + URL-mode (client capability)**
   - Client nhận `elicitation/create` từ server trong lúc `tools/call` đang chạy:
     form-mode render form JSON Schema (kèm default, enum single/multi-select theo
     SEP-1330/1034) hỏi user qua UI desktop; URL-mode mở URL ngoài trình duyệt và chờ
     user xác nhận (không bao giờ hỏi password/key qua form — theo spec). Cần UI
     desktop (modal hỏi đáp) + IPC event. Lưu ý thiết kế theo MRTR của 2026-07-28
     (server trả `InputRequiredResult`, client retry) để khỏi viết lại khi nâng cấp.
   - Độ khó: **L** · File: `packages/core/src/mcp/client.ts` (dispatch
     server-initiated request), `packages/core/src/mcp/types.ts` (type
     `ElicitRequest/Result`), `apps/desktop/src/main/main.ts` + renderer (modal),
     `packages/tools/src/mcpTools.ts` (luồng chờ user).
6. **Tasks — client-side (poll `tasks/get`, lấy `tasks/result`, hủy `tasks/cancel`)**
   - Cho tool chạy lâu: gửi `tools/call` kèm `task` param, nhận handle, poll theo
     `pollInterval`, trả tiến độ về agent (`send_progress_update` đã có ở
     `packages/core/src/agent/loop.ts`), hủy khi user yêu cầu. Chỉ làm phía client
     trước; **đặt sau abstraction** (`TaskHandle` + adapter) vì 2026-07-28 đổi
     thành extension không tương thích ngược (bỏ `tasks/result`/`tasks/list`,
     thêm `tasks/update`).
   - Độ khó: **L** · File: `packages/core/src/mcp/client.ts`,
     `packages/core/src/mcp/types.ts`, `packages/tools/src/mcpTools.ts`
     (tool `mcp_call_tool_async` / tham số `async: true`), `packages/core/src/agent/loop.ts`.
7. **Progress + cancellation**
   - Gửi `progressToken` trong `_meta` khi gọi tool; nhận `notifications/progress`
     → đẩy vào `onProgress` của agent; hỗ trợ `notifications/cancelled` khi user/
     agent hủy tool call đang chạy (nối với timeout 60s hiện có).
   - Độ khó: **M** · File: `packages/core/src/mcp/client.ts`,
     `packages/core/src/mcp/types.ts`, `packages/tools/src/mcpTools.ts`.
8. **Structured output + tool annotations + icons + resource links**
   - Parse và giữ `structuredContent` (trả JSON có cấu trúc cho agent thay vì chỉ
     text), `outputSchema`, `annotations` (`readOnlyHint`, `destructiveHint`,
     `idempotentHint`, `openWorldHint`, `title`), `icons`; render block
     `resource_link` thành link thay vì `JSON.stringify`. Dùng annotation
     `destructiveHint` để quyết định `needsApproval` cho `mcp_call_tool` thay vì
     luôn bắt approval như hiện tại.
   - Độ khó: **M** · File: `packages/core/src/mcp/client.ts` (`parseToolDefs`,
     `contentBlocksToText`, `toolResultToText`), `packages/core/src/mcp/types.ts`
     (`McpToolDef`, `McpContentBlock`), `packages/tools/src/mcpTools.ts`.
9. **OAuth discovery đầy đủ (PRM + OIDC + Client ID Metadata Documents)**
   - Khi HTTP 401: parse `WWW-Authenticate` lấy `resource_metadata` + `scope`;
     fallback fetch `.well-known/oauth-protected-resource`; từ đó discovery
     authorization server (RFC 8414 + OIDC, thử đủ thứ tự endpoint); đăng ký client
     theo thứ tự pre-registered → Client ID Metadata Document → DCR → hỏi user;
     gửi `resource` (RFC 8707) khi xin token; hỗ trợ step-up scope (SEP-835) khi
     server đòi thêm scope giữa chừng. Bỏ yêu cầu host cấu hình endpoint tay.
   - Độ khó: **L** · File: `packages/core/src/mcp/oauth.ts` (mới: discovery),
     `packages/core/src/mcp/client.ts` (401 handling), `packages/core/src/mcp/config.ts`
     (field OAuth trong `mcp.json`: `oauth: { clientId?, scope? }`).

### P2 — Mở rộng theo spec

10. **Streamable HTTP đầy đủ: GET SSE stream + resume + đóng session**
    - Thêm GET stream để nhận server notification, resume bằng `Last-Event-ID`
      sau disconnect (SEP-1699), DELETE session khi đóng client. Cần thiết cho
      tasks `input_required` (server chủ động hỏi giữa chừng) và subscribe.
    - Độ khó: **M** · File: `packages/core/src/mcp/client.ts`
      (`StreamableHttpMcpClient`).
11. **Prompts + resources subscribe/templates + completion**
    - Thêm `prompts/list`/`prompts/get` (tool `mcp_get_prompt`), `resources/subscribe`
      + `resources/templates/list`, `completion/complete` (gợi ý argument). Giá trị
      trung bình — ít server dùng, nhưng rẻ vì cùng mẫu với tools/resources.
    - Độ khó: **M** · File: `packages/core/src/mcp/client.ts`,
      `packages/core/src/mcp/types.ts`, `packages/tools/src/mcpTools.ts`.
12. **MCP Registry: đọc `server.json`, fetch remote, version**
    - Marketplace chuyển sang format Registry chuẩn (`server.json`: `name`, `version`,
      `repository`, `icons`, …), thêm nguồn remote (registry.modelcontextprotocol.io)
      có cache + checksum, hiển thị version/update. Giữ catalogue local làm fallback
      offline. Cần quyết định chính sách trust (chỉ cài server có chữ ký/checksum?
      xác thực publisher?).
    - Độ khó: **M–L** · File: `packages/core/src/mcp/marketplace.ts`,
      `apps/desktop/src/renderer/components/McpMarketplaceView.tsx`.
13. **Nhận và dispatch mọi server-initiated request (nền tảng chung)**
    - Một dispatcher cho message từ server: `sampling/*`, `elicitation/*`,
      `roots/*`, `notifications/*`, `ping` — hiện tại bị drop lặng lẽ ở cả 2 transport.
      Đây là tiền đề kỹ thuật cho mục 5, 7, 11; nên làm trước hoặc cùng chúng.
    - Độ khó: **M** · File: `packages/core/src/mcp/client.ts` (`onStdout`,
      `postRpc` → thêm handler registry), `packages/core/src/mcp/types.ts`.
14. **Token revocation + `mcp_auth_status` refresh thật**
    - `mcp_auth_status` gọi `getValidAccessToken` (refresh nếu hết hạn) thay vì chỉ
      đọc; thêm tool `mcp_revoke` gọi revocation endpoint (RFC 7009) + xóa Vault.
    - Độ khó: **S** · File: `packages/tools/src/mcpSystemTools.ts`,
      `packages/core/src/mcp/oauth.ts`.

### P3 — Chiến lược / dài hạn

15. **Expose open-bot thành MCP server**
    - Cho Claude Desktop / Cursor / app khác gọi tool của open-bot (stdio + Streamable
      HTTP, OAuth resource server nếu cần). Đây là hướng "platform" đúng với tầm nhìn
      open-bot (ROADMAP: "MCP là cổng mở rộng chính"), nhưng là dự án riêng: cần
      server `tools/list`/`tools/call`, auth, rate-limit, sandbox. Cân nhắc dùng SDK
      chính thức cho phía server thay vì tự viết.
    - Độ khó: **L** · File mới: `packages/core/src/mcp/server.ts`,
      `packages/core/src/api/server.ts` (endpoint `/mcp`), `packages/core/src/mcp/types.ts`.
16. **Đánh giá lại: dùng MCP SDK chính thức (TypeScript) thay cho client tự viết**
    - Client tay hiện tại ~540 dòng, đã đủ tốt cho nhu cầu cơ bản, nhưng mỗi tính năng
      spec mới (tasks, elicitation, discovery) là tự implement lại một phần SDK — và
      SDK đã xử lý sẵn 2025-11-25 + đang theo 2026-07-28. Phương án: giữ client tay
      cho stdio nhẹ, hoặc migrate dần sang `@modelcontextprotocol/sdk` (cần đánh giá
      xung đột dependency + chính sách "không dependency lạ"). Không nên migrate chỉ
      vì "chuẩn" — chỉ khi bắt đầu làm các mục 5/6/9.
    - Độ khó: **L** (đánh giá + migrate) · File: `packages/core/src/mcp/*`,
      `package.json` các package.
17. **Roots — chỉ làm nếu có nhu cầu cụ thể (lưu ý deprecated 2026-07-28)**
    - `roots/list` để báo server biết workspace nào được phép. Giá trị thấp với
      open-bot (server filesystem đã nhận allowed-dir qua args), và spec mới đã
      deprecated. Nếu làm: chỉ gửi roots khi server yêu cầu, không đầu tư UI riêng.
    - Độ khó: **S–M** · File: `packages/core/src/mcp/client.ts`.
18. **Sampling — không nên làm**
    - Spec 2026-07-28 deprecated sampling; server nên gọi trực tiếp LLM API. open-bot
      đã có 6 provider + model registry — hướng đúng là để MCP server (nếu cần LLM)
      gọi provider qua Local API của open-bot (mục 15), không phải implement
      `sampling/createMessage`. Ghi chú này để tránh ai đó mở issue làm sampling.

### Thứ tự đề xuất (roadmap ngắn)

1. **Đợt 1 (P0):** mục 1 → 2 → 3 → 4. Xong đợt này thì OAuth thật sự chạy được,
   version đúng chuẩn, và hết lãng phí handshake.
2. **Đợt 2 (P1):** mục 13 (dispatcher) → 7 (progress) → 8 (structured output) →
   5 (elicitation) → 6 (tasks) → 9 (OAuth discovery).
3. **Đợt 3 (P2–P3):** mục 10 → 11 → 12 → 14 → 15; mục 16 đánh giá song song khi
   bắt đầu đợt 2; mục 17/18 không làm trừ khi có yêu cầu cụ thể.

---

## 5. Rủi ro và lưu ý

- **Tasks 2025-11-25 là experimental và đã bị thay thế ở 2026-07-28.** Implement
  theo 2025-11-25 thì phải chấp nhận migrate. Giảm rủi ro bằng adapter + chỉ hỗ trợ
  server nào khai `tasks` capability.
- **Đừng xây tính năng trên sampling/roots/logging** — đã deprecated, sẽ bị xóa sau
  tối thiểu 12 tháng kể từ 2026-07-28.
- **Bảo mật OAuth:** khi nối token vào client (mục 1), giữ nguyên các guard hiện có:
  không log header/token (đã có `redactBearer`), token chỉ sống trong Vault, chỉ
  gửi `Authorization` tới đúng origin của server, validate `redirect_uri` loopback.
  Client ID Metadata Documents yêu cầu host metadata qua HTTPS — open-bot desktop
  không có HTTPS endpoint công khai, nên cơ chế này có thể cần một URL metadata do
  dự án host (hoặc fallback DCR/pre-registered).
- **Tương thích ngược:** nâng `protocolVersion` lên 2025-11-25 nhưng phải giữ khả năng
  nói chuyện với server chỉ hỗ trợ 2024-11-05 (server trả version của nó trong
  `initialize`; client nên tôn trọng version thấp nhất chung, như hiện tại đã làm
  khi đọc `rec['protocolVersion']`).

---

## 6. Nguồn

- MCP spec 2025-11-25 changelog — https://modelcontextprotocol.io/specification/2025-11-25/changelog
- MCP Authorization 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP changelog 2026-07-28 — https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP Tasks (2025-11-25 experimental vs 2026-07-28 extension) — https://aaif.io/blog/handle-long-running-mcp-tool-calls-with-the-mcp-tasks-extension
- Code open-bot: `packages/core/src/mcp/{client,types,config,oauth,marketplace}.ts`,
  `packages/tools/src/mcpTools.ts`, `packages/tools/src/mcpSystemTools.ts`,
  `packages/core/src/coordinator/coordinator.ts`, `tests/mcp.test.mjs`,
  `tests/fixtures/fake-mcp-server.mjs`, `docs/ROADMAP.md`.

---

## 7. Cập nhật P0-4 (2026-11-09, v0.40) — trạng thái sau tích hợp REA §13

Theo `docs/rea-grokbot-deep-dive.md` §8.2/§8.3/§8.4. Số liệu lấy từ client
Grok thật, code viết lại hoàn toàn (không sao chép code/text/tài sản xAI/Cursor).

### 7.1 Đã làm xong

| Hạng mục | Trạng thái | File |
|---|---|---|
| Reconnect config theo `mcp_reconnect_config` của Grok | ✅ | `packages/core/src/mcp/client.ts` (`McpReconnectConfig`, `DEFAULT_MCP_RECONNECT_CONFIG`, `McpReconnectPolicy`), `packages/core/src/mcp/transport.ts` (nối policy vào vòng reconnect GET stream đã có), `packages/core/src/mcp/types.ts` (`McpServerConfig.reconnect`) |
| Fast retry 5s→60s ×5, rồi periodic 5→30 phút (không giới hạn chu kỳ) | ✅ | Policy thuần, backoff mũ có trần; test bằng fake clock |
| Session 404 tombstone sau 5 lần | ✅ | `recordSession404()`; GET stream 404 chưa đủ ngưỡng vẫn nối lại, đủ 5 lần thì dọn session + dừng |
| Keepalive 5 phút ± jitter 30s + probe timeout 10s | ✅ | HTTP client ping định kỳ sau `initialize()`; `getReconnectState()` để diagnostics/UI |
| Degraded probe 30s × 3 fail → degraded, probe lại sau 30s để phát hiện hồi phục | ✅ | `recordDegradedProbeFailure/Success()` |
| Stability 30s → reset bộ đếm retry (recovered) | ✅ | `recordStable()` (fake clock) |
| Tool call idle 120s (reset mỗi progress) / tổng 60 phút | ✅ | `callToolStructured` cả 2 transport; client LUÔN gửi `progressToken` để server báo tiến độ cho idle detection (thay đổi hành vi: test `mcp-dispatcher-v013` đã cập nhật theo — không còn assert "không onProgress thì không gửi `_meta`") |
| Stdio lỗi kết nối không retry | ✅ | `McpError.nonRetryable = true` (mặc định Grok); pool không có vòng retry nối lại |
| Auth-tool UX (mẫu Grok) | ✅ | `mcp_authenticate_<server>` sinh riêng cho mỗi HTTP server (chạy đúng flow PKCE của `mcp_auth`, tách thành `runMcpAuthFlow` dùng chung); lỗi auth ở 4 tool MCP kèm gợi ý gọi tool đó thay vì chỉ báo lỗi 401 |
| Tasks sau abstraction + backend extension 2026-07-28 | ✅ | `tasks.ts`: `TaskHandle.specVersion` (`'2025-11-25'` mặc định / `'2026-07-28'`); 2026-07: `tasks/get` trả luôn kết quả (không gọi `tasks/result`), `tasks/update` qua `sendInput()`, `tasks/list`/`tasks/result` ném lỗi rõ; `detectTaskHandle()` cho handle server trả không cần opt-in. Cùng code gọi chạy được cả hai backend (test chứng minh) |
| Elicitation — kiểm tra lại coverage thực tế | ✅ đủ ở tầng core (xem §7.2) | `elicitation.ts` + `clientHandlers.ts` + coordinator prompt + modal desktop |

### 7.2 Elicitation — coverage thực tế (kiểm tra code, không bịa)

- **Form-mode: đủ.** Parse schema, default cho mọi primitive (SEP-1034),
  enum single-select + multi-select (SEP-1330), chặn field nhạy cảm
  (password/key/token/thanh toán bắt dùng URL-mode), validate/coerce kết quả
  trả về (`parseElicitationSchema`, `validateElicitedContent`,
  `handleElicitationRequest`). Test ở `tests/mcp-elicitation-tasks-v013.test.mjs`.
- **URL-mode: đủ ở tầng parse + theo dõi, thiếu 1 đường nối live.**
  Parse URL http(s) + `elicitationId`, `ElicitationUrlTracker`
  (`waitForCompletion` / `complete` / `cancelAll`), dispatcher đăng ký
  `notifications/elicitation/complete`, modal desktop có nút mở URL — đều có.
  **Còn thiếu:** không có code nào gọi `ElicitationUrlTracker.waitForCompletion()`
  — notification hoàn tất chỉ được ghi nhận (tracker `complete()`), không có
  luồng nào chờ nó hay báo lại cho tool call đang đợi elicitation. Nói cách
  khác: user bấm "accept" ở URL-mode thì client trả `accept` ngay, việc user
  có hoàn tất bước ngoài băng hay không không được theo dõi tiếp. Cần nối
  tracker vào luồng chờ của caller (sóng sau).
- **MRTR (2026-07-28): chưa làm.** Elicitation vẫn đi bằng server-initiated
  request (`elicitation/create`), chưa theo dạng `InputRequiredResult` +
  retry của spec mới. Đây là việc của sóng nâng cấp spec, không phải P0-4.

### 7.3 Còn thiếu / giới hạn (ghi rõ, chưa làm)

- **3 field config Grok chỉ có trong config, chưa nối vào đường live:**
  `focusRetryCooldownMs` / `inlineReconnectCooldownMs` (open-bot không có
  sự kiện focus riêng, pool chỉ reconnect khi tool gọi — không có vòng
  reconnect inline để áp cooldown) và
  `oauthBackendRefreshHydrationPollIntervalMs` (open-bot refresh token đồng
  bộ, không có bước hydration poll). Nối chúng khi có đường live tương ứng;
  đừng nối cho có.
- **Coordinator chưa truyền `openUrl` cho `createMcpTools`** (mới chỉ truyền
  cho `createMcpSystemTools`): tool `mcp_authenticate_<server>` hiện dùng
  fallback trả URL trong kết quả để user tự mở, tới khi coordinator nối
  `openUrl: host?.openMcpAuthUrl` vào `createMcpTools` (1 dòng, sóng sau).
- **Auth tool chỉ sinh cho bản bound `createMcpTools(workspaceDir)`** —
  bản unbound `MCP_TOOLS` không biết workspace lúc tạo nên không sinh (đúng
  thiết kế, không phải bug).
- **Tool call không có `onProgress` vẫn gửi `progressToken`** (cần cho idle
  detection) — thay đổi hành vi so với trước P0-4; server nào lạ với `_meta`
  thì bỏ qua theo spec, không ảnh hưởng kết quả.
- **Keepalive/degraded chỉ theo dõi ở tầng client** (`getReconnectState()`):
  chưa có UI hiện trạng thái degraded/tombstone, chưa có event ra ngoài.
- **Test:** 29 test mới trong `tests/mcp-reconnect-p04.test.mjs` (fake
  clock/random, fake stdio/HTTP server local, không mạng live). Full suite
  xem báo cáo của worker P0-4.

### 7.4 Đính chính §4 sau P0-4

- Mục 5 (elicitation) — phần core đã đủ, còn nối `waitForCompletion` + MRTR
  (xem §7.2).
- Mục 6 (tasks) — xong phần abstraction + backend 2026-07-28; còn thiếu tool
  agent `mcp_call_tool_async` / tham số `async: true` (chưa làm trong P0-4 —
  `TaskHandle` mới nối qua `clientAsTaskTransport`, chưa có tool cho model gọi
  task dài trực tiếp).
- Mục 13 (dispatcher) đã xong từ v0.13 — reconnect lần này nối vào đúng
  dispatcher/transport đã có, không viết cơ chế thứ hai.
