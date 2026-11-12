/**
 * Data tools for @open-bot/tools (v0.89, worker F4 — builtin tools giá trị cao).
 *
 *   csv_parse       — parse CSV text (or a workspace .csv file) into rows.
 *   csv_filter      — filter rows by a simple condition (`age > 30`,
 *                     `city == "Hanoi"`, conditions joined by `&&`).
 *   csv_aggregate   — group-by + count / sum / avg / min / max.
 *   json_query      — read JSON by a simple path (`a.b[0].c`) with an
 *                     optional array filter segment (`users[?age>30].name`).
 *   json_to_csv     — array of objects -> CSV text.
 *   csv_to_json     — CSV text -> JSON array of objects.
 *
 * Pure functions (`parseCsv`, `filterRows`, `aggregateRows`,
 * `queryJsonPath`, `jsonToCsv`, `csvToJson`) are exported so tests can
 * exercise them without a tool context; each tool is a thin wrapper
 * that loads its input (inline text or a workspace file), enforces the
 * limits and truncates the result like every other tool.
 *
 * Limits (fail-closed, same spirit as the rest of the package):
 *  - input at most MAX_DATA_INPUT_BYTES (5 MB), at most MAX_DATA_ROWS
 *    (100k) rows — a bigger input is an error, never a silent cut.
 *  - tool results are truncated to MAX_TOOL_RESULT_CHARS (20.000).
 *
 * Factory (same pattern as createAgentDataTools / createCiTools):
 *   createDataTools() -> Tool[]   (no options needed)
 *   DATA_TOOLS
 *
 * Approval: all six tools only read/transform data given by the caller
 * (or a file inside the workspace) and never write, never call the
 * network -> needsApproval false.
 */
import * as fs from 'node:fs';
import type { Tool, ToolContext } from '@open-bot/core';
import { resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

/** Max input size for a CSV/JSON payload: 5 MB. */
export const MAX_DATA_INPUT_BYTES = 5_000_000;
/** Max rows a CSV/JSON input may hold: 100k. */
export const MAX_DATA_ROWS = 100_000;
/** Max rows shown per aggregation group list / result preview. */
export const MAX_DATA_RESULT_ROWS = 1_000;

export type CsvRow = Record<string, string>;
export type CsvTable = CsvRow[];

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

function assertInputSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_DATA_INPUT_BYTES) {
    throw new Error(
      `Input is over the ${MAX_DATA_INPUT_BYTES} byte limit (${Buffer.byteLength(text, 'utf8')} bytes).`,
    );
  }
}

/**
 * Load a text input from either an inline string argument (`inlineArg`,
 * e.g. `csv` / `json`) or a workspace file (`path`). At least one must
 * be given; when both are given the inline value wins.
 */
function loadTextInput(
  args: Record<string, unknown>,
  ctx: ToolContext,
  inlineArg: string,
): string {
  const inline = args[inlineArg];
  if (typeof inline === 'string') {
    assertInputSize(inline);
    return inline;
  }
  if (inline !== undefined && inline !== null) {
    throw new Error(`Argument "${inlineArg}" must be a string, got ${typeof inline}`);
  }
  const relPath = getStringArg(args, 'path');
  const fullPath = resolveWithin(ctx.workspaceDir, relPath);
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) throw new Error(`Not a file: "${relPath}"`);
  if (stat.size > MAX_DATA_INPUT_BYTES) {
    throw new Error(
      `File is ${stat.size} bytes, over the ${MAX_DATA_INPUT_BYTES} byte input limit: "${relPath}"`,
    );
  }
  return fs.readFileSync(fullPath, 'utf8');
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: quoted fields, doubled quotes, embedded
// commas/newlines, CRLF). Hand-written on purpose: no new dependency.
// ---------------------------------------------------------------------------

/** Parse CSV text into raw rows (arrays of cells). Throws on bad input. */
export function parseCsv(text: string): string[][] {
  assertInputSize(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldQuoted = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
    fieldQuoted = false;
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"' && field === '' && !fieldQuoted) {
      inQuotes = true;
      fieldQuoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      // CRLF counts as one line break.
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) throw new Error('CSV has an unterminated quoted field.');
  // Trailing content without a final newline is still a row; a file
  // ending exactly on a newline has no extra empty row.
  if (field !== '' || row.length > 0) pushRow();
  // Drop a single trailing all-empty row (e.g. input ending "\n\n" is
  // one blank line, not data) — but keep genuinely blank rows inside.
  while (
    rows.length > 0 &&
    (rows[rows.length - 1] as string[]).every((cell) => cell === '')
  ) {
    rows.pop();
  }
  if (rows.length > MAX_DATA_ROWS) {
    throw new Error(
      `CSV has ${rows.length} rows, over the ${MAX_DATA_ROWS} row limit.`,
    );
  }
  return rows;
}

/** Escape one cell for CSV output (RFC 4180). */
export function csvEscapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function stringifyCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvEscapeCell).join(',')).join('\n');
}

/**
 * First row is the header. Duplicate/blank header names get a suffix
 * (`name`, `name_2`, `col_3` for a blank third column). Short rows are
 * padded with '', long rows are cut to the header width.
 */
export function rowsToObjects(rows: string[][]): CsvTable {
  if (rows.length === 0) return [];
  const header = rows[0] as string[];
  const seen = new Map<string, number>();
  const names = header.map((raw, idx) => {
    const base = raw.trim() === '' ? `col_${idx + 1}` : raw.trim();
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
  return rows.slice(1).map((cells) => {
    const obj: CsvRow = {};
    names.forEach((name, idx) => {
      obj[name] = cells[idx] ?? '';
    });
    return obj;
  });
}

/** Parse CSV text straight into an array of objects (header = first row). */
export function csvToJson(text: string): CsvTable {
  return rowsToObjects(parseCsv(text));
}

/** Array of objects -> CSV text (header = union of keys, first-seen order). */
export function jsonToCsv(value: unknown): string {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length > MAX_DATA_ROWS) {
    throw new Error(
      `JSON has ${rows.length} rows, over the ${MAX_DATA_ROWS} row limit.`,
    );
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('json_to_csv needs an array of objects (each row must be an object).');
    }
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const out: string[][] = [headers];
  for (const row of rows) {
    const obj = row as Record<string, unknown>;
    out.push(
      headers.map((h) => {
        const v = obj[h];
        if (v === undefined || v === null) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
      }),
    );
  }
  return stringifyCsv(out);
}

// ---------------------------------------------------------------------------
// Filtering: `field op value [&& field op value ...]`
// ops: == != > >= < <= contains
// ---------------------------------------------------------------------------

export interface FilterCondition {
  field: string;
  op: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains';
  value: string;
  numericValue: number | null;
}

const CONDITION_RE =
  /^\s*([A-Za-z0-9_.\- ]+?)\s*(==|!=|>=|<=|>|<|contains)\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/;

/** Parse one `field op value` condition. Throws on bad syntax. */
export function parseCondition(text: string): FilterCondition {
  const m = CONDITION_RE.exec(text);
  if (!m) {
    throw new Error(
      `Bad condition: "${text}". Expected "field == value", "field > 10", "field contains text", ...`,
    );
  }
  const field = (m[1] as string).trim();
  const op = m[2] as FilterCondition['op'];
  const raw = m[3] ?? m[4] ?? (m[5] as string);
  const value = raw.trim();
  if (value === '' || /^[=!<>]/.test(value)) {
    // A value starting with an operator char means the input had a
    // doubled operator (`age >> 3`, `x === 1`) — reject instead of
    // silently treating `> 3` as the comparison value.
    throw new Error(
      `Bad condition: "${text}". Expected "field == value", "field > 10", "field contains text", ...`,
    );
  }
  const numeric = value === '' ? null : Number(value);
  return { field, op, value, numericValue: Number.isFinite(numeric) ? numeric : null };
}

/** Parse a `&&`-joined condition list. */
export function parseConditions(text: string): FilterCondition[] {
  const parts = text.split('&&').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) throw new Error('Condition must not be empty.');
  return parts.map(parseCondition);
}

function valueOf(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function matchesCondition(row: Record<string, unknown>, cond: FilterCondition): boolean {
  const actual = valueOf(row, cond.field);
  if (cond.op === 'contains') return actual.includes(cond.value);
  const actualNum = actual === '' ? null : Number(actual);
  const bothNumeric = cond.numericValue !== null && actualNum !== null && Number.isFinite(actualNum);
  if (bothNumeric) {
    const a = actualNum as number;
    const b = cond.numericValue as number;
    switch (cond.op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>': return a > b;
      case '>=': return a >= b;
      case '<': return a < b;
      case '<=': return a <= b;
    }
  }
  switch (cond.op) {
    case '==': return actual === cond.value;
    case '!=': return actual !== cond.value;
    case '>': return actual > cond.value;
    case '>=': return actual >= cond.value;
    case '<': return actual < cond.value;
    case '<=': return actual <= cond.value;
  }
}

/** Keep the rows matching ALL conditions. */
export function filterRows(
  rows: Array<Record<string, unknown>>,
  conditions: FilterCondition[],
): Array<Record<string, unknown>> {
  return rows.filter((row) => conditions.every((c) => matchesCondition(row, c)));
}

// ---------------------------------------------------------------------------
// Aggregation: group-by + count / sum:field / avg:field / min:field / max:field
// ---------------------------------------------------------------------------

export interface AggregateSpec {
  kind: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field: string | null;
}

/** Parse `count, sum:amount, avg:price` into specs. Throws on bad syntax. */
export function parseAggregates(text: string): AggregateSpec[] {
  const parts = text.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) throw new Error('Aggregate spec must not be empty.');
  return parts.map((part) => {
    if (part === 'count') return { kind: 'count', field: null };
    const m = /^(sum|avg|min|max):([A-Za-z0-9_.\- ]+)$/.exec(part);
    if (!m) {
      throw new Error(
        `Bad aggregate: "${part}". Expected "count" or "sum:field" / "avg:field" / "min:field" / "max:field".`,
      );
    }
    return { kind: m[1] as AggregateSpec['kind'], field: (m[2] as string).trim() };
  });
}

export interface AggregateResult {
  group: string;
  count: number;
  [key: string]: string | number;
}

/** Group rows by `groupBy` and compute each aggregate per group. */
export function aggregateRows(
  rows: Array<Record<string, unknown>>,
  groupBy: string,
  specs: AggregateSpec[],
): AggregateResult[] {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = valueOf(row, groupBy);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: AggregateResult[] = [];
  for (const [group, members] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const result: AggregateResult = { group, count: members.length };
    for (const spec of specs) {
      if (spec.kind === 'count') {
        result['count'] = members.length;
        continue;
      }
      const field = spec.field as string;
      const nums = members
        .map((row) => Number(valueOf(row, field)))
        .filter((n) => Number.isFinite(n));
      const label = `${spec.kind}_${field}`;
      if (nums.length === 0) {
        result[label] = 0;
        continue;
      }
      if (spec.kind === 'sum') result[label] = nums.reduce((a, b) => a + b, 0);
      else if (spec.kind === 'avg') result[label] = nums.reduce((a, b) => a + b, 0) / nums.length;
      else if (spec.kind === 'min') result[label] = Math.min(...nums);
      else result[label] = Math.max(...nums);
    }
    out.push(result);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON path: `a.b[0].c`, `users[?age>30].name`
// A segment is `key`, `key[0]` or `key[?field op value]`; when the current
// value is an array and the segment is a plain key, the key is mapped
// over every element (so `users.name` works on an array of users).
// ---------------------------------------------------------------------------

export interface PathSegment {
  key: string | null;
  index: number | null;
  filter: FilterCondition | null;
}

const SEGMENT_RE = /^([A-Za-z0-9_$]*)(?:\[(\d+)\]|\[\?([^\]]+)\])?$/;

/** Parse a dotted JSON path into segments. Throws on bad syntax. */
export function parseJsonPath(pathText: string): PathSegment[] {
  const trimmed = pathText.trim();
  if (trimmed === '') throw new Error('JSON path must not be empty.');
  return trimmed.split('.').map((raw) => {
    const m = SEGMENT_RE.exec(raw.trim());
    if (!m) throw new Error(`Bad JSON path segment: "${raw}" (expected key, key[0] or key[?field op value]).`);
    const key = m[1] === '' ? null : (m[1] as string);
    const index = m[2] !== undefined ? Number(m[2]) : null;
    const filter = m[3] !== undefined ? parseCondition(m[3] as string) : null;
    if (key === null && index === null && filter === null) {
      throw new Error(`Bad JSON path segment: "${raw}".`);
    }
    return { key, index, filter };
  });
}

/** Walk `value` along a parsed path. Returns undefined when it misses. */
export function queryJsonPath(value: unknown, pathText: string): unknown {
  const segments = parseJsonPath(pathText);
  let current: unknown = value;
  for (const seg of segments) {
    if (seg.key !== null) {
      if (Array.isArray(current)) {
        current = current.map((el) =>
          el !== null && typeof el === 'object'
            ? (el as Record<string, unknown>)[seg.key as string]
            : undefined,
        );
      } else if (current !== null && typeof current === 'object') {
        current = (current as Record<string, unknown>)[seg.key];
      } else {
        return undefined;
      }
    }
    if (seg.index !== null) {
      if (!Array.isArray(current)) return undefined;
      current = current[seg.index as number];
    }
    if (seg.filter !== null) {
      if (!Array.isArray(current)) return undefined;
      current = current.filter(
        (el) =>
          el !== null &&
          typeof el === 'object' &&
          matchesCondition(el as Record<string, unknown>, seg.filter as FilterCondition),
      );
    }
    if (current === undefined) return undefined;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function formatRows(rows: CsvTable, total: number): string {
  const shown = rows.slice(0, MAX_DATA_RESULT_ROWS);
  const body = JSON.stringify(shown, null, 2);
  const note =
    rows.length > MAX_DATA_RESULT_ROWS
      ? `\n[... showing ${MAX_DATA_RESULT_ROWS} of ${rows.length} rows ...]`
      : '';
  return `${total} row(s)${note}\n${body}`;
}

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

const csvParseTool: Tool = {
  definition: toolDef(
    'csv_parse',
    'Parse CSV text (or a workspace .csv file) into rows of objects. Handles quoted fields, doubled quotes, embedded commas/newlines and CRLF. Input max 5 MB / 100k rows.',
    {
      csv: { type: 'string', description: 'CSV text to parse (either this or "path").' },
      path: { type: 'string', description: 'Workspace file to read as CSV (either this or "csv").' },
    },
    [],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const text = loadTextInput(args, ctx, 'csv');
      const rows = csvToJson(text);
      return truncate(formatRows(rows, rows.length), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const csvFilterTool: Tool = {
  definition: toolDef(
    'csv_filter',
    'Filter CSV rows by a simple condition, e.g. "age > 30", "city == \\"Hanoi\\"", "name contains An". Join conditions with && (all must match). Numbers compare numerically, other values as text.',
    {
      csv: { type: 'string', description: 'CSV text (either this or "path").' },
      path: { type: 'string', description: 'Workspace CSV file (either this or "csv").' },
      where: { type: 'string', description: 'Condition, e.g. "age > 30 && city == Hanoi".' },
    },
    ['where'],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const where = getStringArg(args, 'where');
      const conditions = parseConditions(where);
      const rows = csvToJson(loadTextInput(args, ctx, 'csv'));
      const kept = filterRows(rows, conditions);
      return truncate(
        formatRows(kept as CsvTable, rows.length).replace(/^\d+ row\(s\)/, `${kept.length} of ${rows.length} row(s) kept`),
        MAX_TOOL_RESULT_CHARS,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const csvAggregateTool: Tool = {
  definition: toolDef(
    'csv_aggregate',
    'Group CSV rows by a column and aggregate: "count", "sum:amount", "avg:price", "min:x", "max:x" (comma-separated, e.g. "count, sum:amount"). Non-numeric values are skipped for sum/avg/min/max.',
    {
      csv: { type: 'string', description: 'CSV text (either this or "path").' },
      path: { type: 'string', description: 'Workspace CSV file (either this or "csv").' },
      group_by: { type: 'string', description: 'Column to group by.' },
      agg: { type: 'string', description: 'Aggregates, e.g. "count, sum:amount".' },
    },
    ['group_by', 'agg'],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const groupBy = getStringArg(args, 'group_by');
      const specs = parseAggregates(getStringArg(args, 'agg'));
      const rows = csvToJson(loadTextInput(args, ctx, 'csv'));
      const result = aggregateRows(rows, groupBy, specs);
      return truncate(
        `${result.length} group(s) from ${rows.length} row(s):\n${JSON.stringify(result, null, 2)}`,
        MAX_TOOL_RESULT_CHARS,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const jsonQueryTool: Tool = {
  definition: toolDef(
    'json_query',
    'Read JSON by a simple path, e.g. "a.b[0].c" or "users[?age>30].name" (filter ops: == != > >= < <= contains). A plain key over an array maps over every element. Input max 5 MB.',
    {
      json: { type: 'string', description: 'JSON text (either this or "path").' },
      path: { type: 'string', description: 'Workspace JSON file (either this or "json").' },
      query: { type: 'string', description: 'Path, e.g. "users[0].name".' },
    },
    ['query'],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const query = getStringArg(args, 'query');
      const text = loadTextInput(args, ctx, 'json');
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error('Input is not valid JSON.');
      }
      const found = queryJsonPath(value, query);
      if (found === undefined) return `No value at path "${query}".`;
      return truncate(
        typeof found === 'string' ? found : JSON.stringify(found, null, 2),
        MAX_TOOL_RESULT_CHARS,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const jsonToCsvTool: Tool = {
  definition: toolDef(
    'json_to_csv',
    'Convert a JSON array of objects (or a single object) to CSV text. Header is the union of keys in first-seen order; nested values become JSON strings.',
    {
      json: { type: 'string', description: 'JSON text (either this or "path").' },
      path: { type: 'string', description: 'Workspace JSON file (either this or "json").' },
    },
    [],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const text = loadTextInput(args, ctx, 'json');
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error('Input is not valid JSON.');
      }
      return truncate(jsonToCsv(value), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const csvToJsonTool: Tool = {
  definition: toolDef(
    'csv_to_json',
    'Convert CSV text (or a workspace .csv file) to a JSON array of objects. Same parser as csv_parse (quotes, CRLF, 5 MB / 100k row limits).',
    {
      csv: { type: 'string', description: 'CSV text (either this or "path").' },
      path: { type: 'string', description: 'Workspace CSV file (either this or "csv").' },
    },
    [],
  ),
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const rows = csvToJson(loadTextInput(args, ctx, 'csv'));
      return truncate(
        JSON.stringify(rows, null, 2),
        MAX_TOOL_RESULT_CHARS,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

export function createDataTools(): Tool[] {
  return [
    csvParseTool,
    csvFilterTool,
    csvAggregateTool,
    jsonQueryTool,
    jsonToCsvTool,
    csvToJsonTool,
  ];
}

export const DATA_TOOLS: Tool[] = createDataTools();
