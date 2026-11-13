/**
 * Renderer-side MCP Apps frame helper (v0.98, wave T6).
 *
 * Self-contained on purpose (no import from @open-bot/core — the
 * renderer stays import-free, see types.ts). It MIRRORS the policy in
 * packages/core/src/mcp/apps.ts: `buildAppCsp` /
 * `buildAppFrameConfig`. The two implementations must stay identical —
 * tests/mcp-apps-v098.test.mjs asserts the core and renderer outputs
 * match for the same inputs, so a policy drift fails loudly instead of
 * silently opening a hole.
 *
 * Policy (same as core):
 *  - iframe sandbox is ALWAYS exactly 'allow-scripts': no
 *    allow-same-origin (opaque origin), no top navigation, no forms,
 *    no popups.
 *  - CSP: no network by default (connect-src 'none'); images/media
 *    only from data:/blob: plus explicitly allowed hosts.
 *  - The sample app below is the only HTML this file ships: a tiny
 *    self-contained counter used to verify the sandbox end-to-end
 *    without any MCP server. It loads nothing external, stores
 *    nothing, and calls no network.
 */

export const MCP_APP_SANDBOX = 'allow-scripts';

/**
 * Build the Content-Security-Policy for an app document. Must match
 * `buildAppCsp` in packages/core/src/mcp/apps.ts exactly.
 */
export function buildRendererAppCsp(allowedHosts: string[] = []): string {
  const hosts = allowedHosts.map((h) => `https://${h.toLowerCase()}`);
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the full srcDoc document for an app. Must match
 * `buildAppFrameConfig` in packages/core/src/mcp/apps.ts (same CSP
 * meta injection, same fragment wrapping).
 */
export function buildRendererAppSrcdoc(
  title: string,
  html: string,
  allowedHosts: string[] = [],
): string {
  const csp = buildRendererAppCsp(allowedHosts);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`;
  const titleTag = `<title>${escapeHtml(title || 'MCP App')}</title>`;
  if (/<html[\s>]/i.test(html)) {
    if (/<head[\s>]/i.test(html)) {
      return html.replace(/<head[\s>]/i, (m) => `${m}${meta}${titleTag}`);
    }
    return html.replace(/<html[\s>]/i, (m) => `${m}<head>${meta}${titleTag}</head>`);
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">${meta}${titleTag}` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body>${html}</body></html>`
  );
}

/** Human-readable byte size for the apps list (e.g. 512 B, 3.2 KB). */
export function formatAppBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Built-in sample app: a self-contained counter. Opening it proves the
 * sandbox works (scripts run, but the app cannot reach the network,
 * storage, or the parent window). English strings only — the view
 * labels around it come from i18n.
 */
export const SAMPLE_APP_HTML =
  `<div style="font-family: sans-serif; padding: 16px; max-width: 420px;">` +
  `<h2 style="margin: 0 0 8px;">Sandbox check</h2>` +
  `<p style="margin: 0 0 12px; color: #555;">This app runs inside a sandboxed iframe. ` +
  `It can run scripts, but it cannot reach the network, storage, or the main window.</p>` +
  `<p style="font-size: 28px; margin: 0 0 12px;">Count: <strong id="n">0</strong></p>` +
  `<button id="inc" style="padding: 8px 16px; font-size: 15px;">+1</button> ` +
  `<button id="reset" style="padding: 8px 16px; font-size: 15px;">Reset</button>` +
  `<script>var n = 0;` +
  `document.getElementById('inc').addEventListener('click', function () { n += 1; document.getElementById('n').textContent = n; });` +
  `document.getElementById('reset').addEventListener('click', function () { n = 0; document.getElementById('n').textContent = n; });` +
  `</script></div>`;
