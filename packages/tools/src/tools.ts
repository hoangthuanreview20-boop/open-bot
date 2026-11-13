/**
 * Tool implementations for @open-bot/tools.
 *
 * Contract with @open-bot/core (imported as types only — erased at runtime):
 *   Tool { definition: ToolDefinition; needsApproval: boolean;
 *          execute(args, ctx): Promise<string> }
 * The core agent handles approval from `needsApproval`; tools only execute
 * safely and return a string (truncated to at most 20_000 chars).
 *
 * Safety rules:
 *  - Every file/shell operation goes through the sandbox (resolveWithin /
 *    runShell). There is no path out of ctx.workspaceDir.
 *  - No user data leaves the machine except through web_search / web_fetch /
 *    http_get, and only to the exact URL the agent/user asked for.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '@open-bot/core';
import type { EgressPolicy } from '@open-bot/core/dist/egress/policy';
import {
  assertCommandAllowed,
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  resolveWithin,
  runShell,
  safeEnv,
} from './sandbox';
import { shellQuote } from './shellQuote';
import { fetchPublic } from './ssrf';
import type { ShellDaemon } from './daemon/types';
import { createToolBlobTools, truncateWithBlob } from './blobStore';
import { MAX_TOOL_RESULT_CHARS, truncateText } from './truncate';
import {
  extractOfficeText,
  isOfficeExtension,
  MAX_OFFICE_READ_BYTES,
} from './officeDocs';
// --- v0.89 (worker F4): data / http / text / office-write tools ---
import { DATA_TOOLS } from './dataTools';
import { createHttpTools, HTTP_TOOLS } from './httpTools';
import { OFFICE_WRITE_TOOLS } from './officeWriteTools';
import { TEXT_TOOLS } from './textTools';
// --- v0.98 (T6): git_log KHÔNG gộp vào ALL_TOOLS — v0.97's
// gitWorkflowTools đã đăng ký `git_log` (xem ./gitLog.ts); đăng ký cả
// hai sẽ trùng tên trong registry. Các filter until/grep/stat của T6
// đã port sang gitWorkflowTools.git_log.
// --- v0.95 (Team D1): internet data (clean fetch for web_fetch) ---
import { createInternetDataTools, extractReadableText, INTERNET_DATA_TOOLS } from './internetData';
import type { WatchChangeEvent } from './internetData';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri
// 20.000) — re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };
const MAX_READ_BYTES = 100_000;
const MAX_LIST_ITEMS = 200;
const FETCH_TIMEOUT_MS = 20_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * v0.41 (P0-3, `TruncatedToolCall` kiểu Grok): kết quả dài hơn ngưỡng
 * được lưu nguyên văn vào blob store và chỉ trả preview kèm `blob_id`
 * + `original_size_bytes` (xem blobStore.ts) — agent lấy phần đầy đủ
 * bằng `tool_blob_fetch`. Khi không có workspaceDir (hoặc ghi blob
 * lỗi) thì rơi về cắt cứng kiểu cũ — footer cũ giữ nguyên chuỗi con
 * `truncated to <N> chars` để tương thích ngược.
 */
function truncate(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS, workspaceDir?: string): string {
  if (workspaceDir) return truncateWithBlob(text, workspaceDir, maxChars);
  // Cat cung kieu cu — nay dung helper dung chung (./truncate).
  return truncateText(text, maxChars);
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

/** fetch() with a hard timeout. Throws on timeout / network error. */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http:// and https:// URLs are allowed, got "${url.protocol}"`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

const readFileTool: Tool = {
  definition: {
    name: 'read_file',
    description:
      'Read a file inside the workspace. Plain text files return their contents (max 100KB). PDF, DOCX and XLSX files return extracted text (max 5MB): PDF text per page (scanned image PDFs have no text layer and cannot be read — no OCR), DOCX text with headings and tables, XLSX text per sheet with sheet names. Encrypted or corrupted files return an error.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const fullPath = resolveWithin(ctx.workspaceDir, relPath);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return errorResult(`Not a file: "${relPath}"`);
      const ext = path.extname(relPath).toLowerCase();
      if (isOfficeExtension(ext)) {
        // Office documents are binary containers — never read as UTF-8.
        // They get a larger byte cap than plain text (5 MB vs 100 KB:
        // the formats are compressed, so 100 KB would reject most real
        // documents); the extracted text is still truncated to
        // MAX_TOOL_RESULT_CHARS exactly like plain text (see officeDocs).
        if (stat.size > MAX_OFFICE_READ_BYTES) {
          return errorResult(
            `File is ${stat.size} bytes, over the ${MAX_OFFICE_READ_BYTES} byte read limit for office documents: "${relPath}"`,
          );
        }
        const text = await extractOfficeText(ext, fs.readFileSync(fullPath));
        return truncate(text, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
      }
      if (stat.size > MAX_READ_BYTES) {
        return errorResult(
          `File is ${stat.size} bytes, over the ${MAX_READ_BYTES} byte read limit: "${relPath}"`,
        );
      }
      return truncate(fs.readFileSync(fullPath, 'utf8'), MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const writeFileTool: Tool = {
  definition: {
    name: 'write_file',
    description:
      'Write (create or overwrite) a text file inside the workspace. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
        content: { type: 'string', description: 'Full text content to write.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const content = getStringArg(args, 'content');
      const fullPath = resolveWithin(ctx.workspaceDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to "${relPath}".`;
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const listFilesTool: Tool = {
  definition: {
    name: 'list_files',
    description:
      'List entries in a directory inside the workspace (max 200 items), marking files vs directories with sizes.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list, relative to the workspace root. Defaults to the workspace root.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const relPath = args['path'] === undefined ? '.' : getStringArg(args, 'path', false);
      const fullPath = resolveWithin(ctx.workspaceDir, relPath);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) return errorResult(`Not a directory: "${relPath}"`);
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const shown = entries.slice(0, MAX_LIST_ITEMS);
      const lines = shown.map((entry) => {
        if (entry.isDirectory()) return `DIR  ${entry.name}/`;
        let size = 0;
        try {
          size = fs.statSync(path.join(fullPath, entry.name)).size;
        } catch {
          size = 0;
        }
        return `FILE ${entry.name} (${size} bytes)`;
      });
      const note =
        entries.length > MAX_LIST_ITEMS
          ? `\n[... showing ${MAX_LIST_ITEMS} of ${entries.length} entries ...]`
          : '';
      return truncate(`Directory "${relPath}" — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}${note}`, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Shell tool
// ---------------------------------------------------------------------------

/**
 * Build the shell_exec tool.
 *
 * When `getDaemon` is given and returns a live daemon client, the command
 * runs in the local-exec-daemon child process (crash-isolated, killable);
 * otherwise it runs in-process via runShell (same sandbox rules either
 * way). The sandbox checks (denylist + cwd confinement) always run in
 * the tool FIRST — the daemon re-checks them per request as
 * defence-in-depth (v0.15/v0.16), using the `workspaceDir` passed here
 * (request workspaceDir > daemon workspaceDir > không giam).
 *
 * v0.55: `opts.getEgressPolicy` — resolver policy egress hiệu lực của
 * team hiện tại (coordinator truyền xuống, xem `ToolFactoryHost`).
 * Resolve lười mỗi lần chạy nên sửa team.json có hiệu lực ngay.
 *  - Đường in-process: resolver đi thẳng vào `runShell` (provider
 *    thắng policy module; `undefined` → fail-closed, `null` → tắt).
 *  - Đường daemon: policy đã resolve được mang theo từng request
 *    (`egressPolicy` — daemon ưu tiên policy request hơn policy chung
 *    của nó); resolver trả `undefined` thì không mang theo gì (daemon
 *    dùng policy của nó); `null` cũng không mang theo (daemon coi
 *    `null` là policy sai → BAD_REQUEST, còn `null` vốn chỉ dành cho
 *    test/caller cũ trên đường in-process).
 *
 * Output format is identical on both paths so the agent sees the same
 * shape: `exit code: N`, then `--- stdout ---` / `--- stderr ---`.
 */
export function createShellExecTool(
  getDaemon?: () => ShellDaemon | null,
  opts?: { getEgressPolicy?: () => EgressPolicy | null | undefined },
): Tool {
  return {
    definition: {
      name: 'shell_exec',
      description:
        'Run a shell command inside the workspace directory. Blocked: destructive commands (rm -rf /, mkfs, dd, shutdown, sudo, piping to a shell, ...). Timeout 60s.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const command = getStringArg(args, 'command');
        // Sandbox FIRST: denylist + cwd confinement, before anything
        // reaches the daemon (the daemon re-checks per request as
        // defence-in-depth, v0.15/v0.16).
        assertCommandAllowed(command);
        const cwd = resolveWithin(ctx.workspaceDir, ctx.workspaceDir);
        const daemon = getDaemon?.() ?? null;
        if (!daemon) {
          const result = await runShell(command, cwd, {
            workspaceDir: ctx.workspaceDir,
            signal: ctx.signal,
            // v0.55: policy egress của team hiện tại (resolve lười).
            getEgressPolicy: opts?.getEgressPolicy,
          });
          return formatShellResult(result.code, result.stdout, result.stderr, false, ctx.workspaceDir);
        }
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'powershell' : '/bin/sh';
        const shellArgs = isWindows ? ['-NoProfile', '-Command', command] : ['-c', command];
        const execId = randomUUID();
        let stdout = '';
        let stderr = '';
        const onAbort = (): void => {
          void daemon.kill(execId).catch(() => undefined);
        };
        if (ctx.signal) {
          if (ctx.signal.aborted) {
            await daemon.kill(execId).catch(() => undefined);
            return errorResult('Shell command aborted before it started.');
          }
          ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          // v0.55: policy egress của team hiện tại mang theo request —
          // daemon ưu tiên policy request hơn policy chung của nó.
          // Chỉ mang theo khi resolve ra policy thật (object); `undefined`
          // (không có policy) thì để daemon tự resolve/fail-closed theo
          // policy của nó, `null` (tắt) không có dạng hợp lệ trên đường
          // daemon nên cũng bỏ qua.
          const egressPolicy = opts?.getEgressPolicy?.();
          const result = await daemon.exec(
            {
              command: shell,
              args: shellArgs,
              cwd,
              // v0.16 (M1 đa bot): giam exec này theo đúng workspace của
              // bot gọi — daemon dùng chung cho nhiều bot nên mỗi
              // request phải mang theo workspaceDir của mình.
              workspaceDir: ctx.workspaceDir,
              // safeEnv() allowlist only: a shell child must never
              // inherit secrets from the parent process's env.
              env: { ...safeEnv() } as Record<string, string>,
              timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
              ...(egressPolicy ? { egressPolicy } : {}),
            },
            {
              onStdout: (chunk) => {
                if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
              },
              onStderr: (chunk) => {
                if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
              },
            },
            execId,
          );
          return formatShellResult(result.exitCode, stdout, stderr, result.timedOut, ctx.workspaceDir);
        } finally {
          ctx.signal?.removeEventListener('abort', onAbort);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

/** Shared output format for the shell tool (daemon path + in-process path). */
function formatShellResult(
  code: number | null,
  stdout: string,
  stderr: string,
  timedOut: boolean,
  workspaceDir?: string,
): string {
  const out: string[] = [
    `exit code: ${code === null ? 'null (timed out / killed)' : code}`,
  ];
  const stdoutText = stdout.length > MAX_OUTPUT_CHARS ? stdout.slice(0, MAX_OUTPUT_CHARS) : stdout;
  const stderrText = stderr.length > MAX_OUTPUT_CHARS ? stderr.slice(0, MAX_OUTPUT_CHARS) : stderr;
  if (stdoutText.trim()) out.push(`--- stdout ---\n${stdoutText}`);
  if (stderrText.trim()) out.push(`--- stderr ---\n${stderrText}`);
  if (timedOut) out.push(`[shell: killed after ${DEFAULT_SHELL_TIMEOUT_MS}ms timeout]`);
  return truncate(out.join('\n'), MAX_TOOL_RESULT_CHARS, workspaceDir);
}

/** No-daemon shell tool (in-process runShell). Kept for ALL_TOOLS. */
const shellExecTool: Tool = createShellExecTool();

// ---------------------------------------------------------------------------
// Web tools (no API key; only fetch the exact URL the agent/user asked for)
// ---------------------------------------------------------------------------


/** Parse DuckDuckGo HTML results (max 8). Returns [] when nothing parses. */
export function parseDuckDuckGoResults(html: string): Array<{ href: string; title: string; snippet: string }> {
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ href: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < 8) {
    let href = decodeHtmlEntities(m[1] ?? '');
    // DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<url-encoded target>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        // Keep the wrapped link.
      }
    }
    links.push({ href, title: stripHtml(m[2] ?? '') });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 8) {
    snippets.push(stripHtml(m[1] ?? ''));
  }
  return links.map((link, i) => ({ ...link, snippet: snippets[i] ?? '' }));
}

/**
 * Unwrap a Bing redirect link (`bing.com/ck/a?...&u=a1<target>`) to its
 * destination URL. Returns the original href when it is not such a link
 * or the target cannot be recovered.
 */
export function unwrapBingRedirect(href: string): string {
  try {
    const url = new URL(href);
    if (
      url.hostname.endsWith('bing.com') &&
      (url.pathname === '/ck/a' || url.pathname === '/aclick')
    ) {
      const u = url.searchParams.get('u');
      if (u) {
        const candidates = [
          u,
          u.replace(/^a1/, ''),
          decodeURIComponent(u),
          decodeURIComponent(u).replace(/^a1/, ''),
        ];
        for (const candidate of candidates) {
          if (/^https?:\/\//.test(candidate)) return candidate;
        }
        // Bing's newer redirect format: u=a1<base64url of the target URL>
        // (e.g. a1aHR0cHM6Ly9leGFtcGxlLmNvbS8...). Strip the "a1" prefix,
        // base64-decode (URL-safe alphabet, padding restored) and return
        // the decoded URL when it looks like one.
        const stripped = u.replace(/^a1/, '');
        if (/^[A-Za-z0-9_-]+={0,2}$/.test(stripped) && stripped.length >= 8) {
          try {
            const decoded = Buffer.from(
              stripped.replace(/-/g, '+').replace(/_/g, '/'),
              'base64',
            ).toString('utf-8');
            if (/^https?:\/\//.test(decoded)) return decoded;
          } catch {
            // Not valid base64 — keep the original href below.
          }
        }
      }
    }
  } catch {
    // Not a parseable URL — keep the original href.
  }
  return href;
}

/**
 * Fallback search via Bing HTML (no API key). Parses up to 8 results from
 * `<li class="b_algo"><h2><a href=...>title</a></h2><p>snippet</p>`.
 * Returns [] when Bing blocks the request or its layout changed.
 */
export async function searchBing(
  query: string,
): Promise<Array<{ href: string; title: string; snippet: string }>> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const re =
    /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  const out: Array<{ href: string; title: string; snippet: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 8) {
    const href = unwrapBingRedirect(decodeHtmlEntities(m[1] ?? '').trim());
    if (!href || href.startsWith('#')) continue;
    out.push({
      href,
      title: stripHtml(m[2] ?? '').trim(),
      snippet: stripHtml(m[3] ?? '').trim(),
    });
  }
  return out;
}

export function formatSearchResults(
  query: string,
  source: string,
  results: Array<{ href: string; title: string; snippet: string }>,
  label = 'Web search',
): string {
  const lines = results.map((r, i) => {
    const snippet = r.snippet ? `\n  ${r.snippet}` : '';
    return `${i + 1}. ${r.title}\n   ${r.href}${snippet}`;
  });
  return truncate(`${label} for "${query}" via ${source} — ${results.length} result(s):\n${lines.join('\n')}`);
}

/**
 * Shared web search (no API key): DuckDuckGo HTML first, Bing HTML
 * fallback. Returns null when neither engine yields usable results.
 * Used by `web_search` and by `x_search` (with a `site:x.com` prefix).
 */
export async function searchWeb(
  query: string,
): Promise<{ source: string; results: Array<{ href: string; title: string; snippet: string }> } | null> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (res.ok) {
      const results = parseDuckDuckGoResults(await res.text());
      if (results.length > 0) return { source: 'DuckDuckGo', results };
    }
  } catch {
    // Fall through to the Bing fallback below.
  }
  const bingResults = await searchBing(query);
  if (bingResults.length > 0) return { source: 'Bing', results: bingResults };
  return null;
}

const webSearchTool: Tool = {
  definition: {
    name: 'web_search',
    description:
      'Search the web via DuckDuckGo, falling back to Bing HTML if DuckDuckGo fails (no API key). Returns up to 8 results with title, URL and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args) {
    try {
      const query = getStringArg(args, 'query');
      const found = await searchWeb(query);
      if (!found) {
        return errorResult(
          'Web search failed: DuckDuckGo returned no usable results (blocked or layout changed) ' +
            'and the Bing fallback also returned nothing. Try again later or use web_fetch on a search URL directly.',
        );
      }
      return formatSearchResults(query, found.source, found.results);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  }

};

const webFetchTool: Tool = {
  definition: {
    name: 'web_fetch',
    description:
      'Fetch a web page (http/https only) and return its readable text with HTML tags removed (max 20,000 chars). Internal/private URLs (localhost, private LAN, cloud metadata) are blocked.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const url = assertHttpUrl(getStringArg(args, 'url'));
      // v0.15 (H3 audit): chặn SSRF — không GET service nội bộ (loopback /
      // private / link-local / metadata cloud), kể cả qua redirect.
      const res = await fetchPublic(url.toString(), {
        headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' },
      }, FETCH_TIMEOUT_MS);
      if (!res.ok) return errorResult(`GET ${url} failed with HTTP ${res.status}`);
      // v0.95 (Team D1): readable-text extraction — title + headings +
      // paragraphs, boilerplate (nav/header/footer/scripts) removed,
      // instead of the old flat tag strip.
      const text = extractReadableText(await res.text());
      return truncate(text, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const httpGetTool: Tool = {
  definition: {
    name: 'http_get',
    description:
      'GET JSON or text from any public API endpoint (http/https only). Returns the response body (max 20,000 chars). Internal/private URLs (localhost, private LAN, cloud metadata) are blocked.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL to GET.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const url = assertHttpUrl(getStringArg(args, 'url'));
      // v0.15 (H3 audit): chặn SSRF — xem web_fetch.
      const res = await fetchPublic(url.toString(), {
        headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/json, text/*, */*' },
      }, FETCH_TIMEOUT_MS);
      if (!res.ok) return errorResult(`GET ${url} failed with HTTP ${res.status}`);
      return truncate(await res.text(), MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Git tools (read-only except git_commit, which needs approval)
// ---------------------------------------------------------------------------

async function runGit(gitArgs: string, ctx: ToolContext): Promise<string> {
  const result = await runShell(`git ${gitArgs}`, ctx.workspaceDir, {
    workspaceDir: ctx.workspaceDir,
    signal: ctx.signal,
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return errorResult(`git ${gitArgs.split(' ')[0]} failed (exit ${result.code}): ${detail}`);
  }
  return result.stdout;
}

const gitStatusTool: Tool = {
  definition: {
    name: 'git_status',
    description: 'Show `git status --porcelain` for the workspace repository.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  needsApproval: false,
  async execute(_args, ctx) {
    try {
      const out = await runGit('status --porcelain', ctx);
      if (out.startsWith('Error:')) return out;
      return truncate(out.trim() === '' ? '(working tree clean)' : out, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const gitDiffTool: Tool = {
  definition: {
    name: 'git_diff',
    description: 'Show `git diff` for the workspace (optionally for one file). Max 10,000 chars.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional single file path inside the workspace.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      let gitArgs = 'diff';
      if (args['file'] !== undefined) {
        const file = getStringArg(args, 'file', false);
        if (file) {
          // Validate the path stays in the workspace before quoting it in.
          resolveWithin(ctx.workspaceDir, file);
          gitArgs = `diff -- ${shellQuote(file)}`;
        }
      }
      const out = await runGit(gitArgs, ctx);
      if (out.startsWith('Error:')) return out;
      return truncate(out.trim() === '' ? '(no changes)' : out, 10_000, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const gitCommitTool: Tool = {
  definition: {
    name: 'git_commit',
    description: 'Stage all changes (`git add -A`) and commit with the given message.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (single line preferred).' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const message = getStringArg(args, 'message').replace(/[\r\n]+/g, ' ').trim();
      if (!message) return errorResult('Commit message must not be empty.');
      const out = await runGit(`add -A && git commit -m ${shellQuote(message)}`, ctx);
      return truncate(out, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_TOOLS: Tool[] = [
  ...createToolBlobTools(),
  readFileTool,
  writeFileTool,
  listFilesTool,
  shellExecTool,
  webSearchTool,
  webFetchTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  httpGetTool,
  // --- v0.89 (worker F4): data (6) + http (1) + text (4) + office-write (3) ---
  ...DATA_TOOLS,
  ...HTTP_TOOLS,
  ...TEXT_TOOLS,
  ...OFFICE_WRITE_TOOLS,
  // --- v0.95 (Team D1): internet data (10: search, clean fetch,
  // feeds x4, watches x4) ---
  ...INTERNET_DATA_TOOLS,
];

export function createDefaultTools(opts?: {
  /** When given, shell_exec runs in the local-exec-daemon (resolved lazily per call, so a dead daemon is re-created by the caller on the next call). */
  getDaemon?: () => ShellDaemon | null;
  /**
   * v0.55: resolver policy egress hiệu lực của team hiện tại (xem
   * `createShellExecTool`) — resolve lười mỗi lần shell_exec chạy.
   */
  getEgressPolicy?: () => EgressPolicy | null | undefined;
  /**
   * v0.95 (Team D1): internet-data wiring. When any of these is
   * given, the 10 internet-data placeholders in ALL_TOOLS are
   * replaced by bound tools (same lazy pattern as http_request
   * above) — never registered twice. `getInternetDataFile` resolves
   * the `<userData>/internet-data.json` state file (undefined =
   * memory-only store); `getBraveSearchApiKey` resolves the opt-in
   * Brave key; `onWatchChanged` fires per changed watch.
   */
  getInternetDataFile?: () => string | null | undefined;
  getBraveSearchApiKey?: () => string | null;
  onWatchChanged?: (event: WatchChangeEvent) => void;
}): Tool[] {
  if (!opts?.getDaemon && !opts?.getEgressPolicy && !opts?.getInternetDataFile && !opts?.getBraveSearchApiKey && !opts?.onWatchChanged) return [...ALL_TOOLS];
  const tools = [...ALL_TOOLS];
  const idx = tools.indexOf(shellExecTool);
  if (idx !== -1) {
    tools[idx] = createShellExecTool(opts.getDaemon, { getEgressPolicy: opts.getEgressPolicy });
  }
  // v0.89 (worker F4): http_request bound to the team egress policy when
  // one is configured (same lazy-resolver pattern as shell_exec above);
  // without it the placeholder uses the SSRF guard (see httpTools.ts).
  if (opts?.getEgressPolicy) {
    const httpIdx = tools.findIndex((t) => t.definition.name === 'http_request');
    if (httpIdx !== -1) {
      tools[httpIdx] = createHttpTools({ getEgressPolicy: opts.getEgressPolicy })[0] as Tool;
    }
  }
  // v0.95 (Team D1): bind the internet-data tools when the host wires
  // them (state file / Brave key / watch-change callback). The bound
  // set REPLACES the placeholders in place (same order, same 10
  // names) so the registry never sees a duplicate.
  if (opts?.getInternetDataFile || opts?.getBraveSearchApiKey || opts?.onWatchChanged) {
    const bound = createInternetDataTools({
      stateFile: opts.getInternetDataFile?.() ?? undefined,
      getApiKey: (name: string) =>
        name === 'brave' ? (opts.getBraveSearchApiKey?.() ?? undefined) : undefined,
      getEgressPolicy: opts.getEgressPolicy,
      onWatchChanged: opts.onWatchChanged,
    });
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      return kept;
    }
  }
  return tools;
}
