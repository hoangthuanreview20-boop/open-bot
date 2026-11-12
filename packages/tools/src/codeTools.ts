/**
 * Extra tools for @open-bot/tools (v0.2): file/code search and editing,
 * git blame, diagnostics and keyword-ranked search.
 *
 * Same contract and safety rules as tools.ts: every file/shell operation
 * goes through the sandbox (resolveWithin / runShell), results are
 * truncated to at most 20_000 chars.
 *
 * v0.86 (P2-4) adds the one exception to "no new npm dependencies":
 * `code_symbols` parses with tree-sitter via `web-tree-sitter` (WASM,
 * no native build) + the `tree-sitter-*` grammar packages — see
 * ./code/ast.ts.
 *
 * Honest limits, stated in the tool descriptions too:
 *  - `semantic_search` defaults to keyword TF-IDF ranking over workspace
 *    text files; `mode: 'embeddings'` uses real Ollama embeddings
 *    (local, model nomic-embed-text) instead — no silent fallback.
 *    Vectors are cached per search root under
 *    `.open-bot/embeddings/<hash>/embeddings.json` (P1-9): unchanged
 *    files reuse their stored vector, changed/new files are re-embedded.
 *  - `x_search` used to live here as a web-search fallback; in v0.6 it
 *    moved to webMedia.ts (X API when a bearer token exists, labelled
 *    fallback otherwise).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  EmbeddingIndex,
  MAX_EMBEDDING_ITEMS,
  OllamaEmbeddings,
  semanticSearch,
} from '@open-bot/core/dist/memory/embeddings.js';
import { resolveWithin, runShell } from './sandbox';
import { shellQuote } from './shellQuote';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';
import {
  parseCodeSymbols,
  detectAstLanguage,
  supportedAstLanguagesText,
  SUPPORTED_AST_LANGUAGES,
} from './code/ast';
import type { AstLanguage } from './code/ast';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };
const MAX_TEXT_BYTES = 1_000_000; // 1 MB — grep / semantic search only read text files below this
/** Số ký tự tối đa của một file đưa vào embedding (nomic-embed-text: context 8192 token). */
const EMBED_MAX_CHARS = 8000;
/** Thư mục cache index vector cho semantic_search mode 'embeddings' (P1-9). */
const EMBEDDINGS_INDEX_REL_DIR = path.join('.open-bot', 'embeddings');
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_MATCHES = 100;
const DIAGNOSTICS_TIMEOUT_MS = 60_000;


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

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(
  args: Record<string, unknown>,
  name: string,
  defaultValue: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error(`Argument "${name}" must be a positive number.`);
  }
  return Math.min(Math.floor(value), max);
}

/** Chế độ của semantic_search: 'tfidf' (mặc định) hoặc 'embeddings'. */
function getModeArg(args: Record<string, unknown>): 'tfidf' | 'embeddings' {
  const value = args['mode'];
  if (value === undefined || value === null) return 'tfidf';
  if (value !== 'tfidf' && value !== 'embeddings') {
    throw new Error(
      `mode không hợp lệ: ${JSON.stringify(value)}. Chỉ hỗ trợ "tfidf" hoặc "embeddings".`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Workspace walking helpers
// ---------------------------------------------------------------------------

/** Directories never traversed by glob / grep / semantic search. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.open-bot']);

interface WorkspaceFile {
  rel: string; // posix-style path relative to the workspace root
  full: string;
}

/** All files under the workspace, skipping SKIP_DIRS. Symlinks are not followed. */
function walkFiles(workspaceDir: string): WorkspaceFile[] {
  const out: WorkspaceFile[] = [];
  const walk = (dir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        out.push({ rel, full: path.join(dir, entry.name) });
      }
    }
  };
  walk(workspaceDir, '');
  return out;
}

/** Heuristic text check: no NUL byte in the first 8 KB. */
function isTextBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

/** Read a workspace file as text, or null when it is missing / binary / too large. */
function readTextFileIfSmall(full: string, maxBytes: number): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size >= maxBytes) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return null;
  }
  if (!isTextBuffer(buf)) return null;
  return buf.toString('utf8');
}

// ---------------------------------------------------------------------------
// glob_files
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a RegExp. Supports `**` (any chars, including
 * `/`), `*` (any chars except `/`) and `?` (one char except `/`).
 * `**\/` matches zero or more directories, so `**\/*.ts` also matches
 * `a.ts` at the workspace root.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\.+^${}()|[]'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re);
}

const globFilesTool: Tool = {
  definition: {
    name: 'glob_files',
    description:
      'Find files in the workspace matching a glob pattern (supports **, *, ?; e.g. "src/**/*.ts", "*.md"). ' +
      'A pattern without "/" matches file names at any depth. Skips .git, node_modules and .open-bot. Max 200 results.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts" or "*.json".' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const pattern = getStringArg(args, 'pattern');
      if (!pattern) return errorResult('Pattern must not be empty.');
      const re = globToRegExp(pattern);
      const hasSlash = pattern.includes('/');
      const matches: string[] = [];
      for (const file of walkFiles(ctx.workspaceDir)) {
        const target = hasSlash ? file.rel : path.posix.basename(file.rel);
        if (re.test(target)) {
          matches.push(file.rel);
          if (matches.length >= MAX_GLOB_RESULTS) break;
        }
      }
      matches.sort();
      const note =
        matches.length >= MAX_GLOB_RESULTS
          ? `\n[... showing first ${MAX_GLOB_RESULTS} matches ...]`
          : '';
      return truncate(
        `Glob "${pattern}" — ${matches.length} match(es):\n${matches.join('\n')}${note}`,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// grep_search
// ---------------------------------------------------------------------------

const grepSearchTool: Tool = {
  definition: {
    name: 'grep_search',
    description:
      'Search file contents in the workspace for a string or regex, with line numbers. ' +
      'Only text files under 1 MB are searched; skips .git, node_modules and .open-bot. Max 100 matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for.' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false).' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive match (default false).' },
        path: {
          type: 'string',
          description: 'File or directory inside the workspace to search in (default: whole workspace).',
        },
        max_results: { type: 'number', description: 'Max matches to return (default 100, capped at 100).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const pattern = getStringArg(args, 'pattern');
      if (!pattern) return errorResult('Pattern must not be empty.');
      const useRegex = getBoolArg(args, 'regex', false);
      const caseInsensitive = getBoolArg(args, 'case_insensitive', false);
      const maxResults = getNumberArg(args, 'max_results', MAX_GREP_MATCHES, MAX_GREP_MATCHES);

      let matcher: (line: string) => boolean;
      if (useRegex) {
        let re: RegExp;
        try {
          re = new RegExp(pattern, caseInsensitive ? 'i' : '');
        } catch (err) {
          return errorResult(`Invalid regex "${pattern}": ${(err as Error).message}`);
        }
        matcher = (line) => re.test(line);
      } else if (caseInsensitive) {
        const needle = pattern.toLowerCase();
        matcher = (line) => line.toLowerCase().includes(needle);
      } else {
        matcher = (line) => line.includes(pattern);
      }

      // Resolve the search root (a file, a directory, or the whole workspace).
      const relRoot = args['path'] === undefined ? '.' : getStringArg(args, 'path', false);
      const root = resolveWithin(ctx.workspaceDir, relRoot);
      let candidates: WorkspaceFile[];
      const stat = fs.statSync(root);
      if (stat.isFile()) {
        candidates = [{ rel: relRoot, full: root }];
      } else if (stat.isDirectory()) {
        const prefix = relRoot === '.' ? '' : relRoot.replace(/\\/g, '/').replace(/\/$/, '');
        candidates = walkFiles(root).map((f) => ({
          rel: prefix ? `${prefix}/${f.rel}` : f.rel,
          full: f.full,
        }));
      } else {
        return errorResult(`Not a file or directory: "${relRoot}"`);
      }

      const matches: string[] = [];
      for (const file of candidates) {
        const content = readTextFileIfSmall(file.full, MAX_TEXT_BYTES);
        if (content === null) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string;
          if (matcher(line)) {
            matches.push(`${file.rel}:${i + 1}: ${line.slice(0, 200)}`);
            if (matches.length >= maxResults) break;
          }
        }
        if (matches.length >= maxResults) break;
      }
      if (matches.length === 0) {
        return `No matches for "${pattern}" in "${relRoot}".`;
      }
      const note =
        matches.length >= maxResults ? `\n[... showing first ${maxResults} matches ...]` : '';
      return truncate(`Matches for "${pattern}" (${matches.length}):\n${matches.join('\n')}${note}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------

const deleteFileTool: Tool = {
  definition: {
    name: 'delete_file',
    description:
      'Delete a file inside the workspace. Refuses to delete anything under .open-bot (bot state). Needs approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const firstSegment = relPath.replace(/\\/g, '/').split('/')[0];
      if (firstSegment === '.open-bot') {
        return errorResult('Refusing to delete anything under .open-bot (bot state directory).');
      }
      const fullPath = resolveWithin(ctx.workspaceDir, relPath);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return errorResult(`Not a file: "${relPath}"`);
      fs.unlinkSync(fullPath);
      return `Deleted "${relPath}".`;
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// apply_diff
// ---------------------------------------------------------------------------

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Lines as they appear in the OLD file (context ' ' + removed '-'). */
  oldLines: string[];
  /** Lines as they appear in the NEW file (context ' ' + added '+'). */
  newLines: string[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into hunks. Header lines (`diff --git`, `---`, `+++`)
 * are ignored — the caller says which single file the diff applies to.
 * Throws with a clear message on malformed input.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const lines = diff.split('\n');
  // A trailing newline produces one empty element — it is not a hunk line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  const finishHunk = (): void => {
    if (current === null) return;
    if (current.oldLines.length !== current.oldCount) {
      throw new Error(
        `Malformed diff: hunk @@ -${current.oldStart},${current.oldCount} @@ declares ` +
          `${current.oldCount} old line(s) but contains ${current.oldLines.length}.`,
      );
    }
    if (current.newLines.length !== current.newCount) {
      throw new Error(
        `Malformed diff: hunk @@ +${current.newStart},${current.newCount} @@ declares ` +
          `${current.newCount} new line(s) but contains ${current.newLines.length}.`,
      );
    }
    hunks.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const header = HUNK_HEADER_RE.exec(rawLine);
    if (header) {
      finishHunk();
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        oldLines: [],
        newLines: [],
      };
      continue;
    }
    if (current === null) continue; // diff --git / --- / +++ headers, ignore
    if (rawLine.startsWith('\\')) continue; // "\ No newline at end of file"
    const marker = rawLine[0];
    const content = rawLine.slice(1);
    if (marker === ' ') {
      current.oldLines.push(content);
      current.newLines.push(content);
    } else if (marker === '-') {
      current.oldLines.push(content);
    } else if (marker === '+') {
      current.newLines.push(content);
    } else if (rawLine === '') {
      // A bare empty line in a hunk is a context line with empty content.
      current.oldLines.push('');
      current.newLines.push('');
    } else {
      throw new Error(`Malformed diff: unexpected line in hunk: "${rawLine.slice(0, 80)}"`);
    }
  }
  finishHunk();
  if (hunks.length === 0) {
    throw new Error('No hunks found: the diff contains no "@@ -a,b +c,d @@" header.');
  }
  return hunks;
}

/**
 * Apply parsed hunks to file lines. Each hunk is located by matching its
 * old lines against the file, preferring the position closest to the
 * hunk's declared old start line. Throws when context does not match.
 */
export function applyHunksToLines(fileLines: string[], hunks: DiffHunk[]): string[] {
  const lines = [...fileLines];
  // Apply from the bottom up so earlier line numbers stay valid.
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const hunk of sorted) {
    const hint = Math.max(0, hunk.oldStart - 1);
    let bestPos = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let pos = 0; pos + hunk.oldLines.length <= lines.length; pos++) {
      let ok = true;
      for (let i = 0; i < hunk.oldLines.length; i++) {
        if (lines[pos + i] !== hunk.oldLines[i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const dist = Math.abs(pos - hint);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = pos;
        }
      }
    }
    if (bestPos === -1) {
      const preview = hunk.oldLines.slice(0, 3).map((l) => JSON.stringify(l)).join(', ');
      throw new Error(
        `Context mismatch in hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@: ` +
          `the expected old lines (${preview}${hunk.oldLines.length > 3 ? ', ...' : ''}) ` +
          `do not appear in the file near line ${hunk.oldStart}. ` +
          `The file may have changed since the diff was made — re-read it and regenerate the diff.`,
      );
    }
    lines.splice(bestPos, hunk.oldLines.length, ...hunk.newLines);
  }
  return lines;
}

const applyDiffTool: Tool = {
  definition: {
    name: 'apply_diff',
    description:
      'Apply a unified diff (@@ hunks) to one file inside the workspace. ' +
      'Fails with a clear error when the diff context does not match the current file. Needs approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to patch, relative to the workspace root.' },
        diff: { type: 'string', description: 'Unified diff text with @@ hunks for this file.' },
      },
      required: ['path', 'diff'],
      additionalProperties: false,
    },
  },
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const diff = getStringArg(args, 'diff');
      const fullPath = resolveWithin(ctx.workspaceDir, relPath);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return errorResult(`Not a file: "${relPath}"`);
      if (stat.size > MAX_TEXT_BYTES) {
        return errorResult(`File is ${stat.size} bytes, over the 1 MB apply_diff limit: "${relPath}"`);
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      const hunks = parseUnifiedDiff(diff);
      const newLines = applyHunksToLines(content.split('\n'), hunks);
      fs.writeFileSync(fullPath, newLines.join('\n'), 'utf8');
      return `Applied ${hunks.length} hunk(s) to "${relPath}".`;
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// git_blame
// ---------------------------------------------------------------------------

const gitBlameTool: Tool = {
  definition: {
    name: 'git_blame',
    description: 'Show `git blame` for one file in the workspace (read-only).',
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
      resolveWithin(ctx.workspaceDir, relPath); // validate before quoting into the command
      const result = await runShell(`git blame -- ${shellQuote(relPath)}`, ctx.workspaceDir, {
        workspaceDir: ctx.workspaceDir,
        signal: ctx.signal,
      });
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        return errorResult(`git blame failed (exit ${result.code}): ${detail}`);
      }
      return truncate(result.stdout);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// code_diagnostics
// ---------------------------------------------------------------------------

const codeDiagnosticsTool: Tool = {
  definition: {
    name: 'code_diagnostics',
    description:
      'Check code for errors: if the workspace has a tsconfig.json, runs `npx tsc --noEmit -p .` (60s timeout); ' +
      'otherwise runs `node --check` on a given .js file. Returns the diagnostics, truncated.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Optional .js file to check with `node --check` (only used when there is no tsconfig.json).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const hasTsconfig = fs.existsSync(resolveWithin(ctx.workspaceDir, 'tsconfig.json'));
      if (hasTsconfig) {
        const result = await runShell('npx tsc --noEmit -p .', ctx.workspaceDir, {
          workspaceDir: ctx.workspaceDir,
          signal: ctx.signal,
          timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
        });
        const output = `${result.stdout}${result.stderr}`.trim();
        if (result.code === 0) return 'No TypeScript errors (tsc --noEmit -p . is clean).';
        if (result.code === null) return errorResult('Diagnostics timed out after 60s.');
        return truncate(output === '' ? `tsc exited with code ${result.code} and no output.` : output);
      }
      const file = getStringArg(args, 'file', false);
      if (!file) {
        return errorResult(
          'No tsconfig.json in the workspace, and no .js file was given to check with `node --check`.',
        );
      }
      if (!file.endsWith('.js')) {
        return errorResult(`Without a tsconfig.json only .js files can be checked, got "${file}".`);
      }
      resolveWithin(ctx.workspaceDir, file); // validate before quoting into the command
      const result = await runShell(`node --check ${shellQuote(file)}`, ctx.workspaceDir, {
        workspaceDir: ctx.workspaceDir,
        signal: ctx.signal,
        timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
      });
      if (result.code === 0) return `Syntax OK: "${file}" (node --check clean).`;
      const detail = (result.stderr || result.stdout).trim();
      return truncate(detail === '' ? `node --check exited with code ${result.code}.` : detail);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// semantic_search (keyword TF-IDF ranking, hoặc embedding thật ở mode 'embeddings')
// ---------------------------------------------------------------------------

/**
 * Nhánh embedding thật của `semantic_search`: xếp hạng cùng tập file ứng
 * viên như nhánh TF-IDF bằng `OllamaEmbeddings` + `semanticSearch()` của
 * @open-bot/core (cosine similarity). Trả cùng định dạng kết quả như
 * nhánh TF-IDF (tên file + score + dòng khớp: dòng đầu tiên chứa từ khoá
 * của query, nếu không có thì 200 ký tự đầu của file).
 *
 * KHÔNG lặng lẽ fallback về TF-IDF: Ollama chưa chạy / model chưa pull
 * thì lỗi của core (tiếng Việt, kèm gợi ý `ollama serve` /
 * `ollama pull nomic-embed-text`) được trả về nguyên văn.
 *
 * P1-9 — index vector persistent: vector của mỗi file được cache trong
 * `<workspace>/.open-bot/embeddings/<hash của thư mục gốc>/embeddings.json`
 * (một index riêng cho mỗi `path` tìm kiếm, tránh lẫn scope). File chưa
 * đổi nội dung thì dùng lại vector cũ (không gọi Ollama); file đổi hoặc
 * mới thì embed lại; file đã xoá thì prune khỏi index. Nhờ đó lần tìm
 * thứ hai trở đi chỉ tốn 1 lần embed query (trừ file mới/đổi).
 */
async function runEmbeddingsSearch(
  query: string,
  docs: Array<{ rel: string; content: string; lines: string[] }>,
  relRoot: string,
  maxResults: number,
  ollamaBaseUrl: string | undefined,
  ollamaModel: string | undefined,
  workspaceDir: string,
): Promise<string> {
  const embedDocs = docs.filter((d) => d.content.trim() !== '');
  if (embedDocs.length === 0) return `No searchable text files found in "${relRoot}".`;
  const embeddings = new OllamaEmbeddings({
    ...(ollamaBaseUrl ? { baseUrl: ollamaBaseUrl } : {}),
    ...(ollamaModel ? { model: ollamaModel } : {}),
  });
  // Vượt cap 10.000 item của EmbeddingIndex thì dùng đường không cache
  // (embed lại mỗi lần) thay vì fail cả lần tìm.
  if (embedDocs.length > MAX_EMBEDDING_ITEMS) {
    return runEmbeddingsSearchUncached(query, embedDocs, relRoot, maxResults, embeddings);
  }
  const scopeHash = createHash('sha256').update(relRoot).digest('hex').slice(0, 16);
  const indexDir = path.join(workspaceDir, EMBEDDINGS_INDEX_REL_DIR, scopeHash);
  let index = new EmbeddingIndex({ dir: indexDir, model: embeddings.model, embeddings });
  try {
    index.load();
  } catch (err) {
    // File index hỏng hoặc khác model → bỏ index cũ, build lại từ đầu.
    console.warn(
      `[semantic_search] bỏ index embedding cũ ở ${indexDir}: ${(err as Error).message}`,
    );
    index = new EmbeddingIndex({ dir: indexDir, model: embeddings.model, embeddings });
  }
  const currentIds = new Set<string>();
  const toEmbed: Array<{ rel: string; text: string }> = [];
  for (const doc of embedDocs) {
    currentIds.add(doc.rel);
    // Chỉ embed tối đa 8.000 ký tự đầu (vừa context model); text đã cắt
    // này cũng là thứ lưu trong index để lần sau so sánh đổi/chưa đổi.
    const text = doc.content.slice(0, EMBED_MAX_CHARS);
    const existing = index.get(doc.rel);
    if (existing && existing.text === text) continue;
    toEmbed.push({ rel: doc.rel, text });
  }
  if (toEmbed.length > 0) {
    let vectors: number[][];
    try {
      vectors = await embeddings.embedBatch(toEmbed.map((d) => d.text));
    } catch (err) {
      return errorResult((err as Error).message);
    }
    for (let i = 0; i < toEmbed.length; i++) {
      try {
        await index.add(toEmbed[i]!.rel, toEmbed[i]!.text, vectors[i]);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  }
  for (const id of index.ids()) {
    if (!currentIds.has(id)) index.remove(id);
  }
  try {
    index.save();
  } catch (err) {
    // Không lưu được cache thì lần tìm sau embed lại — không fail lần này.
    console.warn(
      `[semantic_search] không lưu được index embedding ở ${indexDir}: ${(err as Error).message}`,
    );
  }
  let ranked: Array<{ id: string; text: string; score: number }>;
  try {
    ranked = await index.search(query, { topK: maxResults });
  } catch (err) {
    return errorResult((err as Error).message);
  }
  return formatEmbeddingsResults(query, embedDocs, ranked, relRoot, embeddings.model);
}

/** Đường không cache của tìm kiếm embedding (dùng khi vượt cap index). */
async function runEmbeddingsSearchUncached(
  query: string,
  embedDocs: Array<{ rel: string; content: string; lines: string[] }>,
  relRoot: string,
  maxResults: number,
  embeddings: OllamaEmbeddings,
): Promise<string> {
  let ranked: Array<{ id: string; text: string; score: number }>;
  try {
    ranked = await semanticSearch(
      query,
      embedDocs.map((d) => ({ id: d.rel, text: d.content.slice(0, EMBED_MAX_CHARS) })),
      { embeddings, topK: maxResults },
    );
  } catch (err) {
    return errorResult((err as Error).message);
  }
  return formatEmbeddingsResults(query, embedDocs, ranked, relRoot, embeddings.model);
}

/** Render kết quả embedding về cùng định dạng như nhánh TF-IDF. */
function formatEmbeddingsResults(
  query: string,
  embedDocs: Array<{ rel: string; content: string; lines: string[] }>,
  ranked: Array<{ id: string; text: string; score: number }>,
  relRoot: string,
  model: string,
): string {
  if (ranked.length === 0) {
    return `Không tìm thấy file nào khớp với "${query}" (tìm kiếm ngữ nghĩa bằng embedding).`;
  }
  const queryTerms = tokenize(query);
  const byRel = new Map(embedDocs.map((d) => [d.rel, d]));
  const lines = ranked.map((r, i) => {
    const doc = byRel.get(r.id);
    let snippet = '';
    if (doc) {
      for (const line of doc.lines) {
        const lower = line.toLowerCase();
        if (queryTerms.some((t) => lower.includes(t))) {
          snippet = line.trim().slice(0, 200);
          break;
        }
      }
      if (!snippet) {
        snippet = doc.content.replace(/\s+/g, ' ').trim().slice(0, 200);
      }
    }
    return `${i + 1}. ${r.id} (score ${r.score.toFixed(4)})${snippet ? `\n   ${snippet}` : ''}`;
  });
  return truncate(
    `Kết quả tìm kiếm ngữ nghĩa (embeddings, model ${model}) cho "${query}" — ${ranked.length} file(s):\n${lines.join('\n')}`,
  );
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were',
  'it', 'this', 'that', 'with', 'as', 'by', 'at', 'from', 'be', 'not', 'no', 'if', 'then',
  'else', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'just', 'so',
  'cua', 'va', 'la', 'cac', 'mot', 'trong', 'cho', 'voi', 'khi', 'neu', 'thi', 'de', 'da',
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!matches) return [];
  return matches.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const semanticSearchTool: Tool = {
  definition: {
    name: 'semantic_search',
    description:
      'Tìm kiếm trong các file text của workspace, có 2 chế độ: ' +
      '(1) mode "tfidf" (mặc định): xếp hạng từ khoá TF-IDF — nhanh, không cần Ollama. ' +
      '(2) mode "embeddings": xếp hạng ngữ nghĩa bằng embedding thật qua Ollama local ' +
      '(mặc định http://127.0.0.1:11434, model nomic-embed-text); vector của mỗi file được cache ' +
      'trong .open-bot/embeddings/ theo thư mục tìm kiếm, file chưa đổi thì dùng lại vector cũ; ' +
      'Ollama chưa chạy hoặc chưa có model ' +
      'thì báo lỗi rõ ràng, KHÔNG lặng lẽ dùng lại TF-IDF. ' +
      'Trả về các file khớp nhất kèm score và dòng khớp. ' +
      'Chỉ đọc file text dưới 1 MB; bỏ qua .git, node_modules và .open-bot.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Từ khoá hoặc câu truy vấn cần tìm.' },
        path: {
          type: 'string',
          description: 'File or directory inside the workspace to search in (default: whole workspace).',
        },
        max_results: { type: 'number', description: 'Max files to return (default 10, capped at 20).' },
        mode: {
          type: 'string',
          enum: ['tfidf', 'embeddings'],
          description:
            'Chế độ tìm kiếm: "tfidf" (mặc định, xếp hạng từ khoá) hoặc "embeddings" ' +
            '(xếp hạng ngữ nghĩa bằng embedding thật qua Ollama local).',
        },
        ollama_base_url: {
          type: 'string',
          description:
            'Base URL của Ollama cho mode "embeddings" (mặc định http://127.0.0.1:11434).',
        },
        ollama_model: {
          type: 'string',
          description: 'Model embedding của Ollama cho mode "embeddings" (mặc định nomic-embed-text).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const query = getStringArg(args, 'query');
      const mode = getModeArg(args);
      const queryTerms = mode === 'tfidf' ? tokenize(query) : [];
      if (mode === 'tfidf' && queryTerms.length === 0) {
        return errorResult('Query contains no searchable keywords.');
      }
      if (mode === 'embeddings' && query.trim() === '') {
        return errorResult('Query không được rỗng.');
      }
      const maxResults = getNumberArg(args, 'max_results', 10, 20);

      const relRoot = args['path'] === undefined ? '.' : getStringArg(args, 'path', false);
      const root = resolveWithin(ctx.workspaceDir, relRoot);
      let candidates: WorkspaceFile[];
      const stat = fs.statSync(root);
      if (stat.isFile()) {
        candidates = [{ rel: relRoot, full: root }];
      } else if (stat.isDirectory()) {
        const prefix = relRoot === '.' ? '' : relRoot.replace(/\\/g, '/').replace(/\/$/, '');
        candidates = walkFiles(root).map((f) => ({
          rel: prefix ? `${prefix}/${f.rel}` : f.rel,
          full: f.full,
        }));
      } else {
        return errorResult(`Not a file or directory: "${relRoot}"`);
      }

      // Thu thập cùng tập file ứng viên cho cả hai mode: file text dưới
      // 1 MB, bỏ qua .git / node_modules / .open-bot (xem walkFiles).
      interface CandidateDoc {
        rel: string;
        content: string;
        lines: string[];
      }
      const contents: CandidateDoc[] = [];
      for (const file of candidates) {
        const content = readTextFileIfSmall(file.full, MAX_TEXT_BYTES);
        if (content === null) continue;
        contents.push({ rel: file.rel, content, lines: content.split('\n') });
      }
      if (contents.length === 0) return `No searchable text files found in "${relRoot}".`;

      if (mode === 'embeddings') {
        const baseUrl = getStringArg(args, 'ollama_base_url', false) || undefined;
        const model = getStringArg(args, 'ollama_model', false) || undefined;
        return runEmbeddingsSearch(query, contents, relRoot, maxResults, baseUrl, model, ctx.workspaceDir);
      }

      interface Doc {
        rel: string;
        tf: Map<string, number>;
        total: number;
        lines: string[];
      }
      const docs: Doc[] = [];
      const df = new Map<string, number>();
      for (const { rel, content, lines } of contents) {
        const tokens = tokenize(content);
        if (tokens.length === 0) continue;
        const tf = new Map<string, number>();
        for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
        for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
        docs.push({ rel, tf, total: tokens.length, lines });
      }
      if (docs.length === 0) return `No searchable text files found in "${relRoot}".`;

      const n = docs.length;
      const scored: Array<{ rel: string; score: number; snippet: string }> = [];
      for (const doc of docs) {
        let score = 0;
        for (const term of queryTerms) {
          const count = doc.tf.get(term);
          if (!count) continue;
          const idf = Math.log((n + 1) / ((df.get(term) ?? 0) + 1)) + 1;
          score += (count / doc.total) * idf;
        }
        if (score <= 0) continue;
        let snippet = '';
        const lowerTerms = queryTerms.map((t) => t.toLowerCase());
        for (const line of doc.lines) {
          const lower = line.toLowerCase();
          if (lowerTerms.some((t) => lower.includes(t))) {
            snippet = line.trim().slice(0, 200);
            break;
          }
        }
        scored.push({ rel: doc.rel, score, snippet });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, maxResults);
      if (top.length === 0) {
        return `No files match the keywords in "${query}" (keyword TF-IDF ranking).`;
      }
      const lines = top.map(
        (r, i) => `${i + 1}. ${r.rel} (score ${r.score.toFixed(4)})${r.snippet ? `\n   ${r.snippet}` : ''}`,
      );
      return truncate(
        `Keyword-ranked (TF-IDF) matches for "${query}" — ${top.length} file(s):\n${lines.join('\n')}`,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

export { unwrapBingRedirect } from './tools';

// ---------------------------------------------------------------------------
// code_symbols (v0.86, P2-4): tree-sitter AST outline of one source file
// ---------------------------------------------------------------------------

const codeSymbolsTool: Tool = {
  definition: {
    name: 'code_symbols',
    description:
      'List code symbols (functions, classes, methods, interfaces, types, enums) in one source file, ' +
      'with 1-based line/column positions, parsed with a real tree-sitter AST (not text search). ' +
      'Supported: JavaScript (.js, .jsx, .mjs, .cjs), TypeScript (.ts, .mts, .cts), TSX (.tsx), Python (.py). ' +
      'Other languages fail with a clear error. A file with syntax errors still returns the symbols ' +
      'that parsed, flagged as partial. Read-only, needs no approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source file, relative to the workspace root.' },
        language: {
          type: 'string',
          enum: ['javascript', 'typescript', 'tsx', 'python'],
          description:
            'Optional language override; by default the language is detected from the file extension.',
        },
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
      if (stat.size > MAX_TEXT_BYTES) {
        return errorResult(`File is ${stat.size} bytes, over the 1 MB code_symbols limit: "${relPath}"`);
      }
      const languageArg =
        args['language'] === undefined ? undefined : getStringArg(args, 'language', false);
      let language: AstLanguage;
      if (languageArg) {
        if (!(SUPPORTED_AST_LANGUAGES as readonly string[]).includes(languageArg)) {
          return errorResult(
            `Unsupported language "${languageArg}". Supported: ${SUPPORTED_AST_LANGUAGES.join(', ')}.`,
          );
        }
        language = languageArg as AstLanguage;
      } else {
        const detected = detectAstLanguage(relPath);
        if (detected === null) {
          return errorResult(
            `Không hỗ trợ AST cho "${relPath}": nhận diện ngôn ngữ theo đuôi file thất bại. ` +
              `Hỗ trợ: ${supportedAstLanguagesText()}. ` +
              `Dùng tham số "language" để ép ngôn ngữ (javascript, typescript, tsx, python).`,
          );
        }
        language = detected;
      }
      const source = fs.readFileSync(fullPath, 'utf8');
      const result = await parseCodeSymbols(source, language);
      if (result.symbols.length === 0) {
        return `No symbols found in "${relPath}" (${language}).${
          result.hasError ? ' Lưu ý: file có lỗi cú pháp.' : ''
        }`;
      }
      const lines = result.symbols.map(
        (s) => `${s.kind} ${s.qualifiedName} — line ${s.line}, column ${s.column} (to line ${s.endLine})`,
      );
      const note = result.hasError
        ? '\nLưu ý: file có lỗi cú pháp — cây AST có thể thiếu symbol.'
        : '';
      return truncate(
        `Symbols in "${relPath}" (${language}, ${result.symbols.length} symbol(s)):\n${lines.join('\n')}${note}`,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Exports (kept separate from ALL_TOOLS — the coordinator integrates them)
// ---------------------------------------------------------------------------

export const CODE_TOOLS: Tool[] = [
  globFilesTool,
  grepSearchTool,
  deleteFileTool,
  applyDiffTool,
  gitBlameTool,
  codeDiagnosticsTool,
  semanticSearchTool,
  codeSymbolsTool, // v0.86 (P2-4): tree-sitter AST outline — code 7 → 8.
  // NOTE: x_search moved to webMedia.ts (X API + labelled fallback) in v0.6.
];
