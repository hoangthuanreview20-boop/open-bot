# Tích hợp Composio tối thiểu (v0.57) — đã duyệt, đang tích hợp

- **Ngày:** 2026-11-09
- **Trạng thái:** TÍCH HỢP TỐI THIỂU (v0.57) + ĐƯỜNG THỰC THI (v0.58)
  + MAIN SEED KEY (v0.59) + HARNESS LIVE TEST MOCK (v0.59)
  + **LIVE TEST THẬT — PHẦN ĐỌC (v0.72)**. Core + catalog + mock test xong (v0.57), meta-tool đã gọi thật được
  trong turn qua coordinator (v0.58, mock test 12/12). Main seed key
  cho coordinator xong (v0.59, test seed 9/9 — làm việc với mọi
  backend Vault, kể cả safeStorage + NO_STORAGE). Harness live test
  6 bước đã sẵn sàng chạy bằng mock (v0.59, test harness 7/7).
  **Live test thật phần ĐỌC đã làm ở v0.72** (xem §8 + §13.4 + báo cáo
  `scripts/composio-live-v072/report.json`): session thật tạo được,
  tools/list thật (6 meta-tool), SEARCH_TOOLS + GET_TOOL_SCHEMAS thật
  qua coordinator, slug thật 4 toolkit đã phát hiện; live test phát
  hiện và sửa 3 lỗi wire shape (session `toolkits` phải là policy
  object `{enable: [...]}`, GET_TOOL_SCHEMAS cần `tool_slugs`,
  MULTI_EXECUTE item cần `tool_slug`). Key project Composio đã hợp
  lệ từ 2026-11-10 ~21:02 (live test `list-tools` HTTP 200) và sóng
  v0.72a đã dùng key đó discovery live 14 toolkit (xem §4 + §14).
  **Phần GHI (tạo issue/mail/Slack thật) CHƯA làm** — cần Huy phê
  duyệt rõ repo test + hộp thư/kênh test.
- **Quyết định:** Huy phê duyệt tích hợp Composio ngày 2026-11-09 20:09
  ("Tích hợp Composio"). Bỏ giới hạn "chỉ nghiên cứu" của
  `docs/composio-evaluation.md` — làm thật theo từng bước, bắt đầu tối thiểu.
  (Cập nhật 2026-11-11: v0.82 thêm 8 toolkit nữa — tổng **22 toolkit**, xem §4.)
- **Nguồn API (đọc 2026-11-09, không sao chép code):**
  `docs.composio.dev/llms-full.txt` (REST v3.1, Tool Router sessions,
  7 meta-tool), trang tích hợp framework của composio.dev (ADK/Mastra/
  Claude Code), bài khắc phục sự cố tháng 05/2026 (xem §8).

## 1. Thiết kế: opt-in, local-first

Composio là **MỘT nguồn app nữa cắm sau `AppRegistry` của M7**, không phải
não, không phải tài khoản bắt buộc, **mặc định TẮT**:

```
User bật Composio (Settings → Composio)
  → ComposioAppSource đăng ký app vào AppRegistry:
      'composio' (router: 3 meta-tool) + từng toolkit đang bật
      (v0.57: 4 toolkit; nay 22 toolkit — xem §4)
  → Tool Composio đi qua cap M7 (applyAppToolCaps, 10 tool/app/turn)
    + filterTools như tool local — KHÔNG có đường tool song song.
  → Agent gọi meta-tool qua MCP Tool Router (connectMcp đã có).
User tắt Composio → gỡ hết app Composio khỏi registry, M7 local chạy lại như cũ.
```

Provider API key, model local (Ollama) và CLI đã dò trên máy vẫn là phương
án dự phòng — Composio không thay thế chúng, chỉ thêm app.

**Chọn router thay vì SDK — vì sao:** SDK chính thức (`@composio/core`,
MIT) là một dependency lớn chuyên gọi cùng REST + MCP mà repo đã tự có
(`connectMcp` Streamable HTTP từ v0.2, spec 2025-11-25). Dùng router =
tái dùng client đã kiểm chứng, không thêm dependency, không học API
surface mới. Chỉ dùng SDK khi router không đủ — hiện chưa có trường hợp
nào như vậy; nếu live test phát hiện meta-tool thiếu (vd schema param
khác docs), ghi rõ lý do rồi mới xem xét SDK.

## 2. Endpoint + auth đã dùng

| Hạng mục | Giá trị (theo docs chính thức, đọc 2026-11-09) |
|---|---|
| REST base | `https://backend.composio.dev/api/v3.1` (v3.1 mới nhất; v3 cũ vẫn hỗ trợ, đóng băng pinned version) |
| Auth | Header `x-api-key: <COMPOSIO_API_KEY>` (project key của user; scoped key nên dùng khi có) |
| Tạo session | `POST /api/v3.1/tool_router/session`, body `{"user_id": "<user>", "toolkits": {"enable": [...]}}` → `{ session_id, mcp: { url, headers } }` — `toolkits` là policy object, KHÔNG phải mảng string (live v0.72: mảng string → HTTP 400 `Invalid input`) |
| Liệt kê tool session | `GET /api/v3.1/tool_router/session/{id}/tools?limit=500&cursor=` → `{ items: [{ slug, description, input_parameters }], next_cursor }` — session mặc định CHỈ trả 6 meta-tool (live v0.72); tool app phát hiện qua `COMPOSIO_SEARCH_TOOLS`, không phải endpoint này |
| MCP URL | Presigned, dạng `https://backend.composio.dev/tool_router/<session_id>/mcp` (live v0.72 thấy host `backend.composio.dev`; dạng `https://mcp.composio.dev/tool-router/<id>` cũng gặp trong tài liệu) — code dùng đúng `mcp.url` server trả về, KHÔNG tự dựng URL |
| MCP transport | Streamable HTTP qua `connectMcp` đã có; header lấy từ `session.mcp.headers` |
| Meta-tool (6 qua Tool Router session) | `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MULTI_EXECUTE_TOOL` (tối đa 50 tool/call), `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL` — `COMPOSIO_WAIT_FOR_CONNECTIONS` chỉ có khi bật `manage_connections.enable_wait_for_connections` (live v0.72: tools/list trả 6, không có WAIT_FOR_CONNECTIONS) |
| Thực thi | `COMPOSIO_MULTI_EXECUTE_TOOL` với `tools[]`; mỗi item `{tool_slug, arguments}` + `account` khi nhiều tài khoản (live v0.72: field là `tool_slug`, gửi `tool` → `Validation error: Required at "tools[0].tool_slug"`). Slug cụ thể (vd `GITHUB_CREATE_AN_ISSUE`) là argument, không phải tool riêng |
| Lấy schema | `COMPOSIO_GET_TOOL_SCHEMAS` với `{tool_slugs: [<slug>, ...]}` (live v0.72: gửi `{tools: [...]}` → `Validation error: Required at "tool_slugs"`). Response thật: `{successful, data: {tool_schemas: {<slug>: {input_schema: {required, properties}}}}}` — KHÔNG phải `{schemas: [{slug, input_parameters}]}` như mock bịa |
| Fallback REST (chưa dùng) | `POST /api/v3.1/tools/execute/{slug}`, body `{"arguments": {...}}` — chỉ dùng khi MCP router không đủ, ghi rõ lý do |

**Code:** `packages/core/src/composio/router.ts` (`ComposioToolRouter`).
An toàn trong router:

- Key thiếu → `ComposioError('composio_key_missing')`, lỗi sạch, không crash.
- Mọi error message qua `redactComposioKey` trước khi ném (key không vào log).
- `mcp.url` phải là https trên `*.composio.dev`, trừ loopback
  (`http://127.0.0.1`/localhost) chỉ cho mock test — URL lạ bị từ chối
  (chống SSRF qua session giả).
- Session URL là secret (presigned, chứa credential nhúng): không log.

## 3. Key lưu ở đâu

Key Composio (miễn phí, của chính user — lấy ở dashboard Composio →
Project Settings → API Keys) lưu trong **Vault, namespace `provider`,
key `composio`** — tái dùng API Vault hiện có, không refactor vault
(`packages/core/src/composio/keyStore.ts`).

- Chỉ có key PROJECT của user nằm đây. Token OAuth của từng app
  (Gmail, Slack…) nằm phía Composio (managed OAuth) và KHÔNG BAO GIỜ
  về máy này — đó là trade-off custody (xem §8).
- UI chỉ được hỏi "đã cấu hình chưa" (boolean); không đọc key ra hiển thị.
- Key KHÔNG vào code, KHÔNG vào `.env`, KHÔNG vào log/file (test kiểm
  tra cả file `vault.json` trên đĩa không chứa key plaintext).

## 4. 22 toolkit (v0.72a Team A mở rộng từ 4 toolkit đầu lên 14; v0.82 thêm 8 toolkit nữa)

| Toolkit | App id | Tool live (đếm live: 14 toolkit đầu 2026-11-10, 8 toolkit v0.82 đếm 2026-11-11) | Slug curated trong catalog (10, = cap M7) |
|---|---|---|---|
| Gmail | `composio-gmail` | 63 | `GMAIL_FETCH_EMAILS`, `GMAIL_SEND_EMAIL`, `GMAIL_LIST_THREADS`, `GMAIL_GET_PROFILE`, `GMAIL_SEARCH_PEOPLE`, `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_SEND_DRAFT`, `GMAIL_REPLY_TO_THREAD`, `GMAIL_LIST_LABELS`, `GMAIL_MOVE_TO_TRASH` |
| GitHub | `composio-github` | 905 | `GITHUB_CREATE_AN_ISSUE`, `GITHUB_GET_AN_ISSUE`, `GITHUB_SEARCH_ISSUES`, `GITHUB_LIST_PULL_REQUESTS`, `GITHUB_CREATE_A_PULL_REQUEST`, `GITHUB_GET_A_REPOSITORY`, `GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER`, `GITHUB_ADD_LABELS_TO_AN_ISSUE`, `GITHUB_CLOSE_ISSUE`, `GITHUB_SEARCH_REPOSITORIES` |
| Slack | `composio-slack` | 171 | `SLACK_CHAT_POST_MESSAGE`, `SLACK_LIST_CONVERSATIONS`, `SLACK_FETCH_CONVERSATION_HISTORY`, `SLACK_SEARCH_MESSAGES`, `SLACK_LIST_ALL_USERS`, `SLACK_CREATE_CHANNEL`, `SLACK_WHO_AM_I`, `SLACK_LIST_ALL_CHANNELS`, `SLACK_GET_USER_PRESENCE`, `SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK` |
| Notion | `composio-notion` | 60 | `NOTION_SEARCH_NOTION_PAGE`, `NOTION_RETRIEVE_PAGE`, `NOTION_FETCH_ALL_BLOCK_CONTENTS`, `NOTION_CREATE_NOTION_PAGE`, `NOTION_UPDATE_PAGE`, `NOTION_APPEND_BLOCK_CHILDREN`, `NOTION_QUERY_DATABASE`, `NOTION_FETCH_DATABASE`, `NOTION_CREATE_DATABASE`, `NOTION_GET_PAGE_MARKDOWN` |
| Google Sheets | `composio-googlesheets` | 58 | `GOOGLESHEETS_SEARCH_SPREADSHEETS`, `GOOGLESHEETS_VALUES_GET`, `GOOGLESHEETS_GET_SPREADSHEET_INFO`, `GOOGLESHEETS_GET_SHEET_NAMES`, `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`, `GOOGLESHEETS_VALUES_UPDATE`, `GOOGLESHEETS_CREATE_SPREADSHEET_ROW`, `GOOGLESHEETS_UPSERT_ROWS`, `GOOGLESHEETS_CREATE_GOOGLE_SHEET1`, `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW` |
| Google Drive | `composio-googledrive` | 105 | `GOOGLEDRIVE_LIST_FILES`, `GOOGLEDRIVE_FIND_FILE`, `GOOGLEDRIVE_GET_FILE_METADATA`, `GOOGLEDRIVE_DOWNLOAD_FILE`, `GOOGLEDRIVE_CREATE_FILE`, `GOOGLEDRIVE_CREATE_FOLDER`, `GOOGLEDRIVE_COPY_FILE`, `GOOGLEDRIVE_DELETE_FILE`, `GOOGLEDRIVE_CREATE_FILE_FROM_TEXT`, `GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE` |
| Google Calendar | `composio-googlecalendar` | 50 | `GOOGLECALENDAR_EVENTS_LIST`, `GOOGLECALENDAR_FIND_EVENT`, `GOOGLECALENDAR_EVENTS_GET`, `GOOGLECALENDAR_CREATE_EVENT`, `GOOGLECALENDAR_UPDATE_EVENT`, `GOOGLECALENDAR_PATCH_EVENT`, `GOOGLECALENDAR_DELETE_EVENT`, `GOOGLECALENDAR_QUICK_ADD`, `GOOGLECALENDAR_FREE_BUSY_QUERY`, `GOOGLECALENDAR_FIND_FREE_SLOTS` |
| Jira | `composio-jira` | 132 | `JIRA_SEARCH_ISSUES`, `JIRA_GET_ISSUE`, `JIRA_CREATE_ISSUE`, `JIRA_EDIT_ISSUE`, `JIRA_ADD_COMMENT`, `JIRA_TRANSITION_ISSUE`, `JIRA_ASSIGN_ISSUE`, `JIRA_GET_ALL_PROJECTS`, `JIRA_CREATE_PROJECT`, `JIRA_LIST_COMMENTS` |
| Linear | `composio-linear` | 48 | `LINEAR_LIST_LINEAR_ISSUES`, `LINEAR_SEARCH_ISSUES`, `LINEAR_GET_LINEAR_ISSUE`, `LINEAR_CREATE_LINEAR_ISSUE`, `LINEAR_UPDATE_ISSUE`, `LINEAR_CREATE_LINEAR_COMMENT`, `LINEAR_LIST_LINEAR_PROJECTS`, `LINEAR_CREATE_LINEAR_PROJECT`, `LINEAR_LIST_LINEAR_TEAMS`, `LINEAR_GET_CURRENT_USER` |
| Discord | `composio-discord` | 28 | `DISCORD_GET_MY_USER`, `DISCORD_LIST_MY_GUILDS`, `DISCORD_GET_MY_GUILD_MEMBER`, `DISCORD_GET_USER`, `DISCORD_GET_INVITE`, `DISCORD_INVITE_RESOLVE`, `DISCORD_GET_GUILD_WIDGET`, `DISCORD_LIST_MY_CONNECTIONS`, `DISCORD_GET_OPENID_CONNECT_USERINFO`, `DISCORD_MODIFY_CURRENT_USER` |
| Telegram | `composio-telegram` | 18 | `TELEGRAM_GET_ME`, `TELEGRAM_GET_UPDATES`, `TELEGRAM_GET_CHAT`, `TELEGRAM_GET_CHAT_HISTORY`, `TELEGRAM_SEND_MESSAGE`, `TELEGRAM_SEND_PHOTO`, `TELEGRAM_SEND_DOCUMENT`, `TELEGRAM_EDIT_MESSAGE`, `TELEGRAM_DELETE_MESSAGE`, `TELEGRAM_FORWARD_MESSAGE` |
| Trello | `composio-trello` | 335 | `TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER`, `TRELLO_GET_BOARDS_BY_ID_BOARD`, `TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD`, `TRELLO_GET_LISTS_CARDS_BY_ID_LIST`, `TRELLO_GET_CARDS_BY_ID_CARD`, `TRELLO_GET_SEARCH`, `TRELLO_ADD_BOARDS`, `TRELLO_ADD_CARDS`, `TRELLO_ADD_LISTS`, `TRELLO_ADD_CARDS_ACTIONS_COMMENTS_BY_ID_CARD` |
| Asana | `composio-asana` | 247 | `ASANA_SEARCH_TASKS_IN_WORKSPACE`, `ASANA_GET_TASKS_FROM_A_PROJECT`, `ASANA_GET_USER`, `ASANA_GET_WORKSPACE_PROJECTS`, `ASANA_CREATE_A_TASK`, `ASANA_CREATE_A_PROJECT`, `ASANA_CREATE_TASK_COMMENT`, `ASANA_ADD_TAG_TO_TASK`, `ASANA_GET_TASK_SUBTASKS`, `ASANA_SEARCH_PROJECTS_FOR_WORKSPACE` |
| HubSpot | `composio-hubspot` | 344 | `HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA`, `HUBSPOT_SEARCH_COMPANIES`, `HUBSPOT_SEARCH_DEALS`, `HUBSPOT_SEARCH_TICKETS`, `HUBSPOT_CREATE_CONTACT`, `HUBSPOT_CREATE_DEAL`, `HUBSPOT_CREATE_COMPANY`, `HUBSPOT_CREATE_TICKET`, `HUBSPOT_UPDATE_CONTACT`, `HUBSPOT_WHO_AM_I` |
| Zoom | `composio-zoom` | 107 | `ZOOM_CREATE_A_MEETING`, `ZOOM_LIST_MEETINGS`, `ZOOM_GET_A_MEETING`, `ZOOM_UPDATE_A_MEETING`, `ZOOM_DELETE_A_MEETING`, `ZOOM_GET_MEETING_RECORDINGS`, `ZOOM_LIST_ALL_RECORDINGS`, `ZOOM_GET_A_MEETING_SUMMARY`, `ZOOM_GET_USER`, `ZOOM_ADD_A_MEETING_REGISTRANT` |
| Salesforce | `composio-salesforce` | 327 | `SALESFORCE_CREATE_ACCOUNT`, `SALESFORCE_CREATE_CONTACT`, `SALESFORCE_CREATE_LEAD`, `SALESFORCE_CREATE_OPPORTUNITY`, `SALESFORCE_CREATE_TASK`, `SALESFORCE_QUERY`, `SALESFORCE_SEARCH`, `SALESFORCE_GET_ACCOUNT`, `SALESFORCE_GET_CONTACT`, `SALESFORCE_GET_OPPORTUNITY` |
| Zendesk | `composio-zendesk` | 457 | `ZENDESK_CREATE_ZENDESK_TICKET`, `ZENDESK_GET_ZENDESK_TICKET_BY_ID`, `ZENDESK_LIST_ZENDESK_TICKETS`, `ZENDESK_SEARCH_ZENDESK`, `ZENDESK_UPDATE_ZENDESK_TICKET`, `ZENDESK_CREATE_ZENDESK_USER`, `ZENDESK_GET_USER`, `ZENDESK_LIST_ZENDESK_USERS`, `ZENDESK_SEARCH_ZENDESK_USERS`, `ZENDESK_GET_VIEWS` |
| Airtable | `composio-airtable` | 28 | `AIRTABLE_LIST_BASES`, `AIRTABLE_GET_BASE_SCHEMA`, `AIRTABLE_LIST_RECORDS`, `AIRTABLE_GET_RECORD`, `AIRTABLE_CREATE_RECORD`, `AIRTABLE_UPDATE_RECORD`, `AIRTABLE_DELETE_RECORD`, `AIRTABLE_CREATE_MULTIPLE_RECORDS`, `AIRTABLE_WHO_AM_I`, `AIRTABLE_CREATE_TABLE` |
| Monday | `composio-monday` | 126 | `MONDAY_LIST_BOARDS`, `MONDAY_LIST_ITEMS`, `MONDAY_GET_ITEMS`, `MONDAY_CREATE_ITEM`, `MONDAY_UPDATE_ITEM`, `MONDAY_CREATE_BOARD`, `MONDAY_CREATE_UPDATE`, `MONDAY_LIST_USERS`, `MONDAY_GET_ME`, `MONDAY_LIST_GROUPS` |
| ClickUp | `composio-clickup` | 165 | `CLICKUP_CREATE_TASK`, `CLICKUP_GET_TASK`, `CLICKUP_GET_TASKS`, `CLICKUP_UPDATE_TASK`, `CLICKUP_CREATE_LIST`, `CLICKUP_GET_LISTS`, `CLICKUP_GET_SPACES`, `CLICKUP_CREATE_SPACE`, `CLICKUP_GET_AUTHORIZED_USER`, `CLICKUP_CREATE_TASK_COMMENT` |
| Dropbox | `composio-dropbox` | 178 | `DROPBOX_LIST_FILES_IN_FOLDER`, `DROPBOX_GET_METADATA`, `DROPBOX_FILES_SEARCH`, `DROPBOX_CREATE_FOLDER`, `DROPBOX_GET_TEMPORARY_LINK`, `DROPBOX_CREATE_SHARED_LINK`, `DROPBOX_GET_SPACE_USAGE`, `DROPBOX_GET_ABOUT_ME`, `DROPBOX_LIST_SHARED_LINKS`, `DROPBOX_SEARCH_FILE_OR_FOLDER` |
| Outlook | `composio-outlook` | 333 | `OUTLOOK_LIST_MESSAGES`, `OUTLOOK_GET_MESSAGE`, `OUTLOOK_CREATE_USER_MESSAGE`, `OUTLOOK_CREATE_DRAFT`, `OUTLOOK_SEARCH_MESSAGES`, `OUTLOOK_LIST_EVENTS`, `OUTLOOK_CREATE_ME_EVENT`, `OUTLOOK_LIST_CALENDARS`, `OUTLOOK_LIST_CONTACTS`, `OUTLOOK_CREATE_CONTACT` |

**Tổng: 4.285 tool thật trên 22 toolkit (2.564 đếm live 2026-11-10 +
1.721 đếm live 2026-11-11), 220 slug curated trong catalog
(10/toolkit = đúng cap M7).** Mọi slug đều đối chiếu với bằng chứng
live lưu ở `scripts/composio-toolkits-live/toolkits-live-2026-11-10.json`
(14 toolkit đầu) và `toolkits-live-2026-11-11.json` (8 toolkit v0.82)
(script `discover.py` + `README.md` cùng thư mục) — test
`tests/composio-toolkits-a.test.mjs` assert từng slug tồn tại trong
JSON đó, nên catalog không thể trôi khỏi thực tế Composio mà không
bị test bắt.

**Sửa sai v0.57:** slug `GITHUB_CREATE_ISSUE` trong catalog cũ KHÔNG
tồn tại trên Composio thật (suy đoán từ ví dụ tài liệu) — slug thật
là `GITHUB_CREATE_AN_ISSUE`. Tương tự, slug Slack/Notion do mock bịa
ở §7 (`SLACK_POST_MESSAGE`, `NOTION_CREATE_PAGE`…) không bao giờ được
thêm vào catalog; catalog v0.72a chỉ chứa slug đã thấy live.

**Hai phát hiện khi discovery live (xem §14):**
1. Tool Router session (`POST /tool_router/session` rồi
   `GET .../session/{id}/tools`) chỉ trả 6 meta-tool `COMPOSIO_*` —
   tool từng toolkit không nằm trong session list mà tìm qua
   `COMPOSIO_SEARCH_TOOLS` lúc chạy.
2. Endpoint catalog `GET /api/v3.1/tools` lọc theo toolkit bằng tham
   số **`toolkit_slug`** — tham số `toolkit` bị API lặng lẽ bỏ qua
   (bẫy khiến helper `composio.py --toolkit` trước đây trả danh sách
   không lọc).

**Ghi chú từ live test v0.72 (cây chính):** schema
`GITHUB_CREATE_AN_ISSUE` bắt buộc 3 field riêng `owner` + `repo` +
`title`, không phải 1 field `repo` dạng `owner/repo`;
`SLACK_SEND_MESSAGE` cũng đã xác nhận có thật (qua
`COMPOSIO_SEARCH_TOOLS`) nhưng nằm ngoài top-10 cap nên dùng qua
discovery lúc chạy.

Slug còn lại KHÔNG bịa thêm: phát hiện lúc chạy qua
`COMPOSIO_SEARCH_TOOLS` rồi thực thi qua `COMPOSIO_MULTI_EXECUTE_TOOL`
— đúng cách Tool Router thiết kế (không nhồi hàng trăm def vào
context).

Mỗi toolkit là catalog entry có `source: 'composio'`, bật/tắt được từng
app (`ComposioAppSource.setToolkitEnabled`). App router `composio` giữ
3 meta-tool model thực sự gọi (`SEARCH_TOOLS`, `GET_TOOL_SCHEMAS`,
`MULTI_EXECUTE_TOOL`); 4 meta-tool còn lại không expose cho model ở
v0.57 (kết nối app làm qua Composio Connect Link ở trình duyệt;
workbench/bash remote là code execution phía Composio — cố tình không mở).

**Quy tắc approval mới (v0.72a):** `composioToolNeedsApproval(slug)`
so khớp theo segment tách bằng `_` với tập động từ ghi
(`COMPOSIO_WRITE_VERBS`: ADD, APPEND, ARCHIVE, ASSIGN, CLEAR, COPY,
CREATE, DELETE, DUPLICATE, EDIT, FORWARD, IMPORT, INSERT, MERGE,
MODIFY, MOVE, PATCH, POST, PUBLISH, REMOVE, SCHEDULE, SEND, SET,
SHARE, TRANSITION, UNARCHIVE, UPDATE, UPSERT). Quy tắc regex cũ
(`/_ (SEND|CREATE|UPDATE|DELETE|POST|SHARE)_|...$/`) quá hẹp — bỏ sót
APPEND, UPSERT, COPY, QUICK_ADD, EDIT, TRANSITION, ASSIGN, MODIFY,
FORWARD, ADD. So khớp segment tránh nhầm `GET_UPDATES` (đọc) với
`UPDATE` (ghi). Trường hợp biên fail-closed:
`JIRA_SEARCH_FOR_ISSUES_USING_JQL_POST` chứa segment POST nên bị
đánh dấu cần approval dù bản chất là tìm kiếm — an toàn hơn là bỏ
sót tool ghi.

## 5. Cap M7 + filterTools

Tool Composio đã nằm trong AppRegistry nên:

- `applyAppToolCaps` (10 tool/app/turn mặc định, ghi đè theo app) áp
  dụng chung — test `composio-v057` chứng minh 12 tool Composio bị cắt
  còn 10, tool local (`email_read`, `slack_send`) không bị ảnh hưởng.
- `filterTools` (allowlist/skill/mode) chạy sau cap như tool local.
- `COMPOSIO_MULTI_EXECUTE_TOOL` tự giới hạn 50 tool/call (router chặn
  ở client trước khi gửi).

Đã nối (v0.51): cap M7 được nối vào turn chạy thật của loop
(`AgentRunnerOptions.appToolCaps` → `toolsAfterAppCap()` chạy
`applyAppToolCaps` TRƯỚC mọi lần `filterTools`, kể cả small-model path
và fallback) — áp cho cả tool local lẫn Composio.

## 6. UI

- **Đã làm (v0.57):** danh sách Connected apps ghi nhãn `· via Composio`
  cho app có `source: 'composio'` (`SettingsView.tsx` + `ConnectedAppView`
  trong `renderer/types.ts`); component `ComposioAppsSection.tsx` mới
  (props-driven: toggle toàn bộ source, toggle từng toolkit, trạng thái
  key, cảnh báo custody) — sẵn sàng cắm vào Settings.
- **Đã làm (v0.58):** RPC coordinator `composio.setState` /
  `composio.getState` (xem §11) — main process đã có thể gọi để bật/tắt
  Composio + toolkit trong tiến trình coordinator con; bot đã tạo được
  rebuild tool list ngay, không cần tạo lại bot.
- **Đã nối (v0.57, coordinator):** IPC `composio:get-state` /
  `composio:set-enabled` / `composio:set-app-enabled` / `composio:set-key` /
  `composio:clear-key` trong `apps/desktop/src/main/main.ts` + `preload.ts` +
  `global.d.ts` + `renderer/types.ts`; `ComposioAppsSection` đã mount trong
  `SettingsView.tsx` (Connected apps). **Đã nối (v0.88b):** IPC
  `composio:set-user-id` / `composio:clear-user-id` (xem §17) — user id
  vào Vault, main seed cho coordinator qua RPC `composio.setUserId`,
  đổi id có hiệu lực ngay không cần restart app. Main giữ một source duy nhất trong
  coordinator: handler main gọi tiếp RPC coordinator (`setComposioState` /
  `getComposioState` của `CoordinatorClient`, §11), KHÔNG tự quản source
  riêng; `getComposioSource()` lazy singleton trên `defaultAppRegistry`,
  `initComposio()` ở bootstrap phase 2, `syncComposioToCoordinator()` khi
  coordinator (re)spawn. `apps:list` trả cả app Composio (khi source bật)
  để badge "via Composio" hiện thật; nút Connect local không hiện cho app
  Composio (kết nối qua Composio Connect Link ở trình duyệt hệ thống,
  không nhập password trong app); nút Disconnect vô hiệu hoá toolkit (hoặc
  cả source cho app router) — token OAuth nằm phía Composio, thu hồi qua
  Connect Link. Test `tests/composio-ipc-v057.test.mjs` **8/8 pass**.

## 7. Cách test bằng mock (đã chạy)

File `tests/composio-v057.test.mjs` — 10 test, không mạng thật, không
tài khoản/key thật. Mock server local `http://127.0.0.1` giả lập cả hai
đầu: REST Tool Router (`POST /api/v3.1/tool_router/session`,
`GET .../tools`) và MCP endpoint mà session URL trỏ tới (`POST /mcp`,
`initialize` / `tools/list` 7 meta-tool / `tools/call`).

| Test | Kiểm chứng |
|---|---|
| Key trong Vault | set/get/clear; `listSecrets` chỉ trả tên; file `vault.json` không chứa key plaintext |
| Key thiếu | `ComposioError('composio_key_missing')`, không crash; key sai → HTTP 401, message không chứa key |
| Tạo session | `session_id` + presigned MCP URL qua mock REST; `buildMcpConfig` đúng shape cho `connectMcp` |
| Liệt kê tool session | slug + `input_parameters` qua mock REST |
| MCP qua `connectMcp` thật | `listTools` = 7 meta-tool; `searchTools` tìm `GMAIL_SEND_EMAIL`; `executeTool` trả kết quả mock; `tools[]` đúng shape `{tool, arguments}`; >50 tool bị chặn |
| MCP URL lạ | `*.composio.dev` https + loopback được; host lạ / http ngoài loopback bị từ chối |
| Source opt-in | Mặc định TẮT (5 app local); bật → 10 app; tắt từng toolkit; tắt source → gỡ hết, local còn nguyên |
| Catalog 4 toolkit | `source`/`authType` = composio, không `connectorId`, slug đã xác nhận, không đụng tên tool local |
| Cap M7 | 12 tool Composio → cắt còn 10, tool local giữ nguyên; ghi đè cap theo app được tôn trọng |
| Status view | Chưa key → `not_connected`; có key → `connected`; tắt source → rỗng |

Chạy: `npm run build --workspace=@open-bot/core && node --test tests/composio-v057.test.mjs`
Kết quả v0.57: **10/10 pass**. Test liên quan: `apps-m7` + cap-loop +
`mcp` **37/37 pass**.

### Harness live test 6 bước — ĐÃ SẴN SÀNG (v0.59, mock)

File `tests/composio-live-harness-v059.test.mjs` — 7 test, đi đúng 6
bước §8 bằng mock (không key/tài khoản/mạng thật), chạy được ngay:

| Bước §8 | Harness làm gì (mock) | Bằng chứng ghi lại |
|---|---|---|
| (1) Nhập key vào Vault | `setComposioApiKey(vault, FAKE_KEY)`; assert `hasComposioApiKey` + file `vault.json` không chứa key plaintext; sau đó mô phỏng main seed key cho coordinator qua RPC `composio.setApiKey` và assert `getKeyStatus = {hasKey: true, seeded: true, source: 'seeded'}` — các bước 2–6 chạy qua key đã seed (đường chính v0.59, như app thật), không chỉ qua file reader Vault | `step1.keyInVault: true`, `step1.seeded: true` |
| (2) Bật source + GitHub | `composio.setState {enabled, toolkits:['github']}`; assert `registeredAppIds = ['composio','composio-github']`, catalog def `source: 'composio'` (badge), bot tạo sau có meta-tool | `step2.registeredAppIds` |
| (3) Session + tools/list thật | `ComposioToolRouter.createSession` qua mock → `connectMcp` thật → `listTools` = 7 meta-tool; ghi input schema của `COMPOSIO_MULTI_EXECUTE_TOOL` (`tools[]` với `tool`/`arguments`/`account`); `listSessionTools` REST → slug Slack/Notion thấy được | `multiExecuteInputSchema`, `discoveredSlugs` |
| (4) SEARCH → GITHUB_CREATE_AN_ISSUE (mock) | `runTool` search → schemas → multi-execute trên repo test mock (`mock-org/mock-repo`) → issue mock #42 + URL; mock ghi lại đúng args; revoke (mock) → execute lỗi sạch chứa 'revoked' | `issueCreated: {number: 42, url}` |
| (5) Gmail/Slack sau (4) xanh | Test assert `step4 == pass` rồi mới chạy; multi-execute `GMAIL_SEND_EMAIL` + `SLACK_POST_MESSAGE` (mock) → `mock-msg-1` / `mock-ts-1`; báo cáo ghi rõ cảnh báo custody | `custodyWarning` (§9) |
| (6) Trễ 1 hop + tắt mạng | Đo 1 hop search qua mock (vài ms ở mock local — 7.8ms ở lần chạy kiểm tra 2026-11-10; con số này chỉ có ý nghĩa tương đối vì mock chạy trên cùng máy); trỏ manager sang port không ai nghe → `composio_session_failed` sạch, không lộ key; tool local `glob_files` qua coordinator + `getState`/`listBots` vẫn chạy | `latencyMs.oneHopMockMs` |

Chạy: `node --test tests/composio-live-harness-v059.test.mjs`
Kết quả v0.59: **7/7 pass** (6 bước + 1 test báo cáo). Báo cáo JSON
ghi ra `/tmp/composio-live-harness-v059-report.json` (không chứa key).

**MOCK-SLUG — ĐỌC KỸ trước khi bổ sung catalog:** slug Slack/Notion
mà mock "phát hiện" ở bước (3) (`SLACK_POST_MESSAGE`,
`SLACK_LIST_CHANNELS`, `NOTION_CREATE_PAGE`, `NOTION_SEARCH`) là slug
DO MOCK TỰ BỊA để harness chạy được, KHÔNG phải slug thật của
Composio. Chúng chỉ nằm trong báo cáo harness, KHÔNG thêm vào
`packages/core/src/composio/toolkits.ts`. Khi live test thật chạy với
key của Huy, bước (3) sẽ ghi slug thật thấy được và lúc đó mới bổ
sung vào catalog (xem §8 bước 3).

## 8. Live test cần key thật của Huy (phần ĐỌC đã làm ở v0.72 — phần GHI chờ phê duyệt)

**Live test thật phần ĐỌC đã chạy xong ở v0.72** (`scripts/composio-live-v072/`:
driver `run-live.py` lấy surrogate từ connector, `live.mjs` chạy 6 bước
qua code open-bot thật, báo cáo `report.json` — không key thô, không
surrogate trong báo cáo; xem §13.4 cho số đo):

1. ✅ Key: seed cho coordinator qua RPC `composio.setApiKey` (đường
   chính v0.59) — trong live test, key vào coordinator qua surrogate
   của connector (Sentinel đổi thành key thật trên egress); app Vault
   trên máy này vẫn chưa có key (`hasComposioApiKey: false`) — để app
   thật dùng Composio, Huy cần nhập key trong Settings → Composio
   (IPC `composio:set-key`), khi đó main seed như thường.
2. ✅ Bật source + 4 toolkit (GitHub/Gmail/Slack/Notion) qua RPC
   `composio.setState` — 5 app đăng ký, bot tạo sau có meta-tool.
3. ✅ Session thật (tạo trong 601–980ms, MCP host `backend.composio.dev`)
   → `tools/list` qua `connectMcp` thật: **6 meta-tool** (không có
   `COMPOSIO_WAIT_FOR_CONNECTIONS` — chỉ có khi bật
   `manage_connections.enable_wait_for_connections`); input schema thật
   của `COMPOSIO_MULTI_EXECUTE_TOOL`: item `{tool_slug, arguments}`,
   top-level required thêm `sync_response_to_workbench`.
   `listSessionTools` chỉ trả 6 meta-tool (tool app phát hiện qua
   SEARCH, không qua endpoint này). Slug thật 4 toolkit đã bổ sung
   vào `toolkits.ts` (xem §4).
4. ✅ `COMPOSIO_SEARCH_TOOLS` + `COMPOSIO_GET_TOOL_SCHEMAS` thật qua
   coordinator (`runTool`): search trả slug thật cả 4 toolkit;
   GET_TOOL_SCHEMAS với `{tool_slugs: [...]}` được chấp nhận, schema
   `GITHUB_CREATE_AN_ISSUE` bắt buộc `owner` + `repo` + `title`.
   ⏳ Phần GHI (execute `GITHUB_CREATE_AN_ISSUE` trên repo test thật
   → kiểm tra issue qua GitHub UI → revoke) CHƯA chạy — cần Huy phê
   duyệt rõ repo test.
5. ⏳ Gmail/Slack thật CHƯA chạy — chỉ sau khi (4) ghi xanh + Huy
   chấp nhận rủi ro custody (§9) và phê duyệt rõ hộp thư/kênh test.
6. ✅ Trễ 1 hop SEARCH_TOOLS: 3 lần đo 411/683/1407ms, median
   **683ms** (lần chạy trước: 473/1537/2748ms, median 1537ms — dao
   động lớn theo mạng); tắt mạng tới Composio → meta-tool lỗi sạch
   `composio_session_failed`, không lộ key; tool local `glob_files`
   + `getState`/`listBots` vẫn chạy.

**Chế độ live (v0.72, đã làm — thay cho ghi nhận "chưa có" ở trên):**
live test KHÔNG sửa file harness mock; chạy bằng script riêng
`scripts/composio-live-v072/run-live.py` (driver lấy surrogate từ
connector `custom.composio`, KHÔNG key thô) + `live.mjs` (đi đúng
6 bước §8 qua code open-bot thật, chỉ bước đọc; bước ghi ghi lại là
"chờ phê duyệt" thay vì tự làm). Chạy lại: `python3
scripts/composio-live-v072/run-live.py`. Harness mock
`tests/composio-live-harness-v059.test.mjs` vẫn 7/7 (mock).

## 8.1. Live test phần GHI — chuẩn bị xong ở v0.85, CHƯA CHẠY (cần Huy phê duyệt trước)

Phần ghi (tạo issue/mail/tin Slack thật) đã chuẩn bị xong về code,
schema và mock — nhưng **chưa chạy lần nào và không được chạy cho
tới khi Huy điền + ký checklist dưới đây**. Bản checklist đầy đủ để
in/điền nằm ở `scripts/composio-live-v072/WRITE-CHECKLIST.md` (form
trống, không chứa thông tin thật); mục này là bản ghi quyết định +
tóm tắt kỹ thuật.

### 8.1.1. Gate phê duyệt là phê duyệt TRƯỚC — không có gate lúc chạy

- Bot live test chạy với `autoApprove: true`
  (`scripts/composio-live-v072/live.mjs:255`), nên mọi tool call
  trong turn đều tự chạy không hỏi lại.
- `needsApproval: true` của `COMPOSIO_MULTI_EXECUTE_TOOL`
  (`packages/core/src/composio/executors.ts`, dòng ~535) chỉ là cờ
  metadata cho UI/loop ở app thật — **không phải gate trong lúc
  live test chạy**. Đừng nhầm cờ này với phê duyệt: phê duyệt duy
  nhất có hiệu lực là chữ ký của Huy ở checklist này, cấp TRƯỚC
  khi chạy `run-live.py`.
- Vì vậy: không điền checklist = không chạy bước ghi, dù code đã
  sẵn. Người chạy live test phải kiểm tra checklist đã ký trước khi
  đặt env input ghi (xem §8.1.3).

### 8.1.2. Schema thật đã fetch (chỉ đọc, 2026-11-11) + quyết định slug Slack

Fetch qua `COMPOSIO_GET_TOOL_SCHEMAS` (chỉ đọc, không thực thi),
snapshot đã scrub ở
`scripts/composio-live-v072/tool-schemas-write-2026-11-11.json`
(script `probe-write-schemas.mjs`, chạy qua `run-live.py`):

| Slug (ghi) | Required | Field chính (theo schema thật) |
|---|---|---|
| `GITHUB_CREATE_AN_ISSUE` | `owner`, `repo`, `title` | `owner` + `repo` là 2 field riêng (không phải 1 field `repo` dạng `owner/repo`); `body` tuỳ chọn |
| `GMAIL_SEND_EMAIL` | _(không có field required ở schema)_ | `recipient_email` (string, field chính; `to` chỉ là alias) + `subject`/`body` (ít nhất 1 trong 2 phải có; ít nhất 1 trong `to`/`recipient_email`/`cc`/`bcc` phải có). Mock cũ dùng đúng `recipient_email` nên giữ nguyên field này, chỉ bổ sung `subject`/`body` |
| `SLACK_SEND_MESSAGE` | `channel` | `channel` là ID hoặc tên kênh, **không có tiền tố `#`**; nội dung đúng **1 trong** `markdown_text` (nội dung thường) / `blocks` (Block Kit); `fallback_text` chỉ dùng khi dùng `blocks` |

Slug dọn dẹp (schema cũng đã fetch cùng đợt, xem §8.1.4):
`GITHUB_CLOSE_ISSUE` bắt buộc `owner` + `repo` + `issue_number`
(số nguyên); `GMAIL_MOVE_TO_TRASH` bắt buộc `message_id`;
`SLACK_DELETES_A_MESSAGE_FROM_A_CHAT` cần `channel` + `ts`.

**Quyết định slug Slack (v0.85):** bước ghi dùng
`SLACK_SEND_MESSAGE`. Slug cũ trong catalog
`SLACK_CHAT_POST_MESSAGE` vẫn tồn tại trên Composio nhưng mô tả của
nó ghi rõ "this action is deprecated" nên đã loại khỏi top-10
catalog (`packages/core/src/composio/toolkits.ts`, thay bằng
`SLACK_SEND_MESSAGE`) — catalog không còn giới thiệu slug
deprecated làm lựa chọn chính (test `tests/composio-toolkits-a.test.mjs`
assert điều này). Slug mock bịa `SLACK_POST_MESSAGE` không bao giờ
tồn tại — đã xoá khỏi mọi mock, thay bằng `SLACK_SEND_MESSAGE`.

### 8.1.3. Input ghi qua env (live.mjs chỉ chạy ghi khi env đủ)

`live.mjs` đọc input ghi từ env (không hardcode, không hỏi key):

| Env | Ý nghĩa |
|---|---|
| `COMPOSIO_WRITE_REPO` | Repo test dạng `owner/repo` (Huy điền repo thật của mình) |
| `COMPOSIO_WRITE_ISSUE_TITLE` / `COMPOSIO_WRITE_ISSUE_BODY` | Tiêu đề + nội dung issue test |
| `COMPOSIO_WRITE_MAIL_TO` | Hộp thư nhận mail test |
| `COMPOSIO_WRITE_MAIL_SUBJECT` / `COMPOSIO_WRITE_MAIL_BODY` | Tiêu đề + nội dung mail test |
| `COMPOSIO_WRITE_SLACK_CHANNEL` | Kênh Slack test (tên hoặc ID, không có `#`) |
| `COMPOSIO_WRITE_SLACK_TEXT` | Nội dung tin Slack test |

Mọi tiêu đề/nội dung artifact **bắt buộc** có tiền tố
`[open-bot live test]` — `live.mjs` từ chối chạy ghi nếu thiếu
tiền tố (fail rõ, không thực thi gì). Thiếu bất kỳ env nào → bước
ghi tương ứng vẫn `skipped` có lý do, không fail cả run (xem
assertion cuối `live.mjs`).

### 8.1.4. Dọn dẹp + revoke là BẮT BUỘC sau test ghi

Sau khi bước ghi chạy xong (và đã kiểm tra artifact qua GitHub
UI / hộp thư / Slack), `live.mjs` chạy bước dọn dẹp (bước 7) và
ghi kết quả vào `report.json`:

- Đóng issue bằng `GITHUB_CLOSE_ISSUE` (`owner` + `repo` +
  `issue_number` lấy từ output bước 4).
- Trash mail bằng `GMAIL_MOVE_TO_TRASH` (`message_id` lấy từ
  output bước 5). **Lưu ý: mail đã gửi không unsend được** — trash
  chỉ xoá bản trong Sent/hộp thư của tài khoản đã kết nối, người
  nhận vẫn giữ bản đã nhận. Vì vậy hộp thư test phải là hộp thư Huy
  kiểm soát được.
- Xoá tin Slack bằng `SLACK_DELETES_A_MESSAGE_FROM_A_CHAT`
  (`channel` + `ts` lấy từ output bước 5).
- Revoke connection thật: ngắt kết nối 3 app (GitHub/Gmail/Slack)
  trong dashboard Composio (hoặc qua
  `COMPOSIO_MANAGE_CONNECTIONS`) sau khi kiểm tra xong — bước này
  làm bằng tay, `live.mjs` không tự revoke (revoke là thao tác
  huỷ quyền, phải do chính Huy làm/chủ động xác nhận).
- Nếu bước dọn nào thất bại, `report.json` ghi rõ từng mục
  (pass/fail + lý do) để Huy dọn tay phần còn lại — không giấu
  thất bại dọn dẹp.

### 8.1.5. Checklist phê duyệt (Huy điền — xem file đầy đủ ở WRITE-CHECKLIST.md)

- [ ] Repo test: owner = ______, repo = ______ (repo chỉ dùng để test, không phải repo sản phẩm)
- [ ] Hộp thư nhận mail test: ______ (Huy kiểm soát được — mail đã gửi không unsend được)
- [ ] Kênh Slack test: ______ (workspace: ______, tên/ID kênh, không có `#`)
- [ ] Nội dung 3 artifact (đều có tiền tố `[open-bot live test]`): tiêu đề issue ______, tiêu đề mail ______, nội dung tin Slack ______
- [ ] Đã đọc + chấp nhận rủi ro custody §9 (token OAuth nằm phía Composio; sự cố 05/2026)
- [ ] Đã kết nối đủ 3 app GitHub + Gmail + Slack trong dashboard Composio — **điều kiện tiên quyết**: probe ngày 2026-11-11 ghi project của Huy có **total=0 connected account**, tức hiện chưa có app nào được kết nối; chưa connect đủ 3 app thì bước ghi sẽ lỗi (không có account để thực thi), phải connect trước rồi mới chạy
- [ ] Đồng ý dọn dẹp sau test: đóng issue + trash mail + xoá tin Slack + revoke connection 3 app
- [ ] Chữ ký phê duyệt của Huy: ______ — ngày: ______

Chỉ khi mọi ô trên đã tick + có chữ ký thì mới được đặt env §8.1.3
và chạy `python3 scripts/composio-live-v072/run-live.py`.

## 9. Rủi ro / trade-off hiện tại (cập nhật sau sự cố 05/2026)

Đọc lại từ nguồn chính thức ngày 2026-11-09 (xem thêm
`docs/composio-evaluation.md` §5 đã cập nhật):

- **Sự cố tháng 05/2026 (do chính Composio công bố):** kẻ tấn công vào
  hệ thống nội bộ, xâm phạm ~0,3% connection đang hoạt động (5.001
  connection GitHub) + 5.241 Composio API key được xác định là có thể
  đã lộ; đăng ký tool definition độc hại để leo thang quyền; token
  Gmail OAuth của nhân viên bị dùng để vào hệ thống phụ qua magic-link.
  Composio đã xoá toàn bộ API key tạo trước 23:00 PST ngày 22/05/2026.
- **Khắc phục (cập nhật 16/09/2026 + bài viết 21/10/2026):** 6 thay đổi —
  envelope encryption (AES-256-GCM, key-encryption key trong AWS KMS,
  rotate độc lập), API key chỉ lưu hash, Proxy Execute (API không còn
  trả token/secret OAuth), customer-managed KMS (proxy trong cloud của
  khách — Composio không giữ key giải mã), IP allowlist, AppSecure
  verification (đánh giá web/API/2 SDK theo OWASP Top 10; mọi finding
  critical/high đã sửa + re-verify). IntrusionOps làm incident
  response; Latacora review AWS/GitHub — một số item còn đang làm
  ("remaining items in progress"). SOC 2 Type II qua Trust Center.
- **Trade-off còn nguyên:** customer-managed KMS là triển khai tuỳ chọn,
  cần làm việc với team Composio, KHÔNG phải mặc định; mặc định Cloud
  thì execution runtime vẫn giải mã credential lúc gọi (giữ lại 0 sau
  call theo công bố). Log mặc định giữ full payload tới 1 năm (ZDR là
  add-on trả phí). Bản thân Composio cũng viết rõ: đánh giá có phạm vi,
  "không có nghĩa mọi lỗ hổng đã hết", SOC 2 / pentest "không đảm bảo
  không có sự cố khác". Tiền lệ đã có + custody tập trung = rủi ro
  không thể xoá bằng code adapter; chỉ giảm nhẹ bằng: bật Composio
  opt-in (mặc định tắt), chỉ dùng cho tài khoản không nhạy cảm trước,
  scoped key + IP allowlist khi có, và luôn giữ đường local M7 cho app
  cốt lõi.
- **Chi phí:** Hobby $0 — 100K call + 50K trigger/tháng, hard-capped;
  managed app chỉ 20K call miễn phí rồi $0,0005–$0,01/call (xem
  `docs/composio-evaluation.md` §3). Key của user tự mang = user tự
  chịu phí Composio của mình; open-bot không trả hộ.

## 10. File đã đổi (v0.57)

Mới: `packages/core/src/composio/` (`types.ts`, `keyStore.ts`,
`toolkits.ts`, `router.ts`, `source.ts`, `index.ts`, `README.md`),
`tests/composio-v057.test.mjs`, `docs/composio-integration.md`,
`apps/desktop/src/renderer/components/ComposioAppsSection.tsx`.
Sửa: `packages/core/src/apps/types.ts` (`authType: 'composio'`,
`source`, `toolkit`), `packages/core/src/apps/catalog.ts` (validate
chấp nhận `composio`), `packages/core/src/apps/index.ts`,
`packages/core/src/index.ts` (export Composio),
`apps/desktop/src/renderer/types.ts` + `SettingsView.tsx` (nhãn
"via Composio"), `docs/composio-evaluation.md` (trạng thái),
`docs/BEYOND-ROADMAP.md` (mục v0.57 nháp).
KHÔNG chạm: `packages/core/src/agent/loop.ts`,
`packages/core/src/coordinator/coordinator.ts` (worker khác đang sửa),
`packages/core/src/vault/*` (chỉ dùng API Vault hiện có).

## 11. Đường thực thi (v0.58) — meta-tool gọi thật được trong turn

v0.57 chỉ có metadata: 3 meta-tool nằm trong catalog nhưng chưa có
implementation runnable nào. v0.58 nối đường chạy thật:

```
model gọi COMPOSIO_SEARCH_TOOLS / GET_TOOL_SCHEMAS / MULTI_EXECUTE_TOOL
  → Tool (createComposioMetaTools, packages/core/src/composio/executors.ts)
  → ComposioSessionManager (1 instance / tiến trình coordinator)
      lazy tạo Tool Router session (REST) + connectMcp client, cache
      theo (key, toolkit đang bật); đổi key/toolkit → huỷ session cũ,
      lần gọi sau tạo mới; 2 call đồng thời dùng chung 1 lần nối
  → ComposioToolRouter (REST tạo session + gọi meta-tool qua MCP)
  → Composio Tool Router (mock ở test, thật ở live test sau)
```

**Chọn đặt ở core, không đặt ở `@open-bot/tools` — vì sao:**
mọi dependency của đường này đã nằm trong core (`ComposioToolRouter`,
`keyStore`, `connectMcp`, `Vault`). Đặt ở tools sẽ bắt tools import
runtime của core (đi sâu thêm vòng core <-> tools mà
`coordinator.ts` đã cảnh báo) mà không được gì — tool ở đây là tool
của tiến trình coordinator, không phải tool dùng chung.

**Gate trong `defaultToolFactory`** (`packages/core/src/coordinator/coordinator.ts`):
meta-tool chỉ xuất hiện trong tool list khi Composio đang BẬT trong
tiến trình coordinator (host tiêm `ToolFactoryHost.getComposioTools`
trỏ về session manager dùng chung; tắt → `[]` → không đăng ký tool
nào). Khi bật, cap M7 + `filterTools` áp dụng ở loop như tool local
(app `'composio'` trong AppRegistry) — factory không tự cắt/lọc gì
thêm. Bot tạo sau thấy trạng thái mới; bot đã tạo được coordinator
rebuild tool list ngay khi toggle (tách `BotEntry.composioTools`
riêng khỏi `coreTools`, như `rebuildPluginTools`).

**Không retry call lỗi:** lỗi MCP có thể là lỗi sau khi server đã
thực thi (vd đã gửi mail) — retry sẽ thực thi trùng. Call lỗi chỉ
làm mất session/client cache để lần gọi SAU nối lại mới. Mọi error
qua `redactComposioKey` trước khi ném; key thiếu / không đọc được /
source tắt → `ComposioError` sạch, không crash turn. `needsApproval`:
SEARCH + GET_SCHEMAS = false (chỉ đọc/discovery), MULTI_EXECUTE =
true (có thể ghi). Giới hạn 50 tool/call chặn ở tool (trước khi tạo
session) + chặn lại ở router.

**Shape `COMPOSIO_GET_TOOL_SCHEMAS` ĐÃ XÁC NHẬN (live v0.72):**
argument wire là `{ tool_slugs: [<slug>, ...] }` — shape
`{ tools: [...] }` suy đoán ở v0.58 bị server từ chối
(`Validation error: Required at "tool_slugs"`). Tool vẫn chấp nhận
cả `tools` / `slugs` / `tool` đơn lẻ ở đầu vào để tha thứ khi model
gọi lệch; router dịch về `tool_slugs` khi gửi. Response thật:
`{successful, data: {tool_schemas: {<slug>: {input_schema:
{required, properties}}}}}` — KHÔNG phải `{schemas: [{slug,
input_parameters}]}` như mock bịa. Tương tự, item của
`COMPOSIO_MULTI_EXECUTE_TOOL` trên wire là `{tool_slug, arguments}`
(gửi `tool` → `Validation error: Required at
"tools[0].tool_slug"`); tool chấp nhận cả `tool_slug` lẫn `tool` ở
đầu vào, router dịch về `tool_slug`. Tạo session: `toolkits` trên
wire là policy object `{enable: [...]}` (mảng string → HTTP 400).

### Key trong tiến trình coordinator — quyết định + giới hạn

**Đã chọn (v0.58, fallback từ v0.59): đọc TRỰC TIẾP cùng file Vault mà main dùng**
(`createComposioVaultFileKeyReader(dataDir)` trong `keyStore.ts`):
coordinator con mở lại `<dataDir>/vault.json` (userData nó đã biết
qua `CoordinatorOptions.dataDir` / env `OPENBOT_DATA_DIR`). Chỉ ĐỌC,
không bao giờ ghi/xoá. Theo dõi `mtimeMs` của file và mở lại Vault
mới khi file đổi nên key mới/xoay trong main được thấy ở lần đọc sau.
Key KHÔNG bao giờ truyền qua RPC stdio.

**Từ v0.59 đường chính là MAIN SEED (xem §13):** key seed trong bộ
nhớ qua RPC thắng fallback file ở mọi lần đọc
(`createComposioSeededKeyReader` bọc file reader). Đường đọc file
dưới đây chỉ còn là fallback khi main chưa seed (vd coordinator
chạy standalone không qua main).

**Giới hạn — đọc kỹ, đường này chỉ làm việc một phần:**
- CHỈ mở được khi Vault của main dùng **LocalEncryptor fallback**
  (key file `vault.json.key` nằm cùng thư mục). Khi main dùng
  Electron `safeStorage` (OS keychain/DPAPI — mặc định khi máy có
  keychain, tức hầu hết Mac/Windows), tiến trình Node thường không có
  `safeStorage.decryptString` nên `getSecret` ném lỗi giải mã →
  reader trả null → tool báo `composio_key_missing` (fail-closed).
  Trên máy này (Linux, test dùng LocalEncryptor) đường đọc file làm
  việc; trên máy user dùng safeStorage thì KHÔNG.
- Key thêm vào Vault khi main bật **NO_STORAGE** chỉ sống trong bộ
  nhớ của main, không xuống đĩa → reader không thấy (trả null).
- Vault chỉ đọc file lúc mở: hai tiến trình có thể lệch nhau trong
  khoảnh khắc giữa lần ghi của main và lần đọc tiếp theo của
  coordinator (mtime check thu hẹp chứ không xoá hẳn).
- `new Vault()` ở chế độ LocalEncryptor ghi MỘT dòng cảnh báo ra
  stderr mỗi lần mở lại (khi file đổi) — ồn nhưng vô hại.
- Trường hợp biên: entry `provider:composio` hết hạn (key set có
  TTL — hiện không dùng) thì `getSecret` có thể ghi lại file từ
  tiến trình con (purge entry hết hạn); rủi ro nhỏ, ghi nhận ở đây.

**Phương án thay thế (ĐÃ LÀM ở v0.59 — main seed key cho coordinator):**
main seed key cho coordinator lúc `createBot` (param `composioApiKey`)
và qua RPC riêng `composio.setApiKey`, theo đúng mẫu token đã có
trong coordinator (`connectorTokenSets`, `mcpOAuthTokens`, `xBearer`,
`githubToken`): main truyền bản sao key trong bộ nhớ qua params RPC,
con giữ trong bộ nhớ và không bao giờ chạm file Vault; key mới/xoay
trong main thì main gọi lại RPC seed (hoặc coordinator emit event
`composio.key-needed` xin seed lại khi bật source mà không đọc được
key nào). Ưu: làm việc với mọi backend Vault (kể cả safeStorage +
NO_STORAGE), không lệch file. Nhược: key đi qua stdio (cùng kênh với
các secret khác đã đi — chấp nhận được theo mẫu hiện có). Khi seed
xong, `createComposioVaultFileKeyReader` chỉ còn là fallback khi
không có key được seed. Chi tiết + hợp đồng RPC mới: xem §13.

### Hợp đồng RPC coordinator (main process gọi đúng signature này)

Client (`CoordinatorClient`, `packages/core/src/coordinator/client.ts`):

```ts
setComposioState(state: { enabled: boolean; toolkits: string[] })
  : Promise<{ enabled: boolean; toolkits: string[]; registeredAppIds: string[] }>
// → RPC method 'composio.setState'
getComposioState()
  : Promise<{ enabled: boolean; toolkits: string[]; registeredAppIds: string[] }>
// → RPC method 'composio.getState'
setComposioApiKey(apiKey: string | null)
  : Promise<{ hasKey: boolean; seeded: boolean; source: 'seeded' | 'vault-file' | 'none' }>
// → RPC method 'composio.setApiKey' (v0.59 — main seed key, xem §13)
getComposioKeyStatus()
  : Promise<{ hasKey: boolean; seeded: boolean; source: 'seeded' | 'vault-file' | 'none' }>
// → RPC method 'composio.getKeyStatus' (v0.59 — trạng thái key, không chứa key)
```

Coordinator (`AgentCoordinator`, `handle()` dispatch 2 method trên):
giữ MỘT `ComposioAppSource` trên `defaultAppRegistry`; `setState`
validate toolkit theo `COMPOSIO_TOOLKIT_SLUGS` hiện tại (22 slug —
lạ → lỗi rõ ràng, không áp dụng gì) rồi toggle source + từng toolkit (tái dùng
`applyComposioPersistedState` của `state.ts`), huỷ session Composio
cũ, rebuild tool list mọi bot đã tạo; trả state đã áp dụng + app id
đã đăng ký. `getState` trả trạng thái hiện tại (không chứa key).
Kiểu: `ComposioState` / `SetComposioStateParams` /
`SetComposioStateResult` / `GetComposioStateResult` trong
`packages/core/src/coordinator/types.ts` (đã thêm vào
`CoordinatorMethod`). Main ĐÃ nối IPC (§6) và gọi tiếp 2 method client
này — không tự quản source riêng.

### Test v0.58 (mock, không key/tài khoản thật)

File `tests/composio-v058.test.mjs` — 12 test, mock REST + mock MCP
trên `http://127.0.0.1` (mở rộng mock v0.57 thêm
`COMPOSIO_GET_TOOL_SCHEMAS` + lỗi `isError`).

| Test | Kiểm chứng |
|---|---|
| Meta-tool end-to-end | search → schemas → multi-execute qua tool thật; 3 call chỉ tạo 1 session (cache) |
| Key thiếu | `composio_key_missing`, không crash, không tạo session |
| Fetch lỗi mang key | message ném ra đã lọc key (`[composio-key-redacted]`) |
| Validate args | query rỗng / schemas rỗng / execute rỗng / arguments sai / >50 → lỗi rõ, không gọi mạng |
| Toolkit đổi / invalidate | session mới ở lần gọi sau; `isConnected()` false sau invalidate |
| MCP isError | `ComposioError('composio_session_failed')`, không crash |
| Key reader | không dataDir → null; key xoay trên đĩa được thấy; file mất/hỏng → null |
| Gate factory | không tiêm host → vắng; tiêm → có mặt (3 meta-tool) |
| Cap + filter | app `composio` trong registry; cap 2 cắt đúng 1; `filterTools` giữ/bỏ như thường |
| RPC set/get (in-process) | toggle, toolkit lạ lỗi + giữ nguyên trạng thái, tắt từng toolkit |
| Bot + runTool (in-process) | bot tạo sau khi bật → có tool; `runTool` search + execute thật qua mock, 2 call 1 session; tắt → bot đã tạo mất tool ngay |
| Client qua NDJSON-RPC thật | `setComposioState`/`getComposioState` qua tiến trình con; bot trong con có meta-tool khi bật |

Chạy: `npm run build && node --test tests/composio-v058.test.mjs`
Kết quả v0.58: **12/12 pass**. Test liên quan: `composio-v057`
10/10, `composio-ipc-v057` 8/8, `coordinator` + `apps-m7` +
cap-loop 29/29, `mcp` (+dispatcher/reconnect/client/mount) 99/99.

## 12. File đã đổi (v0.58)

Mới: `packages/core/src/composio/executors.ts`
(`ComposioSessionManager`, `createComposioMetaTools`),
`tests/composio-v058.test.mjs`.
Sửa: `packages/core/src/composio/router.ts` (`getToolSchemas`),
`packages/core/src/composio/keyStore.ts`
(`createComposioVaultFileKeyReader`),
`packages/core/src/composio/index.ts` (export mới),
`packages/core/src/coordinator/coordinator.ts` (gate
`defaultToolFactory`, `ToolFactoryHost.getComposioTools`,
`ComposioAppSource` + session manager, RPC `composio.setState` /
`composio.getState`, `BotEntry.composioTools`, rebuild),
`packages/core/src/coordinator/types.ts` (`ComposioState` + method),
`packages/core/src/coordinator/client.ts`
(`setComposioState`/`getComposioState`),
`packages/core/src/coordinator/index.ts`,
`packages/core/src/index.ts` (export Composio mới),
`docs/composio-integration.md` (§11–§12),
`docs/BEYOND-ROADMAP.md` (mục v0.58).
KHÔNG chạm (worker v0.58): `apps/desktop/src/main/*`, preload, renderer
(IPC main đã do coordinator nối riêng ở v0.57 — xem §6),
`packages/tools/src/*` (không cần — đường thực thi
nằm trong core, xem §11), `packages/core/src/vault/*` (chỉ dùng API
Vault hiện có, không refactor vault).

## 13. Main seed key + harness live test (v0.59)

### 13.1. Main seed key cho coordinator — đường chính từ v0.59

Giới hạn v0.58 (§11) đã được sửa đúng bằng phương án thay thế đề
xuất — main seed key cho coordinator, theo đúng mẫu token đã có:

```
main (đọc được Vault bằng safeStorage trong main process)
  → seed bản sao key trong bộ nhớ qua RPC 'composio.setApiKey'
    hoặc param composioApiKey của createBot (cùng kênh stdio với
    xBearer / githubToken / mcpOAuthTokens — không log)
  → coordinator giữ key trong bộ nhớ (createComposioSeededKeyReader),
    KHÔNG BAO GIỜ chạm file Vault
  → key mới/xoay: main gọi lại RPC seed (ghi ĐÈ key cũ, không cần
    destroyBot — khác seed-only của connectorTokenSets/mcpOAuthTokens)
  → user xoá key: main seed null → coordinator xoá bản seed, về
    fallback / fail-closed
  → coordinator bật source mà không đọc được key nào: emit event
    'composio.key-needed' {reason: 'composio_key_missing'} để main
    seed lại (payload không chứa key)
```

**Ưu tiên đọc key trong coordinator:** key đã seed (bộ nhớ) thắng
fallback đọc file Vault (`createComposioVaultFileKeyReader` — chỉ
còn là fallback khi không có key được seed). Nhờ đó meta-tool chạy
được với mọi backend Vault: safeStorage (mặc định Mac/Windows),
NO_STORAGE (key chỉ sống trong bộ nhớ main), và LocalEncryptor
(fallback cũ vẫn làm việc khi không seed).

**Main seed ở 4 điểm** (`apps/desktop/src/main/main.ts`,
`seedComposioKeyToCoordinator()` — đọc Vault bằng
`getComposioApiKey(vault)`, best-effort, không log key):
1. `getOrCreateRuntime` → param `composioApiKey` của `createBot`
   (bot tạo mới / re-attach đều seed lại — xoay key không cần
   destroyBot).
2. `syncComposioToCoordinator()` → seed TRƯỚC khi đẩy state
   (coordinator spawn lại / toggle sau đều seed lại; seed trước để
   khỏi emit `composio.key-needed` thừa).
3. IPC `composio:set-key` → nhập/xoay key xong seed ngay cho
   coordinator (bot đang chạy dùng key mới, session cũ bị huỷ).
4. IPC `composio:clear-key` → seed null (xoá bản seed trong con).
   `routeCoordinatorEvent` nghe `composio.key-needed` → seed lại.

**Hợp đồng RPC mới** (`CoordinatorClient.setComposioApiKey` /
`getComposioKeyStatus`, kiểu `SetComposioApiKeyParams` /
`SetComposioApiKeyResult` / `GetComposioKeyStatusResult` /
`ComposioKeySource` trong `packages/core/src/coordinator/types.ts`):
kết quả chỉ có `{hasKey, seeded, source}` (`source` =
`'seeded' | 'vault-file' | 'none'`), KHÔNG chứa key. Seed chỉ huỷ
session manager khi key hiệu lực thật sự đổi (seed lại cùng key thì
session cũ giữ nguyên). `createBot` với `composioApiKey` rỗng/vắng =
giữ nguyên key đã seed (không clear).

### 13.2. Test v0.59 (mock, không key/tài khoản thật)

File `tests/composio-seed-v059.test.mjs` — 9 test (xem §7 cho harness
6 bước, file `tests/composio-live-harness-v059.test.mjs` — 7 test):

| Test | Kiểm chứng |
|---|---|
| Seeded reader (unit) | seeded thắng fallback; fallback đổi không thắng seed; seed mới ghi đè; seed null/rỗng/khoảng trắng = clear về fallback; fallback ném lỗi → null |
| Chỉ seeded key, KHÔNG file Vault | coordinator KHÔNG dataDir (mô phỏng safeStorage: file reader luôn null) + `createBot({composioApiKey})` → status `seeded`, `runTool` search + execute chạy được, mock ghi session tạo bằng đúng key seed |
| Key xoay qua RPC | `composio.setApiKey(FAKE_KEY_2)` → lần gọi sau tạo session mới bằng key mới; xoay lại qua `createBot` re-attach (không destroyBot) vẫn áp dụng |
| Clear seed | `setApiKey(null)` → status `none`, tool báo `composio_key_missing`, không lộ key |
| Event key-needed | bật source khi chưa có key → emit 1 event `composio.key-needed {reason}` (không chứa key); tắt source không emit thêm; đã seed thì bật lại không emit |
| Fallback còn nguyên | coordinator có dataDir Vault (LocalEncryptor), không seed → status `vault-file`, tool chạy; seed sau thắng fallback; clear seed → về `vault-file` |
| Params sai | `setApiKey(123)` / `setApiKey(null)` → lỗi rõ, trạng thái không đổi |
| Không lộ key | stderr trong lúc seed + chạy tool, `getState`, error message — không chứa key |
| Client qua NDJSON-RPC thật | `setComposioApiKey`/`getComposioKeyStatus` qua tiến trình con; seed qua `createBot` param qua RPC; clear → `none`; kết quả không chứa key |

Chạy: `npm run build --workspace=@open-bot/core && node --test tests/composio-seed-v059.test.mjs`
Kết quả v0.59: **9/9 pass**. Test liên quan: `composio-v057`
10/10, `composio-v058` 12/12, `composio-ipc-v057` 8/8,
`coordinator` 11/11, `coordinator-v04` 5/5.

### 13.3. File đã đổi (v0.59)

Mới: `tests/composio-seed-v059.test.mjs`,
`tests/composio-live-harness-v059.test.mjs`.
Sửa: `packages/core/src/composio/keyStore.ts`
(`createComposioSeededKeyReader`; file reader chỉ còn là fallback),
`packages/core/src/coordinator/types.ts` (`composioApiKey` trong
`CreateBotParams`, `composio.setApiKey` / `composio.getKeyStatus`,
`ComposioKeySource` + kiểu kết quả, event `composio.key-needed`),
`packages/core/src/coordinator/coordinator.ts` (seeded reader,
`seedComposioApiKey`, RPC seed/status, seed ở `createBotInner`,
emit `composio.key-needed`),
`packages/core/src/coordinator/client.ts`
(`setComposioApiKey`/`getComposioKeyStatus`),
`packages/core/src/coordinator/index.ts`,
`packages/core/src/composio/index.ts` + `packages/core/src/index.ts`
(export `createComposioSeededKeyReader`),
`apps/desktop/src/main/main.ts`
(`seedComposioKeyToCoordinator`, seed ở `getOrCreateRuntime` /
`syncComposioToCoordinator` / IPC `composio:set-key` /
`composio:clear-key`, nghe `composio.key-needed`),
`docs/composio-integration.md` (§7–§8, §11, §13 này).
KHÔNG chạm: `packages/core/src/vault/*`,
`packages/core/src/composio/toolkits.ts` (slug Slack/Notion thật chỉ
bổ sung sau live test thật — mock slug không được thêm vào catalog),
`packages/tools/src/*`.

**Lưu ý cho điều phối viên (ngoài phạm vi sóng này, đã sửa để test
chạy được):** cây làm việc đang có thay đổi chưa commit của sóng
UI-5 (threads) làm `new BotMemory` ném `no such column: threadId`
trên DB mới — `CREATE INDEX ... ON messages(threadId)` chạy trong
batch CREATE TABLE trong khi cột `threadId` chưa tồn tại (cả DB mới
lẫn DB cũ). Sóng này đã sửa tối thiểu trong
`packages/core/src/agent/memory.ts` (thêm `threadId TEXT` vào
`CREATE TABLE messages`, chuyển tạo index xuống sau migration đảm
bảo cột tồn tại) để v0.58 về lại 12/12 và test v0.59 chạy được. Hunk
này thuộc về sóng UI-5 — khi tích hợp, giữ lại nếu sóng UI-5 chưa tự
sửa, hoặc thay bằng bản sửa của sóng đó (không được revert về bản
lỗi, vì mọi `createBot` đều hỏng).

### 13.4. Live test thật — phần đọc (v0.72)

Chạy 2026-11-10 ~21:13–21:17 (giờ VN) với key project thật của Huy
qua connector `custom.composio` (key hợp lệ từ ~21:02). Script riêng
`scripts/composio-live-v072/` (KHÔNG nằm trong suite test thường):
`run-live.py` lấy surrogate `hsurr:` từ authd, spawn `live.mjs` với
surrogate trong env (không in/log/ghi surrogate hay key thô);
`live.mjs` đi đúng 6 bước §8 qua code open-bot thật
(coordinator + `ComposioSessionManager` + `ComposioToolRouter` +
`connectMcp` thật). Kết quả: **bước 1, 2, 3, 4, 6 pass; bước 5
skipped** (chờ phê duyệt ghi). Báo cáo đầy đủ (không chứa key):
`scripts/composio-live-v072/report.json`.

Số đo thật (lần chạy cuối, 21:17):
- Tạo session: 776ms (các lần trước 596–980ms); MCP host
  `backend.composio.dev`; `tools/list` qua `connectMcp` thật: 6
  meta-tool (không có `COMPOSIO_WAIT_FOR_CONNECTIONS`).
- `COMPOSIO_MULTI_EXECUTE_TOOL` input schema thật: item
  `{tool_slug, arguments}`, top-level required thêm
  `sync_response_to_workbench`.
- SEARCH_TOOLS thật trả slug: Gmail 12, GitHub 7, Slack 8, Notion 7
  (xem §4 + `report.json`); `GET_TOOL_SCHEMAS` thật cho
  `GITHUB_CREATE_AN_ISSUE`: field `assignee, assignees, body, labels,
  milestone, owner, repo, title`, bắt buộc `owner, repo, title`.
- Trễ 1 hop SEARCH_TOOLS: 411/683/1407ms, median 683ms (lần chạy
  trước median 1537ms — dao động lớn theo mạng).
- `GET /api/v3.1/tools?toolkit=<slug>` KHÔNG lọc (đã kiểm chứng
  riêng qua helper connector với cả 4 toolkit + probe catalog
  limit=100: cùng 100 item đầu, cùng cursor, bất kể toolkit) —
  endpoint catalog này không nhận filter theo toolkit; discovery theo
  toolkit đi qua session `toolkits: {enable: [...]}` + SEARCH_TOOLS.

3 lỗi wire shape live test phát hiện + sửa trong sóng này (xem §2/§11):
(1) tạo session: `toolkits` phải là `{enable: [...]}` (mảng string →
HTTP 400); (2) GET_TOOL_SCHEMAS: `{tool_slugs: [...]}` (gửi `tools`
→ `Validation error: Required at "tool_slugs"`); (3) MULTI_EXECUTE
item: `{tool_slug, arguments}` (gửi `tool` → `Validation error:
Required at "tools[0].tool_slug"` — kiểm chứng bằng probe slug
không tồn tại, không thực thi gì). Mock ở `tests/composio-v057/
v058/live-harness-v059` đã cập nhật để bắt chước đúng 3 shape này
(kèm 1 regression test mới trong v057); test Composio 47/47 pass.

Mock còn khác server thật ở 3 điểm (ghi nhận, chưa sửa mock — mock
chỉ kiểm tra parsing + flow, không phải hành vi thật của endpoint):
(1) mock `listSessionTools` trả slug app, thật chỉ trả 6 meta-tool;
(2) mock `tools/list` trả 7 meta-tool (gồm WAIT_FOR_CONNECTIONS),
thật trả 6; (3) mock GET_TOOL_SCHEMAS trả `{schemas: [{slug,
input_parameters}]}`, thật trả `{data: {tool_schemas: {slug:
{input_schema}}}}`.

Còn lại — cần Huy phê duyệt rõ: (a) bước 4 phần ghi: tạo 1 issue
thật bằng `GITHUB_CREATE_AN_ISSUE` trên repo test của Huy (cần tên
repo + owner), rồi kiểm tra qua GitHub UI + revoke connection;
(b) bước 5: gửi 1 mail test qua `GMAIL_SEND_EMAIL` + 1 tin Slack
qua `SLACK_SEND_MESSAGE` (cần hộp thư + kênh test). Chưa chạy bước
nào trong hai bước này.

**Chuẩn bị phần ghi (v0.85, chưa chạy):** schema live của 6 slug
ghi/dọn đã fetch chỉ-đọc qua `COMPOSIO_GET_TOOL_SCHEMAS`
(`GMAIL_SEND_EMAIL`: `recipient_email` + `subject`/`body`;
`SLACK_SEND_MESSAGE`: bắt buộc `channel`, 1 trong
`markdown_text`/`blocks`; `GITHUB_CREATE_AN_ISSUE`: `owner` +
`repo` + `title`; dọn: `GITHUB_CLOSE_ISSUE`,
`GMAIL_MOVE_TO_TRASH`, `SLACK_DELETES_A_MESSAGE_FROM_A_CHAT`) —
snapshot đã scrub
`scripts/composio-live-v072/tool-schemas-write-2026-11-11.json`.
Mock harness đã sửa theo đúng shape thật (v057/v058/harness
7+12+10 test xanh). `live.mjs` đã có code bước ghi + dọn dẹp (bước
7), chỉ chạy khi env input ghi đã đủ + checklist §8.1 đã ký;
chưa có env thì bước 4-ghi/5/7 vẫn `skipped` có lý do. Chi tiết:
xem docs §8.1 + `scripts/composio-live-v072/WRITE-CHECKLIST.md`.
## 14. Mở rộng 10 toolkit + OAuth trực tiếp (v0.72a Team A)

### 14.1. Discovery live — phương pháp + 2 phát hiện

Script `scripts/composio-toolkits-live/discover.py` gọi
`GET /api/v3.1/tools?toolkit_slug=<slug>&limit=500` (phân trang bằng
`next_cursor`) cho 14 toolkit bằng key project thật của Huy qua
surrogate của helper `composio.py` — key không bao giờ chạm file hay
log. Kết quả lưu ở
`scripts/composio-toolkits-live/toolkits-live-2026-11-10.json`
(2.564 tool) + `README.md` cùng thư mục; chạy lại script bất cứ lúc
nào để kiểm tra catalog có còn khớp thực tế Composio không.

Hai phát hiện (đã ghi ở §4, nhắc lại vì ảnh hưởng code khác):
1. Tool Router session chỉ liệt kê 6 meta-tool `COMPOSIO_*` — tool
   từng toolkit không nằm trong session list; discovery lúc chạy qua
   `COMPOSIO_SEARCH_TOOLS` vẫn là đường chính.
2. Tham số lọc catalog đúng là **`toolkit_slug`**, không phải
   `toolkit` — helper `composio.py --toolkit` hiện gửi `toolkit` nên
   trả danh sách không lọc (đã biết từ trước, chưa sửa helper vì
   ngoài phạm vi sóng này).

### 14.2. OAuth connector trực tiếp — 6 connector mới

Theo đúng mẫu `ConnectorDefinition` sẵn có (slack/gmail/teams):
mỗi connector là một module tự đăng ký qua `registerConnector()`
trong try/catch, export từ `packages/core/src/index.ts`, UI kết nối
qua IPC `auth:oauth-start` có sẵn — không sửa IPC hay framework.

| Connector | Auth URL | Token URL | Scope (chỉ đọc/hẹp nhất có thể) | Ghi chú |
|---|---|---|---|---|
| `google` | `accounts.google.com/o/oauth2/v2/auth` | `oauth2.googleapis.com/token` | `drive.readonly`, `spreadsheets.readonly`, `calendar.events.readonly` | + 3 hàm đọc thật `googleDriveListFiles`, `googleSheetsGetValues`, `googleCalendarListEvents` (qua `callWithAutoRefresh`, mock-test được) |
| `jira` | `auth.atlassian.com/authorize` | `auth.atlassian.com/oauth/token` | `read:jira-user read:jira-work write:jira-work offline_access` | `buildAuthUrl` riêng: cần `audience=api.atlassian.com` + `prompt=consent`; API cần cloudId (qua `/oauth/token/accessible-resources`); chỉ Jira Cloud; + 3 hàm đọc thật `jiraListAccessibleResources`, `jiraSearchIssues`, `jiraGetIssue` (v0.73, mock-test được) |
| `linear` | `linear.app/oauth/authorize` | `api.linear.app/oauth/token` | `read,write` | `buildAuthUrl` riêng: scope nối bằng **dấu phẩy** (docs Linear); API là GraphQL `api.linear.app/graphql`; + 2 hàm đọc thật `linearListIssues`, `linearGetIssue` (v0.73, mock-test được; `issue(id:)` chỉ nhận UUID nên get theo identifier dùng filter `identifier.eq`) |
| `hubspot` | `app.hubspot.com/oauth/authorize` | `api.hubapi.com/oauth/v1/token` | `crm.objects.contacts.read/write`, `crm.objects.companies.read`, `oauth` | `oauth` luôn bắt buộc; **KHÔNG hỗ trợ PKCE** — dùng confidential client + client secret; + 3 hàm đọc thật `hubspotListContacts`, `hubspotListCompanies`, `hubspotSearchContacts` (v0.73, mock-test được) |
| `asana` | `app.asana.com/-/oauth_authorize` | `app.asana.com/-/oauth_token` | `projects:read tasks:read tasks:write` | Hẹp hơn scope `default` toàn quyền; + 4 hàm đọc thật `asanaGetCurrentUser`, `asanaListProjects`, `asanaListTasks`, `asanaGetTask` (v0.73, mock-test được; response bọc trong `{ "data": ... }`) |
| `discord` | `discord.com/oauth2/authorize` | `discord.com/api/oauth2/token` | `identify guilds guilds.members.read` | Chỉ đọc; gửi tin channel cần bot token — chưa hỗ trợ; + 3 hàm đọc thật `discordGetCurrentUser`, `discordListGuilds`, `discordListGuildChannels` (v0.73, mock-test được) |

**Không có OAuth2 trực tiếp (ghi rõ, không bịa connector):**
Trello dùng OAuth 1.0a (không khớp framework OAuth2) và Telegram
không có OAuth2 (dùng Bot API token) — hai app này chỉ đi qua
Composio, chưa có đường local.

**Không thêm catalog app local** cho 10 app mới: guard test
`tests/apps-m7.test.mjs` yêu cầu app oauth2 trỏ tới connector đã
đăng ký (nay 9 connector) VÀ tool local thật trong
`packages/tools/src/integrationTools.ts` — app mới chưa có tool
local thật nên thêm catalog app sẽ là entry không trung thực. Khi
nào có tool local thật cho một app thì thêm catalog app cho app đó
(comment trong guard đã cập nhật).

### 14.3. File đã đổi (v0.72a Team A)

Mới: `scripts/composio-toolkits-live/` (`discover.py`,
`toolkits-live-2026-11-10.json`, `README.md`),
`packages/core/src/connectors/{google,jira,linear,hubspot,asana,discord}.ts`,
`tests/composio-toolkits-a.test.mjs` (6 test),
`tests/connectors-a.test.mjs` (6 test).
Sửa: `packages/core/src/composio/toolkits.ts` (14 toolkit, 140 slug
đã xác minh, `COMPOSIO_WRITE_VERBS` + `composioToolNeedsApproval`,
sửa `GITHUB_CREATE_ISSUE` → `GITHUB_CREATE_AN_ISSUE`),
`packages/core/src/composio/index.ts` (export mới),
`packages/core/src/composio/source.ts` + `state.ts` (comment),
`packages/core/src/index.ts` (export 6 connector),
`tests/apps-m7.test.mjs` (chỉ comment guard — assertion giữ nguyên),
`docs/composio-integration.md` (§4, §14 này),
`docs/BEYOND-ROADMAP.md` (mục v0.72a).
KHÔNG chạm: tầng IPC Composio (`composio:get-state/set-enabled/
set-app-enabled/set-key/clear-key`, main + preload + renderer),
`packages/core/src/composio/router.ts` / `executors.ts` / `keyStore.ts`,
`packages/tools/src/*`, cây chính `~/workspace/open-bot`.

### 14.4. Giới hạn còn lại (để sóng sau)

- Client API thật cho Jira/Linear/HubSpot/Asana/Discord chưa viết
  (chỉ có definition + ghi chú endpoint trong module); chỉ Google có
  3 hàm đọc thật.
- Discord gửi tin channel cần bot token, chưa hỗ trợ.
- Trello (OAuth 1.0a) + Telegram (Bot API token) không có connector
  trực tiếp — chỉ qua Composio.
- Jira API cần cloudId (chưa có helper lấy accessible-resources);
  HubSpot không hỗ trợ PKCE.
- Helper `composio.py --toolkit` vẫn gửi tham số `toolkit` (bị API
  bỏ qua) — chưa sửa thành `toolkit_slug`.
- Live test trong open-bot qua IPC (6 bước §8) do coordinator cây
  chính làm (v0.72); sóng này chỉ discovery live qua REST + test
  mock, không gọi IPC Composio. (Đã xong ở v0.72 — xem §13.4.)

## 15. Triggers → automations (v0.83b)

Sự kiện từ app ngoài (mail mới, issue mới, tin nhắn mới...) chạy
automation của open-bot. Đọc kỹ: `scripts/composio-triggers-live-v083/report.md`
+ snapshot `trigger-types-22.json` (244 trigger type trên 22 toolkit,
đối chiếu live 2026-11-11; **Telegram 0, Dropbox 0** — không có trigger
nào để nối).

### 15.1. Nhận event — route riêng, auth bằng chữ ký

- Local API: `POST /v1/automations/:id/composio-trigger`
  (`packages/core/src/api/server.ts`, đặt TRƯỚC gate Bearer — Composio
  không gửi được Bearer token của Local API; chữ ký HMAC hoặc `?token=`
  CHÍNH là auth; Bearer không được chấp nhận thay thế).
- Envelope V3: `{ id, type: "composio.trigger.message",
  metadata: { trigger_slug, trigger_id, connected_account_id, user_id },
  data, timestamp }` — parse ở `packages/core/src/composio/triggers.ts`
  (`parseComposioTriggerPayload`, chấp nhận alias `payload` cho `data`,
  từ chối envelope không phải V3 / slug sai định dạng / thiếu `data`).
- Chữ ký: `HMAC-SHA256(${webhook-id}.${webhook-timestamp}.${rawBody}, secret)`,
  header `webhook-id` / `webhook-timestamp` /
  `webhook-signature: v1,<base64>`; verify timing-safe, dung sai replay
  300s (`compute/verifyComposioWebhookSignature`). **Auth verify TRƯỚC
  khi parse/chạy**: chữ ký sai bị từ chối ngay cả khi token URL đúng;
  không chữ ký thì so token timing-safe; không có gì → 401, không ghi run.
- Slug trong event phải khớp `triggerSlug` của automation, không thì
  không ghi run (400). Event map thành input của run qua
  `composioTriggerToInput` (context append cho run-agent, fill args cho
  run-tool theo mẫu webhook automation HMAC đã có).
- Status: auth sai/thiếu → 401, automation không tồn tại → 404, automation
  tắt / không phải kind composio / chưa có secret / slug lệch / body sai
  → 400, API chưa mount → 404.

### 15.2. Secrets — Vault, không bao giờ đọc lại

- Namespace `composio-trigger-keys/` (`packages/core/src/composio/triggerKeys.ts`):
  signing secret = `COMPOSIO_WEBHOOK_SECRET` của project Composio do
  user DÁN vào UI (open-bot không tự lấy được secret này từ Composio);
  URL token 32 byte hex sinh ngẫu nhiên, keyId `<automationId>-url-token`.
- IPC main: `composio:trigger-defs` (50 defs đã đối chiếu),
  `automations:composio-trigger-secret:set/exists/delete`,
  `automations:composio-trigger-token:create/rotate/exists/delete`,
  `automations:composio-trigger:test` (ký mock event bằng secret đã lưu,
  secret không rời main process). Secret/token chỉ trả ĐÚNG MỘT LẦN lúc
  tạo/xoay; xoá automation thì xoá cả 2 secret (best-effort).
- `validateForEnable` chặn bật automation Composio chưa có secret
  (fail-closed); `create()` chỉ validate schema nên tạo xong mới dán
  secret vẫn được — dòng automation hiện "secret chưa có" + ô dán.

### 15.3. UI — AutomationsView

- Loại trigger mới `composio`: dropdown 50 defs đã đối chiếu (theo
  toolkit) + ô gõ slug tự do (bất kỳ slug catalog nào đúng định dạng đều
  được chấp nhận) + ô dán secret ngay trong form tạo.
- Dòng automation: hint route `POST /v1/automations/{id}/composio-trigger`,
  trạng thái secret/token, tạo/xoay/xoá token, nút "Gửi sự kiện thử"
  (ký mock event thật bằng secret đã lưu).
- i18n 28 key mới × 6 locale (1218 → 1246 key/file).

### 15.4. Test (mock, không key/tài khoản thật)

- Core `tests/composio-triggers-v083.test.mjs` 9/9: parse, verify
  (giả mạo/replay/sai định dạng), defs/counts (tổng 244), vòng đời key
  trong Vault giả, scheduler delivery đã ký, chữ ký sai/không auth/
  slug lệch không ghi run, token fallback + chữ ký sai thắng token đúng,
  automation tắt + map run-tool, validate/validateForEnable.
- HTTP `tests/composio-trigger-http-v083.test.mjs` 5/5 (server thật,
  port 0, Vault thật trong thư mục tạm): delivery đã ký KHÔNG Bearer →
  200 + run; Bearer sai bị bỏ qua; chữ ký sai/không auth → 401;
  `?token=` → 200 / token sai → 401; slug lệch → 400, không tồn tại →
  404, chưa mount → 404; JSON non-canonical ký đúng trên byte gốc → 200.
- Renderer `tests/automations-composio-v083-renderer.test.mjs` 2/2 dưới
  xvfb (fixture `tests/fixtures/automations-composio-v083-harness.tsx`,
  mock `window.openBot` ghi lại mọi IPC): tạo automation từ form (chọn
  slug + dán secret → tóm tắt slug + "secret đã có", secret KHÔNG hiện
  lại trên trang), dòng chưa có secret (dán secret → đổi trạng thái,
  tạo token hiện đúng 1 lần, gửi sự kiện thử ghi 1 run ok).

### 15.5. Giới hạn còn lại

- **Trigger instance KHÔNG do open-bot tạo**: user tạo trong dashboard /
  CLI / SDK của Composio, trỏ webhook URL của project về Local API.
  Một project Composio chỉ có MỘT webhook URL cho mọi trigger. Xem
  hướng dẫn từng bước ở §15.6 — UI AutomationsView cũng hiện hint +
  link docs ngay trong form tạo (v0.84d).
- **Local API chỉ nghe loopback** nên Composio cloud không gọi trực tiếp
  được — cần tunnel (`composio dev triggers listen --forward
  http://127.0.0.1:<port>/v1/automations/<id>/composio-trigger` hoặc
  cloudflared/ngrok). Chưa có live test end-to-end từ Composio cloud —
  đánh giá tính khả thi ở v0.84b
  (`scripts/composio-triggers-live-v084/report.md`): project của Huy
  hiện có 0 connected account / 0 trigger instance, và CLI 0.6.0 đòi
  `composio login` tương tác — cả hai đều cần Huy làm trước.
- Telegram/Dropbox không có trigger (0 mục trong catalog) — chỉ gọi tool
  chủ động được.
- Poll trigger (104/244, vd Gmail) vẫn qua cùng webhook URL: Composio
  poll rồi push event về URL đã đăng ký.
- Composio phần ghi (tạo issue/mail/Slack thật) vẫn chờ Huy phê duyệt
  (repo test + hộp thư test + kênh Slack test).

### 15.6. Tạo trigger instance — hướng dẫn từng bước (v0.84d)

open-bot **không tự tạo trigger instance thay user** — tạo trigger là
cấp quyền cho Composio theo dõi một app của user (vd đọc mail, theo
dõi repo), nên phải do chính user làm trong tài khoản Composio của
mình. UI AutomationsView hiện hint ngắn + link docs ngay trong form
tạo automation Composio (`automations.composioSetupHint` /
`automations.composioSetupDocs`, đủ 6 locale); dưới đây là bản đầy đủ.

**Bước 1 — Kết nối app (bắt buộc, làm 1 lần cho mỗi app).** Trigger
nào cũng cần một connected account. Trong dashboard Composio: connect
app (vd GitHub, Gmail, Slack) và hoàn tất OAuth. Bằng CLI (sau khi
`composio login`):

```
composio link <toolkit>        # vd: composio link github
```

Kiểm tra: `composio dev connected-accounts list` (hoặc
`GET /api/v3.1/connected_accounts` — project của Huy ngày 2026-11-11
trả total=0, tức là chưa có app nào được kết nối).

**Bước 2 — Tạo trigger instance.** Trong dashboard: Auth Configs →
chọn auth config của toolkit → **Active Triggers → Create Trigger** →
chọn connected account → chọn trigger type → điền config → Create.
Bằng CLI (sau khi `composio login`):

```
composio dev triggers create <SLUG>   # vd: GITHUB_ISSUE_CREATED
```

Hoặc bằng API: `POST /api/v3.1/trigger_instances/{slug}/upsert`
(xem `GET /api/v3.1/trigger_instances/active` để kiểm tra). Slug phải
khớp `triggerSlug` của automation đã tạo trong open-bot, không thì
event tới bị từ chối 400, không ghi run.

**Bước 3 — Dán webhook secret vào open-bot.** Lấy
`COMPOSIO_WEBHOOK_SECRET` trong cài đặt project Composio, dán vào ô
secret trong form tạo automation (hoặc ô dán ở dòng automation). Secret
lưu trong Vault, không hiện lại nữa. Automation chưa có secret thì
không bật được (`validateForEnable` chặn).

**Bước 4 — Đưa event về máy local.** Local API chỉ nghe 127.0.0.1,
Composio cloud không gọi trực tiếp được. Cách khuyên dùng khi dev
(không cần URL công khai — CLI stream event qua WebSocket rồi forward
về loopback, ký đúng như production):

```
composio dev triggers listen \
  --forward "http://127.0.0.1:<port>/v1/automations/<id>/composio-trigger" \
  --trigger-slug <SLUG> --max-events 1
```

Đặt `COMPOSIO_WEBHOOK_SECRET` bằng đúng secret đã dán ở bước 3 để
event forward được ký và open-bot verify HMAC thật. Muốn chạy kiểu
production (webhook thật) thì đăng ký webhook URL công khai của project
(trỏ về route trên qua cloudflared/ngrok) — một project chỉ có một
webhook URL cho mọi trigger.

Docs gốc của Composio:
- Creating triggers: https://docs.composio.dev/docs/setting-up-triggers/creating-triggers
- Receiving events: https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events

**Trạng thái live test:** chưa chạy được end-to-end từ Composio cloud
— xem `scripts/composio-triggers-live-v084/report.md` (v0.84b): cần
Huy kết nối app (bước 1) + `composio login` trên máy này trước.

## 16. Slack inbound / dialog — nhận tin Slack + modal tương tác (v0.87a, P2-2)

Chiều gửi Slack đã có từ trước (`SLACK_SEND_MESSAGE`, live-verified
v0.72). Mục này là chiều **nhận**: tin nhắn Slack đến (`message` /
`app_mention`) và payload tương tác (`block_actions` / `view_submission`
/ `view_closed`, tức dialog/modal) chạy automation hoặc gửi vào bot, rồi
trả lời lại Slack bằng chính slug gửi đã có.

### 16.1. Hai đường nhận — cùng một automation

Một automation trigger `composio` với slug tin nhắn Slack
(`SLACK_CHANNEL_MESSAGE_RECEIVED`, `SLACK_DIRECT_MESSAGE_RECEIVED`,
`SLACK_RECEIVE_MESSAGE` — cả 3 đều có thật trong catalog trigger live
2026-11-11, xem
`scripts/composio-triggers-live-v083/trigger-types-22.json`) nhận được
tin nhắn theo **cả hai đường**; user chỉ cần nối một đường:

1. **Qua Composio** (đã có từ v0.83b): tạo trigger instance Slack trong
   Composio, event về route `POST /v1/automations/:id/composio-trigger`
   với chữ ký HMAC Composio. Scheduler verify chữ ký như cũ, rồi
   **chuẩn hoá** tin nhắn Slack trong `data` của envelope
   (`normalizeSlackMessageFromComposioData` trong
   `packages/core/src/slack/inbound.ts`): input của automation nhận
   thêm block `slack` đã chuẩn hoá + `channel` / `text` / `ts` ở
   top-level, để action run-tool trả lời được qua `SLACK_SEND_MESSAGE`
   và action run-agent đọc được tin nhắn thay vì JSON thô.
2. **Thẳng từ Slack** (mới v0.87a): Slack app post Events API /
   interactivity về route mới
   `POST /v1/automations/:id/slack-inbound`. Auth là **Signing Secret
   của Slack app** (Slack app settings → Basic Information), user dán
   vào Vault namespace `slack-inbound-keys/` (key id = automation id,
   xem `packages/core/src/slack/keys.ts`). Scheduler verify
   `x-slack-signature` (`v0=<hex HMAC-SHA256("v0:{timestamp}:{rawBody}")>`,
   dung sai replay 300 s, giống v0.83b) **trước khi parse hay chạy bất
   kỳ action nào**; chữ ký sai/thiếu → 401, không ghi run. Không có
   fallback `?token=<redacted> đường này — Slack ký mọi request, và token
   trong URL sẽ lọt vào log delivery của Slack.

### 16.2. Payload nào được nhận, payload nào bị bỏ

`packages/core/src/slack/inbound.ts` (`parseSlackInboundPayload`):

- `url_verification` → trả lại `{ challenge }`, **không ghi run**
  (Slack gửi 1 lần lúc đăng ký URL).
- `event_callback` với `message` / `app_mention` → chạy automation.
  Tin nhắn bot (`bot_id` hoặc subtype `bot_message`) và các subtype
  không phải tin mới (`message_changed`, `message_deleted`, …) →
  200 `{ kind: 'ignored' }`, **không ghi run** (bot không tự trả lời
  chính mình, sửa/xoá tin không chạy lại automation).
- `block_actions` / `view_submission` / `view_closed` → chạy
  automation với interaction làm input: action đã bấm
  (`action_id`, `value` / `selectedOption`) và giá trị modal đã submit
  (flatten thành `"<block_id>.<action_id>"` → value, multi-select →
  mảng, ô trống → null). Payload interactivity Slack gửi dạng
  form-encoded `payload=<json>`; JSON thô cũng được chấp nhận.
- Event tới phải khớp slug của automation: DM (`channel_type: 'im'`)
  chỉ chạy automation `SLACK_DIRECT_MESSAGE_RECEIVED`, tin kênh/nhóm
  chỉ chạy `SLACK_CHANNEL_MESSAGE_RECEIVED`, slug generic
  `SLACK_RECEIVE_MESSAGE` nhận tất cả. Lệch → 400, không ghi run.

### 16.3. Trả lời lại Slack

Action trả lời là run-tool `COMPOSIO_MULTI_EXECUTE_TOOL` với:

```json
{ "tools": [{ "tool_slug": "SLACK_SEND_MESSAGE", "arguments": { "channel": "<channel id>", "markdown_text": "<nội dung trả lời>", "thread_ts": "<ts của thread, nếu có>" } }] }
```

`slackReplyArgs(message, text)` build đúng object `arguments` này
(schema live v0.72: bắt buộc `channel`, `markdown_text` cho nội dung,
`thread_ts` tuỳ chọn). Input của automation đã có sẵn `channel` /
`text` / `ts` ở top-level nên `applyTriggerInputToAction` tự điền
`channel` vào args mà action chưa set (arg action ghi rõ vẫn thắng).
Tin trong thread thì trả lời tiếp trong thread đó
(`thread_ts = message.threadTs`); tin ngoài thread thì trả lời trong
kênh, không tạo thread mới.

### 16.4. UI — AutomationsView

Automation có slug tin nhắn Slack hiện thêm mục Slack dưới mục Composio:
hint route `POST /v1/automations/{id}/slack-inbound` + hint tunnel,
trạng thái Slack signing secret, ô dán secret, nút xoá secret và nút
"Gửi tin Slack thử" (IPC `automations:slack-inbound:test` — ký mock
`event_callback` message bằng secret đã lưu, secret không rời main
process). IPC mới: `automations:slack-signing-secret:set/exists/delete`
+ `automations:slack-inbound:test` (preload + `global.d.ts`).
i18n 12 key mới × 6 locale (1310 → 1322 key/file).

### 16.5. Test (mock, không Slack app / tài khoản thật)

- Core `tests/slack-inbound-v087a.test.mjs` 16/16: verify chữ ký
  (round-trip, giả mạo body, sai secret, replay >300 s, thiếu header,
  sai định dạng `v0=`), parse Events API + interactivity (cả 3 loại
  payload, form-encoded `payload=`), normalizer data Composio (4
  shape, reaction/bot → null), slug matching + reply args, vòng đời
  key trong Vault giả, scheduler delivery đã ký (run-agent prompt có
  text + channel, run-tool được điền `channel`, arg rõ thắng), chữ ký
  sai/không auth/thiếu secret/slug không phải Slack/slug lệch/
  automation tắt đều không ghi run, `url_verification` + bot message
  trả về không ghi run, `block_actions` form-encoded chạy được, và
  Composio trigger slug Slack enrich input còn slug reaction thì
  không.
- HTTP `tests/slack-inbound-http-v087a.test.mjs` 6/6 (server thật,
  port 0, Vault thật trong thư mục tạm): delivery đã ký KHÔNG Bearer
  → 200 + run; Bearer <redacted> bị bỏ qua; chữ ký sai/không auth/thiếu
  timestamp → 401; `url_verification` → 200 challenge, bot message →
  200 ignored, cả hai không ghi run; slug lệch → 400, không tồn tại →
  404, chưa mount → 404; JSON non-canonical ký đúng trên byte gốc →
  200; `block_actions` form-encoded → 200 + run.

### 16.6. Giới hạn còn lại — nói thẳng

- **Local API chỉ nghe loopback** nên Slack/Composio cloud không gọi
  trực tiếp được — cần tunnel (`cloudflared tunnel --url
  http://127.0.0.1:<port>` / ngrok) rồi đăng ký URL công khai đó làm
  Request URL trong Slack app (Event Subscriptions + Interactivity &
  Shortcuts). UI hiện hint này ngay trong mục Slack.
- **Shape `data` của trigger Slack qua Composio chưa từng quan sát
  live** (live test v0.83b chỉ đọc catalog trigger type, chưa có event
  Slack nào thật sự fire). Normalizer chấp nhận 4 shape plausibly
  (`data.event`, `data.message`, bare Slack event, flattened
  `text` + `channel`/`channel_id`); shape nào không khớp thì trả
  null và automation vẫn nhận nguyên `data` thô — event không bị
  rớt, chỉ mất phần chuẩn hoá. Khi nào có event thật đầu tiên, đối
  chiếu lại shape và thu hẹp normalizer.
- **Không trả `response_url`, không trả modal update
  (`response_action`)**: open-bot chỉ route payload vào automation
  rồi trả 200 khi run xong. Action agent chạy chậm có thể vượt cửa sổ
  ack 3 s của Slack và user thấy cảnh báo timeout — dialog/modal nên
  dùng action run-tool trả lời nhanh (`SLACK_SEND_MESSAGE`).
- `SLACK_RECEIVE_BOT_MESSAGE` cố tình không nằm trong danh sách slug
  tin nhắn: tin của bot bị bỏ qua ở cả hai đường, nên trigger đó
  không bao giờ fire qua module này.
- Live test end-to-end từ Slack thật chưa làm (cần Slack app + tunnel
  + kênh test của Huy) — giống phần ghi Composio, vẫn chờ phê duyệt.

## 17. Composio user id — session phải dùng đúng id của tài khoản (v0.88b)

### 17.1. Tại sao cần — lỗi đã chặn người dùng thật

Composio gắn mỗi connected account (OAuth Gmail/Slack/GitHub/Notion)
với một **user id** trong tài khoản Composio của user. Tool Router
session chỉ thấy connection khi session được tạo với đúng user id đó.
Trước v0.88b app hardcode user id `'local-user'` cho mọi session
(`COMPOSIO_LOCAL_USER_ID`, `coordinator.ts` tạo `ComposioSessionManager`
với id hằng số) nên session **không thấy** 3 connection đã connect
trong dashboard Composio (GitHub tài khoản openbot1, Gmail
hoangthuanreview20@gmail.com, Slack workspace "open-bot" — cả 3 Active,
cùng user id trên dashboard). Probe `MANAGE_CONNECTIONS` đã chứng minh:
session với user id của dashboard thấy 3 connection Active, session
`'local-user'` chỉ nhận link OAuth mới (pending). Field `account`
trong `MULTI_EXECUTE` không cứu được — Composio từ chối
"Multi-account selection is not enabled".

### 17.2. Lấy user id ở đâu trong dashboard Composio

Mở dashboard Composio → tài khoản/project của bạn → xem **User ID**
(hiển thị trên trang tài khoản/Auth Configs, dạng `pg-test-…` hoặc
UUID). Đó là id của tài khoản sở hữu các connected account — dán
nguyên chuỗi đó vào app, không tự bịa id khác. User id KHÔNG phải
secret như API key (nó là định danh tài khoản, hiển thị công khai
trên dashboard), nhưng app vẫn đối xử thận trọng: không log, không
hiện nguyên văn ra UI, không trả về qua RPC/IPC — UI chỉ báo
"đã cấu hình/chưa".

### 17.3. Cách nhập trong app

Settings → Connected apps → mục Composio: ô **Composio user id** +
nút **Lưu user id** (bên dưới ô API key). Nhập xong có hiệu lực
**ngay, không cần khởi động lại app**: main seed id mới cho
coordinator, session cũ (key theo id cũ) bị huỷ, lần gọi tool sau
tạo session mới đúng id. Nút **Xoá user id** đưa về mặc định
`'local-user'` (session cũ cũng bị huỷ ngay). Khi chưa cấu hình,
app vẫn chạy như trước với `'local-user'`; Composio vẫn opt-in
mặc định TẮT.

### 17.4. Lưu ở đâu — quyết định

User id lưu trong **Vault, cùng namespace `'provider'` với API key**
(key `'composio-user-id'`, xem `keyStore.ts`), KHÔNG lưu trong
`settings.json`. Lý do: id gắn chặt với key (cùng một tài khoản
Composio), đi chung vòng đời backup/xoá với key; Vault là nơi duy
nhất main đọc được bằng safeStorage để seed cho tiến trình
coordinator con (settings.json thì tiến trình con đọc được nhưng
lại tách id khỏi key và phơi id ra file text thường). Giá trị không
bao giờ vào log hay error message.

### 17.5. Đường đi của user id (đúng mẫu key)

```
Settings UI (draft, không prefill)
  → IPC composio:set-user-id / composio:clear-user-id (main)
  → Vault provider/composio-user-id
  → main seed qua RPC composio.setUserId (+ param composioUserId
    của createBot, và lúc (re)spawn trong syncComposioToCoordinator)
  → Coordinator.setComposioUserId → ComposioSessionManager.setUserId()
  → đổi id thật thì invalidate() session + MCP client cũ ngay
  → lần gọi tool sau: router.createSession({ userId: <id mới> })
```

RPC/IPC chỉ trả **boolean** (`{ userIdConfigured, usingDefaultUserId }`
/ `ComposioStateView.userIdConfigured`) — không chứa giá trị id.
Validate lúc lưu: rỗng/chỉ khoảng trắng → lỗi rõ; quá 200 ký tự
hoặc chứa khoảng trắng/ký tự điều khiển → lỗi rõ; mọi định dạng
Composio cấp (`pg-test-…`, `default`, UUID…) đều được chấp nhận —
không validate quá chặt rồi loại id thật (xem
`validateComposioUserId` trong `keyStore.ts`).

### 17.6. Grep toàn repo — không còn đường vòng

`ComposioSessionManager` chỉ được tạo ở **một site duy nhất**:
`packages/core/src/coordinator/coordinator.ts` (constructor).
Mọi đường tạo session đều đi qua manager đó (model gọi meta-tool,
automations trigger Composio cũng gọi tool qua coordinator) nên
không còn site nào dùng `'local-user'` hardcode ngoài hằng số
mặc định khi chưa cấu hình. `COMPOSIO_LOCAL_USER_ID` giữ lại làm
giá trị mặc định đó.

### 17.7. Test (mock, không key/tài khoản thật)

File `tests/composio-userid-v088b.test.mjs` — 8 test: (a) mặc định
`'local-user'` khi chưa cấu hình; (b) id đã cấu hình được truyền
tới lúc tạo session (mock REST ghi lại `user_id`); (c) đổi id làm
drop session cũ (client cũ bị close, lần gọi sau tạo session mới
đúng id; đặt lại cùng id thì không tạo thừa; xoá → về mặc định);
(d) validate (rỗng/khoảng trắng/ký tự lạ lỗi rõ, `pg-test-…`
được chấp nhận) + Vault round-trip + RPC `composio.setUserId` /
`composio.getUserIdStatus` (status chỉ boolean, không chứa id) +
param `composioUserId` của `createBot` (kể cả re-attach đổi id) +
`opts.composio.userId` lúc tạo coordinator. **8/8 pass.**
Hồi quy: `composio-v057/v058`, `composio-seed-v059`,
`composio-ipc-v057`, `composio-toolkits-a`,
`composio-live-harness-v059`, `composio-triggers-v083`,
`composio-trigger-http-v083`, `automations-composio-v083-renderer`,
`i18n`, `connected-apps-v067b` (+ renderer) — nhóm này tổng 107
test: **102 pass, 0 fail, 5 skipped** (skip có sẵn từ trước,
chưa full suite).

### 17.8. Probe live READ-ONLY (v0.88b) — ĐÃ CHẠY, 2026-11-11

`scripts/composio-live-v072/probe-userid-v088b.mjs` (chỉ đọc, không
ghi file, chỉ in trạng thái từng toolkit — không in user id/key):
- Session với user id đã cấu hình: `COMPOSIO_MANAGE_CONNECTIONS`
  trả "All connections are active" — **github/gmail/slack: 3/3 Active**.
- Đối chứng session `'local-user'`: "All connections have been
  initiated and are pending completion" — **0/3 Active**
  (cả 3 status `initiated`, kèm link OAuth mới).
Kết luận: đúng user id là điều kiện cần để session thấy connection;
mặc định `'local-user'` không thấy gì. Lưu ý: lần chạy đối chứng
đã khởi tạo (initiate) 3 luồng OAuth pending cho user id
`'local-user'` — giống probe trước đây với `'local-user-1'`, link
hết hạn sau 10 phút, không hoàn tất, không link tài khoản nào,
không ghi gì lên GitHub/Gmail/Slack và không động vào 3 connection
thật (vẫn Active, không revoke).

### 17.9. Giới hạn còn lại — nói thẳng

- **Một user id cho cả app** (single-user desktop): session dùng
  chung cho mọi bot. Multi-user (fleet) mỗi workspace có Vault
  riêng nên mỗi workspace cấu hình id riêng được, nhưng chưa có
  user id theo từng bot — bot nào cũng thấy cùng connection.
- **Không tự phát hiện user id**: app không gọi API Composio để
  đoán id từ API key (không có endpoint tin cậy cho việc đó) —
  user phải dán tay một lần từ dashboard.
- **Session cũ đang chạy dở thì sao**: đổi id chỉ huỷ session
  cache; một tool call đang thực thi lúc đổi id vẫn chạy nốt với
  session cũ (không abort giữa chừng — tránh thực thi trùng).
- **Popup/kết nối mới**: user id đúng chỉ giúp thấy connection
  *đã connect sẵn*; kết nối app mới vẫn qua Connect Link ở trình
  duyệt hệ thống như trước.

## 18. Trạng thái connection từng toolkit + kiểm tra Active trước khi thực thi (v0.89c, Team E)

v0.88b sửa được user id, nhưng app vẫn mù về trạng thái thật của
từng connection: tool chạy với toolkit chưa Active thì server trả
"No active connection found" khó hiểu, và Settings không cho thấy
app nào đã kết nối thật. Sóng này thêm hai thứ.

### 18.1. Xem trạng thái trong Settings → Connected apps → Composio

- Nút **"Kiểm tra trạng thái kết nối"** (chỉ hiện khi Composio bật
  và đã có key). Bấm → app gọi `COMPOSIO_MANAGE_CONNECTIONS` cho
  các toolkit đang bật và hiện badge từng app: **Đã kết nối** (+
  nhãn tài khoản, vd login GitHub / email Gmail / tên team Slack),
  **Đã bắt đầu kết nối (chưa hoàn tất)**, **Chưa kết nối**.
- **Không tự kiểm tra lúc mở Settings** — cố ý: gọi
  `COMPOSIO_MANAGE_CONNECTIONS` cho toolkit chưa có connection sẽ
  khởi tạo một luồng kết nối pending (link hết hạn sau 10 phút,
  không link gì cho tới khi user hoàn tất trong trình duyệt). Chỉ
  kiểm tra khi user bấm.
- Đổi/xoá user id → trạng thái đã kiểm tra bị reset (không còn
  đúng với tài khoản mới) — bấm kiểm tra lại.
- IPC: `composio:get-connection-status` (main) → RPC
  `composio.getConnectionStatus` (coordinator) → session manager.
  Kết quả chỉ chứa toolkit + trạng thái + nhãn tài khoản — không
  user id, không redirect_url, không key.

### 18.2. Kiểm tra Active trước lần thực thi đầu tiên (session manager)

Trước lần thực thi đầu tiên của mỗi session, `executeTools()` suy
toolkit cần từ prefix slug (`GITHUB_` → `github`, …) và kiểm tra
Active qua `COMPOSIO_MANAGE_CONNECTIONS`:

- Toolkit nào chưa Active → tool **không thực thi**, ném
  `ComposioError` code `composio_connection_inactive`, message nêu
  tên toolkit + hướng dẫn: connect trong dashboard Composio →
  Auth Configs → Connect Account, rồi kiểm tra Composio user id
  trong Settings → Composio có khớp User ID trên dashboard không.
- Chỉ kiểm tra **một lần mỗi session** (cache theo user id +
  toolkit đang bật); đổi user id/key/toolkit → kiểm tra lại.
- Kiểm tra lỗi vì mạng → **fail-open**: thực thi vẫn chạy (không
  chặn user vì một lần gọi trạng thái lỗi), lần sau kiểm tra lại.
- Slug không thuộc toolkit Composio nào → bỏ qua kiểm tra.

### 18.3. Test (mock, không key/tài khoản thật)

`tests/composio-connection-status-v089.test.mjs` 10/10: parse
active/initiated/none + accountLabel, không lộ redirect_url, JSON
stringify 2 lần, lỗi MCP → session_failed; pre-check (inactive →
lỗi rõ + không thực thi, Active → chạy, cache 1 lần, đổi user id
→ kiểm tra lại, lỗi mạng → fail-open, slug lạ → bỏ qua); RPC
coordinator (shape đúng, không chứa user id/key, toolkit lạ →
lỗi); i18n 10 key × 6 locale.

### 18.4. Giới hạn còn lại — nói thẳng

- Trạng thái chỉ đúng tại lúc bấm kiểm tra — user connect/xoá
  connection trong dashboard sau đó thì app không tự biết cho tới
  lần kiểm tra sau (hoặc lần thực thi đầu tiên của session mới).
- Một user id cho cả app (kế thừa §17.9) — trạng thái cũng theo
  user id đó.
- Kiểm tra trạng thái cho toolkit chưa có connection sẽ mở luồng
  pending trong dashboard Composio (link hết hạn 10 phút) — vô
  hại nhưng user có thể thấy một bản ghi Initiated dư (như bản
  ghi Slack Initiated dở dang đã có từ trước).
- Chưa có lần test ghi nào chạy qua app: test ghi live 7/7 ngày
  2026-11-11 (commit `da495fb`) chạy qua session trực tiếp trong
  script `run-live.py`, không qua app — và test ghi live v0.98 chạy
  lại ngày 2026-11-13 cũng qua script (7/7, xem §19.5). Probe đọc
  v0.88b/v0.89c chứng minh session của app (với user id đã cấu hình)
  thấy 3/3 Active — nhưng đường ghi qua app vẫn chưa được chạy live
  lần nào.

## 19. Scheduler nền cho Composio polling — mail mới tự chạy automation (v0.98, Team T3)

**Ngày:** 2026-11-13. **Trạng thái:** ĐÃ LÀM + LIVE-VERIFY XONG.

### 19.1. Vấn đề — 3 mảnh v0.96 chưa nối thành vòng chạy

v0.96 (Team T4) đã có 3 mảnh rời: `ComposioPoller` (hỏi tool
list/search định kỳ, dedupe trong bộ nhớ), `createComposioPollToQueueBridge`
(item mới → synthetic event vào queue), `ComposioTriggerQueue`
(đệm + dedupe + long-poll) — nhưng không có ai chạy poller định
kỳ, không ai drain queue để automation chạy, và trạng thái poll
(id đã thấy, số lỗi liên tiếp) mất hết khi restart app (lần poll
đầu sau restart sẽ coi mọi mail 15 phút gần nhất là "mới" và chạy
automation trùng). v0.98 nối 3 mảnh đó thành một vòng chạy tự động:

```
ComposioPoller (polling.ts — GMAIL_FETCH_EMAILS 15 phút/lần)
  → enqueueComposioPollResult (pollBridge.ts — item mới thành event
     poll:GMAIL_NEW_GMAIL_MESSAGE:<messageId>)
  → ComposioTriggerQueue (triggerQueue.ts — đệm + dedupe)
  → onEventsEnqueued → AutomationScheduler.drainComposioTriggerQueue()
     (automations/scheduler.ts — automation `composio` khớp
      triggerSlug tự chạy, không cần poll tay hay long-poll)
```

### 19.2. Trạng thái poll bền vững — `composio/pollState.ts`

File `<stateDir>/composio-poll-state.json` (cùng thư mục với
`automations.json` của scheduler, cùng quy ước ghi atomic tmp+rename
và file hỏng thì giữ `<file>.corrupt` rồi bắt đầu trống). Mỗi poller
giữ: `enabled`, `intervalMs`, `lastPolledAtMs`, `lastSuccessAtMs`,
`lastError`, `consecutiveFailures`, `nextPollAtMs`, `totalPolls`,
`totalNewItems`, `seenIds` (id + thời điểm, tối đa 1000, cắt cũ
nhất). File chỉ chứa metadata vận hành — KHÔNG BAO GIỜ chứa key,
token hay nội dung mail/item (id mail là opaque identifier của
Composio, không phải secret). `ComposioPoller.restoreSeen()` /
`seenSnapshot()` (thêm ở v0.98) nạp lại dedupe lúc scheduler khởi
động — restart không tạo event trùng. Test chứng minh: scheduler
mới cùng store, poll lại cùng item → 0 mới.

### 19.3. Backoff + cấu hình khoảng poll — `composio/pollScheduler.ts`

`ComposioPollScheduler` chạy mỗi poller bằng chuỗi `setTimeout`
(không phải `setInterval` cố định) để delay lần sau tính lại sau
mỗi lần poll: thành công → `intervalMs`; lỗi → backoff cấp số nhân
`interval × 2^(failures-1)`, trần 2 giờ (`composioPollBackoffDelayMs`,
lỗi đầu = đúng interval, lỗi thứ 2 ×2, thứ 3 ×4…). `nextPollAtMs`
đã tính backoff được persist — restart tôn trọng backoff, không
reset về 0. Lỗi không crash timer, không xoá dedupe. Khoảng poll
cấu hình được từng poller (`setPollerInterval`, clamp [1 phút,
24 giờ] — ngắn hơn sẽ đốt quota Composio), bật/tắt từng poller
(`setPollerEnabled`, persist ngay), poll tay (`pollNow` — chạy cả
khi poller tắt, vì đó là hành động chủ động của user). `getStatus()`
cho UI/IPC: lần poll cuối/thành công cuối/kế tiếp, lỗi cuối, bộ
đếm, số id đang nhớ, số event chờ trong queue.

### 19.4. Xử lý queue trong AutomationScheduler + wiring main process

- `AutomationScheduler.dispatchComposioQueueEvent(event)`: chạy
  automation `composio` đang bật và khớp `triggerSlug` (cùng
  cooldown event + guard in-flight như `notifyEvent`, không chạy
  khi chat đang active). Event trong queue KHÔNG cần auth lại:
  queue là ranh giới tin cậy — chỉ event đã verify (webhook có chữ
  ký/token hợp lệ ở `handleComposioTrigger`, hoặc poller local đọc
  từ chính tài khoản đã kết nối của user) mới vào queue.
- `drainComposioTriggerQueue(filter?)`: drain queue rồi dispatch
  từng event; chat đang active thì KHÔNG drain (event ở lại queue
  để lần sau chạy — drain rồi bỏ sẽ mất event); không có queue cấu
  hình → `[]`. Input shaping Slack dùng chung qua helper
  `composioEventToInput` (tách từ `handleComposioTrigger`, hành vi
  không đổi).
- Main process (`apps/desktop/src/main/main.ts`): `ComposioPollScheduler`
  riêng cho poller Gmail (manager session riêng — chỉ poll, không
  chạy tool bot; key/user id đọc từ Vault trong main, user id đổi
  → session poll cũ huỷ qua `setUserId`); `refreshComposioPolling()`
  chạy/dừng theo trạng thái (source bật + có key + gmail bật),
  gọi sau `initComposio` lúc khởi động và sau mỗi lần toggle/key/
  user-id đổi; `onEventsEnqueued` nối thẳng vào
  `drainComposioTriggerQueue()`.
- IPC (`composio:get-poll-status` / `composio:set-poll-config` /
  `composio:poll-now`) + preload + `ComposioPollingSection.tsx`
  trong Connected apps (trạng thái từng poller, đổi khoảng poll,
  poll ngay, bật/tắt) + i18n `settings.composioPoll.*` 26 key ×
  6 locale. Trạng thái IPC chỉ chứa metadata vận hành.

### 19.5. Live-verify v0.98 — ĐÃ CHẠY, 2026-11-13

Script `scripts/composio-live-v098/probe-v098.mjs` (chỉ đọc + poll,
chạy qua driver `run-live.py`, báo cáo `report.json` cùng thư mục)
và test ghi chạy lại bằng `scripts/composio-live-v072/live.mjs`
với env đã duyệt (báo cáo `scripts/composio-live-v098/report-write.json`):

- **18 toolkit mới v0.96 đối chiếu live:** `list-tools` từng
  toolkit (limit 1000) — tổng **3.767 tool** (stripe 435, shopify
  478, box 286, confluence 70, gitlab 317, calendly 57, mailchimp
  278, twilio 454, googledocs 48, youtube 69, linkedin 29, reddit
  50, whatsapp 127, pagerduty 368, typeform 35, sendgrid 364,
  bitbucket 118, freshdesk 184); **180/180 slug curated trong
  catalog tồn tại live** (script `verify-new-toolkits.mjs`,
  `toolkits-verify-2026-11-13.json`).
- **3 connection Active** với user id đã cấu hình
  (`pg-test-0d236b17-eece-4031-aae3-e8dbc3d70910`): GitHub
  `openbot1`, Gmail `hoangthuanreview20@gmail.com`, Slack `open-bot`.
- **Schema toolkit mới:** `GET_TOOL_SCHEMAS` thật cho
  `STRIPE_CREATE_CUSTOMER` (không có field required),
  `GITLAB_ADD_PROJECT_MEMBER` (required `id`, `access_level`),
  `YOUTUBE_CREATE_CHANNEL_SECTION` (required `snippet`); `SEARCH_TOOLS`
  "create a Stripe customer" trả 4 slug `STRIPE_*` gồm
  `STRIPE_CREATE_CUSTOMER` — **với điều kiện toolkit stripe phải bật
  trong session** (search của Tool Router chỉ thấy toolkit đang bật:
  session chỉ github/gmail/slack → 0 slug `STRIPE_*`).
- **Poll Gmail thật** qua `ComposioPoller` + `ComposioSessionManager`
  (`GMAIL_FETCH_EMAILS`, query `newer_than:15m`): lần 1 fetched 10,
  mới 10, enqueue 10 vào queue; lần 2 mới 0 (dedupe đúng), queue
  còn 10 chờ drain. Báo cáo chỉ ghi số lượng + tên field item
  (không ghi tiêu đề/nội dung mail).
- **Test ghi thật 7/7** (đích đã duyệt §8.1, Huy giữ 3 connection
  — KHÔNG revoke): issue **#4** trên `openbot1/open-bot`
  (`[open-bot live test] v0.98 Composio verify — poll scheduler`,
  đã đóng ngay); mail tới `hoangthuanreview20@gmail.com`
  (id `1a1d57c78f262b14`, đã trash); tin Slack kênh `social`
  (`C0CGHN8L5R9`, ts `1794583066.476869`, đã xoá). Dọn dẹp bước 7:
  3/3 pass. 1-hop SEARCH_TOOLS median 2813.8ms (3 lần:
  1878.8/2813.8/3525.2ms — chậm hơn median 683ms của v0.72, dao
  động theo mạng); offline lỗi sạch `composio_session_failed`,
  tool local vẫn chạy.

### 19.6. Hai phát hiện thật khi live-verify (đã sửa trong v0.98)

1. **Gmail trả `messageId`, KHÔNG trả `id`.** Ghi chú v0.96 đoán
   mail có field `id` — sai. Shape thật: `GMAIL_FETCH_EMAILS` trả
   `{ messages: [...], nextPageToken, resultSizeEstimate }`, mỗi
   message có `messageId` (+ `subject`, `sender`, `preview`,
   `messageText`, `messageTimestamp`, `threadId`, `to`,
   `labelIds`, `display_url`, `attachmentList`). Dedupe trước v0.98
   vẫn chạy nhờ fallback `'messageId'` trong `composioPollItemId`,
   nhưng preset Gmail đã sửa `idField` thành `'messageId'`
   (`polling.ts` + `pollScheduler.ts`) để không lệ thuộc fallback.
2. **`response.data_preview` — kết quả quá lớn bị cắt ngắn.**
   `ComposioSessionManager.executeTools` trả text JSON
   `{ successful, data: { results: [{ response: {...}, tool_slug,
   index }], total_count, ... }, error, log_id }`. Khi kết quả nhỏ,
   `response.data` đầy đủ; khi quá lớn (đo thật: `max_results` 15 →
   `data` đủ 15 mail, 28.704 byte; `max_results` 25 → `data_preview`
   chỉ 3 mail đầu), server trả `data_preview` cắt ngắn thay vì
   `data`. Parser mới `parseComposioPollItems` (core, dùng chung
   main + probe + test) bóc đúng cả hai shape (`results` trong
   `data` lẫn top-level) và chấp nhận `data_preview` làm fallback —
   nhưng preset Gmail hạ `max_results` từ 25 xuống **10** để thường
   xuyên nhận đủ `data` (hộp thư >10 mail mới/15 phút thì số còn
   lại vào poll sau, vẫn trong cửa sổ 15m). Đây là bẫy thật: parser
   cũ (chỉ đọc `results` top-level) đã trả 0 item dù mailbox có
   mail — probe lần đầu bắt được nhờ assert "lần 1 phải có item
   mới".

### 19.7. Test (mock, không key/tài khoản thật)

`tests/composio-poll-scheduler-v098.test.mjs` **26/26 pass**:
pollState (resolve fail-closed, store file round-trip + mở lại +
file hỏng, memory store, cắt seenIds), backoff (cấp số nhân + trần,
clamp interval), preset Gmail (`messageId`), parser
(`parseComposioPollItems` cả 2 shape wire + `data_preview` +
Slack `messages.matches` + không khớp → `[]`), poll tay (enqueue +
persist state, dedupe trong bộ nhớ + sống qua restart, lỗi → backoff
tăng / thành công → reset, bật/tắt + đổi interval persist, timer nền
tôn trọng `nextPollAtMs` đã persist), preset GitHub + Slack
(đúng slug/schema, throw khi thiếu repo/query, dedupe `id` số và
`ts` qua restart), drain queue (chạy automation khớp slug, không ai
nghe → rơi queue không lỗi, không queue → `[]`, chat active → giữ
event, cooldown chặn chạy trùng), vòng đầy đủ (poller → queue →
drain → automation chạy, không cần poll tay).
Test liên quan: `composio-channels-v096` + `automations` 56/56
cùng file mới (tổng 56 test, 0 fail).

### 19.8. Giới hạn còn lại — nói thẳng

- Chỉ có poller Gmail (`gmail-new-mail`) được nối vào main process —
  preset GitHub + Slack đã có sẵn ở core (§19.9) nhưng chưa nối,
  vì main chưa biết repo cần theo dõi / query tìm kiếm nào.
- `max_results: 10` là cân bằng thực nghiệm, không phải đảm bảo:
  mail có body rất lớn vẫn có thể khiến server trả `data_preview`
  (chỉ vài mail đầu) — parser chấp nhận preview, nhưng mail ngoài
  preview có thể bị bỏ lỡ trong cửa sổ 15m đó.
- Trạng thái poll lưu trên đĩa máy này — đổi máy thì dedupe bắt
  đầu lại (lần poll đầu có thể chạy automation trùng cho mail 15
  phút gần nhất).
- Scheduler nền chạy trong main process với session riêng — tốn
  thêm 1 Tool Router session so với coordinator (không đáng kể,
  chỉ poll 15 phút/lần).
- Đường ghi qua app (bot gọi meta-tool với key trong Vault) vẫn
  chưa được chạy live lần nào — test ghi v0.98 vẫn qua script
  trực tiếp như các lần trước.

### 19.9. Preset poller GitHub + Slack — shape thật đã live-verify (v0.98, Team T3)

Scheduler hỗ trợ nhiều entry; ngoài Gmail đã nối vào main, core có
thêm 2 preset đã xác minh shape thật qua MULTI_EXECUTE live
(`scripts/composio-live-v098/poll-shapes-2026-11-13.json` — chỉ ghi
keys + số lượng, không ghi nội dung issue/tin nhắn):

| Preset | Tool | Shape thật (live) | `idField` | Trigger slug |
|---|---|---|---|---|
| `createGithubComposioPollEntry` | `GITHUB_SEARCH_ISSUES` | `{ items: [...], total_count, ... }`; mỗi issue có `id` số nguyên (repo `openbot1/open-bot` trả 4 issue) | `id` (số → string khi dedupe) | `GITHUB_ISSUE_CREATED_TRIGGER` (delivery 'poll') |
| `createSlackComposioPollEntry` | `SLACK_SEARCH_MESSAGES` | `{ messages: { matches: [...], paging, total }, ok, query }` — parser bóc `messages.matches` (mới thêm) | `ts` | `SLACK_CHANNEL_MESSAGE_RECEIVED` |

Ba lưu ý thật:

- **GitHub bắt buộc field `q`, không phải `query`.** Lần gọi đầu
  dùng `query` đã bị server từ chối 400 (`Following fields are
  missing: {'q'}`). Schema: required `["q"]`, props
  `q, page, sort, order, per_page`.
- **Slack search là tìm theo nội dung, không có API "liệt kê tin
  mới nhất".** Preset bắt buộc `query` (vd `in:#social` để theo dõi
  một kênh, hoặc một từ khoá); query rỗng → throw, không đoán thay
  user. GitHub cũng bắt buộc `repo` dạng `owner/repo` — không có
  default, vì poller phải biết rõ repo nào cần theo dõi.
- **Slack chưa quan sát được match thật.** Workspace "open-bot"
  không có tin nào khớp tìm kiếm (`query: 'test'` và `'bot'` đều
  0 match), nên `idField: 'ts'` theo shape chuẩn của Slack search
  (mỗi match có `ts` là id tin nhắn), chưa chứng minh trực tiếp
  bằng match thật — khi workspace có tin, poll lần đầu sẽ chứng
  minh. Preset GitHub thì đã chứng minh đầy đủ (4 issue thật, dedupe
  bằng `id` số qua restart).

Test: 5 test mới trong `tests/composio-poll-scheduler-v098.test.mjs`
(preset GitHub/Slack đúng slug/schema + throw khi thiếu repo/query,
parser bóc `messages.matches`, dedupe `id` số và `ts` qua restart,
queue event đúng `eventId: poll:<slug>:<id>`).
