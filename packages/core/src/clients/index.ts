/**
 * Direct read-only API clients (worker F2, v0.89b) — index.
 *
 * Mỗi client gọi API công khai của một app TRỰC TIẾP (không qua Composio,
 * không qua packages/core/src/connectors/*). Tất cả chỉ ĐỌC.
 * Client đọc thật ĐÃ CÓ từ trước (nằm trong connectors/): Google
 * (Drive/Sheets/Calendar), Jira, Linear, HubSpot, Asana, Discord — xem
 * packages/core/src/connectors/*.ts, không map lại ở đây.
 *
 * Map toolkit slug (Composio) → client: dùng cho tầng wiring sau này
 * (coordinator) để biết toolkit nào đã có client đọc trực tiếp.
 */
export * from './common';
export * from './notion';
export * from './trello';
export * from './dropbox';
export * from './outlook';
export * from './airtable';
export * from './zoom';
export * from './telegram';
export * from './monday';
export * from './clickup';
export * from './salesforce';
export * from './zendesk';

export interface ReadClientInfo {
  /** Composio toolkit slug. */
  slug: string;
  /** Tên client (tên file, không có .ts). */
  client: string;
  /** Tên hiển thị. */
  label: string;
  /** Cách xác thực của API đó. */
  auth: string;
}

/** Map toolkit slug → direct read client (11 toolkit, v0.89b). */
export const READ_CLIENT_TOOLKITS: Record<string, ReadClientInfo> = {
  notion: {
    slug: 'notion',
    client: 'notion',
    label: 'Notion',
    auth: 'Bearer integration token + Notion-Version 2022-06-28',
  },
  trello: {
    slug: 'trello',
    client: 'trello',
    label: 'Trello',
    auth: 'API key + token (query string)',
  },
  dropbox: {
    slug: 'dropbox',
    client: 'dropbox',
    label: 'Dropbox',
    auth: 'Bearer access token (API v2)',
  },
  outlook: {
    slug: 'outlook',
    client: 'outlook',
    label: 'Outlook',
    auth: 'Bearer access token (Microsoft Graph v1.0, scope Mail.Read)',
  },
  airtable: {
    slug: 'airtable',
    client: 'airtable',
    label: 'Airtable',
    auth: 'Bearer personal access token',
  },
  zoom: {
    slug: 'zoom',
    client: 'zoom',
    label: 'Zoom',
    auth: 'Bearer OAuth / Server-to-Server token (API v2)',
  },
  telegram: {
    slug: 'telegram',
    client: 'telegram',
    label: 'Telegram',
    auth: 'Bot token (trong path /bot<token>/...)',
  },
  monday: {
    slug: 'monday',
    client: 'monday',
    label: 'monday.com',
    auth: 'Bearer API token (GraphQL, API-Version 2024-01)',
  },
  clickup: {
    slug: 'clickup',
    client: 'clickup',
    label: 'ClickUp',
    auth: 'API token thô trong header Authorization (API v2)',
  },
  salesforce: {
    slug: 'salesforce',
    client: 'salesforce',
    label: 'Salesforce',
    auth: 'Bearer OAuth token + instanceUrl (REST v59.0, SOQL SELECT)',
  },
  zendesk: {
    slug: 'zendesk',
    client: 'zendesk',
    label: 'Zendesk',
    auth: 'Bearer OAuth token + subdomain (API v2)',
  },
};

/** Danh sách toolkit slug đã có direct read client. */
export const READ_CLIENT_TOOLKIT_SLUGS: string[] = Object.keys(READ_CLIENT_TOOLKITS);

/** Lấy thông tin client của một toolkit slug (undefined khi chưa có client). */
export function getReadClientInfo(slug: string): ReadClientInfo | undefined {
  return READ_CLIENT_TOOLKITS[slug];
}
