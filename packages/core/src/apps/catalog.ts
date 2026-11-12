/**
 * Catalog app thống nhất (M7) — registry pattern như detector M1
 * (packages/core/src/detected/registry.ts) và ConnectorRegistry
 * (connectors/framework.ts).
 *
 * Thêm app mới = thêm một khai báo qua `registerApp()` (hoặc truyền
 * vào constructor), KHÔNG sửa code core. Catalog chỉ giữ dữ liệu:
 * tool nào thuộc app nào, app nào cần OAuth nào — logic tool vẫn
 * nằm ở packages/tools/src/integrationTools.ts, logic OAuth vẫn ở
 * connectors/framework.ts.
 *
 * App built-in liệt kê THẬT từ code repo đã có (đối chiếu
 * integrationTools.ts + connectors/*.ts, 2026-11-09; GitHub thêm
 * ở v0.68b — 7 tool API thật trong gitTools.ts, token PAT trong
 * Vault 'github'/'token', xem types.ts):
 *  - slack: 3 tool (slack_send, slack_list_channels, slack_read),
 *    OAuth2 qua connector 'slack'.
 *  - gmail: 2 tool (email_read, email_send), OAuth2 qua connector
 *    'gmail' (đăng nhập qua provider Google).
 *  - teams: 2 tool (teams_send, teams_list_teams), OAuth2 qua
 *    connector 'teams' (đăng nhập qua provider Microsoft).
 *  - imessage: 1 tool (imessage_draft, CHỈ soạn nháp, không gửi),
 *    không cần xác thực — chạy local.
 *  - meeting: 2 tool (meeting_transcript, meeting_summarize — import
 *    file/URL + tóm tắt rule-based, KHÔNG tự tham gia meeting thật),
 *    không cần xác thực — chạy local.
 *  - github: 7 tool API GitHub (git_host_connect, pr_list/create/
 *    update, pr_label_set, pr_code_tour_view/update), xác thực bằng
 *    personal access token (PAT) do user dán vào — authType 'token',
 *    Vault namespace 'github', key 'token'. Tool `set_active_branch`
 *    (git checkout local) KHÔNG thuộc app này: nó là khả năng của
 *    máy host, không phải API GitHub, nên vẫn nằm ngoài catalog như
 *    session box / memory.
 *
 * KHÔNG có app nào khác trong catalog: các tool còn lại trong
 * integrationTools (session box, memory, transcript archive, team
 * context, set_active_branch) là tool nội bộ của bot, không phải app
 * bên ngoài nên không đưa vào catalog.
 */

import type { AppDefinition } from './types';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** App built-in — dữ liệu thật từ code repo, không bịa app chưa có. */
export const BUILTIN_APPS: AppDefinition[] = [
  {
    id: 'slack',
    label: 'Slack',
    description:
      'Gửi/đọc tin Slack bằng token OAuth của user (chat.postMessage, conversations.history).',
    icon: '💬',
    authType: 'oauth2',
    connectorId: 'slack',
    tools: [
      { name: 'slack_send', description: 'Gửi tin tới channel Slack.', needsApproval: true },
      { name: 'slack_list_channels', description: 'Liệt kê channel của workspace.', needsApproval: false },
      { name: 'slack_read', description: 'Đọc tin gần nhất của một channel.', needsApproval: false },
    ],
  },
  {
    id: 'gmail',
    label: 'Gmail',
    description:
      'Đọc/gửi mail qua Gmail API bằng token OAuth của user (không phải IMAP).',
    icon: '✉️',
    authType: 'oauth2',
    connectorId: 'gmail',
    tools: [
      { name: 'email_read', description: 'Đọc inbox hoặc một mail theo id.', needsApproval: false },
      { name: 'email_send', description: 'Gửi mail qua Gmail API.', needsApproval: true },
    ],
  },
  {
    id: 'teams',
    label: 'Microsoft Teams',
    description:
      'Gửi tin tới channel Teams qua Microsoft Graph bằng token OAuth của user.',
    icon: '👥',
    authType: 'oauth2',
    connectorId: 'teams',
    tools: [
      { name: 'teams_send', description: 'Gửi tin tới một channel Teams.', needsApproval: true },
      { name: 'teams_list_teams', description: 'Liệt kê team + channel đã tham gia.', needsApproval: false },
    ],
  },
  {
    id: 'imessage',
    label: 'iMessage',
    description:
      'Chỉ soạn NHÁP iMessage (macOS mở cửa sổ soạn sẵn, Linux/Windows ghi file nháp) — không bao giờ tự gửi.',
    icon: '💭',
    authType: 'none',
    tools: [
      { name: 'imessage_draft', description: 'Soạn nháp iMessage (không gửi).', needsApproval: true },
    ],
  },
  {
    id: 'meeting',
    label: 'Meeting',
    description:
      'Import transcript meeting từ file/URL rồi tóm tắt rule-based — không tự tham gia meeting thật.',
    icon: '📝',
    authType: 'none',
    tools: [
      { name: 'meeting_transcript', description: 'Import transcript meeting từ file hoặc URL.', needsApproval: false },
      { name: 'meeting_summarize', description: 'Tóm tắt transcript đã import (rule-based).', needsApproval: false },
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    description:
      'Quản lý pull request GitHub qua API (xem/khởi tạo/cập nhật PR, đặt label, xem/bình luận code tour) bằng personal access token (PAT) của user. Tạo PAT ở github.com → Settings → Developer settings → Personal access tokens, rồi dán vào đây.',
    icon: '🐙',
    authType: 'token',
    vaultNamespace: 'github',
    vaultKey: 'token',
    tools: [
      { name: 'git_host_connect', description: 'Kiểm tra token GitHub và liệt kê repo của user.', needsApproval: false },
      { name: 'pr_list', description: 'Liệt kê pull request của một repo.', needsApproval: false },
      { name: 'pr_create', description: 'Tạo pull request mới.', needsApproval: true },
      { name: 'pr_update', description: 'Cập nhật tiêu đề/nội dung/trạng thái của pull request.', needsApproval: true },
      { name: 'pr_label_set', description: 'Đặt lại label của pull request.', needsApproval: true },
      { name: 'pr_code_tour_view', description: 'Xem file thay đổi + review comment của pull request.', needsApproval: false },
      { name: 'pr_code_tour_update', description: 'Bình luận hoặc gửi review trên pull request.', needsApproval: true },
    ],
  },
];

function copyApp(def: AppDefinition): AppDefinition {
  return {
    ...def,
    tools: def.tools.map((t) => ({ ...t })),
  };
}

function validateApp(def: AppDefinition): void {
  if (!def || typeof def.id !== 'string' || !ID_RE.test(def.id)) {
    throw new Error('App id must be non-empty and match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.');
  }
  if (!def.label || typeof def.label !== 'string') {
    throw new Error(`App "${def.id}" must have a non-empty label.`);
  }
  if (
    def.authType !== 'oauth2' &&
    def.authType !== 'none' &&
    def.authType !== 'composio' &&
    def.authType !== 'token'
  ) {
    throw new Error(`App "${def.id}" has unknown authType "${def.authType}".`);
  }
  if (def.authType === 'oauth2' && !def.connectorId) {
    throw new Error(`OAuth2 app "${def.id}" needs a connectorId.`);
  }
  if ((def.authType === 'none' || def.authType === 'composio') && def.connectorId) {
    throw new Error(`App "${def.id}" with authType "${def.authType}" must not have a connectorId.`);
  }
  // v0.68b: app token (PAT dán tay) phải khai báo rõ vị trí token
  // trong Vault, và không được có connectorId; app khác không được
  // khai báo vị trí Vault (tránh hai nguồn token tranh nhau một app).
  if (def.authType === 'token') {
    if (def.connectorId) {
      throw new Error(`Token app "${def.id}" must not have a connectorId.`);
    }
    if (!def.vaultNamespace || !ID_RE.test(def.vaultNamespace)) {
      throw new Error(`Token app "${def.id}" needs a valid vaultNamespace.`);
    }
    if (!def.vaultKey || !ID_RE.test(def.vaultKey)) {
      throw new Error(`Token app "${def.id}" needs a valid vaultKey.`);
    }
  } else if (def.vaultNamespace !== undefined || def.vaultKey !== undefined) {
    throw new Error(`App "${def.id}" with authType "${def.authType}" must not declare a Vault token location.`);
  }
  if (def.source === 'composio' && def.authType !== 'composio') {
    throw new Error(`Composio app "${def.id}" must use authType "composio".`);
  }
  if (def.source === 'composio' && def.id !== 'composio' && !def.toolkit) {
    throw new Error(`Composio toolkit app "${def.id}" needs a toolkit slug.`);
  }
  const names = new Set<string>();
  for (const tool of def.tools ?? []) {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error(`App "${def.id}" has a tool without a name.`);
    }
    if (names.has(tool.name)) {
      throw new Error(`App "${def.id}" lists tool "${tool.name}" twice.`);
    }
    names.add(tool.name);
  }
}

/**
 * Registry catalog app. Mở rộng bằng registerApp(), không sửa core.
 * Một tool chỉ thuộc về tối đa một app — đăng ký app thứ hai trỏ
 * cùng tên tool thì ném lỗi (tránh hai app tranh nhau một tool).
 */
export class AppRegistry {
  private readonly apps = new Map<string, AppDefinition>();
  private readonly toolToApp = new Map<string, string>();

  constructor(definitions: AppDefinition[] = BUILTIN_APPS) {
    for (const def of definitions) this.register(def);
  }

  /** Đăng ký app. Ném lỗi khi trùng id, id không hợp lệ, hoặc tool đã thuộc app khác. */
  register(def: AppDefinition): void {
    validateApp(def);
    if (this.apps.has(def.id)) {
      throw new Error(`App "${def.id}" is already registered.`);
    }
    for (const tool of def.tools) {
      const owner = this.toolToApp.get(tool.name);
      if (owner !== undefined && owner !== def.id) {
        throw new Error(
          `Tool "${tool.name}" already belongs to app "${owner}" — cannot also register it under "${def.id}".`,
        );
      }
    }
    this.apps.set(def.id, copyApp(def));
    for (const tool of def.tools) this.toolToApp.set(tool.name, def.id);
  }

  unregister(id: string): boolean {
    const def = this.apps.get(id);
    if (!def) return false;
    for (const tool of def.tools) {
      if (this.toolToApp.get(tool.name) === id) this.toolToApp.delete(tool.name);
    }
    return this.apps.delete(id);
  }

  get(id: string): AppDefinition | undefined {
    const def = this.apps.get(id);
    return def ? copyApp(def) : undefined;
  }

  has(id: string): boolean {
    return this.apps.has(id);
  }

  list(): AppDefinition[] {
    return [...this.apps.values()].map(copyApp);
  }

  size(): number {
    return this.apps.size;
  }

  /** App sở hữu một tên tool (undefined khi tool không thuộc app nào). */
  appIdForTool(toolName: string): string | undefined {
    return this.toolToApp.get(toolName);
  }

  /** Tên các tool của một app (rỗng khi app không tồn tại). */
  toolNamesForApp(appId: string): string[] {
    return this.apps.get(appId)?.tools.map((t) => t.name) ?? [];
  }
}

/** Registry mặc định của process (built-in apps). */
export const defaultAppRegistry = new AppRegistry();

/** Tạo registry mới với built-in apps + app thêm ngoài (cho test/host). */
export function createDefaultAppRegistry(extra: AppDefinition[] = []): AppRegistry {
  const registry = new AppRegistry();
  for (const def of extra) registry.register(def);
  return registry;
}

/** Liệt kê app trong registry mặc định. */
export function listApps(): AppDefinition[] {
  return defaultAppRegistry.list();
}

/** Lấy một app từ registry mặc định (undefined khi chưa đăng ký). */
export function getApp(id: string): AppDefinition | undefined {
  return defaultAppRegistry.get(id);
}

/** App sở hữu một tên tool trong registry mặc định. */
export function appIdForTool(toolName: string): string | undefined {
  return defaultAppRegistry.appIdForTool(toolName);
}

/** Tên các tool của một app trong registry mặc định. */
export function getAppToolNames(appId: string): string[] {
  return defaultAppRegistry.toolNamesForApp(appId);
}
