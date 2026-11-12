# Composio (v0.57 + v0.58) — adapter opt-in sau AppRegistry

Tích hợp tối thiểu đã duyệt (Huy 2026-11-09 20:09). Chi tiết đầy đủ:
`docs/composio-integration.md` (thiết kế, endpoint/auth, test mock,
live test cần key thật) và `docs/composio-evaluation.md` (so sánh M7
vs Composio, chi phí, rủi ro — đã cập nhật trạng thái sau sự cố 05/2026).

## File

- `types.ts` — hằng số (REST v3.1, 7 meta-tool), `ComposioSession`,
  `ComposioError` (có `code`, message không chứa key).
- `keyStore.ts` — key user trong Vault (`provider:composio`), chỉ
  boolean "đã cấu hình chưa" được lộ ra; `redactComposioKey` lọc key
  khỏi mọi message; `createComposioVaultFileKeyReader` (v0.58) đọc
  trực tiếp file Vault của main cho tiến trình coordinator (chỉ khi
  Vault dùng LocalEncryptor fallback — xem docs §11).
- `toolkits.ts` — 4 toolkit đầu (Gmail, GitHub, Slack, Notion) + app
  router giữ 3 meta-tool model thực sự gọi. Chỉ liệt kê slug đã xác
  nhận từ docs chính thức; slug còn lại discovery lúc chạy qua
  `COMPOSIO_SEARCH_TOOLS`.
- `router.ts` — `ComposioToolRouter`: tạo session REST
  (`POST /tool_router/session`, header `x-api-key`), liệt kê tool
  session, `buildMcpConfig()` cho `connectMcp` (tái dùng MCP client),
  `searchTools` / `getToolSchemas` (v0.58) / `executeTools` qua
  `callTool` tiêm vào. Không dùng SDK Composio, không thêm dependency.
- `executors.ts` (v0.58) — `ComposioSessionManager` (lazy session +
  MCP client, cache theo vòng đời coordinator) +
  `createComposioMetaTools` (3 meta-tool runnable cho model). Đặt ở
  core vì mọi dependency đã nằm trong core.
- `source.ts` — `ComposioAppSource`: bật/tắt source (mặc định TẮT) +
  bật/tắt từng toolkit, đăng ký/gỡ app trong AppRegistry. Tool Composio
  đi qua cap M7 + filterTools như tool local — không đường riêng.
- `state.ts` (v0.57 IPC) — trạng thái persist (`settings.json`, không
  chứa key) + state view cho main process.
- `index.ts` — public surface (export lại ở `packages/core/src/index.ts`).

## Dùng nhanh (host)

```ts
import { ComposioAppSource, ComposioToolRouter, getComposioApiKey } from '@open-bot/core';

// 1. Bật source (mặc định tắt): đăng ký router + 4 toolkit vào registry.
const source = new ComposioAppSource({ registry, hasApiKey: () => hasComposioApiKey(vault) });
source.setEnabled(true);
source.setToolkitEnabled('notion', false); // tắt riêng Notion

// 2. Tạo session cho toolkit đang bật, rồi nối MCP client đã có.
const router = new ComposioToolRouter({ apiKey: getComposioApiKey(vault) });
const session = await router.createSession({ userId: 'local-user', toolkits: source.enabledToolkits() });
const client = await connectMcp(router.buildMcpConfig(session));

// 3. Discovery + thực thi qua meta-tool (callTool tiêm từ client).
const found = await router.searchTools('gửi mail cho Lan', (n, a) => callMcpTool(client, n, a));
await router.executeTool('GMAIL_SEND_EMAIL', { /* arguments */ }, (n, a) => callMcpTool(client, n, a));
```

## Quy tắc an toàn

- Key thiếu → `ComposioError('composio_key_missing')`, lỗi sạch, không crash.
- Key không bao giờ vào log/file/error message (test kiểm tra cả file Vault).
- `mcp.url` phải là https trên `*.composio.dev` (trừ loopback cho mock test).
- Tắt source là mọi app Composio biến mất khỏi registry; M7 local không ảnh hưởng.
- Live test thật CHƯA làm (chưa có key thật của Huy) — xem docs.

## v0.58 — đường thực thi (coordinator)

- `createComposioMetaTools({ manager })` → 3 tool runnable cho model
  (SEARCH + GET_SCHEMAS không cần approval, MULTI_EXECUTE cần
  approval). `ComposioSessionManager` giữ 1 session + MCP client cho
  cả tiến trình coordinator; không retry call lỗi (tránh thực thi trùng).
- Gate: `defaultToolFactory` chỉ đăng ký 3 tool này khi
  `ToolFactoryHost.getComposioTools` trả về non-empty (tức Composio
  đang bật trong coordinator); RPC `composio.setState` /
  `composio.getState` để main bật/tắt + chọn toolkit (xem
  `docs/composio-integration.md` §11).
- Key trong coordinator: đọc trực tiếp file Vault của main qua
  `createComposioVaultFileKeyReader(dataDir)` — chỉ mở được khi Vault
  dùng LocalEncryptor fallback; main dùng safeStorage/NO_STORAGE thì
  fail-closed (xem docs §11 + phương án seed key từ main).
