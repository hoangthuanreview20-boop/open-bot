/**
 * MCP Apps (v0.97, Team T1; hợp nhất v0.98 sóng T6).
 *
 * MCP Apps (first official MCP extension, 2026-01-26) let a server
 * return interactive HTML that the client renders — a form, a chart,
 * a small dashboard — instead of plain text. The host renders the
 * HTML inside a sandboxed `<iframe>` and the app talks to the host
 * only through a narrow, explicit message bridge; it never gets
 * direct access to host APIs, the file system, or the user's keys.
 *
 * This module is the host side of that contract (ideas only — no
 * code copied from any MCP implementation or the Grok Bot / Cursor
 * installers). Two APIs live here side by side, from the two waves
 * that built this feature:
 *   - v0.97 API (findings-based): `validateAppHtml` returns coded
 *     findings (`{ severity, code, message }`, English messages, i18n
 *     by code); `parseAppResource` parses the strict `resource`
 *     block; `buildAppFrameDescriptor` returns everything the
 *     renderer needs (raw srcdoc + sandbox + CSP + warnings).
 *   - v0.98 API (T6): `parseAppResult` recognises the app in a
 *     `tools/call` result in 3 wire shapes; `buildAppFrameConfig`
 *     builds the iframe config with the CSP injected as a meta tag;
 *     `AppManager` (appsManager.ts) tracks open apps.
 *
 * MERGE POLICY (v0.98, coordinator decision — the two waves built
 * conflicting validation policies, so one had to win):
 *   - Validation is the UNION of both waves' blocking rules, i.e.
 *     the stricter side wins. v0.98 T6's allowlist model is the
 *     product policy: nothing external unless the user explicitly
 *     allowlists the host; no storage, no form action, no parent
 *     access. This matches the runtime reality — the CSP already
 *     sets `connect-src 'none'` and `form-action 'none'`, and the
 *     sandbox's opaque origin has no durable storage — so v0.97's
 *     warnings for storage / external links are now blocking
 *     findings (tests/mcp-v097-apps.test.mjs was updated to assert
 *     the stricter policy).
 *   - `validateAppHtml(html, options?)` returns BOTH shapes:
 *     `findings` (v0.97, coded) and `errors` (v0.98, Vietnamese
 *     strings for the UI). The default HTML cap stays the v0.97
 *     product limit (256 KB, `MCP_APP_MAX_HTML_BYTES`); T6's
 *     `MAX_APP_HTML_BYTES` (512 KB) is kept as a named constant.
 *   - `buildAppCsp(options?)` merges both CSPs: the v0.97
 *     directives plus v0.98's `frame-src 'none'`, and
 *     `options.allowedHosts` opens `img-src`/`media-src`/
 *     `connect-src` for exactly those hosts (nothing else).
 *   - Sandbox: two flavours, both kept — `MCP_APP_IFRAME_SANDBOX`
 *     (v0.97 descriptor) and the strict `'allow-scripts'` used by
 *     `buildAppFrameConfig` / the renderer mirror (v0.98).
 */

import type { McpContentBlock, McpToolCallResult } from './types';

export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/apps';
/** MIME type of an MCP App resource. */
export const MCP_APP_MIME_TYPE = 'text/html';
/** Maximum app HTML the host accepts (256 KB) — v0.97 product limit, the default cap. */
export const MCP_APP_MAX_HTML_BYTES = 256 * 1024;
/** T6's named cap (512 KB) — kept for the v0.98 API/tests; not the default. */
export const MAX_APP_HTML_BYTES = 512 * 1024;
/** Maximum app title length. */
export const MCP_APP_MAX_TITLE_CHARS = 120;
/** Số app mở tối đa cùng lúc (xem AppManager). */
export const MAX_OPEN_APPS = 10;

/** Sandbox flags the host always applies for the v0.97 descriptor (renderer must not relax). */
export const MCP_APP_IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups-to-escape-sandbox';

/** One validation finding. `blocking` findings refuse the app. */
export interface AppValidationFinding {
  severity: 'blocking' | 'warning';
  /** Stable code, for i18n / logs (never shown raw to the model). */
  code: string;
  /** Human-readable explanation (English; UI translates by code). */
  message: string;
}

/**
 * Validation result — both waves' shapes in one object:
 * `findings` (v0.97, coded) and `errors` (v0.98, Vietnamese strings
 * of the blocking findings, for the UI).
 */
export interface AppValidationResult {
  /** True when no blocking finding exists. */
  valid: boolean;
  findings: AppValidationFinding[];
  /** Vietnamese messages of the blocking findings (v0.98 UI strings). */
  errors: string[];
}

/** An MCP App resource, as returned by the server. */
export interface McpAppResource {
  /** App URI, e.g. `ui://server/app-name`. */
  uri: string;
  /** Display title (server-provided, length-capped). */
  title?: string;
  /** The HTML document. */
  html: string;
  /** Declared MIME type — must be `text/html`. */
  mimeType?: string;
}

/** Everything the renderer needs to mount an app iframe safely (v0.97). */
export interface AppFrameDescriptor {
  /** The HTML to put in `srcdoc` (validated, size-capped). */
  srcdoc: string;
  /** Fixed sandbox attribute — renderer must apply verbatim. */
  sandbox: string;
  /** Content-Security-Policy for the iframe. */
  csp: string;
  /** App title for the frame label / accessibility. */
  title: string;
  /** App URI (for the activity log, not for navigation). */
  uri: string;
  /** Non-blocking warnings to show next to the frame. */
  warnings: AppValidationFinding[];
}

/** Một app tương tác đã qua validate, sẵn sàng render (v0.98 T6). */
export interface McpAppDefinition {
  /** Id ổn định trong phiên (AppManager sinh khi open). */
  id: string;
  /** Tên MCP server đã trả app. */
  serverName: string;
  /** Tên tool đã trả app (nếu có). */
  toolName?: string;
  /** Tiêu đề hiển thị (từ server, đã cắt ngắn). */
  title: string;
  /** HTML đã qua validate. */
  html: string;
  /** URI gốc của resource app (vd `ui://server/card`), nếu có. */
  sourceUri?: string;
  /** App tới từ đâu: kết quả tool / mở tay / app mẫu kiểm tra sandbox. */
  origin: 'tool-result' | 'manual' | 'sample';
  /** Thời điểm mở (ms epoch). */
  openedAt: number;
}

/** Tuỳ chọn validate HTML của app (v0.98 T6). */
export interface ValidateAppOptions {
  /** Kích thước tối đa (bytes UTF-8). Mặc định MCP_APP_MAX_HTML_BYTES. */
  maxBytes?: number;
  /** Host ngoài được phép (vd ['cdn.example.com']). Mặc định [] = không host nào. */
  allowedHosts?: string[];
}

/** Tuỳ chọn cho `buildAppCsp` (v0.98 T6). */
export interface AppCspOptions {
  /** Host ngoài được phép load ảnh + fetch (mặc định [] = không host nào). */
  allowedHosts?: string[];
}

export class McpAppError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppError';
    this.code = code;
  }
}

/** Lỗi khi HTML của app vi phạm policy (v0.98 T6, dùng kèm danh sách lỗi chi tiết). */
export class AppValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`MCP App bị chặn: ${errors.join('; ')}`);
    this.name = 'AppValidationError';
    this.errors = errors;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Trích host từ một URL tuyệt đối (http/https hoặc protocol-relative).
 * Trả null khi không parse được hoặc không phải URL tuyệt đối.
 */
export function hostOfUrl(raw: string): string | null {
  const value = raw.trim();
  // Mọi URL tuyệt đối có scheme (https, http, ws, wss, ...) — trước đây
  // chỉ nhận https? nên wss:// lọt qua khe kiểm tra allowlist.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      return hostname === '' ? null : hostname;
    } catch {
      return null;
    }
  }
  if (value.startsWith('//')) {
    try {
      return new URL(`https:${value}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

function isAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return lower === a || lower.endsWith(`.${a}`);
  });
}

/**
 * Validate app HTML. Returns every finding; `valid` is false when
 * any blocking finding exists. Validation never rewrites the HTML —
 * a refused app is refused, with the reason, so the server (or the
 * user) can fix it instead of seeing a silently altered app.
 *
 * Blocking rules are the union of v0.97 and v0.98 T6 (stricter side
 * wins — see the header note). `options.allowedHosts` exempts exactly
 * those hosts (and their subdomains) from the external-host rules;
 * everything else about the rule still applies.
 */
export function validateAppHtml(html: string, options: ValidateAppOptions = {}): AppValidationResult {
  const findings: AppValidationFinding[] = [];
  const errors: string[] = [];
  const maxBytes = options.maxBytes ?? MCP_APP_MAX_HTML_BYTES;
  const allowedHosts = options.allowedHosts ?? [];

  const block = (code: string, message: string, messageVi: string): void => {
    findings.push({ severity: 'blocking', code, message });
    errors.push(messageVi);
  };
  const warn = (code: string, message: string): void => {
    findings.push({ severity: 'warning', code, message });
  };

  if (typeof html !== 'string' || html.trim() === '') {
    block('app-empty', 'App HTML is empty.', 'App rỗng: server không trả HTML.');
    return { valid: false, findings, errors };
  }
  if (byteLength(html) > maxBytes) {
    block(
      'app-too-large',
      `App HTML exceeds ${maxBytes} bytes.`,
      `App quá lớn (${byteLength(html)} bytes, tối đa ${maxBytes} bytes) — server phải trả app gọn hơn.`,
    );
  }

  // --- Forbidden tags (v0.98: any <base>, any nested frame) ---
  if (/<base[\s>]/i.test(html)) {
    block(
      'app-base-href',
      'App sets a <base> href (rewrites relative URLs).',
      'Thẻ <base> bị cấm — app không được đổi base URL của trang.',
    );
  }
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) {
    block(
      'app-meta-refresh',
      'App uses meta refresh (forced navigation).',
      'Meta refresh bị cấm — app không được tự điều hướng.',
    );
  }
  for (const tag of ['iframe', 'object', 'embed', 'portal']) {
    if (new RegExp(`<${tag}[\\s>]`, 'i').test(html)) {
      block(
        'app-nested-frame',
        `App uses a nested <${tag}> (apps must not open child frames).`,
        `Thẻ <${tag}> bị cấm — app không được mở frame/object con.`,
      );
    }
  }

  // --- Dangerous URI schemes anywhere (v0.97 + v0.98) ---
  if (/javascript\s*:/i.test(html) || /data\s*:\s*text\/html/i.test(html) || /vbscript\s*:/i.test(html)) {
    block(
      'app-javascript-url',
      'App uses a javascript:/data:text/html/vbscript: URL.',
      'URI javascript:/data:text/html/vbscript: bị cấm trong app.',
    );
  }

  // --- External hosts in resource attributes (v0.97 specific codes,
  // v0.98 generic allowlist rule — both fire, both are blocking) ---
  const attrRe = /(?:src|href|action|poster|data)\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  const externalHosts = new Set<string>();
  while ((match = attrRe.exec(html)) !== null) {
    const host = hostOfUrl(match[1] ?? '');
    if (host !== null && !isAllowedHost(host, allowedHosts)) externalHosts.add(host);
  }
  // Remote <script src> (v0.97 code; allowlist-aware per v0.98).
  const scriptSrcRe = /<script[^>]+src\s*=\s*["'](https?:[^"']+)["']/gi;
  while ((match = scriptSrcRe.exec(html)) !== null) {
    const host = hostOfUrl(match[1] ?? '');
    if (host !== null && !isAllowedHost(host, allowedHosts)) {
      block(
        'app-remote-script',
        'App loads a remote script (apps must be self-contained).',
        `App load script từ host ngoài allowlist: ${host} — thêm host vào allowlist hoặc nhúng script vào HTML.`,
      );
      break;
    }
  }
  // Remote resources on media/link/frame tags (v0.97 code).
  const mediaRe =
    /<(?:img|link|iframe|video|audio|source|embed|object)[^>]*\s(?:src|href)\s*=\s*["'](https?:[^"']+)["']/gi;
  while ((match = mediaRe.exec(html)) !== null) {
    const host = hostOfUrl(match[1] ?? '');
    if (host !== null && !isAllowedHost(host, allowedHosts)) {
      block(
        'app-external-resource',
        'App loads a remote image, stylesheet or frame (apps must be self-contained).',
        `App load tài nguyên từ host ngoài allowlist: ${host} — thêm host vào allowlist hoặc nhúng tài nguyên vào HTML.`,
      );
      break;
    }
  }
  // Generic external-host rule (v0.98): every external host in any
  // resource attribute must be allowlisted. This also covers <a href>,
  // which v0.97 only warned about.
  for (const host of externalHosts) {
    block(
      'app-external-host',
      `App loads a resource from a host outside the allowlist: ${host}.`,
      `App load tài nguyên từ host ngoài allowlist: ${host} — thêm host vào allowlist hoặc nhúng tài nguyên vào HTML.`,
    );
  }

  // --- Remote code import (v0.97 @import, v0.98 import()) ---
  if (/@import\s+["']https?:/i.test(html)) {
    block(
      'app-remote-import',
      'App imports remote code (apps must be self-contained).',
      'App import code từ xa bị cấm — app phải tự chứa.',
    );
  }
  const importRe = /import\s*\(\s*["']([^"']+)["']/gi;
  while ((match = importRe.exec(html)) !== null) {
    const host = hostOfUrl(match[1] ?? '');
    if (host !== null && !isAllowedHost(host, allowedHosts)) {
      block(
        'app-remote-import',
        'App imports remote code (apps must be self-contained).',
        `App import() từ host ngoài allowlist: ${host}.`,
      );
    }
  }

  // --- Form action (v0.97: remote only; v0.98: any action) ---
  const formAction = /<form[^>]+action\s*=\s*(["'])([^"']*)\1/i.exec(html);
  if (formAction) {
    block(
      'app-form-action',
      'App submits a form (forms in apps must not submit anywhere).',
      'Thuộc tính action của <form> bị cấm — form trong app không được gửi đi.',
    );
    const actionUrl = formAction[2] ?? '';
    if (/^https?:/i.test(actionUrl)) {
      block(
        'app-form-remote',
        'App submits a form to a remote origin.',
        `Form trong app gửi tới host ngoài: ${hostOfUrl(actionUrl) ?? actionUrl}.`,
      );
    }
  }

  // --- Network calls from JS (v0.97 + v0.98, allowlist-aware) ---
  const callRe = /(?:fetch|XMLHttpRequest|sendBeacon)\s*\(\s*["']([^"']+)["']/gi;
  while ((match = callRe.exec(html)) !== null) {
    const host = hostOfUrl(match[1] ?? '');
    if (host !== null && !isAllowedHost(host, allowedHosts)) {
      block(
        'app-fetch-remote',
        'App fetches a remote URL directly (apps ask the host for live data).',
        `App gọi mạng tới host ngoài allowlist: ${host} — dùng host đã cho phép hoặc bỏ gọi mạng.`,
      );
    }
  }
  const wsRe = /new\s+WebSocket\s*\(\s*["']([^"']+)["']/gi;
  while ((match = wsRe.exec(html)) !== null) {
    const host = hostOfUrl(match[1] ?? '');
    if (host !== null && !isAllowedHost(host, allowedHosts)) {
      block(
        'app-websocket-remote',
        'App opens a remote WebSocket (apps ask the host for live data).',
        `App mở WebSocket tới host ngoài allowlist: ${host}.`,
      );
    }
  }
  // EventSource with an absolute URL outside the allowlist (v0.98).
  const esRe = /new\s+EventSource\s*\(\s*["']([^"']+)["']/gi;
  while ((match = esRe.exec(html)) !== null) {
    const host = hostOfUrl(match[1] ?? '');
    if (host !== null && !isAllowedHost(host, allowedHosts)) {
      block(
        'app-fetch-remote',
        'App opens a remote EventSource directly (apps ask the host for live data).',
        `App gọi mạng tới host ngoài allowlist: ${host} — dùng host đã cho phép hoặc bỏ gọi mạng.`,
      );
    }
  }

  // --- Top navigation / parent access (v0.97 + v0.98) ---
  if (/window\s*\.\s*top\s*(?:\.location|=\s*)|top\s*\.\s*location|target\s*=\s*["']_top["']/i.test(html)) {
    block(
      'app-top-navigation',
      'App tries to navigate the top-level window.',
      'App không được điều hướng cửa sổ chính.',
    );
  }
  if (
    /window\s*\.\s*parent\s*\.\s*(?!postMessage)|parent\s*\.\s*document|parent\s*\.\s*localStorage|parent\s*\.\s*indexedDB/i.test(html) ||
    /\bwindow\s*\.\s*(top|parent)\b/i.test(html) ||
    /\btop\s*\.\s*(document|postMessage)\b/i.test(html)
  ) {
    block(
      'app-parent-access',
      'App accesses the parent window directly (use the message bridge).',
      'App không được chạm window.top / window.parent / top.location — app chạy trong sandbox, không thấy khung cha.',
    );
  }
  if (/postMessage\s*\([^,]+,\s*["']\*["']\s*\)/i.test(html)) {
    block(
      'app-wildcard-postmessage',
      'App posts a message to any origin ("*").',
      'App không được postMessage tới mọi origin ("*").',
    );
  }

  // --- Dynamic code execution (v0.97) ---
  if (/\beval\s*\(|new\s+Function\s*\(/i.test(html)) {
    block(
      'app-eval',
      'App uses eval / new Function (dynamic code execution).',
      'App không được dùng eval / new Function.',
    );
  }

  // --- Cookie / storage (v0.97 warned, v0.98 blocks — strict wins) ---
  if (/\bdocument\s*\.\s*cookie\b/i.test(html)) {
    block(
      'app-cookie-access',
      'App reads document.cookie.',
      'App không được đọc document.cookie.',
    );
  }
  if (/\b(localStorage|sessionStorage)\b/.test(html)) {
    block(
      'app-localstorage',
      'App uses web storage (the sandboxed opaque origin has no durable storage).',
      'App không được dùng localStorage/sessionStorage (origin mờ của sandbox không có storage bền).',
    );
  }

  // --- Warnings (non-blocking, v0.97) ---
  if (/\son\w+\s*=\s*["']/i.test(html)) {
    warn(
      'app-inline-event-handler',
      'App uses inline event handlers; prefer addEventListener.',
    );
  }
  if (/[\s\S]{200000,}/.test(html)) {
    warn('app-large-html', 'App HTML is large (over ~200 KB); rendering may be slow.');
  }

  return { valid: !findings.some((f) => f.severity === 'blocking'), findings, errors };
}

/** Ném AppValidationError khi HTML không hợp lệ (v0.98 T6, tiện cho code gọi muốn fail nhanh). */
export function assertValidAppHtml(html: string, options: ValidateAppOptions = {}): void {
  const result = validateAppHtml(html, options);
  if (!result.valid) throw new AppValidationError(result.errors);
}

/**
 * Build the Content-Security-Policy for an app iframe (merged
 * v0.97 + v0.98). Deliberately strict: no network at all
 * (`default-src 'none'`), inline scripts and styles only, no
 * plugins, no top navigation, forms only to the same (null) origin.
 * `options.allowedHosts` opens `img-src` / `media-src` /
 * `connect-src` for exactly those hosts (v0.98).
 */
export function buildAppCsp(options: AppCspOptions = {}): string {
  const hosts = (options.allowedHosts ?? []).map((h) => `https://${h.toLowerCase()}`);
  const imgSrc = ['data:', 'blob:', ...hosts].join(' ');
  const connectSrc = hosts.length > 0 ? hosts.join(' ') : "'none'";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src ${imgSrc}`,
    `media-src ${imgSrc}`,
    "font-src data:",
    `connect-src ${connectSrc}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Parse the `resource` block a server returns for an app (v0.97).
 * Throws `McpAppError` on a wrong MIME type, a non-`ui://` URI, or
 * an over-long title — the renderer never receives an app it cannot
 * safely label and mount.
 */
export function parseAppResource(value: unknown): McpAppResource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpAppError('App resource is not an object.', 'app-not-object');
  }
  const rec = value as Record<string, unknown>;
  const uri = rec['uri'];
  if (typeof uri !== 'string' || !uri.startsWith('ui://')) {
    throw new McpAppError('App resource uri must start with "ui://".', 'app-bad-uri');
  }
  const html = rec['html'] ?? rec['text'];
  if (typeof html !== 'string' || html.length === 0) {
    throw new McpAppError('App resource has no HTML.', 'app-no-html');
  }
  const mimeType = rec['mimeType'];
  if (mimeType !== undefined && mimeType !== MCP_APP_MIME_TYPE) {
    throw new McpAppError(
      `App resource mimeType must be "${MCP_APP_MIME_TYPE}".`,
      'app-bad-mime',
    );
  }
  const title = rec['title'];
  if (title !== undefined && typeof title !== 'string') {
    throw new McpAppError('App resource title must be a string.', 'app-bad-title');
  }
  if (typeof title === 'string' && title.length > MCP_APP_MAX_TITLE_CHARS) {
    throw new McpAppError(
      `App title exceeds ${MCP_APP_MAX_TITLE_CHARS} characters.`,
      'app-title-too-long',
    );
  }
  return {
    uri,
    ...(typeof title === 'string' ? { title } : {}),
    html,
    mimeType: MCP_APP_MIME_TYPE,
  };
}

/**
 * Validate an app and build everything the renderer needs to mount
 * it (v0.97). Throws `McpAppError` when validation blocks the app
 * (the first blocking finding is the error message); warnings travel
 * in the descriptor so the UI can show them next to the frame.
 */
export function buildAppFrameDescriptor(app: McpAppResource): AppFrameDescriptor {
  const validation = validateAppHtml(app.html);
  if (!validation.valid) {
    const first = validation.findings.find((f) => f.severity === 'blocking');
    throw new McpAppError(
      `MCP App refused: ${first?.message ?? 'validation failed.'}`,
      first?.code ?? 'app-invalid',
    );
  }
  return {
    srcdoc: app.html,
    sandbox: MCP_APP_IFRAME_SANDBOX,
    csp: buildAppCsp(),
    title: app.title ?? app.uri,
    uri: app.uri,
    warnings: validation.findings.filter((f) => f.severity === 'warning'),
  };
}

/**
 * Cấu hình iframe cho một app đã validate (v0.98 T6): giá trị
 * `sandbox`, chuỗi CSP và tài liệu `srcdoc` hoàn chỉnh. Renderer chỉ
 * việc gán 3 giá trị này vào `<iframe sandbox={...} srcDoc={...}>` —
 * không tự chế CSP riêng.
 *
 * `sandbox` LUÔN là đúng `'allow-scripts'`: không allow-same-origin
 * (origin mờ), không allow-top-navigation, không allow-forms, không
 * allow-popups, không allow-modals.
 */
export interface AppFrameConfig {
  /** Giá trị thuộc tính sandbox của iframe — luôn 'allow-scripts'. */
  sandbox: string;
  /** Chuỗi CSP (đã nhúng vào srcdoc). */
  csp: string;
  /** Tài liệu HTML đầy đủ cho thuộc tính srcDoc. */
  srcdoc: string;
}

export function buildAppFrameConfig(
  app: Pick<McpAppDefinition, 'title' | 'html'>,
  options: AppCspOptions = {},
): AppFrameConfig {
  const csp = buildAppCsp(options);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`;
  const title = `<title>${escapeHtml(app.title || 'MCP App')}</title>`;
  let doc: string;
  if (/<html[\s>]/i.test(app.html)) {
    // Tài liệu đầy đủ: chèn CSP + title vào <head> nếu có, ngược lại
    // chèn ngay sau <html>.
    if (/<head[\s>]/i.test(app.html)) {
      doc = app.html.replace(/<head[\s>]/i, (m) => `${m}${meta}${title}`);
    } else {
      doc = app.html.replace(/<html[\s>]/i, (m) => `${m}<head>${meta}${title}</head>`);
    }
  } else {
    // Đoạn HTML lẻ: bọc thành tài liệu đầy đủ.
    doc =
      `<!doctype html><html><head><meta charset="utf-8">${meta}${title}` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
      `<body>${app.html}</body></html>`;
  }
  return { sandbox: 'allow-scripts', csp, srcdoc: doc };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function titleOf(block: McpContentBlock, fallback: string): string {
  const title = asNonEmptyString(block.title) ?? asNonEmptyString(block.name);
  if (title) return title.slice(0, 120);
  const resource = isRecord(block.resource) ? block.resource : undefined;
  const resourceTitle =
    asNonEmptyString(resource?.['title']) ?? asNonEmptyString(resource?.['name']);
  if (resourceTitle) return resourceTitle.slice(0, 120);
  return fallback;
}

/** Kết quả nhận diện app trong một tool result (v0.98 T6). */
export interface ParsedAppResult {
  /** App đã validate (null khi không có app, hoặc app bị chặn). */
  app: Omit<McpAppDefinition, 'id' | 'openedAt'> | null;
  /** Lý do chặn (chỉ khi server CÓ trả app nhưng validate rớt). */
  blocked?: string;
}

/**
 * Nhận diện app trong kết quả `tools/call` (v0.98 T6). 3 wire shapes:
 *  A. content block `{ type: 'resource', resource: { uri, mimeType:
 *     'text/html', text: '<html>…' } }` — dạng chuẩn của MCP Apps.
 *  B. content block `{ type: 'app', html: '<html>…', title?: string }`
 *     — dạng rút gọn do open-bot tự quy ước cho server nội bộ.
 *  C. `structuredContent.app = { html, title? }` (hoặc
 *     `structuredContent.html` trực tiếp).
 * Chỉ block app ĐẦU TIÊN được lấy; app không hợp lệ thì bị chặn với
 * lý do rõ ràng (`blocked`), không throw, không render một phần.
 */
export function parseAppResult(
  result: Pick<McpToolCallResult, 'content' | 'structuredContent'>,
  context: { serverName: string; toolName?: string },
  options: ValidateAppOptions = {},
): ParsedAppResult {
  const fallbackTitle = context.toolName
    ? `App từ ${context.toolName}`
    : `App từ ${context.serverName}`;
  let rawHtml: string | undefined;
  let rawTitle: string | undefined;
  let sourceUri: string | undefined;

  for (const block of result.content ?? []) {
    // Dạng A: resource text/html (chuẩn MCP Apps).
    if (block.type === 'resource') {
      const resource = isRecord(block.resource) ? block.resource : undefined;
      const mime = asNonEmptyString(block.mimeType) ?? asNonEmptyString(resource?.['mimeType']);
      const text = asNonEmptyString(block.text) ?? asNonEmptyString(resource?.['text']);
      if (mime === 'text/html' && text) {
        rawHtml = text;
        rawTitle = titleOf(block, fallbackTitle);
        sourceUri = asNonEmptyString(block.uri) ?? asNonEmptyString(resource?.['uri']);
        break;
      }
      continue;
    }
    // Dạng B: block app rút gọn của open-bot.
    if (block.type === 'app') {
      const html = asNonEmptyString(block.html);
      if (html) {
        rawHtml = html;
        rawTitle = titleOf(block, fallbackTitle);
        sourceUri = asNonEmptyString(block.uri);
        break;
      }
      continue;
    }
  }

  // Dạng C: structuredContent.app / structuredContent.html.
  if (rawHtml === undefined && isRecord(result.structuredContent)) {
    const structured = result.structuredContent;
    const appField = structured['app'];
    if (isRecord(appField)) {
      const html = asNonEmptyString(appField['html']);
      if (html) {
        rawHtml = html;
        rawTitle = asNonEmptyString(appField['title'])?.slice(0, 120) ?? fallbackTitle;
        sourceUri = asNonEmptyString(appField['uri']);
      }
    } else {
      const html = asNonEmptyString(structured['html']);
      if (html) {
        rawHtml = html;
        rawTitle = asNonEmptyString(structured['title'])?.slice(0, 120) ?? fallbackTitle;
      }
    }
  }

  if (rawHtml === undefined) return { app: null };
  const validation = validateAppHtml(rawHtml, options);
  if (!validation.valid) {
    return { app: null, blocked: validation.errors.join('; ') };
  }
  return {
    app: {
      serverName: context.serverName,
      toolName: context.toolName,
      title: rawTitle ?? fallbackTitle,
      html: rawHtml,
      sourceUri,
      origin: 'tool-result',
    },
  };
}

/**
 * The message bridge: the only channel between app and host. The app
 * posts `{ type: 'mcp-app-request', ... }` and the host answers with
 * `{ type: 'mcp-app-response', ... }`. Validate inbound messages
 * here so a compromised app cannot smuggle an unexpected shape into
 * the host: unknown types are dropped, and the payload must be a
 * plain object.
 */
export interface McpAppBridgeMessage {
  type: 'mcp-app-request';
  /** What the app asks for: `tool-call` / `notify` / `close`. */
  action: string;
  payload?: Record<string, unknown>;
}

export function parseAppBridgeMessage(value: unknown): McpAppBridgeMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (rec['type'] !== 'mcp-app-request') return null;
  if (typeof rec['action'] !== 'string' || rec['action'].length === 0) return null;
  const allowedActions = ['tool-call', 'notify', 'close', 'get-data'];
  if (!allowedActions.includes(rec['action'])) return null;
  if (rec['payload'] !== undefined && (typeof rec['payload'] !== 'object' || rec['payload'] === null)) {
    return null;
  }
  return {
    type: 'mcp-app-request',
    action: rec['action'],
    ...(rec['payload'] !== undefined
      ? { payload: rec['payload'] as Record<string, unknown> }
      : {}),
  };
}
