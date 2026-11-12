/**
 * Office WRITE tools for @open-bot/tools (v0.89, worker F4 — builtin tools giá trị cao).
 *
 *   docx_write       — write a .docx from plain text / light Markdown.
 *   markdown_to_docx — write a .docx from Markdown (headings, bullets,
 *                       **bold**, *italic*).
 *   xlsx_write       — write a .xlsx from headers + rows.
 *
 * Why this file exists: `officeDocs.ts` only READS office files
 * (mammoth / SheetJS / pdf.js) — there is no write path anywhere in
 * the repo. These tools add the minimal write path WITHOUT a new
 * dependency: the OOXML containers are plain ZIPs built with Node's
 * built-in `zlib` (deflate) plus a small hand-written ZIP writer
 * (local headers + central directory + CRC-32, ~60 lines) and the
 * document XML is generated from templates below.
 *
 * What "minimal" means, honestly:
 *  - DOCX: one section, Normal / Heading 1-3 / List Bullet styles,
 *    paragraphs, bullet lists, **bold** / *italic* runs. No tables,
 *    images, footnotes, headers/footers, or tracked changes.
 *  - XLSX: one sheet, shared strings, numbers / booleans / strings,
 *    bold header row. No formulas, formatting beyond the header,
 *    multiple sheets, or charts.
 * Both files are verified in tests by unzipping them and by reading
 * them back with the repo's own readers (`extractOfficeText` in
 * officeDocs.ts: mammoth for DOCX, SheetJS for XLSX), so they are
 * real documents, not just well-formed ZIPs.
 *
 * Safety: output paths are confined to the workspace via
 * `resolveWithin` (same rule as `write_file`); only `.docx` /
 * `.xlsx` extensions are accepted; input caps (markdown 1 MB,
 * 100k rows, 200 cells per row) fail closed.
 *
 * Factory (same pattern as the other tool groups):
 *   createOfficeWriteTools() -> Tool[]   (no options needed)
 *   OFFICE_WRITE_TOOLS
 *
 * Approval: all three tools write files -> needsApproval true.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { Tool, ToolContext } from '@open-bot/core';
import { resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

/** Max Markdown/text input for a .docx: 1 MB. */
export const MAX_OFFICE_WRITE_INPUT_BYTES = 1_000_000;
/** Max rows for an .xlsx: 100k (same as the data tools). */
export const MAX_XLSX_ROWS = 100_000;
/** Max cells per spreadsheet row. */
export const MAX_XLSX_CELLS_PER_ROW = 200;

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

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (STORE/DEFLATE, CRC-32). Node has no built-in ZIP
// writer; `archiver`/`jszip` would be new dependencies, so this is
// written out (~70 lines, standard ZIP format).
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (buf[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Build a ZIP archive (deflate, DOS date = now). Deterministic layout, no extras. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((Math.floor(now.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed (2.0 — deflate)
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 filenames
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8
    central.writeUInt16LE(8, 10); // method: deflate
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // central dir disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, centralDir, end]);
}

// ---------------------------------------------------------------------------
// DOCX (WordprocessingML, minimal)
// ---------------------------------------------------------------------------

interface MdRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** Split one line into runs on **bold** and *italic* markers. */
export function parseInlineRuns(line: string): MdRun[] {
  const runs: MdRun[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) runs.push({ text: line.slice(last, m.index), bold: false, italic: false });
    if (m[2] !== undefined) runs.push({ text: m[2], bold: true, italic: false });
    else if (m[4] !== undefined) runs.push({ text: m[4], bold: false, italic: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), bold: false, italic: false });
  if (runs.length === 0) runs.push({ text: '', bold: false, italic: false });
  return runs;
}

function runsToXml(runs: MdRun[]): string {
  return runs
    .map((run) => {
      const props =
        run.bold || run.italic
          ? `<w:rPr>${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}</w:rPr>`
          : '';
      return `<w:r>${props}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
    })
    .join('');
}

function markdownToDocxBody(markdown: string): string {
  const paragraphs: string[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      paragraphs.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${runsToXml(parseInlineRuns(heading[2] as string))}</w:p>`,
      );
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      paragraphs.push(
        `<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>${runsToXml(parseInlineRuns(bullet[1] as string))}</w:p>`,
      );
      continue;
    }
    paragraphs.push(`<w:p>${runsToXml(parseInlineRuns(line))}</w:p>`);
  }
  if (paragraphs.length === 0) paragraphs.push('<w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p>');
  return paragraphs.join('');
}

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
const DOCX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720"/></w:pPr></w:style></w:styles>`;

/** Build a minimal .docx Buffer from Markdown text. `title` is unused in the body (kept for API symmetry). */
export function buildDocx(markdown: string, _title?: string): Buffer {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_OFFICE_WRITE_INPUT_BYTES) {
    throw new Error(
      `Markdown is over the ${MAX_OFFICE_WRITE_INPUT_BYTES} byte limit for .docx output.`,
    );
  }
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    markdownToDocxBody(markdown) +
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(DOCX_CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(DOCX_ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(DOCX_STYLES, 'utf8') },
  ]);
}

// ---------------------------------------------------------------------------
// XLSX (SpreadsheetML, minimal: one sheet, shared strings)
// ---------------------------------------------------------------------------

function columnLetter(colIndex: number): string {
  let letters = '';
  let n = colIndex;
  while (n >= 0) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  }
  return letters;
}

const XLSX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
const XLSX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const XLSX_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/**
 * Build a minimal .xlsx Buffer: one sheet, first row bold when
 * `headers` is given (headers become row 1). Cell values: numbers
 * stay numeric, booleans stay boolean, everything else is a shared
 * string (null/undefined -> empty).
 */
export function buildXlsx(
  headers: string[] | null,
  rows: unknown[][],
  sheetName = 'Sheet1',
): Buffer {
  if (rows.length > MAX_XLSX_ROWS) {
    throw new Error(`Too many rows: ${rows.length} (max ${MAX_XLSX_ROWS}).`);
  }
  const cleanName = sheetName.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet1';
  const shared = new Map<string, number>();
  const sharedList: string[] = [];
  const sharedIndex = (text: string): number => {
    const existing = shared.get(text);
    if (existing !== undefined) return existing;
    const idx = sharedList.length;
    shared.set(text, idx);
    sharedList.push(text);
    return idx;
  };
  const allRows: unknown[][] = headers ? [headers, ...rows] : rows;
  const cellXml = (value: unknown, ref: string, isHeader: boolean): string => {
    const style = isHeader ? ' s="1"' : '';
    if (value === null || value === undefined) return `<c r="${ref}"${style}/>`;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `<c r="${ref}"${style} t="n"><v>${value}</v></c>`;
    }
    if (typeof value === 'boolean') {
      return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
    }
    const idx = sharedIndex(String(value));
    return `<c r="${ref}"${style} t="s"><v>${idx}</v></c>`;
  };
  const sheetRows = allRows
    .map((row, rowIdx) => {
      if (row.length > MAX_XLSX_CELLS_PER_ROW) {
        throw new Error(`Row ${rowIdx + 1} has ${row.length} cells, over the ${MAX_XLSX_CELLS_PER_ROW} limit.`);
      }
      const cells = row
        .map((value, colIdx) =>
          cellXml(value, `${columnLetter(colIdx)}${rowIdx + 1}`, headers !== null && rowIdx === 0),
        )
        .join('');
      return `<row r="${rowIdx + 1}">${cells}</row>`;
    })
    .join('');
  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const sharedXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedList.length}" uniqueCount="${sharedList.length}">` +
    sharedList.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
    `</sst>`;
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(cleanName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(XLSX_CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(XLSX_ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(XLSX_WORKBOOK_RELS, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedXml, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(XLSX_STYLES, 'utf8') },
  ]);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function writeWorkspaceFile(
  ctx: ToolContext,
  relPath: string,
  data: Buffer,
  expectedExt: string,
): string {
  const ext = path.extname(relPath).toLowerCase();
  if (ext !== expectedExt) {
    throw new Error(`Output path must end in "${expectedExt}", got "${relPath}".`);
  }
  const fullPath = resolveWithin(ctx.workspaceDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, data);
  return `Wrote ${data.length} bytes to "${relPath}".`;
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

const docxWriteTool: Tool = {
  definition: toolDef(
    'docx_write',
    'Write a minimal .docx file from plain text / light Markdown (# headings, - bullets, **bold**, *italic*). Real Word document (OOXML, no extra dependency) — readable by Word and by open-bot read_file. No tables, images or headers/footers.',
    {
      path: { type: 'string', description: 'Output path inside the workspace, ending in .docx.' },
      content: { type: 'string', description: 'Text / light Markdown content (max 1 MB).' },
      title: { type: 'string', description: 'Optional title (kept for API symmetry; not written into the body).' },
    },
    ['path', 'content'],
  ),
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const content = getStringArg(args, 'content');
      if (args['title'] !== undefined && typeof args['title'] !== 'string') {
        throw new Error('Argument "title" must be a string.');
      }
      const buf = buildDocx(content, args['title'] as string | undefined);
      return truncate(writeWorkspaceFile(ctx, relPath, buf, '.docx'), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const markdownToDocxTool: Tool = {
  definition: toolDef(
    'markdown_to_docx',
    'Convert Markdown to a minimal .docx file (# / ## / ### headings, - bullet lists, **bold**, *italic*). Same writer as docx_write; tables, code blocks and images are rendered as plain paragraphs.',
    {
      path: { type: 'string', description: 'Output path inside the workspace, ending in .docx.' },
      markdown: { type: 'string', description: 'Markdown source (max 1 MB).' },
      title: { type: 'string', description: 'Optional title (kept for API symmetry; not written into the body).' },
    },
    ['path', 'markdown'],
  ),
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const markdown = getStringArg(args, 'markdown');
      if (args['title'] !== undefined && typeof args['title'] !== 'string') {
        throw new Error('Argument "title" must be a string.');
      }
      const buf = buildDocx(markdown, args['title'] as string | undefined);
      return truncate(writeWorkspaceFile(ctx, relPath, buf, '.docx'), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const xlsxWriteTool: Tool = {
  definition: toolDef(
    'xlsx_write',
    'Write a minimal .xlsx file (one sheet) from headers + rows. Numbers stay numeric, booleans stay boolean, everything else is text. First row is bold when headers are given. No formulas, formatting or extra sheets.',
    {
      path: { type: 'string', description: 'Output path inside the workspace, ending in .xlsx.' },
      headers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional header row (becomes row 1, bold).',
      },
      rows: {
        type: 'array',
        items: { type: 'array', items: {} },
        description: 'Rows of values (string/number/boolean/null). Max 100k rows, 200 cells per row.',
      },
      sheet_name: { type: 'string', description: 'Sheet name (default "Sheet1", max 31 chars).' },
    },
    ['path', 'rows'],
  ),
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const rowsRaw = args['rows'];
      if (!Array.isArray(rowsRaw)) {
        throw new Error(`Argument "rows" must be an array of arrays, got ${typeof rowsRaw}`);
      }
      for (const row of rowsRaw) {
        if (!Array.isArray(row)) throw new Error('Each row in "rows" must be an array.');
      }
      let headers: string[] | null = null;
      if (args['headers'] !== undefined && args['headers'] !== null) {
        if (!Array.isArray(args['headers']) || args['headers'].some((h) => typeof h !== 'string')) {
          throw new Error('Argument "headers" must be an array of strings.');
        }
        headers = args['headers'] as string[];
      }
      const sheetName =
        args['sheet_name'] === undefined ? 'Sheet1' : getStringArg(args, 'sheet_name', false);
      const buf = buildXlsx(headers, rowsRaw as unknown[][], sheetName);
      return truncate(writeWorkspaceFile(ctx, relPath, buf, '.xlsx'), MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

export function createOfficeWriteTools(): Tool[] {
  return [docxWriteTool, markdownToDocxTool, xlsxWriteTool];
}

export const OFFICE_WRITE_TOOLS: Tool[] = createOfficeWriteTools();
