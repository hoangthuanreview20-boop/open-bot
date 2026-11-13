# Composio + Channels — v0.96 Team T4

Sóng v0.96, đội T4 (Composio + Channels). Base: main `dd31507` (v0.95 + sửa CI).
Branch: `parallel/v096-composio`. Không push GitHub (coordinator đẩy sau).

## 1. Composio: 22 → 40 toolkit

18 toolkit mới, mỗi toolkit 10 slug đã **xác nhận live** bằng
`GET /api/v3.1/tools?toolkit_slug=<slug>&limit=200` ngày 2026-11-13
(qua helper `~/workspace/custom-connectors/custom.composio/bin/composio.py`;
API trả theo thứ tự ABC nên 10 slug/toolkit được chọn tay từ mẫu đó —
đọc + ghi + tìm kiếm). Bằng chứng: 2.386 slug mẫu lưu tại
`scripts/composio-toolkits-live-v096/toolkits-live-2026-11-13.json`;
test `tests/composio-channels-v096.test.mjs` đối chiếu từng slug mới
với file evidence này (fail nếu slug không có trong kết quả live).

| Toolkit | 10 slug (đọc / ghi) |
|---|---|
| stripe | GET_ACCOUNT, GET_BALANCE_TRANSACTION, CREATE_CUSTOMER, CREATE_PAYMENT_INTENT, CREATE_INVOICE, CREATE_REFUND, CREATE_PRODUCT, CREATE_PRICE, CREATE_CHARGE, CREATE_CUSTOMER_SUBSCRIPTION |
| shopify | GET_CUSTOMER, GET_CUSTOMERS_SEARCH, GET_CUSTOMER_ORDERS, GET_COLLECTION_BY_ID, GET_CUSTOMERS_COUNT, CREATE_PRODUCT, CREATE_ORDER, CREATE_CUSTOMER, CREATE_DRAFT_ORDER, CREATE_PRODUCT_VARIANT |
| box | DOWNLOAD_FILE, GET_FILE_INFORMATION, GET_FILE_THUMBNAIL, GET_FILE_VERSION, FIND_FILE_FOR_SHARED_LINK, LIST_ALL_COLLECTIONS, CREATE_FOLDER, COPY_FILE, ADD_SHARED_LINK_TO_FILE, CREATE_COMMENT |
| confluence | CQL_SEARCH, GET_PAGE_BY_ID, GET_SPACE_BY_ID, GET_SPACE_CONTENTS, GET_ATTACHMENTS, GET_PAGE_ANCESTORS, CREATE_PAGE, CREATE_BLOGPOST, CREATE_SPACE, DELETE_PAGE |
| gitlab | GET_PROJECT, GET_ISSUE, GET_CURRENT_USER, GET_COMMIT_DIFF, LIST_ALL_PROJECT_MEMBERS, LIST_ISSUES, CREATE_MERGE_REQUEST, CREATE_ISSUE_NOTE, CREATE_PIPELINE, CREATE_GROUP |
| calendly | LIST_EVENTS, LIST_EVENT_INVITEES, GET_EVENT, GET_USER, GET_EVENT_TYPE, GET_EVENT_TYPE_AVAILABILITY, CREATE_EVENT_TYPE, CREATE_SCHEDULING_LINK, CANCEL_SCHEDULED_EVENT, CREATE_EVENT_INVITEE |
| mailchimp | GET_AUDIENCES_CONTACTS, GET_CAMPAIGN_CONTENT, GET_AUTOMATION_INFO, GET_ABUSE_REPORT, ADD_LIST_MEMBER, ADD_CAMPAIGN, ADD_LIST, ADD_MEMBER_TO_SEGMENT, DELETE_CAMPAIGN, DELETE_LIST_MEMBER |
| twilio | CREATE_MESSAGE, CREATE_CALL, FETCH_BALANCE, FETCH_CALL, FETCH_ACCOUNT, FETCH_ADDRESS, FETCH_MESSAGE, CONVERSATIONS_CREATE_CONVERSATION_MESSAGE, CONVERSATIONS_FETCH_CONVERSATION, CREATE_INCOMING_PHONE_NUMBER |
| googledocs | GET_DOCUMENT_BY_ID, GET_DOCUMENT_PLAINTEXT, SEARCH_DOCUMENTS, GET_DOCS_DRIVE_FILE_METADATA, LIST_DRIVE_ITEM_PERMISSIONS, CREATE_DOCUMENT, CREATE_DOCUMENT_MARKDOWN, CREATE_AND_POPULATE_TABLE, COPY_DOCUMENT, CREATE_HEADER |
| youtube | SEARCH_YOU_TUBE, GET_VIDEO_DETAILS_BATCH, GET_CHANNEL_STATISTICS, GET_CHANNEL_ID_BY_HANDLE, LIST_CHANNEL_VIDEOS, LIST_COMMENTS, GET_PLAYLISTS_BY_ID, CREATE_PLAYLIST, ADD_VIDEO_TO_PLAYLIST, CREATE_COMMENT_REPLY |
| linkedin | GET_MY_INFO, GET_COMPANY_INFO, GET_NETWORK_SIZE, GET_PERSON, GET_ORG_PAGE_STATS, SEARCH_AD_TARGETING_ENTITIES, CREATE_LINKED_IN_POST, CREATE_COMMENT_ON_POST, CREATE_ARTICLE_OR_URL_SHARE, DELETE_LINKED_IN_POST |
| reddit | GET_NEW, GET_R_TOP, GET_SUBREDDITS_SEARCH, GET_REDDIT_USER_ABOUT, GET_SUBREDDIT_RULES, GET_INBOX_MESSAGE, LIST_INBOX_MESSAGES, CREATE_REDDIT_POST, EDIT_REDDIT_COMMENT_OR_POST, DELETE_REDDIT_POST |
| whatsapp | SEND_MESSAGE, SEND_MEDIA, SEND_LOCATION, SEND_CONTACTS, SEND_INTERACTIVE_BUTTONS, GET_MESSAGE_HISTORY, GET_MESSAGE_TEMPLATES, GET_MEDIA_INFO, CREATE_MESSAGE_TEMPLATE, GET_BUSINESS_ACCOUNT_DETAILS |
| pagerduty | FETCH_INCIDENT_LIST, FETCH_ESCALATION_POLICES_LIST, FETCH_INCIDENT_ANALYTICS_BY_ID, GET_ALERTS_BY_INCIDENT_ID, GET_ADDONS_LIST, CREATE_INCIDENT_RECORD, CREATE_USER_OBJECT, CREATE_ESCALATION_POLICY, CREATE_INCIDENT_WORKFLOW, CREATE_SERVICE_EVENT_RULE |
| typeform | GET_FORM, GET_FORM_RESPONSES, GET_WORKSPACE, GET_THEME, GET_ABOUT_ME, CREATE_FORM, CREATE_WORKSPACE, CREATE_THEME, DELETE_FORM, DELETE_RESPONSES |
| sendgrid | GET_A_LIST_OF_ALL_SENDERS, GET_ALL_CATEGORIES, GET_A_CONTACT_BY_ID, GET_ALL_AUTOMATION_STATS, GET_A_LIST_OF_ALL_IP_ADDRESSES_ON_YOUR_ACCOUNT, CREATE_A_LIST, CREATE_A_CAMPAIGN, ADD_OR_UPDATE_A_CONTACT, ADD_A_SINGLE_RECIPIENT_TO_A_LIST, CREATE_A_NEW_TRANSACTIONAL_TEMPLATE_VERSION |
| bitbucket | GET_BRANCH, GET_FILE_FROM_REPOSITORY, LIST_BRANCHES, LIST_COMMITS, LIST_ISSUES, CREATE_PULL_REQUEST, CREATE_ISSUE, CREATE_REPOSITORY, CREATE_BRANCH, APPROVE_PULL_REQUEST |
| freshdesk | GET_TICKETS, GET_AGENT, GET_AGENTS, GET_COMPANY, LIST_ALL_TICKET_CONVERSATIONS, LIST_ADMIN_GROUPS, CREATE_TICKET, CREATE_CONTACT, CREATE_AGENTS, ADD_NOTE_TO_TICKET |

Tổng catalog: **400 tool** (40 toolkit × 10). Approval theo động từ
ghi vẫn áp dụng (`composioToolNeedsApproval`).

**Hai slug sửa trong lúc test** (tưởng có nhưng live không trả):
`GITLAB_LIST_COMMITS` → `GITLAB_LIST_ISSUES`,
`TWILIO_CREATE_CONVERSATION` → `TWILIO_FETCH_MESSAGE` (Twilio trả
tới 500 tool, slug cũ không có trong đó).

**Teams KHÔNG thêm được**: slug `microsoftteams` và `teams` đều trả
0 tool (HTTP 200) — Composio không có toolkit Teams dưới 2 tên này.
Không bịa slug Teams.

Wire shape không đổi (đã xác nhận live v0.72, test mock lại trong
file test mới): session policy object `{toolkits: {enable: [...]}}`,
`COMPOSIO_GET_TOOL_SCHEMAS` nhận `{tool_slugs: [...]}`, 
`COMPOSIO_MULTI_EXECUTE_TOOL` nhận `tools: [{tool_slug, arguments, account?}]`,
tối đa 50 tool/call.

## 2. Triggers mở rộng

`packages/core/src/composio/triggerQueue.ts` — `ComposioTriggerQueue`
(in-memory, không ghi đĩa):
- `enqueue(event)`: dedupe theo `eventId` (Composio retry cùng `msg_…`
  chỉ vào 1 lần); queue đầy (mặc định 500) thì drop event cũ nhất
  (FIFO); TTL mặc định 10 phút, `purgeExpired()` loại event hết hạn.
- `waitForEvents(filter, timeoutMs)`: long-poll, cap timeout 60s —
  có event khớp filter thì trả ngay, hết timeout trả `[]`; waiter
  được đánh thức đúng lúc `enqueue` (không busy-loop).
- `drain(filter)` / `peek(filter)` / `stats()` (enqueued/deduped/
  droppedFull/expired/pending/waiters).
- HMAC-SHA256 verify vẫn ở `triggers.ts` (v0.83) — queue chỉ nhận
  event **đã parse + verify**.

`packages/core/src/composio/polling.ts` — `ComposioPoller` (polling
cho app chỉ có trigger dạng poll: Gmail, Drive, Zoom, Salesforce…):
- Host tiêm `fetchItems` (nối `ComposioToolRouter.executeTool` thật);
  module này **không cần key, không tạo connection mới** — dùng
  session + connected account đã có.
- Preset Gmail: `GMAIL_FETCH_EMAILS`, query `newer_than:15m`, poll
  15 phút/lần, dedupe theo id mail trong 24h, tối đa 25 mail mới/lần.
- Dedupe theo `idField` (fallback `id`/`messageId`/`ts`/`uuid`);
  item không có id vẫn báo mới (bỏ sót tệ hơn trùng).
- Lỗi fetch (mất mạng, session hết hạn) → result có `error`, trạng
  thái dedupe giữ nguyên, timer không dừng. Timer `unref`.

Trigger instance vẫn do user tạo trong Composio (dashboard/SDK/CLI),
không phải app — như cũ.

## 3. Channels

`packages/core/src/channels/` (ý tưởng học OpenMausBot, tự thiết kế):
- `Channel { id, name, kind: work|personal|project, transcript,
  sharedInstructions, workingFolder, responderRules, botRoster }`.
- `ChannelStore`: file JSON `channels.json` (ghi atomic qua file tạm
  + rename, hỏng → về rỗng fail-closed, cùng kiểu GroupChatStore).
  CRUD, thêm/bớt bot khỏi roster, **chuyển bot giữa 2 channel**,
  transcript tối đa 500 tin/channel, round-robin state bền vững.
- Responder rules (`resolveChannelResponders`): 5 mode —
  `mentioned` (mặc định, chỉ bot @mention), `all`, `round-robin`
  (xoay vòng theo `lastResponderId`), `first`, `none` — cộng
  `onlyBotIds` (giới hạn bot được trả lời) và `requireMentionFor`
  (bot chỉ trả lời khi bị @mention, kể cả mode all/round-robin/first).
- `buildChannelSystemPrompt`: tên/loại channel + shared instructions
  + working folder (+ nhắc nhiều-bot đừng làm trùng việc).
- `coordinatorAdapter.ts` — `routeChannelMessage(store, channelId,
  {text, bots}, runBot)`: ghi tin user vào transcript → resolve
  responder → chạy từng bot **tuần tự** (bot sau thấy câu trả lời
  bot trước) → ghi trả lời + cập nhật round-robin. Adapter không
  import coordinator (host tiêm `runBot` — chính là `run()` silent
  mà group chat dùng cho delegation). **Một hop duy nhất**: câu trả
  lời bot không parse @mention tiếp (chống vòng lặp bot-bot, như M8).
  Bot lỗi → ghi tin `[lỗi] …` vào transcript, không đổ channel.
- UI `apps/desktop/src/renderer/components/ChannelsView.tsx`:
  tạo/sửa/xoá channel, xem roster, sửa shared instructions +
  working folder + responder mode, **chuyển bot giữa 2 channel**,
  gửi tin nhắn thật (chạy responder rules trong coordinator).
  Nối vào App (`view='channels'`) + Sidebar (`📡 Channels`).
- IPC `channel:*` (main → coordinator RPC → `ChannelStore`):
  `channel:create/list/update/delete/add-bot/remove-bot/move-bot/
  post-message/list-messages` — 9 handler trong
  `apps/desktop/src/main/main.ts`, bridge trong `preload.ts`,
  type trong `global.d.ts` + `renderer/types.ts`
  (`ChannelView`/`ChannelMessageView`). Coordinator methods
  (`packages/core/src/coordinator/coordinator.ts` +
  `types.ts` + `client.ts`): `createChannel/listChannels/
  updateChannel/deleteChannel/addBotToChannel/removeBotFromChannel/
  moveBotBetweenChannels/postChannelMessage/listChannelMessages`.
  `postChannelMessage` nối `routeChannelMessage` với `run()` silent:
  shared instructions gộp vào đầu prompt, working folder làm `cwd`
  của run — test coordinator chứng minh instructions tới được prompt
  của model (mockRecordPath).

## 4. Kiểm chứng

- `npm run build` + `npm run typecheck` xanh 4 workspace (xem báo cáo).
- `node --test tests/composio-channels-v096.test.mjs`: **19/19 pass**
  (toolkit 40/400 + đối chiếu evidence live; wire shape mock; queue;
  poll → queue bridge; shared-queue singleton;
  polling Gmail; channels CRUD/roster/move/responder 5 mode/transcript
  bền vững/route adapter; trigger defs 79/447; coordinator channels
  với mock provider — instructions tới được prompt model).
- File test cũ cập nhật theo số mới (không phải hồi quy): 
  `tests/composio-toolkits-a.test.mjs` 22 → 40 toolkit (400 tool,
  registry 6+41, views 41), `tests/composio-triggers-v083.test.mjs`
  50 → 79 defs, 244 → 447 total. Chạy chung 4 file đích:
  toolkits-a + triggers-v083 + composio-channels-v096 + i18n =
  **45/45 pass**.
- Trigger catalog: `GET /api/v3.1/triggers_types` phân trang toàn bộ
  15 trang, vẫn 714 type; 203 type trên 18 toolkit mới, 29 def đại
  diện thêm vào `COMPOSIO_TRIGGER_DEFS` (79 defs, total 447).
  7 toolkit mới có 0 trigger: GitLab, LinkedIn, Reddit, PagerDuty,
  SendGrid, Bitbucket, Freshdesk.
- i18n: `channels.*` + `sidebar.channels` = 58 key mới × 6 locale
  (vi/en/zh/ja/es/fr), 1736 key/locale, parity khớp 6/6.

## 5. Giới hạn còn lại (nói thẳng)

1. **Mock-only, chưa live-verify**: không dùng key Composio thật
   trong code/test; 18 toolkit mới chỉ xác nhận slug tồn tại qua
   `GET /tools` (chưa chạy tool thật qua MULTI_EXECUTE, chưa kết nối
   tài khoản từng app). Channels chạy bot thật mới test bằng mock
   provider trong coordinator (chưa chạy qua app Electron thật).
2. **Trigger queue in-memory**: restart app thì queue trống (Composio
   retry delivery chưa ack nếu cần). Queue ĐÃ nối vào scheduler:
   `handleComposioTrigger` enqueue delivery đã verify (sau auth +
   parse + khớp slug) vào singleton `getSharedComposioTriggerQueue()`
   (main.ts truyền qua `composioTriggerQueue`), best-effort — run
   ngay vẫn chạy như cũ; `pollBridge.ts` biến item poll mới thành
   synthetic event (`composio.trigger.poll`, `GMAIL_NEW_GMAIL_MESSAGE`)
   vào cùng queue để consumer chỉ đọc một nguồn. Polling vẫn chưa có
   scheduler nền tự động trong app (chỉ có class + bridge — host
   phải gọi `start()`).
3. **Teams**: không có toolkit (xem §1). 7 toolkit mới có 0 trigger
   (GitLab, LinkedIn, Reddit, PagerDuty, SendGrid, Bitbucket,
   Freshdesk) — chỉ gọi tool chủ động được, không nhận event.
4. Full suite chưa chạy (máy 1,5 CPU, 6 đội chung) — chỉ build +
   typecheck + test đích (4 file, 45/45 pass).
