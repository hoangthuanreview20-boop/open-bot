/**
 * Skill loader (v0.11a: Agent Skills standard, agentskills.io).
 *
 * Reads skills in two layouts:
 *  1. Standard — a skill DIRECTORY `<name>/SKILL.md` (+ optional
 *     `scripts/` / `references/` / `assets/`). `name` must equal the
 *     directory name. This is the agentskills.io layout.
 *  2. Legacy — a loose `<name>.md` file with the same frontmatter+body
 *     shape (v0.4 format). Still loads; `tools:` maps to `allowed-tools:`,
 *     `version:` defaults to `1.0.0` when absent.
 *
 * Directories (searched in this order; first file wins on name clash —
 * see registry.ts for the override order):
 * 1. built-in skills — compiled into the registry (see registry.ts), not disk.
 * 2. user skills — `<userData>/skills/` (loose `*.md` files and/or
 *    skill directories holding `SKILL.md`).
 * 3. plugin skills — `<plugin-dir>/skills/` for each installed plugin
 *    (same mix of loose files and skill directories).
 *
 * Progressive disclosure: the registry loads TIER 1 (frontmatter only)
 * at startup via `parseSkillMetadata` / `loadSkillFileMetadata` /
 * `loadSkillDir` — the body is NOT retained (`bodyLoaded === false`).
 * Tier 2 (`ensureSkillBody`, in registry.ts) reads the body only for a
 * skill that matched a task. Tier 3 reads a `scripts/` / `references/` /
 * `assets/` file only when asked, via `readSkillResource`.
 *
 * YAML: the frontmatter parser is a real YAML subset parser (no
 * dependency — no `js-yaml` in this repo), not the old flat
 * `key: value` splitter. It understands block mappings (nested via
 * indentation), block sequences (`- item`), flow collections
 * (`[a, b]`, `{k: v}`), quoted strings, literal `|` / folded `>`
 * block scalars, comments, and scalar typing (null/bool/number).
 * It does NOT implement anchors/aliases, tags, multi-document files
 * or complex keys — frontmatter that needs those is rejected with a
 * clear error instead of being silently misread.
 *
 * Safety: a skill file is data, never code. The loader rejects files
 * whose frontmatter or body contains an obvious secret pattern (API key
 * / token / password assignment). That is a tripwire against
 * accidentally pasting a credential into a skill, not a guarantee —
 * never put secrets in skills. Resource files are NOT executed by this
 * loader; `readSkillResource` only reads, and `resolveSkillResourcePath`
 * only hands out a path for the caller to execute.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Skill, SkillFrontmatter, SkillResources, SkillSource } from './types';
import { emptySkillResources, SkillLoadError, SKILL_RESOURCE_DIRS } from './types';

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Default version for standard skills (agentskills.io has no version field). */
export const DEFAULT_SKILL_VERSION = '1.0.0';
/** A skill body is truncated to this when injected into a system prompt. */
export const MAX_SKILL_BODY_CHARS = 4000;
/**
 * v0.66b: cap for reading / installing a whole SKILL.md text (read +
 * install paths). Matches the IPC `requireText` cap (200.000 chars) so
 * the renderer, the IPC layer and the core all enforce the same limit —
 * a skill larger than this is rejected with a clear error instead of
 * being read into memory unbounded.
 */
export const MAX_SKILL_TEXT_CHARS = 200_000;
/** `SKILL.md` file name inside a standard skill directory. */
export const SKILL_FILE_NAME = 'SKILL.md';

/** Patterns that look like a pasted secret — rejected at load time. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/i,
  /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?\S{8,}['"]?/i,
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI-style key
  /\bxai-[A-Za-z0-9]{16,}\b/, // xAI-style key
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub personal access token
  /\bBearer\s+[A-Za-z0-9_\-.]{16,}\b/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// ---------------------------------------------------------------------------
// YAML subset parser (dependency-free)
// ---------------------------------------------------------------------------

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface YamlLine {
  indent: number;
  content: string;
  lineNo: number;
}

function yamlFail(message: string, filePath?: string): never {
  throw new SkillLoadError(`Invalid YAML frontmatter: ${message}`, filePath);
}

/** Split a YAML document into significant lines (blank/comment-only dropped). */
function yamlLines(text: string, filePath?: string): YamlLine[] {
  const out: YamlLine[] = [];
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (raw.includes('\t') && raw.slice(0, indent).includes('\t')) {
      yamlFail(`line ${i + 1}: tabs are not allowed for indentation`, filePath);
    }
    out.push({ indent, content: raw.trim(), lineNo: i + 1 });
  }
  return out;
}

/** Parse a flow scalar / collection starting at `value` (already trimmed). */
function parseFlowValue(value: string, filePath?: string): YamlValue {
  const v = stripInlineComment(value).trim();
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null;
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) yamlFail(`unclosed flow sequence ${JSON.stringify(value)}`, filePath);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlowItems(inner, filePath).map((item) => parseFlowValue(item, filePath));
  }
  if (v.startsWith('{')) {
    if (!v.endsWith('}')) yamlFail(`unclosed flow mapping ${JSON.stringify(value)}`, filePath);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return {};
    const obj: { [key: string]: YamlValue } = {};
    for (const item of splitFlowItems(inner, filePath)) {
      const colon = findFlowColon(item);
      if (colon === -1) yamlFail(`flow mapping entry needs "key: value": ${JSON.stringify(item)}`, filePath);
      obj[unquoteKey(item.slice(0, colon).trim(), filePath)] = parseFlowValue(
        item.slice(colon + 1),
        filePath,
      );
    }
    return obj;
  }
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    return unquoteScalar(v, filePath);
  }
  if (v.startsWith('"') || v.startsWith("'") || v.startsWith('[') || v.startsWith('{')) {
    yamlFail(`unterminated quoted/flow value ${JSON.stringify(value)}`, filePath);
  }
  if (v === 'true' || v === 'True' || v === 'TRUE') return true;
  if (v === 'false' || v === 'False' || v === 'FALSE') return false;
  if (/^-?(0|[1-9][0-9]*)$/.test(v)) return parseInt(v, 10);
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(v) && /[.eE]/.test(v)) {
    return parseFloat(v);
  }
  return v;
}

/** Split a flow `[...]` / `{...}` body on top-level commas. */
function splitFlowItems(inner: string, filePath?: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      if (quote === "'" && ch === "'") quote = '';
      else if (quote === '"' && ch === '"' && inner[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (quote) yamlFail(`unterminated quote in flow collection ${JSON.stringify(inner)}`, filePath);
  if (depth !== 0) yamlFail(`unbalanced brackets in flow collection ${JSON.stringify(inner)}`, filePath);
  items.push(inner.slice(start));
  return items.map((s) => s.trim()).filter((s) => s !== '');
}

/** Index of the `:` separating key/value in a flow mapping entry (outside quotes/brackets). */
function findFlowColon(item: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < item.length; i++) {
    const ch = item[i]!;
    if (quote) {
      if (quote === "'" && ch === "'") quote = '';
      else if (quote === '"' && ch === '"' && item[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0 && (i + 1 === item.length || item[i + 1] === ' ')) return i;
  }
  return -1;
}

/** Remove a trailing ` # comment` outside quotes. */
function stripInlineComment(value: string): string {
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      if (quote === "'" && ch === "'") quote = '';
      else if (quote === '"' && ch === '"' && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '#' && i > 0 && value[i - 1] === ' ') return value.slice(0, i);
  }
  return value;
}

function unquoteKey(key: string, filePath?: string): string {
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    return unquoteScalar(key, filePath);
  }
  return key;
}

function unquoteScalar(value: string, filePath?: string): string {
  const q = value[0]!;
  const inner = value.slice(1, -1);
  if (q === "'") return inner.replace(/''/g, "'");
  // Double-quoted: handle the common escapes; anything else stays literal.
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1]!;
      const escapes: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        '"': '"',
        '\\': '\\',
        '0': '\0',
      };
      out += escapes[next] ?? next;
      i++;
    } else {
      out += ch;
    }
  }
  if (value.length < 2 || value[value.length - 1] !== q) {
    yamlFail(`unterminated quoted string ${JSON.stringify(value)}`, filePath);
  }
  return out;
}

/**
 * Match a `key:` mapping entry at the start of `content`.
 * Returns `{ key, rest }` or null when this line is not a mapping entry.
 * A key is plain text (or quoted) followed by `:` + space/EOL.
 */
function matchMappingKey(
  content: string,
  filePath?: string,
): { key: string; rest: string } | null {
  let key: string;
  let rest: string;
  if (content.startsWith('"') || content.startsWith("'")) {
    const q = content[0]!;
    let end = -1;
    for (let i = 1; i < content.length; i++) {
      if (content[i] === q && (q === "'" || content[i - 1] !== '\\')) {
        end = i;
        break;
      }
    }
    if (end === -1) yamlFail(`unterminated quoted key in ${JSON.stringify(content)}`, filePath);
    key = unquoteScalar(content.slice(0, end + 1), filePath);
    rest = content.slice(end + 1);
  } else {
    const colon = content.indexOf(':');
    if (colon === -1) return null;
    key = content.slice(0, colon).trim();
    rest = content.slice(colon);
  }
  if (!/^:\s*(.*)$/.test(rest)) return null;
  if (key === '' || key.includes(' #')) return null;
  return { key, rest: rest.replace(/^:\s*/, '') };
}

/**
 * Parse a literal `|` / folded `>` block scalar whose header is `header`
 * (`|`, `|-`, `|+`, `>`, `>-`, `>+`, optionally with an indent digit).
 * `rawLines` are the ORIGINAL frontmatter lines (blank lines kept);
 * consumption starts after `headerLineNo` (0-based) and takes every
 * following line that is blank or indented more than `parentIndent`.
 */
function parseBlockScalar(
  header: string,
  rawLines: string[],
  headerLineNo: number,
  parentIndent: number,
  filePath?: string,
): { value: string; nextLineNo: number } {
  const m = /^([|>])([+-]?)([1-9]?)\s*(?:#.*)?$/.exec(header.trim());
  if (!m) yamlFail(`invalid block scalar header ${JSON.stringify(header)}`, filePath);
  const folded = m[1] === '>';
  const chomping = m[2] === '-' ? 'strip' : m[2] === '+' ? 'keep' : 'clip';
  const explicitIndent = m[3] ? parseInt(m[3], 10) : 0;
  const collected: string[] = [];
  let i = headerLineNo + 1;
  let contentIndent: number | null = explicitIndent > 0 ? parentIndent + explicitIndent : null;
  for (; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    if (raw.trim() === '') {
      collected.push('');
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent <= parentIndent) break;
    if (contentIndent === null) contentIndent = indent;
    if (indent < contentIndent) break;
    collected.push(raw.slice(contentIndent));
  }
  // Drop trailing blank lines (chomping decides the final newlines).
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  let value: string;
  if (folded) {
    // Folded: non-blank lines in a run join with a space; a blank line
    // is a paragraph break (one newline).
    let foldedValue = '';
    for (const line of collected) {
      if (line === '') {
        foldedValue += '\n';
        continue;
      }
      if (foldedValue !== '' && !foldedValue.endsWith('\n')) foldedValue += ' ';
      foldedValue += line;
    }
    value = foldedValue;
  } else {
    value = collected.join('\n');
  }
  if (chomping === 'clip') value += '\n';
  else if (chomping === 'keep') value += '\n';
  return { value, nextLineNo: i };
}

/**
 * Parse a YAML document (frontmatter block) into a plain JS value.
 * Supports the subset described in the header. Throws SkillLoadError.
 * `rawLines` (optional) is the original line array, needed only for
 * block scalars (`|` / `>`); when omitted, block scalars are rejected.
 */
export function parseYaml(text: string, filePath?: string, rawLines?: string[]): YamlValue {
  const lines = yamlLines(text, filePath);
  if (lines.length === 0) return null;
  const sourceLines = rawLines ?? text.split(/\r?\n/);
  const [value] = parseYamlBlock(lines, 0, lines[0]!.indent, sourceLines, filePath);
  return value;
}

function parseYamlBlock(
  lines: YamlLine[],
  start: number,
  indent: number,
  rawLines: string[] | undefined,
  filePath?: string,
): [YamlValue, number] {
  const first = lines[start]!;
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseYamlSequence(lines, start, indent, rawLines, filePath);
  }
  if (matchMappingKey(first.content, filePath)) {
    return parseYamlMapping(lines, start, indent, rawLines, filePath);
  }
  // A lone scalar (one line). Multi-line plain scalars are not supported.
  if (start + 1 < lines.length && lines[start + 1]!.indent >= indent) {
    yamlFail(`line ${first.lineNo}: unexpected content after scalar`, filePath);
  }
  return [parseFlowValue(first.content, filePath), start + 1];
}

function parseYamlMapping(
  lines: YamlLine[],
  start: number,
  indent: number,
  rawLines: string[] | undefined,
  filePath?: string,
): [YamlValue, number] {
  const obj: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      yamlFail(`line ${line.lineNo}: unexpected indentation`, filePath);
    }
    const matched = matchMappingKey(line.content, filePath);
    if (!matched) {
      yamlFail(`line ${line.lineNo}: expected "key: value", got ${JSON.stringify(line.content)}`, filePath);
    }
    const { key, rest } = matched;
    if (rest !== '') {
      if (/^[|>]/.test(rest)) {
        if (!rawLines) yamlFail(`line ${line.lineNo}: block scalar needs source lines`, filePath);
        const { value, nextLineNo } = parseBlockScalar(rest, rawLines, line.lineNo - 1, indent, filePath);
        obj[key] = value;
        // Skip the consumed lines: advance past every yamlLine whose
        // original line number is < nextLineNo.
        i++;
        while (i < lines.length && lines[i]!.lineNo <= nextLineNo) i++;
        continue;
      }
      obj[key] = parseFlowValue(rest, filePath);
      i++;
      continue;
    }
    // Empty value: nested block, or null when nothing more-indented follows.
    const next = lines[i + 1];
    if (!next || next.indent <= indent) {
      obj[key] = null;
      i++;
      continue;
    }
    const [child, nextI] = parseYamlBlock(lines, i + 1, next.indent, rawLines, filePath);
    obj[key] = child;
    i = nextI;
  }
  return [obj, i];
}

function parseYamlSequence(
  lines: YamlLine[],
  start: number,
  indent: number,
  rawLines: string[] | undefined,
  filePath?: string,
): [YamlValue, number] {
  const arr: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      yamlFail(`line ${line.lineNo}: unexpected indentation in sequence`, filePath);
    }
    if (!(line.content === '-' || line.content.startsWith('- '))) break;
    const itemText = line.content === '-' ? '' : line.content.slice(2);
    if (itemText === '') {
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        arr.push(null);
        i++;
        continue;
      }
      const [child, nextI] = parseYamlBlock(lines, i + 1, next.indent, rawLines, filePath);
      arr.push(child);
      i = nextI;
      continue;
    }
    if (/^[|>]/.test(itemText)) {
      yamlFail(`line ${line.lineNo}: block scalar as a sequence item is not supported`, filePath);
    }
    // `- key: value ...` — an inline mapping whose first line sits at
    // indent+2; following more-indented lines belong to the same item.
    if (matchMappingKey(itemText, filePath)) {
      const synthetic: YamlLine[] = [{ indent: indent + 2, content: itemText, lineNo: line.lineNo }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent > indent) {
        synthetic.push(lines[j]!);
        j++;
      }
      const [child] = parseYamlMapping(synthetic, 0, indent + 2, rawLines, filePath);
      arr.push(child);
      i = j;
      continue;
    }
    if (itemText.startsWith('- ')) {
      const synthetic: YamlLine[] = [{ indent: indent + 2, content: itemText, lineNo: line.lineNo }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent > indent) {
        synthetic.push(lines[j]!);
        j++;
      }
      const [child] = parseYamlSequence(synthetic, 0, indent + 2, rawLines, filePath);
      arr.push(child);
      i = j;
      continue;
    }
    arr.push(parseFlowValue(itemText, filePath));
    i++;
  }
  return [arr, i];
}

// ---------------------------------------------------------------------------
// Frontmatter → SkillFrontmatter (agentskills.io + legacy mapping)
// ---------------------------------------------------------------------------

function asString(value: unknown, field: string, filePath?: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new SkillLoadError(
    `Skill frontmatter field "${field}" must be a string, got ${typeof value}.`,
    filePath,
  );
}

function asStringList(value: unknown, field: string, filePath?: string): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return [];
    // A bare string: one tool, or comma-separated ("a, b").
    return trimmed
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const s = asString(item, field, filePath);
      if (s === undefined || s.trim() === '') {
        throw new SkillLoadError(`Skill frontmatter field "${field}" must be a list of strings.`, filePath);
      }
      return s.trim();
    });
  }
  throw new SkillLoadError(`Skill frontmatter field "${field}" must be a string or a list.`, filePath);
}

function asBoolean(value: unknown, field: string, filePath?: string): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  throw new SkillLoadError(`Skill frontmatter field "${field}" must be true or false.`, filePath);
}

function asRecord(value: unknown, field: string, filePath?: string): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new SkillLoadError(`Skill frontmatter field "${field}" must be a mapping.`, filePath);
}

/**
 * Parse a frontmatter block into a validated SkillFrontmatter.
 * Accepts the agentskills.io fields plus the legacy open-bot fields
 * (`version`, `when-to-use`, `tools`); unknown keys are ignored.
 */
export function parseFrontmatter(block: string, filePath?: string): SkillFrontmatter {
  const fail = (msg: string): never => {
    throw new SkillLoadError(msg, filePath);
  };
  let parsed: unknown;
  try {
    parsed = parseYaml(block, filePath, block.split(/\r?\n/));
  } catch (err) {
    if (err instanceof SkillLoadError) throw err;
    throw new SkillLoadError(`Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`, filePath);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('Skill frontmatter must be a mapping of "key: value" pairs.');
  }
  const raw = parsed as Record<string, unknown>;

  const name = asString(raw['name'], 'name', filePath) ?? '';
  if (!SKILL_NAME_RE.test(name)) {
    fail(
      `Invalid skill name ${JSON.stringify(name)}: use 1–${SKILL_NAME_MAX_LENGTH} lowercase letters, digits, "-" and "_", starting with a letter or digit (agentskills.io: lowercase + "-" only, matching the skill directory name).`,
    );
  }
  const description = asString(raw['description'], 'description', filePath) ?? '';
  if (description.trim() === '') {
    fail(`Skill "${name}" must have a non-empty "description".`);
  }
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    fail(
      `Skill "${name}" description is ${description.length} chars — the agentskills.io limit is ${SKILL_DESCRIPTION_MAX_LENGTH} (it is the trigger text loaded at startup, so keep it short).`,
    );
  }
  const versionRaw = asString(raw['version'], 'version', filePath);
  if (versionRaw !== undefined && !SKILL_VERSION_RE.test(versionRaw)) {
    fail(`Skill "${name}" has invalid version ${JSON.stringify(versionRaw)}: expected semver like "1.0.0".`);
  }
  const contextRaw = asString(raw['context'], 'context', filePath);
  if (contextRaw !== undefined && contextRaw !== 'fork') {
    fail(`Skill "${name}": unsupported "context" ${JSON.stringify(contextRaw)} — only "fork" is supported.`);
  }
  const allowedTools =
    asStringList(raw['allowed-tools'] ?? raw['allowed_tools'] ?? raw['allowedTools'], 'allowed-tools', filePath) ??
    asStringList(raw['tools'], 'tools', filePath);
  const compatibilityRaw = raw['compatibility'];
  let compatibility: string | string[] | undefined;
  if (compatibilityRaw !== undefined && compatibilityRaw !== null) {
    if (typeof compatibilityRaw === 'string') compatibility = compatibilityRaw;
    else {
      const list = asStringList(compatibilityRaw, 'compatibility', filePath);
      if (list !== undefined) compatibility = list;
    }
  }
  return {
    name,
    description,
    version: versionRaw,
    whenToUse:
      asString(raw['when-to-use'] ?? raw['when_to_use'] ?? raw['whenToUse'], 'when-to-use', filePath) ??
      undefined,
    tools: asStringList(raw['tools'], 'tools', filePath),
    allowedTools,
    license: asString(raw['license'], 'license', filePath),
    compatibility,
    metadata: asRecord(raw['metadata'], 'metadata', filePath),
    context: contextRaw === 'fork' ? 'fork' : undefined,
    disableModelInvocation: asBoolean(
      raw['disable-model-invocation'] ?? raw['disable_model_invocation'] ?? raw['disableModelInvocation'],
      'disable-model-invocation',
      filePath,
    ),
    userInvocable: asBoolean(
      raw['user-invocable'] ?? raw['user_invocable'] ?? raw['userInvocable'],
      'user-invocable',
      filePath,
    ),
  };
}

// ---------------------------------------------------------------------------
// Skill parsing (full body = tier 2; metadata only = tier 1)
// ---------------------------------------------------------------------------

function splitFrontmatter(
  text: string,
  filePath?: string,
): { frontmatter: SkillFrontmatter; body: string } {
  const match = FRONTMATTER_FENCE.exec(text);
  if (!match) {
    throw new SkillLoadError(
      'Skill must start with a YAML frontmatter block delimited by "---" lines.',
      filePath,
    );
  }
  return { frontmatter: parseFrontmatter(match[1]!, filePath), body: text.slice(match[0].length).trim() };
}

/** Extract the body (everything after the frontmatter fence) from full skill text. */
export function extractSkillBody(text: string, filePath?: string): string {
  const match = FRONTMATTER_FENCE.exec(text);
  if (!match) {
    throw new SkillLoadError(
      'Skill must start with a YAML frontmatter block delimited by "---" lines.',
      filePath,
    );
  }
  return text.slice(match[0].length).trim();
}

function buildSkill(
  fm: SkillFrontmatter,
  body: string,
  bodyLoaded: boolean,
  source: SkillSource,
  filePath?: string,
  pluginId?: string,
  skillDir?: string,
  resources?: SkillResources,
): Skill {
  const allowedTools = fm.allowedTools ?? fm.tools ?? [];
  return {
    name: fm.name,
    description: fm.description,
    version: fm.version ?? DEFAULT_SKILL_VERSION,
    whenToUse: fm.whenToUse ?? '',
    tools: allowedTools,
    allowedTools,
    license: fm.license,
    compatibility: fm.compatibility,
    metadata: fm.metadata,
    context: fm.context,
    disableModelInvocation: fm.disableModelInvocation ?? false,
    userInvocable: fm.userInvocable ?? true,
    body,
    bodyLoaded,
    skillDir,
    resources: resources ?? emptySkillResources(),
    source,
    filePath,
    pluginId,
    enabled: true,
  };
}

/**
 * Parse one skill's Markdown text (full body). Throws SkillLoadError on
 * any problem: missing/malformed frontmatter, bad name/version, missing
 * description, empty body, or a secret-looking value.
 */
export function parseSkillMarkdown(
  text: string,
  source: SkillSource,
  filePath?: string,
  pluginId?: string,
  skillDir?: string,
): Skill {
  const fail = (msg: string): never => {
    throw new SkillLoadError(msg, filePath);
  };
  if (looksLikeSecret(text)) {
    fail(
      'Skill contains text that looks like a secret (API key / token / password). ' +
        'Skills must never contain credentials — remove it and try again.',
    );
  }
  const { frontmatter, body } = splitFrontmatter(text, filePath);
  if (body.length === 0) {
    fail(`Skill "${frontmatter.name}" has an empty instruction body.`);
  }
  return buildSkill(
    frontmatter,
    body,
    true,
    source,
    filePath,
    pluginId,
    skillDir,
    skillDir ? listSkillResources(skillDir) : undefined,
  );
}

/**
 * Tier-1 parse: frontmatter only. The body is NOT retained
 * (`body === ''`, `bodyLoaded === false`) — it is loaded later, only
 * for skills that match, via `ensureSkillBody` (registry.ts).
 * Only the frontmatter is secret-scanned here; the body is scanned
 * when it is loaded (tier 2).
 */
export function parseSkillMetadata(
  text: string,
  source: SkillSource,
  filePath?: string,
  pluginId?: string,
  skillDir?: string,
): Skill {
  const match = FRONTMATTER_FENCE.exec(text);
  if (!match) {
    throw new SkillLoadError(
      'Skill must start with a YAML frontmatter block delimited by "---" lines.',
      filePath,
    );
  }
  if (looksLikeSecret(match[1]!)) {
    throw new SkillLoadError(
      'Skill frontmatter contains text that looks like a secret (API key / token / password). ' +
        'Skills must never contain credentials — remove it and try again.',
      filePath,
    );
  }
  const frontmatter = parseFrontmatter(match[1]!, filePath);
  return buildSkill(
    frontmatter,
    '',
    false,
    source,
    filePath,
    pluginId,
    skillDir,
    skillDir ? listSkillResources(skillDir) : undefined,
  );
}

/** Read and parse one skill file (full body). Throws SkillLoadError. */
export function loadSkillFile(
  filePath: string,
  source: SkillSource,
  pluginId?: string,
): Skill {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new SkillLoadError(`Cannot read skill file "${filePath}".`, filePath);
  }
  return parseSkillMarkdown(text, source, filePath, pluginId);
}

/** Read one skill file, frontmatter only (tier 1). Throws SkillLoadError. */
export function loadSkillFileMetadata(
  filePath: string,
  source: SkillSource,
  pluginId?: string,
): Skill {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new SkillLoadError(`Cannot read skill file "${filePath}".`, filePath);
  }
  return parseSkillMetadata(text, source, filePath, pluginId);
}

/**
 * Load a standard skill directory: `<dir>/SKILL.md` + optional
 * `scripts/` / `references/` / `assets/`. Tier 1 (frontmatter only).
 * The skill `name` MUST equal the directory name (agentskills.io).
 * Throws SkillLoadError when SKILL.md is missing/unreadable or the
 * name does not match the directory.
 */
export function loadSkillDir(
  skillDir: string,
  source: SkillSource,
  pluginId?: string,
): Skill {
  const dirName = path.basename(path.resolve(skillDir));
  const skillFile = path.join(skillDir, SKILL_FILE_NAME);
  let text: string;
  try {
    text = fs.readFileSync(skillFile, 'utf8');
  } catch {
    throw new SkillLoadError(
      `Skill directory "${skillDir}" has no readable ${SKILL_FILE_NAME}.`,
      skillFile,
    );
  }
  const skill = parseSkillMetadata(text, source, skillFile, pluginId, skillDir);
  if (skill.name !== dirName) {
    throw new SkillLoadError(
      `Skill name "${skill.name}" does not match its directory name "${dirName}" (agentskills.io: name must equal the skill directory name).`,
      skillFile,
    );
  }
  return skill;
}

/** Result of loading a directory: the skills that parsed + per-file errors. */
export interface LoadSkillsResult {
  skills: Skill[];
  /** One entry per file/directory that failed; loading continues with the rest. */
  errors: Array<{ file: string; error: string }>;
}

export interface LoadSkillsOptions {
  /** Tier-1 only: keep bodies unloaded (`bodyLoaded === false`). Default false (full bodies, legacy behaviour). */
  metadataOnly?: boolean;
}

/**
 * Load every skill in `dir` (sorted by entry name). Each entry may be:
 * - a loose `*.md` file (legacy layout), or
 * - a sub-directory holding `SKILL.md` (standard layout).
 * Sub-directories without `SKILL.md` and non-`.md` files are ignored.
 * A missing directory is not an error — it just yields no skills.
 * A broken entry is reported in `errors` and skipped; it never blocks
 * the other skills in the same directory.
 */
export function loadSkillsFromDir(
  dir: string,
  source: SkillSource,
  pluginId?: string,
  opts: LoadSkillsOptions = {},
): LoadSkillsResult {
  const skills: Skill[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return { skills, errors };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    try {
      if (stat.isDirectory()) {
        // Standard layout — only when the dir actually holds SKILL.md.
        try {
          if (!fs.statSync(path.join(full, SKILL_FILE_NAME)).isFile()) continue;
        } catch {
          continue;
        }
        skills.push(loadSkillDir(full, source, pluginId));
      } else if (stat.isFile() && entry.endsWith('.md')) {
        skills.push(
          opts.metadataOnly
            ? loadSkillFileMetadata(full, source, pluginId)
            : loadSkillFile(full, source, pluginId),
        );
      }
      // Anything else (notes.txt, stray dirs) is ignored.
    } catch (err) {
      errors.push({ file: full, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { skills, errors };
}

/**
 * Skill directories contributed by installed plugins.
 * Convention (see header): `<plugin-dir>/skills/`. `pluginsDir` is the
 * directory that holds one subdirectory per installed plugin (the same
 * layout `PluginManager` scans). Only subdirectories are considered.
 */
export function pluginSkillDirs(pluginsDir: string): Array<{ pluginId: string; dir: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ pluginId: e.name, dir: path.join(pluginsDir, e.name, 'skills') }))
    .filter(({ dir }) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// Tier 3: skill resources (scripts / references / assets)
// ---------------------------------------------------------------------------

/** List a skill directory's resources (relative paths, sorted, recursive). */
export function listSkillResources(skillDir: string): SkillResources {
  const out: SkillResources = emptySkillResources();
  for (const sub of SKILL_RESOURCE_DIRS) {
    const base = path.join(skillDir, sub);
    const found: string[] = [];
    const walk = (dir: string, rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
        else if (e.isFile()) found.push(relPath);
      }
    };
    walk(base, '');
    out[sub] = found.map((relPath) => `${sub}/${relPath}`);
  }
  return out;
}

const RESOURCE_PATH_RE = /^(scripts|references|assets)\/[A-Za-z0-9._\-/]+$/;

/**
 * Resolve a resource path inside a skill directory, guarding against
 * traversal (`..`, absolute paths) and against escaping the skill dir.
 * Returns the absolute path, or undefined when the path is not a
 * `scripts/` / `references/` / `assets/` file inside the skill.
 */
export function resolveSkillResourcePath(
  skill: Skill,
  relPath: string,
): string | undefined {
  if (!skill.skillDir) return undefined;
  const cleaned = relPath.replace(/\\/g, '/');
  if (!RESOURCE_PATH_RE.test(cleaned) || cleaned.includes('..')) return undefined;
  const abs = path.resolve(skill.skillDir, cleaned);
  if (!abs.startsWith(path.resolve(skill.skillDir) + path.sep)) return undefined;
  try {
    if (!fs.statSync(abs).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return abs;
}

/**
 * Tier 3: read a skill resource file (utf-8) — only when needed.
 * Throws SkillLoadError on an invalid path or an unreadable file.
 * Resources are data, never code: this only READS; running a script
 * is the caller's job (use `resolveSkillResourcePath` for the path).
 */
export function readSkillResource(skill: Skill, relPath: string): string {
  const abs = resolveSkillResourcePath(skill, relPath);
  if (!abs) {
    throw new SkillLoadError(
      `Skill "${skill.name}" has no readable resource ${JSON.stringify(relPath)} (expected scripts/… or references/… or assets/… inside the skill directory).`,
      skill.filePath,
    );
  }
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    throw new SkillLoadError(`Cannot read skill resource "${abs}".`, skill.filePath);
  }
}
