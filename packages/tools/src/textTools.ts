/**
 * Text tools for @open-bot/tools (v0.89, worker F4 — builtin tools giá trị cao).
 *
 *   text_extract           — regex extract (capped matches, capped input).
 *   text_diff              — unified diff of two texts (LCS, hunks with
 *                            3 lines of context; prefix/suffix fast path
 *                            for very long inputs).
 *   text_summarize_extract — extractive summary: rank sentences by
 *                            plain term frequency (no model call) and
 *                            return the top N in original order.
 *   markdown_toc           — table of contents from Markdown headings.
 *
 * Pure functions (`extractWithRegex`, `diffLines`,
 * `extractiveSummarize`, `markdownToc`) are exported for tests; each
 * tool is a thin wrapper (inline text or a workspace file, limits,
 * truncation like every other tool).
 *
 * Limits: text inputs max MAX_TEXT_INPUT_CHARS (1M chars — regex and
 * diff are quadratic-ish, so the cap is lower than the 5 MB data cap),
 * matches max 100, diff inputs max 1.000 lines each on the LCS path.
 *
 * Factory (same pattern as the other tool groups):
 *   createTextTools() -> Tool[]   (no options needed)
 *   TEXT_TOOLS
 *
 * Approval: all four tools only read/transform caller-supplied text
 * (or a file inside the workspace) and never write, never call the
 * network -> needsApproval false.
 */
import * as fs from 'node:fs';
import type { Tool, ToolContext } from '@open-bot/core';
import { resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

/** Max input text per call: 1M chars (regex/diff cost). */
export const MAX_TEXT_INPUT_CHARS = 1_000_000;
/** Max regex matches returned. */
export const MAX_TEXT_MATCHES = 100;
/** Max lines per side on the exact LCS diff path. */
export const MAX_DIFF_LINES = 1_000;
/** Diff context lines around each change hunk. */
export const DIFF_CONTEXT_LINES = 3;

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

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return Math.floor(value);
}

function assertTextSize(text: string): void {
  if (text.length > MAX_TEXT_INPUT_CHARS) {
    throw new Error(
      `Input is ${text.length} chars, over the ${MAX_TEXT_INPUT_CHARS} char limit.`,
    );
  }
}

function loadTextInput(
  args: Record<string, unknown>,
  ctx: ToolContext,
  inlineArg: string,
): string {
  const inline = args[inlineArg];
  if (typeof inline === 'string') {
    assertTextSize(inline);
    return inline;
  }
  if (inline !== undefined && inline !== null) {
    throw new Error(`Argument "${inlineArg}" must be a string, got ${typeof inline}`);
  }
  const relPath = getStringArg(args, 'path');
  const fullPath = resolveWithin(ctx.workspaceDir, relPath);
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) throw new Error(`Not a file: "${relPath}"`);
  if (stat.size > MAX_TEXT_INPUT_CHARS) {
    throw new Error(
      `File is ${stat.size} bytes, over the ${MAX_TEXT_INPUT_CHARS} byte input limit: "${relPath}"`,
    );
  }
  const text = fs.readFileSync(fullPath, 'utf8');
  assertTextSize(text);
  return text;
}

// ---------------------------------------------------------------------------
// text_extract — regex
// ---------------------------------------------------------------------------

export interface RegexMatch {
  match: string;
  groups: string[];
  index: number;
}

/** All matches of `pattern` in `text` (global), capped at MAX_TEXT_MATCHES. */
export function extractWithRegex(
  text: string,
  pattern: string,
  flags = '',
  limit: number = MAX_TEXT_MATCHES,
): RegexMatch[] {
  assertTextSize(text);
  if (pattern === '') throw new Error('Regex pattern must not be empty.');
  if (pattern.length > 1_000) throw new Error('Regex pattern is too long (max 1000 chars).');
  const cleanFlags = [...new Set((flags + 'g').split(''))].join('');
  if (/[^dgimsuvy]/.test(cleanFlags)) {
    throw new Error(`Bad regex flag in "${flags}" (allowed: d g i m s u v y).`);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, cleanFlags);
  } catch (err) {
    throw new Error(`Invalid regex: ${(err as Error).message}`);
  }
  const out: RegexMatch[] = [];
  let m: RegExpExecArray | null;
  // Guard against a pattern that matches the empty string forever:
  // exec() with /g advances lastIndex, but an empty match at the same
  // index would loop — break out if no progress is made.
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    out.push({ match: m[0], groups: m.slice(1), index: m.index });
    if (out.length >= limit) break;
    if (m[0] === '') {
      re.lastIndex += 1;
      if (re.lastIndex > text.length) break;
    }
    guard += 1;
    if (guard > limit + text.length) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// text_diff — unified diff (LCS)
// ---------------------------------------------------------------------------

type DiffOp = { kind: ' ' | '-' | '+'; line: string };

function lcsDiff(aLines: string[], bLines: string[]): DiffOp[] {
  const n = aLines.length;
  const m = bLines.length;
  // dp[i][j] = LCS length of aLines[i..] and bLines[j..]. (n, m <= 1000
  // so the table is at most ~1M cells — fine.)
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      (dp[i] as Uint32Array)[j] =
        aLines[i] === bLines[j]
          ? (dp[i + 1] as Uint32Array)[j + 1] + 1
          : Math.max((dp[i + 1] as Uint32Array)[j], (dp[i] as Uint32Array)[j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ kind: ' ', line: aLines[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[i + 1] as Uint32Array)[j] >= (dp[i] as Uint32Array)[j + 1]) {
      ops.push({ kind: '-', line: aLines[i] as string });
      i += 1;
    } else {
      ops.push({ kind: '+', line: bLines[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: aLines[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: '+', line: bLines[j] as string });
    j += 1;
  }
  return ops;
}

function formatUnifiedDiff(ops: DiffOp[]): string {
  // Group changed ops into hunks with DIFF_CONTEXT_LINES of context.
  const changed = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.kind !== ' ') {
      for (let k = Math.max(0, idx - DIFF_CONTEXT_LINES); k <= Math.min(ops.length - 1, idx + DIFF_CONTEXT_LINES); k += 1) {
        changed.add(k);
      }
    }
  });
  if (changed.size === 0) return 'No differences.';
  const lines: string[] = [];
  const sorted = [...changed].sort((x, y) => x - y);
  const flushHunk = (from: number, to: number, aStart: number, bStart: number): void => {
    let aCount = 0;
    let bCount = 0;
    for (let k = from; k <= to; k += 1) {
      const op = ops[k] as DiffOp;
      if (op.kind !== '+') aCount += 1;
      if (op.kind !== '-') bCount += 1;
    }
    lines.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (let k = from; k <= to; k += 1) {
      const op = ops[k] as DiffOp;
      lines.push(`${op.kind}${op.line}`);
    }
  };
  // aBefore/bBefore count the a/b lines consumed before the current run.
  let runStart = sorted[0] as number;
  let prev = sorted[0] as number;
  let aBefore = 0;
  let bBefore = 0;
  for (let k = 0; k < runStart; k += 1) {
    const op = ops[k] as DiffOp;
    if (op.kind !== '+') aBefore += 1;
    if (op.kind !== '-') bBefore += 1;
  }
  for (let s = 1; s <= sorted.length; s += 1) {
    const cur = sorted[s];
    if (cur === undefined || cur !== prev + 1) {
      flushHunk(runStart, prev, aBefore, bBefore);
      if (cur === undefined) break;
      for (let k = prev + 1; k < cur; k += 1) {
        const op = ops[k] as DiffOp;
        if (op.kind !== '+') aBefore += 1;
        if (op.kind !== '-') bBefore += 1;
      }
      runStart = cur;
    }
    prev = cur as number;
  }
  return lines.join('\n');
}

/**
 * Unified diff of two texts. For inputs over MAX_DIFF_LINES lines per
 * side the exact LCS table is too big, so only the common prefix /
 * suffix are shown and the middle is summarised.
 */
export function diffLines(a: string, b: string): string {
  assertTextSize(a);
  assertTextSize(b);
  if (a === b) return 'No differences.';
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  if (aLines.length > MAX_DIFF_LINES || bLines.length > MAX_DIFF_LINES) {
    let prefix = 0;
    while (
      prefix < aLines.length &&
      prefix < bLines.length &&
      aLines[prefix] === bLines[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < aLines.length - prefix &&
      suffix < bLines.length - prefix &&
      aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const aMid = aLines.length - prefix - suffix;
    const bMid = bLines.length - prefix - suffix;
    return [
      `Inputs too long for an exact diff (${aLines.length} vs ${bLines.length} lines, limit ${MAX_DIFF_LINES} each).`,
      `Common prefix: ${prefix} line(s); common suffix: ${suffix} line(s).`,
      `Changed middle: ${aMid} line(s) in the first text, ${bMid} line(s) in the second.`,
    ].join('\n');
  }
  return formatUnifiedDiff(lcsDiff(aLines, bLines));
}

// ---------------------------------------------------------------------------
// text_summarize_extract — TF sentence ranking (no model)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for',
  'with', 'as', 'by', 'at', 'from', 'is', 'are', 'was', 'were', 'be',
  'been', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you',
  'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her', 'our', 'their',
  'not', 'no', 'so', 'if', 'then', 'than', 'too', 'very', 'can', 'will',
  'would', 'should', 'have', 'has', 'had', 'do', 'does', 'did',
  // Vietnamese
  'và', 'hoặc', 'nhưng', 'của', 'cho', 'trong', 'trên', 'với', 'là',
  'là', 'đã', 'sẽ', 'đang', 'có', 'không', 'một', 'các', 'những', 'này',
  'đó', 'kia', 'thì', 'mà', 'để', 'từ', 'đến', 'về', 'khi', 'nếu',
  'như', 'rất', 'cũng', 'chỉ', 'được', 'bị', 'ra', 'vào', 'lên', 'xuống',
  'nên', 'phải', 'cần', 'tôi', 'bạn', 'anh', 'chị', 'em', 'chúng',
]);

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokenize(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Return the `maxSentences` most important sentences (term-frequency
 * score), in their original order.
 */
export function extractiveSummarize(text: string, maxSentences = 5): string[] {
  assertTextSize(text);
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  if (sentences.length <= maxSentences) return sentences;
  const freq = new Map<string, number>();
  const tokenized = sentences.map(tokenize);
  for (const words of tokenized) {
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const scored = tokenized.map((words, idx) => {
    const raw = words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0);
    // Length-normalised so one very long sentence does not win by bulk.
    const score = words.length > 0 ? raw / Math.sqrt(words.length) : 0;
    return { idx, score };
  });
  const picked = scored
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, Math.max(1, maxSentences))
    .map((s) => s.idx)
    .sort((a, b) => a - b);
  return picked.map((idx) => sentences[idx] as string);
}

// ---------------------------------------------------------------------------
// markdown_toc
// ---------------------------------------------------------------------------

/** GitHub-style slug: lowercase, punctuation dropped, spaces -> `-`. */
export function slugifyHeading(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Build a Markdown table of contents from `#` headings (max depth). */
export function markdownToc(markdown: string, maxDepth = 3): string {
  assertTextSize(markdown);
  const used = new Map<string, number>();
  const lines: string[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const depth = (m[1] as string).length;
    if (depth > maxDepth) continue;
    const title = (m[2] as string).replace(/[*_`[\]()]/g, '').trim();
    if (title === '') continue;
    let slug = slugifyHeading(title);
    if (slug === '') slug = 'section';
    const count = (used.get(slug) ?? 0) + 1;
    used.set(slug, count);
    if (count > 1) slug = `${slug}-${count - 1}`;
    lines.push(`${'  '.repeat(depth - 1)}- [${title}](#${slug})`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no headings found)';
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

const textExtractTool: Tool = {
  definition: toolDef(
    'text_extract',
    'Extract all matches of a regex from text (or a workspace file). Returns each match with its capture groups and index. Input max 1M chars, at most 100 matches.',
    {
      text: { type: 'string', description: 'Text to search (either this or "path").' },
      path: { type: 'string', description: 'Workspace file to search (either this or "text").' },
      pattern: { type: 'string', description: 'Regex pattern, e.g. "\\\\b[\\\\w.]+@[\\\\w.]+\\\\.\\\\w+\\\\b".' },
      flags: { type: 'string', description: 'Optional regex flags: i, m, s, u (g is always on).' },
      limit: { type: 'number', description: 'Max matches to return (default 100, max 100).' },
    },
    ['pattern'],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const pattern = getStringArg(args, 'pattern');
      const flags = args['flags'] === undefined ? '' : getStringArg(args, 'flags', false);
      const limit = Math.min(Math.max(1, getNumberArg(args, 'limit', MAX_TEXT_MATCHES)), MAX_TEXT_MATCHES);
      const text = loadTextInput(args, ctx, 'text');
      const matches = extractWithRegex(text, pattern, flags, limit);
      if (matches.length === 0) return `No matches for /${pattern}/${flags || 'g'}.`;
      return truncate(
        `${matches.length} match(es):\n${JSON.stringify(matches, null, 2)}`,
        MAX_TOOL_RESULT_CHARS,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const textDiffTool: Tool = {
  definition: toolDef(
    'text_diff',
    'Unified diff of two texts (or two workspace files): hunks with 3 lines of context. Identical texts report "No differences." Very long inputs (over 1000 lines a side) get a prefix/suffix summary instead of an exact diff.',
    {
      a: { type: 'string', description: 'First text (either this or "path_a").' },
      b: { type: 'string', description: 'Second text (either this or "path_b").' },
      path_a: { type: 'string', description: 'Workspace file for the first text.' },
      path_b: { type: 'string', description: 'Workspace file for the second text.' },
    },
    [],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const load = (inlineArg: string, pathArg: string): string => {
        const inline = args[inlineArg];
        if (typeof inline === 'string') {
          assertTextSize(inline);
          return inline;
        }
        if (inline !== undefined && inline !== null) {
          throw new Error(`Argument "${inlineArg}" must be a string.`);
        }
        const relPath = getStringArg(args, pathArg);
        const fullPath = resolveWithin(ctx.workspaceDir, relPath);
        if (!fs.statSync(fullPath).isFile()) throw new Error(`Not a file: "${relPath}"`);
        return fs.readFileSync(fullPath, 'utf8');
      };
      const a = load('a', 'path_a');
      const b = load('b', 'path_b');
      return truncate(diffLines(a, b), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const textSummarizeTool: Tool = {
  definition: toolDef(
    'text_summarize_extract',
    'Extractive summary: rank sentences by plain term frequency (no model call) and return the most important ones in original order. Good for a quick gist of a long text, not a paraphrase.',
    {
      text: { type: 'string', description: 'Text to summarise (either this or "path").' },
      path: { type: 'string', description: 'Workspace file to summarise (either this or "text").' },
      sentences: { type: 'number', description: 'How many sentences to keep (default 5).' },
    },
    [],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const count = Math.min(Math.max(1, getNumberArg(args, 'sentences', 5)), 20);
      const text = loadTextInput(args, ctx, 'text');
      const picked = extractiveSummarize(text, count);
      if (picked.length === 0) return 'No sentences found in the input.';
      return truncate(picked.map((s, i) => `${i + 1}. ${s}`).join('\n'), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const markdownTocTool: Tool = {
  definition: toolDef(
    'markdown_toc',
    'Build a Markdown table of contents from the headings of a Markdown text (or workspace file), with GitHub-style anchor slugs. Duplicate headings get -1, -2 suffixes.',
    {
      markdown: { type: 'string', description: 'Markdown text (either this or "path").' },
      path: { type: 'string', description: 'Workspace Markdown file (either this or "markdown").' },
      max_depth: { type: 'number', description: 'Deepest heading level to include (default 3).' },
    },
    [],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const depth = Math.min(Math.max(1, getNumberArg(args, 'max_depth', 3)), 6);
      const text = loadTextInput(args, ctx, 'markdown');
      return truncate(markdownToc(text, depth), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

export function createTextTools(): Tool[] {
  return [textExtractTool, textDiffTool, textSummarizeTool, markdownTocTool];
}

export const TEXT_TOOLS: Tool[] = createTextTools();
