# Connected apps (M7) — lớp "connected apps" thống nhất (kiểu Composio)

Một "app" là một dịch vụ bên ngoài mà bot dùng qua tool (Slack, Gmail,
Teams, iMessage, meeting, GitHub, ...). Lớp này tự làm trên
MCP/connector đã có (phương án (a), theo hướng Huy) — và từ v0.57 có
thêm adapter Composio opt-in (phương án (b)) cắm SAU registry này, xem
`packages/core/src/composio/` + `docs/composio-integration.md`. App
Composio khai báo bằng cùng `AppDefinition` (`authType: 'composio'`,
`source: 'composio'`, không có `connectorId`); token OAuth của app nằm
phía Composio, key project của user nằm trong Vault `provider:composio`.
Từ v0.68b có thêm app token (PAT dán tay, vd GitHub): `authType:
'token'`, token thô lưu trong Vault theo `vaultNamespace`/`vaultKey`
đã khai — xem mục "Token PAT" dưới đây.

## File

- `types.ts` — kiểu chung: `AppDefinition`, `AppAuthStatus`, `AppStatusView`.
- `catalog.ts` — `AppRegistry` + 6 app built-in (liệt kê thật từ code repo).
- `authStore.ts` — `SharedAppAuthStore`: OAuth một lần, chia sẻ cho mọi bot.
- `toolCap.ts` — cap số tool của một app trong 1 turn.
- `index.ts` — public surface (được export lại ở `packages/core/src/index.ts`).

## Catalog app

App built-in (đối chiếu `packages/tools/src/integrationTools.ts` +
`packages/core/src/connectors/*.ts`, 2026-11-09):

| App | Auth | Tool (tên thật) |
| --- | --- | --- |
| Slack | OAuth2 (`connector: slack`) | `slack_send`, `slack_list_channels`, `slack_read` |
| Gmail | OAuth2 (`connector: gmail`) | `email_read`, `email_send` |
| Microsoft Teams | OAuth2 (`connector: teams`) | `teams_send`, `teams_list_teams` |
| iMessage | không cần (local, chỉ soạn nháp) | `imessage_draft` |
| Meeting | không cần (local, import + tóm tắt rule-based) | `meeting_transcript`, `meeting_summarize` |
| GitHub | token PAT dán tay (Vault `github`/`token`) | `git_host_connect`, `pr_list`, `pr_create`, `pr_update`, `pr_label_set`, `pr_code_tour_view`, `pr_code_tour_update` |

Catalog chỉ là dữ liệu + hàm thuần: mỗi app khai tên tool nó cung cấp,
không chứa logic tool. Một tool chỉ thuộc tối đa một app (đăng ký trùng
thì ném lỗi).

### Thêm app mới (không sửa core)

```ts
import { AppRegistry, BUILTIN_APPS } from '@open-bot/core';

const registry = new AppRegistry(BUILTIN_APPS);
registry.register({
  id: 'notion',
  label: 'Notion',
  description: 'Đọc/ghi page Notion.',
  icon: '📓',
  authType: 'oauth2',
  connectorId: 'notion', // cần ConnectorDefinition + TokenStore tương ứng
  tools: [
    { name: 'notion_read', description: 'Đọc một page.', needsApproval: false },
  ],
});
```

Lưu ý: đăng ký catalog chỉ khai báo — tool `notion_read` vẫn phải được
viết/đăng ký ở `packages/tools` (như `createAppTools('notion', opts)` lọc
theo tên), và OAuth flow/client config vẫn cần `ConnectorDefinition`
trong `connectors/framework.ts` + flow ở `apps/desktop/src/main/main.ts`.
Catalog không tự sinh tool hay OAuth flow.

Tool của app lấy qua `createAppTools(appId, opts)` trong
`packages/tools/src/integrationTools.ts` — lọc list tool đã có theo tên
catalog, không viết lại logic tool.

## OAuth một lần, chia sẻ cho mọi bot

`SharedAppAuthStore` (bọc một `TokenStore`, thường là `vaultTokenStore`:
Vault namespace `connector`, key = connector id):

- **Kết nối một lần**: `connect(appId, tokenSet, accountLabel?)` ghi
  TokenSet MỘT lần vào store. Mọi bot đọc chung qua `getAccessToken()`.
- **Mọi bot dùng chung**: trong coordinator, store này trỏ thẳng vào
  map `connectorTokenSets` mà `buildToolHost` đọc — bot tạo TRƯỚC khi
  kết nối cũng dùng được token mới ngay, không cần tạo lại bot (sửa
  giới hạn v0.19). Main còn đẩy token vào coordinator ngay sau khi
  OAuth login thành công (`auth:oauth-start` → `apps.setSharedToken`).
- **Thu hồi một chỗ**: `disconnect(appId)` xóa token khỏi store + cache
  ngay; lần lấy token sau của bất kỳ bot nào cũng trả null nên tool của
  app báo "chưa kết nối". Main xóa Vault song song (`apps:disconnect` →
  `apps.revokeSharedToken`).
- **Auto-refresh**: tái dùng `getValidAccessToken` của
  `connectors/framework.ts` (refresh trước 5 phút, dedup) khi host đã
  cấp client config qua `setClientConfig()` — store này không tự viết
  refresh. Token tĩnh không hạn (vd Slack xoxb) dùng tiếp như cũ.
- **Token không bao giờ lộ**: trạng thái/status chỉ chứa nhãn tài khoản
  (display name/email do host cấp khi connect), không chứa token; lỗi
  refresh chỉ ghi lý do, không echo body token endpoint.

## Token PAT (v0.68b, vd GitHub)

App token dùng khi dịch vụ không có (hoặc chưa cần) connector OAuth
riêng mà chấp nhận personal access token do user tự tạo — GitHub là
app đầu tiên kiểu này, thay cho việc đăng ký OAuth app GitHub mới
(không cần client id/secret, PAT là chuẩn GitHub cho dùng cá nhân;
trade-off: user phải tự tạo PAT rồi dán vào).

- **Tạo PAT**: github.com → Settings → Developer settings →
  Personal access tokens. Token classic (`ghp_…`) hoặc fine-grained
  (`github_pat_…`); cần quyền `repo` để bot đọc/tạo PR. UI ghi rõ
  đường dẫn này trong gợi ý dưới ô nhập.
- **Khai báo catalog**: `authType: 'token'` + `vaultNamespace` /
  `vaultKey` (vd `'github'`/`'token'`) — KHÔNG có `connectorId`.
  `validateApp` ném lỗi khi app token thiếu vị trí Vault, khi có
  `connectorId`, hoặc khi app khác khai vị trí Vault (một app chỉ có
  một nguồn token). Test chốt chặn trong `tests/apps-m7.test.mjs`.
- **Xác thực lúc kết nối (v0.69a)**: trước khi lưu, main xác thực PAT
  bằng GET `https://api.github.com/user` (`validateGithubPat` trong
  `packages/core/src/apps/githubToken.ts`, timeout 10s, `fetchFn`
  inject được cho test) — 200 thì lưu + seed (kèm login làm nhãn tài
  khoản cho UI), 401 thì báo 'PAT không đúng hoặc đã hết hạn', 403 thì
  báo 'GitHub từ chối token' (header `X-RateLimit-Remaining: 0` thì
  ghi chú hết rate limit), lỗi mạng/timeout thì báo 'Không kiểm tra
  được PAT — thử lại sau'. Validate fail thì token KHÔNG vào Vault,
  KHÔNG seed coordinator; token không bao giờ vào log hay error
  message. Test trong `tests/apps-github-pat-validate.test.mjs`
  (mock fetch, không gọi api.github.com thật). Chỉ xác thực lúc dán
  PAT — PAT bị thu hồi sau khi lưu thì vẫn chỉ lộ khi bot gọi tool
  (trạng thái app vẫn chỉ kiểm tra tồn tại trong Vault).
- **Lưu token**: UI Connected apps → ô password (không hiện lại sau
  khi lưu) → IPC `apps:set-token` → main lưu nguyên chuỗi vào Vault
  rồi seed ngay cho coordinator qua RPC `apps.setPlainToken`
  (`SharedAppAuthStore.connectPlainToken`); bot đã tạo dùng được
  token mới ngay vì tool đọc `host.getGitHubToken` lúc gọi. Tool
  GitHub nằm trong `createIntegrationTools` (gom `createGitTools`)
  để `createAppTools('github')` lọc được — coordinator KHÔNG đăng
  ký riêng `createGitTools` nữa (trùng tên sẽ ném lỗi). Tool
  `set_active_branch` (git checkout local) vẫn nằm trong
  `createIntegrationTools` nhưng KHÔNG thuộc app `github` trong
  catalog (không phải API GitHub).
- **Trạng thái**: PAT không có hạn nên không refresh, không hết hạn —
  chỉ có `not_connected` (chưa có token), `connected` (có token
  không rỗng) và `error` (lỗi đọc kho; lỗi dính tới khi kết nối lại
  thành công, như đường OAuth). Main tính trạng thái trong
  `buildAppStatusViews` chỉ bằng cách kiểm tra sự tồn tại của secret
  trong Vault — KHÔNG gọi API ngoài, không log giá trị token.
- **Thu hồi**: nút Ngắt kết nối → IPC `apps:disconnect` xóa secret
  khỏi Vault + RPC `apps.revokeSharedToken` xóa token trong bộ nhớ
  coordinator (`SharedAppAuthStore.disconnect` nhánh token) — mọi
  bot mất quyền ngay.

## Trạng thái auth

`deriveAppAuthStatus(tokenSet)` (thuần, không I/O) + `getStatus(appId)`:

- `not_connected` — chưa có token nào.
- `connected` — có token còn hạn, hoặc token không hạn, hoặc token hết
  hạn nhưng có refresh token (framework tự refresh khi dùng).
- `expired` — token đã hết hạn và KHÔNG có refresh token — user phải
  kết nối lại.
- `error` — token lưu hỏng định dạng, hoặc lần refresh/lấy token gần
  nhất thất bại (xem `getError()`). Với app token: lỗi đọc kho PAT.
- `local` — app không cần xác thực (iMessage, meeting), luôn dùng được.

App token (PAT) không có trạng thái `expired`: PAT không mang hạn
nên `getStatus` chỉ trả `not_connected` / `connected` / `error`.

UI đọc trạng thái qua IPC `apps:list` (main đọc Vault trực tiếp) và qua
RPC `apps.listStatuses` (coordinator đọc kho dùng chung).

## Giới hạn số tool của connector (cap)

`toolCap.ts` — MỖI app chỉ được expose tối đa N tool trong 1 turn:

- Mặc định `DEFAULT_APP_TOOL_CAP = 10` tool/app/turn. Đủ cho mọi app
  hiện có (nhiều nhất 3 tool: Slack) và chặn app tương lai expose hàng
  chục tool trong một lần (v0.29 đo 123 tool ≈ 16.929 token, lọc còn 20
  defs ≈ 3.241 token).
- Ghi đè theo từng app: `SharedAppAuthStore.setToolCap(appId, cap)`
  (1..100) hoặc tham số `capsByApp` của `applyAppToolCaps()`.
- `applyAppToolCaps(tools, capsByApp)` giữ đúng thứ tự catalog (tool
  đầu giữ trước), tool không thuộc app nào giữ nguyên; trả thêm báo cáo
  app nào bị cắt (`droppedToolNames`) để loop/UI log rõ.
- Cap chạy TRƯỚC `filterTools` (`agent/toolFilter.ts` —
  allowlist/skill/mode), không viết cơ chế lọc thứ hai và không thay
  filterTools. Cap hiện CHƯA được nối vào `AgentRunner`/loop — loop
  vẫn dùng `filterTools` như cũ; nối cap vào turn chạy là việc tiếp
  theo (xem "Chưa làm" dưới).

## UI

Settings → **Connected apps** (`SettingsView.tsx`): liệt kê app + trạng
thái auth + nhãn tài khoản + nút Kết nối/Ngắt kết nối + danh sách tool
của app trong `<details>` (progressive disclosure) + cap tool/turn.
Kết nối tái dùng flow OAuth đã có (mục Connectors); ngắt kết nối qua
IPC `apps:disconnect` (xóa Vault + thu hồi trong coordinator đang chạy).
Preload + `global.d.ts` có kênh `apps:list` / `apps:disconnect` và alias
`listConnectedApps` / `disconnectConnectedApp`.

## Chưa làm / chưa kiểm chứng

- **Cap tool chưa nối vào turn chạy thật**: `applyAppToolCaps` có test
  unit nhưng `AgentRunner`/loop chưa gọi nó — tool của app vẫn đi qua
  `filterTools` như cũ. Cần nối ở `buildToolHost`/`defaultToolFactory`
  hoặc trong loop trước khi gửi definitions cho model.
- **OAuth chia sẻ với provider thật chưa kiểm chứng**: test chỉ dùng
  token giả + fake OAuth server local (token endpoint giả trên
  127.0.0.1) + mock fetch cho Slack/Gmail API. Chưa kết nối Slack /
  Gmail / Teams thật (không tài khoản/key thật trong repo).
- **IPC `apps:list` / `apps:disconnect` ở main chưa có test tự động**:
  main.ts cần Electron nên không chạy được dưới `node --test`; chỉ
  kiểm chứng bằng build + typecheck + review code. RPC coordinator
  (`apps.setSharedToken` / `apps.revokeSharedToken` /
  `apps.listStatuses`) thì có test qua `handle()` in-process.
- **Cap dưới tải chưa đo**: chưa đo số token thực tế khi một app có
  nhiều tool (catalog hiện tối đa 3 tool/app nên cap 10 chưa bao giờ
  cắt thật ngoài test).
- **Trạng thái `expired` chỉ tính từ `expiresAt` đã lưu**: token bị
  thu hồi phía provider nhưng `expiresAt` còn hạn thì vẫn hiện
  `connected` tới khi một lần gọi API trả 401/invalid_grant (lúc đó
  `getAccessToken` ghi lỗi → trạng thái `error`).
- App local (iMessage/meeting) không có nút Kết nối/Ngắt kết nối trong
  UI — đúng theo thiết kế (không có token để quản lý).
