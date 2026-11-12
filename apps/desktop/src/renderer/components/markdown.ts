/**
 * Safe Markdown for the chat renderer (UI-1, v0.59).
 *
 * The agent's reply is parsed with `marked`'s lexer into a plain data AST
 * and rendered to React elements by Markdown.tsx. There is NO
 * `dangerouslySetInnerHTML` anywhere in this path, so raw HTML in a reply
 * can never execute:
 *
 * - `html` tokens (raw `<script>`, `<img onerror=...>` ...) are turned
 *   into plain text nodes; React escapes them on render.
 * - Links only become `<a>` for http(s)/mailto URLs; anything else
 *   (`javascript:`, `data:`, `vbscript:`, protocol-relative, relative)
 *   degrades to its visible text.
 * - Images only render for http(s) URLs; anything else degrades to alt text.
 * - Inline code / code blocks keep their raw characters as text; React
 *   escapes them, so `<div>` inside a code block stays visible text.
 *
 * The AST is plain JSON-shaped data, so node:test can cover it without a
 * DOM or Electron (see tests/ui-markdown-stop-v059.test.mjs).
 */
import { marked, type Token, type Tokens } from 'marked';

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: MdInline[] }
  | { kind: 'em'; children: MdInline[] }
  | { kind: 'del'; children: MdInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; title: string | null; children: MdInline[] }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'br' };

export type MdBlock =
  | { kind: 'heading'; depth: number; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { kind: 'table'; header: MdInline[][]; align: Array<'left' | 'center' | 'right' | null>; rows: MdInline[][][] }
  | { kind: 'blockquote'; children: MdBlock[] }
  | { kind: 'hr' };

/** ASCII control characters must never reach a URL attribute. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Links: only http(s) and mailto may become an anchor. */
export function isSafeLinkUrl(href: string): boolean {
  const value = href.trim();
  if (!value || CONTROL_CHARS.test(value)) return false;
  return /^(https?:\/\/|mailto:)/i.test(value);
}

/** Images: only http(s) may become an <img>. No data: URLs. */
export function isSafeImageUrl(src: string): boolean {
  const value = src.trim();
  if (!value || CONTROL_CHARS.test(value)) return false;
  return /^https?:\/\//i.test(value);
}

/** Inline child tokens of a marked token, if any. */
function childTokens(token: Token): Token[] {
  const maybe = token as { tokens?: unknown };
  return Array.isArray(maybe.tokens) ? (maybe.tokens as Token[]) : [];
}

/** Plain text of a marked token (its `text` field, else its `raw` source). */
function tokenText(token: Token): string {
  const maybe = token as { text?: unknown; raw?: unknown };
  if (typeof maybe.text === 'string') return maybe.text;
  if (typeof maybe.raw === 'string') return maybe.raw;
  return '';
}

function toInline(tokens: Token[]): MdInline[] {
  const out: MdInline[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape':
        out.push({ kind: 'text', text: tokenText(token) });
        break;
      case 'strong':
        out.push({ kind: 'strong', children: toInline(childTokens(token)) });
        break;
      case 'em':
        out.push({ kind: 'em', children: toInline(childTokens(token)) });
        break;
      case 'del':
        out.push({ kind: 'del', children: toInline(childTokens(token)) });
        break;
      case 'codespan':
        out.push({ kind: 'code', text: tokenText(token) });
        break;
      case 'br':
        out.push({ kind: 'br' });
        break;
      case 'link': {
        const children = toInline(childTokens(token));
        const href = typeof token.href === 'string' ? token.href : '';
        if (isSafeLinkUrl(href)) {
          out.push({
            kind: 'link',
            href: href.trim(),
            title: typeof token.title === 'string' ? token.title : null,
            children,
          });
        } else {
          // Unsafe scheme: keep the visible text, drop the anchor.
          out.push(...children);
        }
        break;
      }
      case 'image': {
        const src = typeof token.href === 'string' ? token.href : '';
        const alt = tokenText(token);
        if (isSafeImageUrl(src)) {
          out.push({ kind: 'image', src: src.trim(), alt });
        } else {
          // Unsafe source: show the alt text, never an <img>.
          if (alt) out.push({ kind: 'text', text: alt });
        }
        break;
      }
      case 'html':
      case 'tag':
        // Raw HTML from the reply is shown as literal text, never parsed.
        out.push({ kind: 'text', text: tokenText(token) || (token as { raw?: string }).raw || '' });
        break;
      default:
        out.push({ kind: 'text', text: tokenText(token) });
        break;
    }
  }
  return out;
}

function toBlocks(tokens: Token[]): MdBlock[] {
  const out: MdBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'heading':
        out.push({
          kind: 'heading',
          depth: token.depth >= 1 && token.depth <= 6 ? token.depth : 3,
          children: toInline(childTokens(token)),
        });
        break;
      case 'paragraph':
        out.push({ kind: 'paragraph', children: toInline(childTokens(token)) });
        break;
      case 'text': {
        const children = toInline(childTokens(token));
        out.push({
          kind: 'paragraph',
          children: children.length > 0 ? children : [{ kind: 'text', text: tokenText(token) }],
        });
        break;
      }
      case 'code':
        out.push({
          kind: 'code',
          lang: typeof token.lang === 'string' ? token.lang : '',
          text: typeof token.text === 'string' ? token.text : '',
        });
        break;
      case 'table':
        // NOTE: marked's Token union includes Tokens.Generic (index
        // signature), so narrowing does not give these callbacks a
        // contextual type — annotate them explicitly (TS7006 otherwise).
        out.push({
          kind: 'table',
          header: token.header.map((cell: Tokens.TableCell) =>
            toInline(childTokens(cell as unknown as Token)),
          ),
          align: token.align.map((a: 'center' | 'left' | 'right' | null) =>
            a === 'left' || a === 'center' || a === 'right' ? a : null,
          ),
          rows: token.rows.map((row: Tokens.TableCell[]) =>
            row.map((cell: Tokens.TableCell) => toInline(childTokens(cell as unknown as Token))),
          ),
        });
        break;
      case 'hr':
        out.push({ kind: 'hr' });
        break;
      case 'blockquote':
        out.push({ kind: 'blockquote', children: toBlocks(childTokens(token)) });
        break;
      case 'list': {
        const start =
          typeof token.start === 'number' && Number.isFinite(token.start) ? token.start : 1;
        out.push({
          kind: 'list',
          ordered: token.ordered,
          start,
          items: token.items.map((item: Tokens.ListItem) =>
            toBlocks(childTokens(item as unknown as Token)),
          ),
        });
        break;
      }
      case 'html':
        // A raw-HTML block (e.g. `<script>...</script>`) is shown as
        // literal text, never parsed or injected.
        out.push({ kind: 'paragraph', children: [{ kind: 'text', text: token.raw }] });
        break;
      default:
        out.push({ kind: 'paragraph', children: [{ kind: 'text', text: tokenText(token) }] });
        break;
    }
  }
  return out;
}

/**
 * Parse Markdown into the safe AST. Never throws: a lexer failure falls
 * back to one plain-text paragraph so a weird reply cannot break chat.
 */
export function parseMarkdown(text: string): MdBlock[] {
  if (!text || !text.trim()) return [];
  try {
    return toBlocks(marked.lexer(text));
  } catch {
    return [{ kind: 'paragraph', children: [{ kind: 'text', text }] }];
  }
}

// ---------------------------------------------------------------------------
// Minimal code highlighting (no extra dependency).
// ---------------------------------------------------------------------------

export interface CodeSpan {
  text: string;
  cls: 'kw' | 'str' | 'com' | 'num' | null;
}

/** Generic keyword set shared by JS/TS/Python/Go/Rust/Java/C/C++/C#/PHP/Ruby. */
const CODE_KEYWORDS = new Set(
  ('and as assert async await boolean break byte case catch char class const continue ' +
    'crate debugger default def del delete do double dynamic elif else enum except export ' +
    'extends extern false final finally float fn for foreach foreach from function global goto ' +
    'if implements import in instanceof int interface is lambda let long loop match mod move ' +
    'mut namespace native new nonlocal not null object of or package pass private protected ' +
    'public println pub raise ref return self Self short signed sizeof static string struct ' +
    'super switch synchronized template this throw throws trait transient true try type typedef ' +
    'typeof typename union unsigned use using var virtual void volatile while with yield ' +
    'bool char8_t concept consteval constexpr constinit decltype noexcept nullptr requires ' +
    'static_assert static_cast reinterpret_cast dynamic_cast explicit friend inline mutable ' +
    'operator override typename virtual wchar_t ' +
    'None True False print echo require include std cout cin ' +
    'function fn let mut pub struct impl trait where match loop mod use crate self Self ' +
    'extern ref move box dyn async await println ' +
    'def class import from as global nonlocal assert del elif is not and or None True False ' +
    'lambda pass raise except with yield print ' +
    'func package import var const type chan map interface go defer range select case ' +
    'default fallthrough goto nil iota ' +
    'fn let mut pub struct impl trait where match loop mod use crate self Self super extern ' +
    'ref move box dyn async await println macro unsafe ' +
    'abstract boolean byte catch char class double enum extends final finally float implements ' +
    'instanceof int interface long native new package private protected public short static ' +
    'strictfp super switch synchronized this throw throws transient try void volatile ' +
    'namespace using std string vector map set list queue stack pair auto register ' +
    'sizeof typedef union struct enum goto ' +
    'echo function global static abstract final class interface trait extends implements ' +
    'public private protected var const new clone instanceof try catch finally throw ' +
    'foreach as endif endforeach endwhile endswitch declare list unset isset empty ' +
    'puts gets begin rescue ensure end module require attr_accessor initialize ' +
    'val var fun object companion init constructor by lazy lateinit data sealed inner ' +
    'open internal out tailrec operator infix crossinline reified suspend ' +
    'switch case default break continue return if else for while do foreach in of ' +
    'try catch finally throw throws new delete typeof void instanceof in ' +
    'SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE DROP ALTER JOIN ON GROUP BY ' +
    'ORDER LIMIT OFFSET HAVING UNION ALL DISTINCT AS AND OR NOT NULL PRIMARY KEY ' +
    'VARCHAR INT INTEGER TEXT BOOLEAN DATE TIMESTAMP').split(/\s+/),
);

/**
 * Split code into keyword / string / comment / number spans. The spans
 * carry the raw characters; the renderer puts them in React text nodes,
 * so `<`/`>` inside code stay literal text. Multi-line `/* ... *\/`
 * comments and backtick template strings are tracked across lines;
 * `${...}` inside a template string is treated as string content.
 */
export function highlightCode(code: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  const push = (text: string, cls: CodeSpan['cls']): void => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last && last.cls === cls) last.text += text;
    else spans.push({ text, cls });
  };
  const n = code.length;
  let i = 0;
  let inBlockComment = false;
  let inTemplate = false;
  while (i < n) {
    if (inBlockComment) {
      const end = code.indexOf('*/', i);
      if (end === -1) {
        push(code.slice(i), 'com');
        i = n;
      } else {
        push(code.slice(i, end + 2), 'com');
        i = end + 2;
        inBlockComment = false;
      }
      continue;
    }
    if (inTemplate) {
      let j = i;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === '`') break;
        j += 1;
      }
      push(code.slice(i, j), 'str');
      if (j < n) {
        push('`', 'str');
        i = j + 1;
        inTemplate = false;
      } else {
        i = n;
      }
      continue;
    }
    const ch = code[i];
    const next = i + 1 < n ? code[i + 1] : '';
    if (ch === '/' && next === '/') {
      const eol = code.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      push(code.slice(i, end), 'com');
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      push('/*', 'com');
      i += 2;
      continue;
    }
    // `#` comment only at line start or after whitespace (so `a#b` and
    // URL fragments are not eaten).
    if (ch === '#' && (i === 0 || code[i - 1] === '\n' || code[i - 1] === ' ' || code[i - 1] === '\t')) {
      const eol = code.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      push(code.slice(i, end), 'com');
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === quote || code[j] === '\n') break;
        j += 1;
      }
      const end = j < n && code[j] === quote ? j + 1 : j;
      push(code.slice(i, end), 'str');
      i = end;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      push('`', 'str');
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]))) {
      const m = /^[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?/.exec(code.slice(i));
      if (m) {
        push(m[0], 'num');
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(code.slice(i));
      if (m) {
        push(m[0], CODE_KEYWORDS.has(m[0]) ? 'kw' : null);
        i += m[0].length;
        continue;
      }
    }
    push(ch, null);
    i += 1;
  }
  return spans;
}
