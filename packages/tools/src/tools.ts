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
import type { Tool, ToolContext } from '@open-bot/core';
import { resolveWithin, runShell } from './sandbox';

export const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_READ_BYTES = 100_000;
const MAX_LIST_ITEMS = 200;
const FETCH_TIMEOUT_MS = 20_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function truncate(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated to ${maxChars} chars ...]`;
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

function shellQuote(value: string): string {
  // POSIX single-quote escaping: ' -> '\'' (works in /bin/sh and PowerShell? No —
  // PowerShell uses different quoting; git tools run under /bin/sh on the
  // platforms this bot targets first, and runShell picks the platform shell.
  // On Windows the same single-quoted form is accepted by PowerShell for
  // simple values, and we additionally strip newlines below.)
  if (process.platform === 'win32') {
    return `"${value.replace(/["$`]/g, '')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
      'Read a text file inside the workspace. Returns the file contents (max 100KB).',
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
      if (stat.size > MAX_READ_BYTES) {
        return errorResult(
          `File is ${stat.size} bytes, over the ${MAX_READ_BYTES} byte read limit: "${relPath}"`,
        );
      }
      return truncate(fs.readFileSync(fullPath, 'utf8'));
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
      return truncate(`Directory "${relPath}" — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}${note}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Shell tool
// ---------------------------------------------------------------------------

const shellExecTool: Tool = {
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
      const result = await runShell(command, ctx.workspaceDir, {
        workspaceDir: ctx.workspaceDir,
        signal: ctx.signal,
      });
      const out: string[] = [`exit code: ${result.code === null ? 'null (timed out / killed)' : result.code}`];
      if (result.stdout.trim()) out.push(`--- stdout ---\n${result.stdout}`);
      if (result.stderr.trim()) out.push(`--- stderr ---\n${result.stderr}`);
      return truncate(out.join('\n'));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Web tools (no API key; only fetch the exact URL the agent/user asked for)
// ---------------------------------------------------------------------------


/** Parse DuckDuckGo HTML results (max 8). Returns [] when nothing parses. */
function parseDuckDuckGoResults(html: string): Array<{ href: string; title: string; snippet: string }> {
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
 * Fallback search via Bing HTML (no API key). Parses up to 8 results from
 * `<li class="b_algo"><h2><a href=...>title</a></h2><p>snippet</p>`.
 * Returns [] when Bing blocks the request or its layout changed.
 */
async function searchBing(
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
    const href = decodeHtmlEntities(m[1] ?? '').trim();
    if (!href || href.startsWith('#')) continue;
    out.push({
      href,
      title: stripHtml(m[2] ?? '').trim(),
      snippet: stripHtml(m[3] ?? '').trim(),
    });
  }
  return out;
}

function formatSearchResults(
  query: string,
  source: string,
  results: Array<{ href: string; title: string; snippet: string }>,
): string {
  const lines = results.map((r, i) => {
    const snippet = r.snippet ? `\n  ${r.snippet}` : '';
    return `${i + 1}. ${r.title}\n   ${r.href}${snippet}`;
  });
  return truncate(`Web search for "${query}" via ${source} — ${results.length} result(s):\n${lines.join('\n')}`);
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
      // Primary: DuckDuckGo HTML. On any failure (HTTP error, blocked,
      // unparseable layout) fall back to Bing HTML before giving up.
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
          if (results.length > 0) return formatSearchResults(query, 'DuckDuckGo', results);
        }
      } catch {
        // Fall through to the Bing fallback below.
      }
      const bingResults = await searchBing(query);
      if (bingResults.length > 0) return formatSearchResults(query, 'Bing', bingResults);
      return errorResult(
        'Web search failed: DuckDuckGo returned no usable results (blocked or layout changed) ' +
          'and the Bing fallback also returned nothing. Try again later or use web_fetch on a search URL directly.',
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  }

};

const webFetchTool: Tool = {
  definition: {
    name: 'web_fetch',
    description:
      'Fetch a web page (http/https only) and return its readable text with HTML tags removed (max 20,000 chars).',
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
  async execute(args) {
    try {
      const url = assertHttpUrl(getStringArg(args, 'url'));
      const res = await fetchWithTimeout(url.toString(), {
        headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      if (!res.ok) return errorResult(`GET ${url} failed with HTTP ${res.status}`);
      const text = stripHtml(await res.text());
      return truncate(text);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const httpGetTool: Tool = {
  definition: {
    name: 'http_get',
    description:
      'GET JSON or text from any API endpoint (http/https only). Returns the response body (max 20,000 chars).',
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
  async execute(args) {
    try {
      const url = assertHttpUrl(getStringArg(args, 'url'));
      const res = await fetchWithTimeout(url.toString(), {
        headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/json, text/*, */*' },
      });
      if (!res.ok) return errorResult(`GET ${url} failed with HTTP ${res.status}`);
      return truncate(await res.text());
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
      return truncate(out.trim() === '' ? '(working tree clean)' : out);
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
      return truncate(out.trim() === '' ? '(no changes)' : out, 10_000);
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
      return truncate(out);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_TOOLS: Tool[] = [
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
];

export function createDefaultTools(): Tool[] {
  return [...ALL_TOOLS];
}
