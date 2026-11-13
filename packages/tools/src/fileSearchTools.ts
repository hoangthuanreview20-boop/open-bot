/**
 * Deep file search for @open-bot/tools (v0.97, Team T6):
 * `search_files_deep` — content/regex search across the workspace.
 *
 * Compared with the older `grep_search` (codeTools.ts: max 100 matches,
 * no glob filter, no context lines, no time budget), this tool adds:
 *  - include / exclude glob patterns (`*.ts`, `src/**`, `*.test.*`)
 *  - context lines around each match (0–5)
 *  - whole-word matching
 *  - a time budget (default 10s, max 60s): on expiry it returns the
 *    partial results found so far instead of hanging the turn
 *  - caps on matches and on files read, with a clear "stopped early" note
 *  - `.gitignore` support (default on): ignored paths are never read
 *
 * Safety: the search root is confined to the workspace with
 * resolveWithin; binary files (NUL byte in the first 8 KB) and files
 * over 1 MB are skipped, like grep_search. Read-only, no approval.
 *
 * Factory (same pattern as createGitTools / createBrowserTools):
 *   createFileSearchTools() -> Tool[]   (bound, usable)
 *   FILE_SEARCH_TOOLS                  (unbound placeholders)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS lives in ./truncate —
// re-export so code importing from this module does not have to change.
export { MAX_TOOL_RESULT_CHARS };

/** Files over this size are never read (same cap as grep_search). */
export const FILE_SEARCH_MAX_BYTES = 1_000_000;
/** Directories never descended into (same skip list as grep_search). */
export const FILE_SEARCH_SKIP_DIRS = ['.git', '.svn', '.hg', 'node_modules', '.open-bot', '__pycache__'];
export const FILE_SEARCH_DEFAULT_MAX_RESULTS = 100;
export const FILE_SEARCH_MAX_RESULTS_CAP = 500;
export const FILE_SEARCH_DEFAULT_MAX_FILES = 200;
export const FILE_SEARCH_MAX_FILES_CAP = 1000;
export const FILE_SEARCH_DEFAULT_TIMEOUT_MS = 10_000;
export const FILE_SEARCH_MAX_TIMEOUT_MS = 60_000;
export const FILE_SEARCH_MAX_CONTEXT_LINES = 5;

export function errorResult(message: string): string {
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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
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

function getIntArg(
  args: Record<string, unknown>,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Argument "${name}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

// ---------------------------------------------------------------------------
// Glob matching (small subset: `*`, `**`, `?`; no brace expansion)
// ---------------------------------------------------------------------------

/**
 * Convert a glob to a RegExp. A double star followed by a slash matches
 * zero or more directories, `**` matches anything (incl. `/`), `*`
 * matches within one path segment, `?` matches one non-`/` character.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` — zero or more directories (the trailing `/` is consumed).
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(out + '$');
}

/**
 * True when `relPath` (workspace-relative, `/`-separated) matches the
 * glob. A pattern without `/` is matched against the basename too, so
 * `*.ts` matches `src/deep/file.ts` (gitignore-style semantics).
 */
export function matchesGlob(relPath: string, glob: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (globToRegExp(glob).test(normalized)) return true;
  if (!glob.includes('/')) {
    const base = normalized.split('/').pop() ?? normalized;
    if (globToRegExp(glob).test(base)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// .gitignore (small subset: `*`/`**`/`?`, directory patterns, `!` negation)
// ---------------------------------------------------------------------------

export interface GitignoreRule {
  negate: boolean;
  /** True when the pattern ends with `/` (matches a directory + everything under it). */
  dirOnly: boolean;
  pattern: string;
}

export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const body = negate ? line.slice(1) : line;
    if (body === '') continue;
    const dirOnly = body.endsWith('/');
    rules.push({ negate, dirOnly, pattern: dirOnly ? body.slice(0, -1) : body });
  }
  return rules;
}

/** True when `relPath` is ignored by the rules (last matching rule wins). */
export function isGitignored(relPath: string, rules: GitignoreRule[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  let ignored = false;
  for (const rule of rules) {
    const pattern = rule.pattern.startsWith('/') ? rule.pattern.slice(1) : rule.pattern;
    let hit = false;
    if (rule.dirOnly) {
      hit =
        matchesGlob(normalized, `${pattern}/**`) ||
        normalized === pattern ||
        normalized.startsWith(`${pattern}/`);
    } else if (pattern.includes('/')) {
      hit = matchesGlob(normalized, pattern);
    } else {
      // No slash: match any path segment (gitignore semantics).
      hit = normalized.split('/').some((segment) => matchesGlob(segment, pattern));
    }
    if (hit) ignored = !rule.negate;
  }
  return ignored;
}

function loadGitignoreRules(rootDir: string): GitignoreRule[] {
  try {
    const file = path.join(rootDir, '.gitignore');
    if (!fs.existsSync(file)) return [];
    return parseGitignore(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core search (pure over the filesystem; the Tool wraps it)
// ---------------------------------------------------------------------------

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface SearchFilesDeepResult {
  matches: SearchMatch[];
  /** Files actually read. */
  filesSearched: number;
  /** Files skipped (binary / too big / ignored / over the file cap). */
  filesSkipped: number;
  /** True when the time budget ran out (results are partial). */
  timedOut: boolean;
  /** True when a cap (maxResults / maxFiles) stopped the search early. */
  stoppedEarly: boolean;
  /** Per-file match counts, in first-match order. */
  perFileCounts: Array<{ file: string; count: number }>;
}

export interface SearchFilesDeepOptions {
  workspaceDir: string;
  pattern: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  wholeWord?: boolean;
  /** Sub-path inside the workspace to search (default: whole workspace). */
  path?: string;
  include?: string[];
  exclude?: string[];
  maxResults?: number;
  maxFiles?: number;
  contextLines?: number;
  timeoutMs?: number;
  respectGitignore?: boolean;
  signal?: AbortSignal;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

export function searchFilesDeep(opts: SearchFilesDeepOptions): SearchFilesDeepResult {
  const maxResults = Math.max(1, Math.min(opts.maxResults ?? FILE_SEARCH_DEFAULT_MAX_RESULTS, FILE_SEARCH_MAX_RESULTS_CAP));
  const maxFiles = Math.max(1, Math.min(opts.maxFiles ?? FILE_SEARCH_DEFAULT_MAX_FILES, FILE_SEARCH_MAX_FILES_CAP));
  const contextLines = Math.max(0, Math.min(opts.contextLines ?? 0, FILE_SEARCH_MAX_CONTEXT_LINES));
  const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? FILE_SEARCH_DEFAULT_TIMEOUT_MS, FILE_SEARCH_MAX_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  const include = opts.include ?? [];
  const exclude = opts.exclude ?? [];
  const respectGitignore = opts.respectGitignore ?? true;

  let matcher: (line: string) => boolean;
  if (opts.regex) {
    let source = opts.pattern;
    if (opts.wholeWord) source = `\\b(?:${source})\\b`;
    const re = new RegExp(source, opts.caseInsensitive ? 'i' : '');
    matcher = (line) => {
      re.lastIndex = 0;
      return re.test(line);
    };
  } else if (opts.wholeWord) {
    const escaped = opts.pattern.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, opts.caseInsensitive ? 'i' : '');
    matcher = (line) => {
      re.lastIndex = 0;
      return re.test(line);
    };
  } else if (opts.caseInsensitive) {
    const needle = opts.pattern.toLowerCase();
    matcher = (line) => line.toLowerCase().includes(needle);
  } else {
    matcher = (line) => line.includes(opts.pattern);
  }

  const root = resolveWithin(opts.workspaceDir, opts.path ?? '.');
  const gitignoreRules = respectGitignore ? loadGitignoreRules(opts.workspaceDir) : [];

  const matches: SearchMatch[] = [];
  const perFileCounts: Array<{ file: string; count: number }> = [];
  let filesSearched = 0;
  let filesSkipped = 0;
  let timedOut = false;
  let stoppedEarly = false;

  // Collect candidate files first (deterministic order), then search
  // them until a cap or the deadline stops us.
  const candidates: Array<{ rel: string; full: string }> = [];
  const collect = (dir: string, relPrefix: string): void => {
    if (Date.now() > deadline) {
      timedOut = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (FILE_SEARCH_SKIP_DIRS.includes(entry.name)) continue;
        if (respectGitignore && isGitignored(rel, gitignoreRules)) {
          filesSkipped++;
          continue;
        }
        collect(path.join(dir, entry.name), rel);
        if (timedOut) return;
      } else if (entry.isFile()) {
        if (respectGitignore && isGitignored(rel, gitignoreRules)) {
          filesSkipped++;
          continue;
        }
        if (include.length > 0 && !include.some((g) => matchesGlob(rel, g))) continue;
        if (exclude.some((g) => matchesGlob(rel, g))) continue;
        candidates.push({ rel, full: path.join(dir, entry.name) });
      }
    }
  };

  const rootStat = fs.statSync(root);
  if (rootStat.isFile()) {
    candidates.push({ rel: opts.path ?? '.', full: root });
  } else if (rootStat.isDirectory()) {
    collect(root, opts.path && opts.path !== '.' ? opts.path.replace(/\\/g, '/').replace(/\/$/, '') : '');
  } else {
    throw new Error(`Not a file or directory: "${opts.path ?? '.'}"`);
  }

  for (const file of candidates) {
    if (matches.length >= maxResults) {
      stoppedEarly = true;
      break;
    }
    if (filesSearched >= maxFiles) {
      stoppedEarly = true;
      filesSkipped += candidates.length - candidates.indexOf(file);
      break;
    }
    if (opts.signal?.aborted) {
      timedOut = true;
      break;
    }
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.full);
    } catch {
      filesSkipped++;
      continue;
    }
    if (stat.size > FILE_SEARCH_MAX_BYTES) {
      filesSkipped++;
      continue;
    }
    let content: string;
    try {
      const buf = fs.readFileSync(file.full);
      if (isBinaryBuffer(buf)) {
        filesSkipped++;
        continue;
      }
      content = buf.toString('utf-8');
    } catch {
      filesSkipped++;
      continue;
    }
    filesSearched++;
    const lines = content.split('\n');
    let fileCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!matcher(line)) continue;
      matches.push({
        file: file.rel,
        line: i + 1,
        text: line.slice(0, 500),
        contextBefore: lines
          .slice(Math.max(0, i - contextLines), i)
          .map((l) => l.slice(0, 500)),
        contextAfter: lines.slice(i + 1, i + 1 + contextLines).map((l) => l.slice(0, 500)),
      });
      fileCount++;
      if (matches.length >= maxResults) {
        stoppedEarly = true;
        break;
      }
      // Check the deadline every 200 lines so a single huge file
      // cannot blow the time budget.
      if (i % 200 === 199 && Date.now() > deadline) {
        timedOut = true;
        break;
      }
    }
    if (fileCount > 0) perFileCounts.push({ file: file.rel, count: fileCount });
    if (timedOut) break;
  }

  return { matches, filesSearched, filesSkipped, timedOut, stoppedEarly, perFileCounts };
}

function formatResult(
  result: SearchFilesDeepResult,
  pattern: string,
  relRoot: string,
  maxResults: number,
  timeoutMs: number,
): string {
  const { matches, filesSearched, filesSkipped, timedOut, stoppedEarly, perFileCounts } = result;
  if (matches.length === 0) {
    return (
      `No matches for "${pattern}" in "${relRoot}" ` +
      `(${filesSearched} file(s) searched${filesSkipped > 0 ? `, ${filesSkipped} skipped` : ''}` +
      `${timedOut ? `, stopped early: ${timeoutMs}ms time budget ran out` : ''}).`
    );
  }
  const lines: string[] = [
    `Search "${pattern}" in "${relRoot}" — ${matches.length} match(es) in ${perFileCounts.length} file(s) ` +
      `(${filesSearched} file(s) searched${filesSkipped > 0 ? `, ${filesSkipped} skipped` : ''}):`,
  ];
  for (const match of matches) {
    for (let j = 0; j < match.contextBefore.length; j++) {
      lines.push(`  ${match.file}:${match.line - match.contextBefore.length + j}: ${match.contextBefore[j] ?? ''}`);
    }
    lines.push(`${match.file}:${match.line}: ${match.text}`);
    for (let j = 0; j < match.contextAfter.length; j++) {
      lines.push(`  ${match.file}:${match.line + j + 1}: ${match.contextAfter[j] ?? ''}`);
    }
  }
  if (stoppedEarly) {
    lines.push(`[... showing first ${matches.length} of at least ${maxResults} matches — raise max_results to see more ...]`);
  }
  if (timedOut) {
    lines.push(`[... stopped early: ${timeoutMs}ms time budget ran out — partial results, narrow the path or pattern ...]`);
  }
  return lines.join('\n');
}

export function createFileSearchTools(): Tool[] {
  const searchFilesDeepTool: Tool = {
    definition: {
      name: 'search_files_deep',
      description:
        'Deep content search across the workspace: literal string or regex, with include/exclude globs, ' +
        'context lines, whole-word matching and .gitignore support. Returns matches as file:line with ' +
        'context, capped by max_results / max_files / a time budget (partial results on timeout). ' +
        'Skips .git, node_modules, binary files and files over 1 MB. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for.' },
          regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false).' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive match (default false).' },
          whole_word: { type: 'boolean', description: 'Match whole words only (default false).' },
          path: { type: 'string', description: 'File or directory inside the workspace to search in (default: whole workspace).' },
          include: { type: 'array', description: 'Only search files matching these globs, e.g. ["*.ts", "src/**"] (default: all).', items: { type: 'string' } },
          exclude: { type: 'array', description: 'Skip files matching these globs, e.g. ["*.test.*", "dist/**"] (default: none).', items: { type: 'string' } },
          max_results: { type: 'number', description: `Max matches to return (default ${FILE_SEARCH_DEFAULT_MAX_RESULTS}, capped at ${FILE_SEARCH_MAX_RESULTS_CAP}).` },
          max_files: { type: 'number', description: `Max files to read (default ${FILE_SEARCH_DEFAULT_MAX_FILES}, capped at ${FILE_SEARCH_MAX_FILES_CAP}).` },
          context_lines: { type: 'number', description: `Lines of context before/after each match (0–${FILE_SEARCH_MAX_CONTEXT_LINES}, default 0).` },
          timeout_ms: { type: 'number', description: `Time budget in ms (default ${FILE_SEARCH_DEFAULT_TIMEOUT_MS}, max ${FILE_SEARCH_MAX_TIMEOUT_MS}).` },
          respect_gitignore: { type: 'boolean', description: 'Skip paths ignored by the workspace .gitignore (default true).' },
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
        if (useRegex) {
          try {
            new RegExp(pattern);
          } catch (err) {
            return errorResult(`Invalid regex "${pattern}": ${(err as Error).message}`);
          }
        }
        const maxResults = getIntArg(args, 'max_results', FILE_SEARCH_DEFAULT_MAX_RESULTS, 1, FILE_SEARCH_MAX_RESULTS_CAP);
        const maxFiles = getIntArg(args, 'max_files', FILE_SEARCH_DEFAULT_MAX_FILES, 1, FILE_SEARCH_MAX_FILES_CAP);
        const contextLines = getIntArg(args, 'context_lines', 0, 0, FILE_SEARCH_MAX_CONTEXT_LINES);
        const timeoutMs = getIntArg(args, 'timeout_ms', FILE_SEARCH_DEFAULT_TIMEOUT_MS, 1, FILE_SEARCH_MAX_TIMEOUT_MS);
        const relRoot = args['path'] === undefined ? '.' : getStringArg(args, 'path', false);
        const result = searchFilesDeep({
          workspaceDir: ctx.workspaceDir,
          pattern,
          regex: useRegex,
          caseInsensitive: getBoolArg(args, 'case_insensitive', false),
          wholeWord: getBoolArg(args, 'whole_word', false),
          path: relRoot,
          include: getStringArrayArg(args, 'include'),
          exclude: getStringArrayArg(args, 'exclude'),
          maxResults,
          maxFiles,
          contextLines,
          timeoutMs,
          respectGitignore: getBoolArg(args, 'respect_gitignore', true),
          signal: ctx.signal,
        });
        return truncate(
          formatResult(result, pattern, relRoot, maxResults, timeoutMs),
          MAX_TOOL_RESULT_CHARS,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [searchFilesDeepTool];
}

/** Tool names, in registration order (for tests / docs). */
export const FILE_SEARCH_TOOL_NAMES = ['search_files_deep'] as const;

/** Unbound placeholders (same pattern as CODE_TOOLS / GIT_TOOLS). */
export const FILE_SEARCH_TOOLS: Tool[] = createFileSearchTools();
