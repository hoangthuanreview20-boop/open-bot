/**
 * Composio — 40 toolkit + app router (v0.57 gốc, mở rộng v0.72a Team A,
 * mở rộng v0.82: +8 toolkit Zoom/Salesforce/Zendesk/Airtable/Monday/
 * ClickUp/Dropbox/Outlook; mở rộng v0.96 Team T4: +18 toolkit
 * Stripe/Shopify/Box/Confluence/GitLab/Calendly/Mailchimp/Twilio/
 * Google Docs/YouTube/LinkedIn/Reddit/WhatsApp/PagerDuty/Typeform/
 * SendGrid/Bitbucket/Freshdesk — slug xác nhận live 2026-11-13,
 * xem scripts/composio-toolkits-live-v096/).
 *
 * Mỗi toolkit là MỘT catalog entry trong AppRegistry (`source:
 * 'composio'`, bật/tắt được từng app), KHÔNG phải tool song song:
 * tool của toolkit chịu cap M7 + filterTools như tool local.
 *
 * Slug tool liệt kê ở đây là slug ĐÃ XÁC NHẬN LIVE bằng API thật
 * (key project Composio thật, xem scripts/composio-toolkits-live/):
 *  - 14 toolkit đầu: ngày 2026-11-10, tổng cộng 2.564 tool thật
 *    (`toolkits-live-2026-11-10.json`).
 *  - 8 toolkit v0.82: ngày 2026-11-11, tổng cộng 1.721 tool thật
 *    (`toolkits-live-2026-11-11.json`).
 *  - 18 toolkit v0.96: ngày 2026-11-13, 2.386 slug mẫu đầu (limit 200
 *    mỗi toolkit, thứ tự ABC) trong
 *    `scripts/composio-toolkits-live-v096/toolkits-live-2026-11-13.json`;
 *    10 slug/toolkit được chọn tay từ mẫu đó (đọc + ghi + tìm kiếm).
 *    Teams KHÔNG thêm được: slug `microsoftteams` và `teams` đều trả
 *    0 tool (HTTP 200) — Composio không có toolkit Teams dưới 2 tên này.
 *  Tổng: 4.285 tool thật trên 22 toolkit cũ + 2.386 slug mẫu trên 18 toolkit v0.96; script discover.py chạy
 *  lại được):
 *  - Catalog endpoint `GET /api/v3.1/tools` lọc theo toolkit bằng
 *    tham số `toolkit_slug` (`toolkit` bị API lặng lẽ bỏ qua).
 *  - Tool Router session (`/tool_router/session/{id}/tools`) chỉ
 *    trả 6 meta-tool `COMPOSIO_*` — tool từng toolkit được tìm lúc
 *    chạy qua COMPOSIO_SEARCH_TOOLS, không nằm trong session list.
 *
 * Mỗi toolkit giữ đúng 10 slug dùng nhiều nhất (CRUD + tìm kiếm +
 * đọc) — bằng cap M7 `DEFAULT_APP_TOOL_CAP = 10` (xem
 * apps/toolCap.ts): liệt kê hơn cũng bị cap cắt, vừa tốn context.
 * Toàn bộ tool còn lại của toolkit vẫn dùng được qua discovery lúc
 * chạy (COMPOSIO_SEARCH_TOOLS → COMPOSIO_GET_TOOL_SCHEMAS →
 * COMPOSIO_MULTI_EXECUTE_TOOL) — đó chính là cách Tool Router thiết
 * kế (không nhồi hàng trăm def vào context).
 *
 * Sửa sai v0.57 (phát hiện nhờ live test v0.72/v0.72a): slug
 * `GITHUB_CREATE_ISSUE` trong file này trước đây KHÔNG tồn tại trên
 * Composio thật (suy đoán từ vd tài liệu) — slug thật là
 * `GITHUB_CREATE_AN_ISSUE`. Mọi slug trong file này từ nay đều phải
 * đối chiếu với `toolkits-live-2026-11-10.json` (14 toolkit đầu) và
 * `toolkits-live-2026-11-11.json` (8 toolkit v0.82) trước khi thêm.
 * Slug mock bịa `SLACK_POST_MESSAGE` / `SLACK_LIST_CHANNELS` và
 * `NOTION_CREATE_PAGE` / `NOTION_SEARCH` cũng không có thật.
 * `SLACK_SEND_MESSAGE` đã xác nhận có thật (live test v0.72 qua
 * COMPOSIO_SEARCH_TOOLS; schema live fetch ở v0.85 — xem
 * `scripts/composio-live-v072/tool-schemas-write-2026-11-11.json`:
 * bắt buộc `channel`, nội dung đúng 1 trong `markdown_text` /
 * `blocks` + `fallback_text` chỉ khi dùng `blocks`) và từ v0.85 nằm
 * TRONG top-10, thay `SLACK_CHAT_POST_MESSAGE` — slug cũ vẫn tồn
 * tại trên Composio nhưng mô tả của nó ghi rõ "this action is
 * deprecated", nên catalog không giới thiệu nó làm lựa chọn chính
 * nữa. Quyết định này ghi ở docs/composio-integration.md §8.1.
 *
 * App 'composio' (router) giữ 3 meta-tool mà model thực sự gọi:
 * COMPOSIO_SEARCH_TOOLS, COMPOSIO_GET_TOOL_SCHEMAS,
 * COMPOSIO_MULTI_EXECUTE_TOOL. 4 meta-tool còn lại
 * (MANAGE/WAIT_CONNECTIONS, REMOTE_WORKBENCH/BASH) là năng lực của
 * session, không expose cho model ở v0.57 (kết nối app làm qua
 * Composio Connect Link ở trình duyệt; workbench/bash remote là code
 * execution phía Composio — cố tình không mở).
 */

import type { AppDefinition } from '../apps/types';

/**
 * Động từ ghi (segment trong slug, tách bằng '_') — tool chứa một
 * trong các segment này là tool GHI, cần approval trước khi chạy.
 * So khớp theo segment (không phải substring) để không nhầm
 * `GET_UPDATES` (đọc) với `UPDATE` (ghi). Fail-closed: động từ
 * chưa rõ thì thêm vào đây sau khi kiểm tra slug thật.
 */
export const COMPOSIO_WRITE_VERBS: ReadonlySet<string> = new Set([
  'ADD',
  'APPEND',
  'ARCHIVE',
  'ASSIGN',
  'CLEAR',
  'COPY',
  'CREATE',
  'DELETE',
  'DUPLICATE',
  'EDIT',
  'FORWARD',
  'IMPORT',
  'INSERT',
  'MERGE',
  'MODIFY',
  'MOVE',
  'PATCH',
  'POST',
  'PUBLISH',
  'REMOVE',
  'SCHEDULE',
  'SEND',
  'SET',
  'SHARE',
  'TRANSITION',
  'UNARCHIVE',
  'UPDATE',
  'UPSERT',
]);

/** Tool Composio có cần approval không (tool ghi → true, tool đọc → false). */
export function composioToolNeedsApproval(slug: string): boolean {
  if (!slug || typeof slug !== 'string') return true;
  return slug.split('_').some((segment) => COMPOSIO_WRITE_VERBS.has(segment));
}

/** Toolkit slug Composio của 40 app (khớp tên toolkit Composio). */
export const COMPOSIO_TOOLKIT_SLUGS: readonly string[] = [
  'gmail',
  'github',
  'slack',
  'notion',
  'googlesheets',
  'googledrive',
  'googlecalendar',
  'jira',
  'linear',
  'discord',
  'telegram',
  'trello',
  'asana',
  'hubspot',
  'zoom',
  'salesforce',
  'zendesk',
  'airtable',
  'monday',
  'clickup',
  'dropbox',
  'outlook',
  'stripe',
  'shopify',
  'box',
  'confluence',
  'gitlab',
  'calendly',
  'mailchimp',
  'twilio',
  'googledocs',
  'youtube',
  'linkedin',
  'reddit',
  'whatsapp',
  'pagerduty',
  'typeform',
  'sendgrid',
  'bitbucket',
  'freshdesk',
] as const;

/** App id của router trong AppRegistry (giữ meta-tool). */
export const COMPOSIO_ROUTER_APP_ID = 'composio';

/** App id của một toolkit trong AppRegistry: 'composio-<toolkit>'. */
export function composioAppId(toolkit: string): string {
  return `composio-${toolkit}`;
}

/** Toolkit slug từ app id 'composio-<toolkit>' (undefined khi không phải app Composio). */
export function toolkitForComposioAppId(appId: string): string | undefined {
  if (!appId.startsWith('composio-')) return undefined;
  const toolkit = appId.slice('composio-'.length);
  return (COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(toolkit) ? toolkit : undefined;
}

/** Khai báo một toolkit Composio (dữ liệu catalog, chưa phải AppDefinition). */
export interface ComposioToolkitDef {
  /** Slug toolkit Composio, vd 'gmail'. */
  slug: string;
  /** Tên hiển thị. */
  label: string;
  /** Biểu tượng hiển thị. */
  icon: string;
  /** Mô tả ngắn cho UI — luôn nói rõ token nằm phía Composio. */
  description: string;
  /** Slug tool đã xác nhận live (xem ghi chú đầu file); 10 slug = cap M7. */
  verifiedToolSlugs: string[];
}

/**
 * 40 toolkit — slug đã xác nhận live (14 toolkit đầu ngày
 * 2026-11-10, 8 toolkit v0.82 ngày 2026-11-11, 18 toolkit v0.96
 * ngày 2026-11-13), 10 slug mỗi toolkit
 * (xem scripts/composio-toolkits-live/toolkits-live-2026-11-10.json,
 * toolkits-live-2026-11-11.json và
 * scripts/composio-toolkits-live-v096/toolkits-live-2026-11-13.json).
 * Tổng cộng 400 tool thật trong catalog; toàn bộ tool của 40
 * toolkit vẫn tới được qua COMPOSIO_SEARCH_TOOLS lúc chạy.
 */
export const COMPOSIO_TOOLKITS: readonly ComposioToolkitDef[] = [
  {
    slug: 'gmail',
    label: 'Gmail (via Composio)',
    icon: '✉️',
    description:
      'Đọc/gửi mail qua Composio Tool Router. Token Gmail nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'GMAIL_FETCH_EMAILS',
      'GMAIL_SEND_EMAIL',
      'GMAIL_LIST_THREADS',
      'GMAIL_GET_PROFILE',
      'GMAIL_SEARCH_PEOPLE',
      'GMAIL_CREATE_EMAIL_DRAFT',
      'GMAIL_SEND_DRAFT',
      'GMAIL_REPLY_TO_THREAD',
      'GMAIL_LIST_LABELS',
      'GMAIL_MOVE_TO_TRASH',
    ],
  },
  {
    slug: 'github',
    label: 'GitHub (via Composio)',
    icon: '🐙',
    description:
      'Tạo issue/PR và làm việc với repo qua Composio Tool Router. Token GitHub nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'GITHUB_CREATE_AN_ISSUE',
      'GITHUB_GET_AN_ISSUE',
      'GITHUB_SEARCH_ISSUES',
      'GITHUB_LIST_PULL_REQUESTS',
      'GITHUB_CREATE_A_PULL_REQUEST',
      'GITHUB_GET_A_REPOSITORY',
      'GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER',
      'GITHUB_ADD_LABELS_TO_AN_ISSUE',
      'GITHUB_CLOSE_ISSUE',
      'GITHUB_SEARCH_REPOSITORIES',
    ],
  },
  {
    slug: 'slack',
    label: 'Slack (via Composio)',
    icon: '💬',
    description:
      'Gửi/đọc tin Slack qua Composio Tool Router. Token Slack nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'SLACK_SEND_MESSAGE',
      'SLACK_LIST_CONVERSATIONS',
      'SLACK_FETCH_CONVERSATION_HISTORY',
      'SLACK_SEARCH_MESSAGES',
      'SLACK_LIST_ALL_USERS',
      'SLACK_CREATE_CHANNEL',
      'SLACK_WHO_AM_I',
      'SLACK_LIST_ALL_CHANNELS',
      'SLACK_GET_USER_PRESENCE',
      'SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK',
    ],
  },
  {
    slug: 'notion',
    label: 'Notion (via Composio)',
    icon: '📓',
    description:
      'Đọc/ghi page Notion qua Composio Tool Router. Token Notion nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'NOTION_SEARCH_NOTION_PAGE',
      'NOTION_RETRIEVE_PAGE',
      'NOTION_FETCH_ALL_BLOCK_CONTENTS',
      'NOTION_CREATE_NOTION_PAGE',
      'NOTION_UPDATE_PAGE',
      'NOTION_APPEND_BLOCK_CHILDREN',
      'NOTION_QUERY_DATABASE',
      'NOTION_FETCH_DATABASE',
      'NOTION_CREATE_DATABASE',
      'NOTION_GET_PAGE_MARKDOWN',
    ],
  },
  {
    slug: 'googlesheets',
    label: 'Google Sheets (via Composio)',
    icon: '📊',
    description:
      'Đọc/ghi Google Sheets qua Composio Tool Router — tìm, đọc, thêm dòng, cập nhật giá trị. Token Google nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'GOOGLESHEETS_SEARCH_SPREADSHEETS',
      'GOOGLESHEETS_VALUES_GET',
      'GOOGLESHEETS_GET_SPREADSHEET_INFO',
      'GOOGLESHEETS_GET_SHEET_NAMES',
      'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
      'GOOGLESHEETS_VALUES_UPDATE',
      'GOOGLESHEETS_CREATE_SPREADSHEET_ROW',
      'GOOGLESHEETS_UPSERT_ROWS',
      'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
      'GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW',
    ],
  },
  {
    slug: 'googledrive',
    label: 'Google Drive (via Composio)',
    icon: '📁',
    description:
      'Tìm, tải, tạo, sao chép, xoá file Drive qua Composio Tool Router. Token Google nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'GOOGLEDRIVE_LIST_FILES',
      'GOOGLEDRIVE_FIND_FILE',
      'GOOGLEDRIVE_GET_FILE_METADATA',
      'GOOGLEDRIVE_DOWNLOAD_FILE',
      'GOOGLEDRIVE_CREATE_FILE',
      'GOOGLEDRIVE_CREATE_FOLDER',
      'GOOGLEDRIVE_COPY_FILE',
      'GOOGLEDRIVE_DELETE_FILE',
      'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT',
      'GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE',
    ],
  },
  {
    slug: 'googlecalendar',
    label: 'Google Calendar (via Composio)',
    icon: '📅',
    description:
      'Xem/tạo/sửa/xoá sự kiện Google Calendar qua Composio Tool Router — tìm slot trống, kiểm tra bận/rảnh. Token Google nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'GOOGLECALENDAR_EVENTS_LIST',
      'GOOGLECALENDAR_FIND_EVENT',
      'GOOGLECALENDAR_EVENTS_GET',
      'GOOGLECALENDAR_CREATE_EVENT',
      'GOOGLECALENDAR_UPDATE_EVENT',
      'GOOGLECALENDAR_PATCH_EVENT',
      'GOOGLECALENDAR_DELETE_EVENT',
      'GOOGLECALENDAR_QUICK_ADD',
      'GOOGLECALENDAR_FREE_BUSY_QUERY',
      'GOOGLECALENDAR_FIND_FREE_SLOTS',
    ],
  },
  {
    slug: 'jira',
    label: 'Jira (via Composio)',
    icon: '🎫',
    description:
      'Tìm, tạo, sửa issue Jira qua Composio Tool Router — tìm bằng JQL, bình luận, chuyển trạng thái, gán người. Token Jira nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'JIRA_SEARCH_ISSUES',
      'JIRA_GET_ISSUE',
      'JIRA_CREATE_ISSUE',
      'JIRA_EDIT_ISSUE',
      'JIRA_ADD_COMMENT',
      'JIRA_TRANSITION_ISSUE',
      'JIRA_ASSIGN_ISSUE',
      'JIRA_GET_ALL_PROJECTS',
      'JIRA_CREATE_PROJECT',
      'JIRA_LIST_COMMENTS',
    ],
  },
  {
    slug: 'linear',
    label: 'Linear (via Composio)',
    icon: '🔷',
    description:
      'Quản lý issue Linear qua Composio Tool Router — liệt kê/tìm issue theo team, tạo/sửa issue, bình luận. Token Linear nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'LINEAR_LIST_LINEAR_ISSUES',
      'LINEAR_SEARCH_ISSUES',
      'LINEAR_GET_LINEAR_ISSUE',
      'LINEAR_CREATE_LINEAR_ISSUE',
      'LINEAR_UPDATE_ISSUE',
      'LINEAR_CREATE_LINEAR_COMMENT',
      'LINEAR_LIST_LINEAR_PROJECTS',
      'LINEAR_CREATE_LINEAR_PROJECT',
      'LINEAR_LIST_LINEAR_TEAMS',
      'LINEAR_GET_CURRENT_USER',
    ],
  },
  {
    slug: 'discord',
    label: 'Discord (via Composio)',
    icon: '🎮',
    description:
      'Đọc thông tin user/server Discord qua Composio Tool Router (OAuth user — chỉ đọc; gửi tin channel cần bot token, chưa hỗ trợ ở đây). Token Discord nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'DISCORD_GET_MY_USER',
      'DISCORD_LIST_MY_GUILDS',
      'DISCORD_GET_MY_GUILD_MEMBER',
      'DISCORD_GET_USER',
      'DISCORD_GET_INVITE',
      'DISCORD_INVITE_RESOLVE',
      'DISCORD_GET_GUILD_WIDGET',
      'DISCORD_LIST_MY_CONNECTIONS',
      'DISCORD_GET_OPENID_CONNECT_USERINFO',
      'DISCORD_MODIFY_CURRENT_USER',
    ],
  },
  {
    slug: 'telegram',
    label: 'Telegram (via Composio)',
    icon: '✈️',
    description:
      'Gửi/đọc tin Telegram qua Composio Tool Router — gửi tin/ảnh/file, sửa/xoá/forward tin nhắn. Token Telegram nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'TELEGRAM_GET_ME',
      'TELEGRAM_GET_UPDATES',
      'TELEGRAM_GET_CHAT',
      'TELEGRAM_GET_CHAT_HISTORY',
      'TELEGRAM_SEND_MESSAGE',
      'TELEGRAM_SEND_PHOTO',
      'TELEGRAM_SEND_DOCUMENT',
      'TELEGRAM_EDIT_MESSAGE',
      'TELEGRAM_DELETE_MESSAGE',
      'TELEGRAM_FORWARD_MESSAGE',
    ],
  },
  {
    slug: 'trello',
    label: 'Trello (via Composio)',
    icon: '📋',
    description:
      'Quản lý board Trello qua Composio Tool Router — xem board/list/card, tạo board/card/list, bình luận. Token Trello nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER',
      'TRELLO_GET_BOARDS_BY_ID_BOARD',
      'TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD',
      'TRELLO_GET_LISTS_CARDS_BY_ID_LIST',
      'TRELLO_GET_CARDS_BY_ID_CARD',
      'TRELLO_GET_SEARCH',
      'TRELLO_ADD_BOARDS',
      'TRELLO_ADD_CARDS',
      'TRELLO_ADD_LISTS',
      'TRELLO_ADD_CARDS_ACTIONS_COMMENTS_BY_ID_CARD',
    ],
  },
  {
    slug: 'asana',
    label: 'Asana (via Composio)',
    icon: '✅',
    description:
      'Tìm/tạo task Asana qua Composio Tool Router — tìm task trong workspace, tạo task/project, bình luận, gắn tag. Token Asana nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'ASANA_SEARCH_TASKS_IN_WORKSPACE',
      'ASANA_GET_TASKS_FROM_A_PROJECT',
      'ASANA_GET_USER',
      'ASANA_GET_WORKSPACE_PROJECTS',
      'ASANA_CREATE_A_TASK',
      'ASANA_CREATE_A_PROJECT',
      'ASANA_CREATE_TASK_COMMENT',
      'ASANA_ADD_TAG_TO_TASK',
      'ASANA_GET_TASK_SUBTASKS',
      'ASANA_SEARCH_PROJECTS_FOR_WORKSPACE',
    ],
  },
  {
    slug: 'hubspot',
    label: 'HubSpot (via Composio)',
    icon: '🧲',
    description:
      'Tìm/tạo contact, company, deal, ticket HubSpot qua Composio Tool Router. Token HubSpot nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA',
      'HUBSPOT_SEARCH_COMPANIES',
      'HUBSPOT_SEARCH_DEALS',
      'HUBSPOT_SEARCH_TICKETS',
      'HUBSPOT_CREATE_CONTACT',
      'HUBSPOT_CREATE_DEAL',
      'HUBSPOT_CREATE_COMPANY',
      'HUBSPOT_CREATE_TICKET',
      'HUBSPOT_UPDATE_CONTACT',
      'HUBSPOT_WHO_AM_I',
    ],
  },
  {
    slug: 'zoom',
    label: 'Zoom (via Composio)',
    icon: '🎥',
    description:
      'Tạo/xem/sửa meeting Zoom qua Composio Tool Router — liệt kê meeting, xem recording và tóm tắt AI. Token Zoom nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'ZOOM_CREATE_A_MEETING',
      'ZOOM_LIST_MEETINGS',
      'ZOOM_GET_A_MEETING',
      'ZOOM_UPDATE_A_MEETING',
      'ZOOM_DELETE_A_MEETING',
      'ZOOM_GET_MEETING_RECORDINGS',
      'ZOOM_LIST_ALL_RECORDINGS',
      'ZOOM_GET_A_MEETING_SUMMARY',
      'ZOOM_GET_USER',
      'ZOOM_ADD_A_MEETING_REGISTRANT',
    ],
  },
  {
    slug: 'salesforce',
    label: 'Salesforce (via Composio)',
    icon: '☁️',
    description:
      'Quản lý account/contact/lead/opportunity Salesforce qua Composio Tool Router — tạo/sửa record, truy vấn SOQL, tìm kiếm. Token Salesforce nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'SALESFORCE_CREATE_ACCOUNT',
      'SALESFORCE_CREATE_CONTACT',
      'SALESFORCE_CREATE_LEAD',
      'SALESFORCE_CREATE_OPPORTUNITY',
      'SALESFORCE_CREATE_TASK',
      'SALESFORCE_QUERY',
      'SALESFORCE_SEARCH',
      'SALESFORCE_GET_ACCOUNT',
      'SALESFORCE_GET_CONTACT',
      'SALESFORCE_GET_OPPORTUNITY',
    ],
  },
  {
    slug: 'zendesk',
    label: 'Zendesk (via Composio)',
    icon: '🎧',
    description:
      'Quản lý ticket Zendesk qua Composio Tool Router — tạo/xem/sửa ticket, tìm user, xem view. Token Zendesk nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'ZENDESK_CREATE_ZENDESK_TICKET',
      'ZENDESK_GET_ZENDESK_TICKET_BY_ID',
      'ZENDESK_LIST_ZENDESK_TICKETS',
      'ZENDESK_SEARCH_ZENDESK',
      'ZENDESK_UPDATE_ZENDESK_TICKET',
      'ZENDESK_CREATE_ZENDESK_USER',
      'ZENDESK_GET_USER',
      'ZENDESK_LIST_ZENDESK_USERS',
      'ZENDESK_SEARCH_ZENDESK_USERS',
      'ZENDESK_GET_VIEWS',
    ],
  },
  {
    slug: 'airtable',
    label: 'Airtable (via Composio)',
    icon: '🗂️',
    description:
      'Đọc/ghi base Airtable qua Composio Tool Router — liệt kê base/record, tạo/sửa/xoá record. Token Airtable nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'AIRTABLE_LIST_BASES',
      'AIRTABLE_GET_BASE_SCHEMA',
      'AIRTABLE_LIST_RECORDS',
      'AIRTABLE_GET_RECORD',
      'AIRTABLE_CREATE_RECORD',
      'AIRTABLE_UPDATE_RECORD',
      'AIRTABLE_DELETE_RECORD',
      'AIRTABLE_CREATE_MULTIPLE_RECORDS',
      'AIRTABLE_WHO_AM_I',
      'AIRTABLE_CREATE_TABLE',
    ],
  },
  {
    slug: 'monday',
    label: 'Monday (via Composio)',
    icon: '📅',
    description:
      'Quản lý board/item Monday qua Composio Tool Router — liệt kê board/item, tạo/sửa item, bình luận update. Token Monday nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'MONDAY_LIST_BOARDS',
      'MONDAY_LIST_ITEMS',
      'MONDAY_GET_ITEMS',
      'MONDAY_CREATE_ITEM',
      'MONDAY_UPDATE_ITEM',
      'MONDAY_CREATE_BOARD',
      'MONDAY_CREATE_UPDATE',
      'MONDAY_LIST_USERS',
      'MONDAY_GET_ME',
      'MONDAY_LIST_GROUPS',
    ],
  },
  {
    slug: 'clickup',
    label: 'ClickUp (via Composio)',
    icon: '✅',
    description:
      'Quản lý task ClickUp qua Composio Tool Router — tạo/xem/sửa task, liệt kê list/space, bình luận. Token ClickUp nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'CLICKUP_CREATE_TASK',
      'CLICKUP_GET_TASK',
      'CLICKUP_GET_TASKS',
      'CLICKUP_UPDATE_TASK',
      'CLICKUP_CREATE_LIST',
      'CLICKUP_GET_LISTS',
      'CLICKUP_GET_SPACES',
      'CLICKUP_CREATE_SPACE',
      'CLICKUP_GET_AUTHORIZED_USER',
      'CLICKUP_CREATE_TASK_COMMENT',
    ],
  },
  {
    slug: 'dropbox',
    label: 'Dropbox (via Composio)',
    icon: '📦',
    description:
      'Tìm/tải/chia sẻ file Dropbox qua Composio Tool Router — liệt kê thư mục, tìm file, tạo link chia sẻ. Token Dropbox nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'DROPBOX_LIST_FILES_IN_FOLDER',
      'DROPBOX_GET_METADATA',
      'DROPBOX_FILES_SEARCH',
      'DROPBOX_CREATE_FOLDER',
      'DROPBOX_GET_TEMPORARY_LINK',
      'DROPBOX_CREATE_SHARED_LINK',
      'DROPBOX_GET_SPACE_USAGE',
      'DROPBOX_GET_ABOUT_ME',
      'DROPBOX_LIST_SHARED_LINKS',
      'DROPBOX_SEARCH_FILE_OR_FOLDER',
    ],
  },
  {
    slug: 'outlook',
    label: 'Outlook (via Composio)',
    icon: '📧',
    description:
      'Đọc/gửi mail và quản lý lịch Outlook qua Composio Tool Router — liệt kê/tìm mail, tạo nháp, xem/tạo sự kiện. Token Microsoft nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'OUTLOOK_LIST_MESSAGES',
      'OUTLOOK_GET_MESSAGE',
      'OUTLOOK_CREATE_USER_MESSAGE',
      'OUTLOOK_CREATE_DRAFT',
      'OUTLOOK_SEARCH_MESSAGES',
      'OUTLOOK_LIST_EVENTS',
      'OUTLOOK_CREATE_ME_EVENT',
      'OUTLOOK_LIST_CALENDARS',
      'OUTLOOK_LIST_CONTACTS',
      'OUTLOOK_CREATE_CONTACT',
    ],
  },
  {
    slug: 'stripe',
    label: 'Stripe (via Composio)',
    icon: '💳',
    description:
      'Quản lý customer, invoice, payment, subscription Stripe qua Composio Tool Router. Token Stripe nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'STRIPE_GET_ACCOUNT',
      'STRIPE_GET_BALANCE_TRANSACTION',
      'STRIPE_CREATE_CUSTOMER',
      'STRIPE_CREATE_PAYMENT_INTENT',
      'STRIPE_CREATE_INVOICE',
      'STRIPE_CREATE_REFUND',
      'STRIPE_CREATE_PRODUCT',
      'STRIPE_CREATE_PRICE',
      'STRIPE_CREATE_CHARGE',
      'STRIPE_CREATE_CUSTOMER_SUBSCRIPTION',
    ],
  },
  {
    slug: 'shopify',
    label: 'Shopify (via Composio)',
    icon: '🛍️',
    description:
      'Quản lý product, order, customer Shopify qua Composio Tool Router. Token Shopify nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'SHOPIFY_GET_CUSTOMER',
      'SHOPIFY_GET_CUSTOMERS_SEARCH',
      'SHOPIFY_GET_CUSTOMER_ORDERS',
      'SHOPIFY_GET_COLLECTION_BY_ID',
      'SHOPIFY_GET_CUSTOMERS_COUNT',
      'SHOPIFY_CREATE_PRODUCT',
      'SHOPIFY_CREATE_ORDER',
      'SHOPIFY_CREATE_CUSTOMER',
      'SHOPIFY_CREATE_DRAFT_ORDER',
      'SHOPIFY_CREATE_PRODUCT_VARIANT',
    ],
  },
  {
    slug: 'box',
    label: 'Box (via Composio)',
    icon: '📦',
    description:
      'Tìm/tải/chia sẻ file Box qua Composio Tool Router. Token Box nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'BOX_DOWNLOAD_FILE',
      'BOX_GET_FILE_INFORMATION',
      'BOX_GET_FILE_THUMBNAIL',
      'BOX_GET_FILE_VERSION',
      'BOX_FIND_FILE_FOR_SHARED_LINK',
      'BOX_LIST_ALL_COLLECTIONS',
      'BOX_CREATE_FOLDER',
      'BOX_COPY_FILE',
      'BOX_ADD_SHARED_LINK_TO_FILE',
      'BOX_CREATE_COMMENT',
    ],
  },
  {
    slug: 'confluence',
    label: 'Confluence (via Composio)',
    icon: '📖',
    description:
      'Tìm/đọc/tạo page Confluence qua Composio Tool Router — tìm bằng CQL, xem page/space, tạo page/blog. Token Confluence nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'CONFLUENCE_CQL_SEARCH',
      'CONFLUENCE_GET_PAGE_BY_ID',
      'CONFLUENCE_GET_SPACE_BY_ID',
      'CONFLUENCE_GET_SPACE_CONTENTS',
      'CONFLUENCE_GET_ATTACHMENTS',
      'CONFLUENCE_GET_PAGE_ANCESTORS',
      'CONFLUENCE_CREATE_PAGE',
      'CONFLUENCE_CREATE_BLOGPOST',
      'CONFLUENCE_CREATE_SPACE',
      'CONFLUENCE_DELETE_PAGE',
    ],
  },
  {
    slug: 'gitlab',
    label: 'GitLab (via Composio)',
    icon: '🦊',
    description:
      'Quản lý project, merge request, issue, pipeline GitLab qua Composio Tool Router. Token GitLab nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'GITLAB_GET_PROJECT',
      'GITLAB_GET_ISSUE',
      'GITLAB_GET_CURRENT_USER',
      'GITLAB_GET_COMMIT_DIFF',
      'GITLAB_LIST_ALL_PROJECT_MEMBERS',
      'GITLAB_LIST_ISSUES',
      'GITLAB_CREATE_MERGE_REQUEST',
      'GITLAB_CREATE_ISSUE_NOTE',
      'GITLAB_CREATE_PIPELINE',
      'GITLAB_CREATE_GROUP',
    ],
  },
  {
    slug: 'calendly',
    label: 'Calendly (via Composio)',
    icon: '🗓️',
    description:
      'Xem/tạo/huỷ lịch hẹn Calendly qua Composio Tool Router — liệt kê event, xem invitee, tạo scheduling link. Token Calendly nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'CALENDLY_LIST_EVENTS',
      'CALENDLY_LIST_EVENT_INVITEES',
      'CALENDLY_GET_EVENT',
      'CALENDLY_GET_USER',
      'CALENDLY_GET_EVENT_TYPE',
      'CALENDLY_GET_EVENT_TYPE_AVAILABILITY',
      'CALENDLY_CREATE_EVENT_TYPE',
      'CALENDLY_CREATE_SCHEDULING_LINK',
      'CALENDLY_CANCEL_SCHEDULED_EVENT',
      'CALENDLY_CREATE_EVENT_INVITEE',
    ],
  },
  {
    slug: 'mailchimp',
    label: 'Mailchimp (via Composio)',
    icon: '🐵',
    description:
      'Quản lý audience, campaign, member Mailchimp qua Composio Tool Router. Token Mailchimp nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'MAILCHIMP_GET_AUDIENCES_CONTACTS',
      'MAILCHIMP_GET_CAMPAIGN_CONTENT',
      'MAILCHIMP_GET_AUTOMATION_INFO',
      'MAILCHIMP_GET_ABUSE_REPORT',
      'MAILCHIMP_ADD_LIST_MEMBER',
      'MAILCHIMP_ADD_CAMPAIGN',
      'MAILCHIMP_ADD_LIST',
      'MAILCHIMP_ADD_MEMBER_TO_SEGMENT',
      'MAILCHIMP_DELETE_CAMPAIGN',
      'MAILCHIMP_DELETE_LIST_MEMBER',
    ],
  },
  {
    slug: 'twilio',
    label: 'Twilio (via Composio)',
    icon: '📱',
    description:
      'Gửi SMS, gọi điện, quản lý conversation Twilio qua Composio Tool Router. Token Twilio nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'TWILIO_CREATE_MESSAGE',
      'TWILIO_CREATE_CALL',
      'TWILIO_FETCH_BALANCE',
      'TWILIO_FETCH_CALL',
      'TWILIO_FETCH_ACCOUNT',
      'TWILIO_FETCH_ADDRESS',
      'TWILIO_FETCH_MESSAGE',
      'TWILIO_CONVERSATIONS_CREATE_CONVERSATION_MESSAGE',
      'TWILIO_CONVERSATIONS_FETCH_CONVERSATION',
      'TWILIO_CREATE_INCOMING_PHONE_NUMBER',
    ],
  },
  {
    slug: 'googledocs',
    label: 'Google Docs (via Composio)',
    icon: '📄',
    description:
      'Đọc/tạo/sửa Google Docs qua Composio Tool Router — đọc plaintext, tìm doc, tạo doc từ markdown. Token Google nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
      'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
      'GOOGLEDOCS_SEARCH_DOCUMENTS',
      'GOOGLEDOCS_GET_DOCS_DRIVE_FILE_METADATA',
      'GOOGLEDOCS_LIST_DRIVE_ITEM_PERMISSIONS',
      'GOOGLEDOCS_CREATE_DOCUMENT',
      'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
      'GOOGLEDOCS_CREATE_AND_POPULATE_TABLE',
      'GOOGLEDOCS_COPY_DOCUMENT',
      'GOOGLEDOCS_CREATE_HEADER',
    ],
  },
  {
    slug: 'youtube',
    label: 'YouTube (via Composio)',
    icon: '▶️',
    description:
      'Tìm/xem video, quản lý playlist và bình luận YouTube qua Composio Tool Router. Token YouTube nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'YOUTUBE_SEARCH_YOU_TUBE',
      'YOUTUBE_GET_VIDEO_DETAILS_BATCH',
      'YOUTUBE_GET_CHANNEL_STATISTICS',
      'YOUTUBE_GET_CHANNEL_ID_BY_HANDLE',
      'YOUTUBE_LIST_CHANNEL_VIDEOS',
      'YOUTUBE_LIST_COMMENTS',
      'YOUTUBE_GET_PLAYLISTS_BY_ID',
      'YOUTUBE_CREATE_PLAYLIST',
      'YOUTUBE_ADD_VIDEO_TO_PLAYLIST',
      'YOUTUBE_CREATE_COMMENT_REPLY',
    ],
  },
  {
    slug: 'linkedin',
    label: 'LinkedIn (via Composio)',
    icon: '💼',
    description:
      'Đăng bài, bình luận, xem profile/company LinkedIn qua Composio Tool Router. Token LinkedIn nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'LINKEDIN_GET_MY_INFO',
      'LINKEDIN_GET_COMPANY_INFO',
      'LINKEDIN_GET_NETWORK_SIZE',
      'LINKEDIN_GET_PERSON',
      'LINKEDIN_GET_ORG_PAGE_STATS',
      'LINKEDIN_SEARCH_AD_TARGETING_ENTITIES',
      'LINKEDIN_CREATE_LINKED_IN_POST',
      'LINKEDIN_CREATE_COMMENT_ON_POST',
      'LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE',
      'LINKEDIN_DELETE_LINKED_IN_POST',
    ],
  },
  {
    slug: 'reddit',
    label: 'Reddit (via Composio)',
    icon: '🤖',
    description:
      'Đọc/đăng bài Reddit qua Composio Tool Router — xem subreddit, tìm bài, đăng/sửa/xoá post. Token Reddit nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'REDDIT_GET_NEW',
      'REDDIT_GET_R_TOP',
      'REDDIT_GET_SUBREDDITS_SEARCH',
      'REDDIT_GET_REDDIT_USER_ABOUT',
      'REDDIT_GET_SUBREDDIT_RULES',
      'REDDIT_GET_INBOX_MESSAGE',
      'REDDIT_LIST_INBOX_MESSAGES',
      'REDDIT_CREATE_REDDIT_POST',
      'REDDIT_EDIT_REDDIT_COMMENT_OR_POST',
      'REDDIT_DELETE_REDDIT_POST',
    ],
  },
  {
    slug: 'whatsapp',
    label: 'WhatsApp (via Composio)',
    icon: '💚',
    description:
      'Gửi/đọc tin WhatsApp Business qua Composio Tool Router — gửi tin/media/location, xem lịch sử tin, quản lý template. Token WhatsApp nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'WHATSAPP_SEND_MESSAGE',
      'WHATSAPP_SEND_MEDIA',
      'WHATSAPP_SEND_LOCATION',
      'WHATSAPP_SEND_CONTACTS',
      'WHATSAPP_SEND_INTERACTIVE_BUTTONS',
      'WHATSAPP_GET_MESSAGE_HISTORY',
      'WHATSAPP_GET_MESSAGE_TEMPLATES',
      'WHATSAPP_GET_MEDIA_INFO',
      'WHATSAPP_CREATE_MESSAGE_TEMPLATE',
      'WHATSAPP_GET_BUSINESS_ACCOUNT_DETAILS',
    ],
  },
  {
    slug: 'pagerduty',
    label: 'PagerDuty (via Composio)',
    icon: '🚨',
    description:
      'Quản lý incident, service, escalation PagerDuty qua Composio Tool Router. Token PagerDuty nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'PAGERDUTY_FETCH_INCIDENT_LIST',
      'PAGERDUTY_FETCH_ESCALATION_POLICES_LIST',
      'PAGERDUTY_FETCH_INCIDENT_ANALYTICS_BY_ID',
      'PAGERDUTY_GET_ALERTS_BY_INCIDENT_ID',
      'PAGERDUTY_GET_ADDONS_LIST',
      'PAGERDUTY_CREATE_INCIDENT_RECORD',
      'PAGERDUTY_CREATE_USER_OBJECT',
      'PAGERDUTY_CREATE_ESCALATION_POLICY',
      'PAGERDUTY_CREATE_INCIDENT_WORKFLOW',
      'PAGERDUTY_CREATE_SERVICE_EVENT_RULE',
    ],
  },
  {
    slug: 'typeform',
    label: 'Typeform (via Composio)',
    icon: '📝',
    description:
      'Tạo/xem form và câu trả lời Typeform qua Composio Tool Router. Token Typeform nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'TYPEFORM_GET_FORM',
      'TYPEFORM_GET_FORM_RESPONSES',
      'TYPEFORM_GET_WORKSPACE',
      'TYPEFORM_GET_THEME',
      'TYPEFORM_GET_ABOUT_ME',
      'TYPEFORM_CREATE_FORM',
      'TYPEFORM_CREATE_WORKSPACE',
      'TYPEFORM_CREATE_THEME',
      'TYPEFORM_DELETE_FORM',
      'TYPEFORM_DELETE_RESPONSES',
    ],
  },
  {
    slug: 'sendgrid',
    label: 'SendGrid (via Composio)',
    icon: '📨',
    description:
      'Gửi mail, quản lý contact/list/campaign SendGrid qua Composio Tool Router. Token SendGrid nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'SENDGRID_GET_A_LIST_OF_ALL_SENDERS',
      'SENDGRID_GET_ALL_CATEGORIES',
      'SENDGRID_GET_A_CONTACT_BY_ID',
      'SENDGRID_GET_ALL_AUTOMATION_STATS',
      'SENDGRID_GET_A_LIST_OF_ALL_IP_ADDRESSES_ON_YOUR_ACCOUNT',
      'SENDGRID_CREATE_A_LIST',
      'SENDGRID_CREATE_A_CAMPAIGN',
      'SENDGRID_ADD_OR_UPDATE_A_CONTACT',
      'SENDGRID_ADD_A_SINGLE_RECIPIENT_TO_A_LIST',
      'SENDGRID_CREATE_A_NEW_TRANSACTIONAL_TEMPLATE_VERSION',
    ],
  },
  {
    slug: 'bitbucket',
    label: 'Bitbucket (via Composio)',
    icon: '🪣',
    description:
      'Quản lý repo, pull request, issue Bitbucket qua Composio Tool Router. Token Bitbucket nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'BITBUCKET_GET_BRANCH',
      'BITBUCKET_GET_FILE_FROM_REPOSITORY',
      'BITBUCKET_LIST_BRANCHES',
      'BITBUCKET_LIST_COMMITS',
      'BITBUCKET_LIST_ISSUES',
      'BITBUCKET_CREATE_PULL_REQUEST',
      'BITBUCKET_CREATE_ISSUE',
      'BITBUCKET_CREATE_REPOSITORY',
      'BITBUCKET_CREATE_BRANCH',
      'BITBUCKET_APPROVE_PULL_REQUEST',
    ],
  },
  {
    slug: 'freshdesk',
    label: 'Freshdesk (via Composio)',
    icon: '🎫',
    description:
      'Quản lý ticket, contact, agent Freshdesk qua Composio Tool Router. Token Freshdesk nằm trên Composio Cloud (managed OAuth), không lưu trên máy này.',
    verifiedToolSlugs: [
      'FRESHDESK_GET_TICKETS',
      'FRESHDESK_GET_AGENT',
      'FRESHDESK_GET_AGENTS',
      'FRESHDESK_GET_COMPANY',
      'FRESHDESK_LIST_ALL_TICKET_CONVERSATIONS',
      'FRESHDESK_LIST_ADMIN_GROUPS',
      'FRESHDESK_CREATE_TICKET',
      'FRESHDESK_CREATE_CONTACT',
      'FRESHDESK_CREATE_AGENTS',
      'FRESHDESK_ADD_NOTE_TO_TICKET',
    ],
  },
] as const;

function toolkitAppDefinition(toolkit: ComposioToolkitDef): AppDefinition {
  return {
    id: composioAppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.verifiedToolSlugs.map((slug) => ({
      name: slug,
      description: `Tool Composio ${slug} — phát hiện/xác nhận qua Tool Router, thực thi qua COMPOSIO_MULTI_EXECUTE_TOOL.`,
      // Tool ghi cần approval; tool đọc thì không (xem composioToolNeedsApproval).
      needsApproval: composioToolNeedsApproval(slug),
    })),
  };
}

/** App router — giữ 3 meta-tool model thực sự gọi (xem ghi chú đầu file). */
export const COMPOSIO_ROUTER_APP: AppDefinition = {
  id: COMPOSIO_ROUTER_APP_ID,
  label: 'Composio Tool Router',
  description:
    'Meta-tool tìm kiếm + thực thi tool của mọi app Composio đã bật (COMPOSIO_SEARCH_TOOLS, COMPOSIO_GET_TOOL_SCHEMAS, COMPOSIO_MULTI_EXECUTE_TOOL). Không phải một app dữ liệu — tắt Composio là app này biến mất cùng 40 toolkit.',
  icon: '🔌',
  authType: 'composio',
  source: 'composio',
  tools: [
    {
      name: 'COMPOSIO_SEARCH_TOOLS',
      description: 'Tìm tool Composio phù hợp với mô tả task (discovery động).',
      needsApproval: false,
    },
    {
      name: 'COMPOSIO_GET_TOOL_SCHEMAS',
      description: 'Lấy input schema đầy đủ của slug tool đã tìm được.',
      needsApproval: false,
    },
    {
      name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      description: 'Thực thi một hoặc nhiều tool Composio đã tìm được (tối đa 50/call).',
      needsApproval: true,
    },
  ],
};

/** Toàn bộ AppDefinition Composio: router + 40 toolkit (để đăng ký vào AppRegistry). */
export function createComposioAppDefinitions(): AppDefinition[] {
  return [
    { ...COMPOSIO_ROUTER_APP, tools: COMPOSIO_ROUTER_APP.tools.map((t) => ({ ...t })) },
    ...COMPOSIO_TOOLKITS.map(toolkitAppDefinition),
  ];
}

/** Chỉ 40 app toolkit (không gồm router) — cho UI bật/tắt từng app. */
export function createComposioToolkitAppDefinitions(): AppDefinition[] {
  return COMPOSIO_TOOLKITS.map(toolkitAppDefinition);
}
