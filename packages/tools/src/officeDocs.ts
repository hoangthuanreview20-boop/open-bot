/**
 * Office document text extraction for `read_file` (v0.87b).
 *
 * Plain text files stay on the old path (UTF-8 read, 100 KB cap — see
 * tools.ts `MAX_READ_BYTES`). PDF / DOCX / XLSX go through here instead:
 * they are binary containers, so reading them as UTF-8 would return
 * garbage. Each format is extracted with a small, well-known,
 * permissively licensed library — no hand-written PDF/OOXML parser:
 *
 *   PDF  — `pdfjs-dist` 3.11.174 (Apache-2.0), legacy CJS build, text
 *          layer only, one worker-less `getDocument` per file.
 *   DOCX — `mammoth` 1.13.0 (BSD-2-Clause): `convertToHtml` + a small
 *          HTML-to-plain-text formatter below (headings, paragraphs,
 *          tables as `cell | cell` rows, lists). The formatter only
 *          reshapes mammoth's HTML output; it does not parse DOCX.
 *   XLSX — `xlsx` 0.18.5 / SheetJS Community Edition (Apache-2.0):
 *          one section per sheet (`--- Sheet: <name> (N row(s)) ---`),
 *          rows as tab-separated values.
 *
 * Byte cap: office files get their own, larger cap
 * (`MAX_OFFICE_READ_BYTES` = 5 MB) instead of the 100 KB text cap,
 * because the formats are compressed — a 100 KB cap would reject most
 * real-world office documents, while a 5 MB .xlsx can still hold far
 * more text than fits in a tool result. The extracted text is still
 * truncated to `MAX_TOOL_RESULT_CHARS` (20.000 chars, blob-backed)
 * by the caller, exactly like plain text, so the larger input cap
 * cannot blow up a tool result.
 *
 * Fail-closed by design — nothing is ever returned half-parsed:
 *  - password-protected / encrypted files: a clear error naming the
 *    format and the fix (remove the password). Encrypted OOXML is an
 *    OLE compound file, not a ZIP, so it is caught by the container
 *    check before any library sees it; encrypted PDFs raise
 *    pdf.js `PasswordException`, mapped to the same clear message.
 *  - corrupted / wrong-format files: magic-byte check first
 *    (`%PDF`, ZIP `PK..`, OLE `D0CF11E0`), then the library error
 *    mapped to a short message. No stack traces, no partial garbage.
 *  - a PDF with no text layer (scanned image PDF): the extractor
 *    returns an explicit "no extractable text — OCR is not supported"
 *    error instead of an empty result pretending the PDF is blank.
 *    OCR is out of scope for this milestone (it needs an OCR engine
 *    and a rendered page image; see the v0.87b BEYOND-ROADMAP entry).
 *  - legacy binary Office formats (.doc/.xls, OLE compound files):
 *    rejected with a clear error — only modern OOXML is supported.
 *
 * pdf.js note: the legacy build tries to `require('canvas')` at load
 * time and prints a "Cannot polyfill DOMMatrix/Path2D" warning when
 * the optional package is absent. `canvas` is only needed to render
 * pages to images; text extraction never uses it, so it is NOT a
 * dependency here. The module is therefore lazy-loaded inside
 * `extractPdf` with `console.log`/`console.warn` muted for the single
 * `require` call (pdf.js `warn()` writes via `console.log`), so the
 * host log stays clean.
 */
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';

/** File extensions handled here (lowercase, with leading dot). */
export const OFFICE_EXTENSIONS = ['.pdf', '.docx', '.xlsx'] as const;
export type OfficeExtension = (typeof OFFICE_EXTENSIONS)[number];

/**
 * Byte cap for office documents (5 MB). See the header comment for why
 * it is larger than the 100 KB plain-text cap in tools.ts.
 */
export const MAX_OFFICE_READ_BYTES = 5_000_000;

const ZIP_MAGIC = [0x50, 0x4b]; // 'PK' — ZIP-based OOXML container.
const EOCD_MAGIC = [0x50, 0x4b, 0x05, 0x06]; // 'PK\x05\x06' — ZIP end of central directory.
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // OLE compound file.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // '%PDF'.

export function isOfficeExtension(ext: string): ext is OfficeExtension {
  return (OFFICE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

function startsWith(buffer: Buffer, magic: number[]): boolean {
  if (buffer.length < magic.length) return false;
  return magic.every((byte, i) => buffer[i] === byte);
}

/**
 * A valid ZIP always ends with an end-of-central-directory (EOCD)
 * record: 22 bytes, preceded by an optional comment of at most 64 KB.
 * A truncated ZIP has no EOCD — check for it before handing the buffer
 * to a library, because SheetJS's ZIP reader hangs (never returns)
 * on a truncated archive instead of throwing. Found by the v0.87b
 * corrupt-XLSX test: `XLSX.read` on the first 100 bytes of a real
 * .xlsx never resolved.
 */
function hasZipEndOfCentralDirectory(buffer: Buffer): boolean {
  const earliest = Math.max(0, buffer.length - (65_535 + 22));
  for (let i = buffer.length - 22; i >= earliest; i -= 1) {
    if (EOCD_MAGIC.every((byte, j) => buffer[i + j] === byte)) return true;
  }
  return false;
}

/**
 * Guard shared by the ZIP-based formats (DOCX/XLSX): an encrypted
 * OOXML file is an OLE compound document, not a ZIP — report it as
 * password-protected instead of letting the unzipper fail with an
 * opaque "end of central directory" error. Anything that is neither
 * OLE nor ZIP is not a valid modern Office file at all.
 */
function assertZipContainer(buffer: Buffer, kind: string): void {
  if (startsWith(buffer, OLE_MAGIC)) {
    throw new Error(
      `${kind} file is password-protected (encrypted) or in the legacy binary Office format; ` +
        `open-bot can only read modern unencrypted ${kind} files. ` +
        `Remove the password or re-save it as a modern ${kind} file and try again.`,
    );
  }
  if (!startsWith(buffer, ZIP_MAGIC)) {
    throw new Error(
      `Not a valid ${kind} file (not a ZIP-based Office document; the file may be corrupted).`,
    );
  }
  if (!hasZipEndOfCentralDirectory(buffer)) {
    throw new Error(
      `Not a valid ${kind} file (ZIP container is truncated or corrupted — no end-of-central-directory record).`,
    );
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
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    );
}

function stripInlineTags(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r]+/g, ' ')
    .trim();
}

/**
 * Reshape mammoth's HTML into plain text, keeping the structure that
 * is useful to an agent: headings as `#`/`##` lines, tables as
 * `cell | cell` rows, list items as `- ` lines. Everything else is
 * paragraphs. This is formatting of mammoth output, not DOCX parsing.
 */
function htmlToPlainText(html: string): string {
  let out = html;
  // Tables first: each row becomes one `cell | cell` line (cells may
  // contain <p> wrappers from mammoth — strip them per cell).
  out = out.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((row) => {
      const cells = [...row[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((cell) =>
        stripInlineTags(cell[0]),
      );
      return cells.join(' | ');
    });
    return `\n${rows.join('\n')}\n`;
  });
  out = out.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, level: string, inner: string) => `\n${'#'.repeat(Number(level))} ${stripInlineTags(inner)}\n`,
  );
  out = out.replace(/<li[\s\S]*?<\/li>/gi, (item) => `\n- ${stripInlineTags(item)}\n`);
  out = out.replace(/<p[\s\S]*?<\/p>/gi, (para) => `\n${stripInlineTags(para)}\n`);
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  out = decodeHtmlEntities(out)
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return out;
}

// ---------------------------------------------------------------------------
// PDF (pdfjs-dist, text layer only — no OCR)
// ---------------------------------------------------------------------------

// pdfjs-dist ships no typed subpath for the legacy CJS build that this
// package (CommonJS) can require, so the module is loaded lazily via
// require and typed loosely. Only the small surface used here is typed.
interface PdfjsTextItem {
  str?: string;
}
interface PdfjsTextContent {
  items: PdfjsTextItem[];
}
interface PdfjsPage {
  getTextContent(): Promise<PdfjsTextContent>;
}
interface PdfjsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
  destroy(): Promise<void>;
}
interface PdfjsModule {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfjsDocument> };
  VerbosityLevel: { ERRORS: number; WARNINGS: number; INFOS: number };
}

let pdfjsModule: PdfjsModule | null = null;

function loadPdfjs(): PdfjsModule {
  if (pdfjsModule) return pdfjsModule;
  // Mute console output for this one require: pdf.js warns about the
  // missing optional `canvas` package (rendering only — see the header
  // comment). Without muting, every process that loads this module
  // prints two "Cannot polyfill" warnings into the host log.
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pdfjsModule = require('pdfjs-dist/legacy/build/pdf') as PdfjsModule;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return pdfjsModule;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  if (!startsWith(buffer, PDF_MAGIC)) {
    throw new Error('Not a valid PDF file (missing the %PDF header; the file may be corrupted).');
  }
  const pdfjs = loadPdfjs();
  let doc: PdfjsDocument;
  try {
    doc = await pdfjs
      .getDocument({
        data: new Uint8Array(buffer),
        disableWorker: true,
        verbosity: pdfjs.VerbosityLevel.ERRORS,
      })
      .promise;
  } catch (err) {
    const error = err as Error;
    if (error.name === 'PasswordException') {
      throw new Error(
        'PDF is password-protected (encrypted); open-bot cannot read encrypted PDFs. ' +
          'Remove the password and try again.',
      );
    }
    if (error.name === 'InvalidPDFException') {
      throw new Error('Not a valid PDF file (corrupted or not a PDF).');
    }
    throw new Error(`Could not read PDF: ${error.message}`);
  }
  const pages: string[] = [];
  let allText = '';
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => item.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      allText += text;
      pages.push(
        `--- Page ${pageNumber} of ${doc.numPages} ---\n${text || '(no extractable text on this page)'}`,
      );
    }
  } finally {
    // Release the document's worker/port: without destroy() the
    // process (and `node --test`) never exits after a PDF read.
    await doc.destroy();
  }
  if (!allText.trim()) {
    throw new Error(
      'PDF has no extractable text — it may be a scanned image PDF. ' +
        'OCR is not supported, so open-bot cannot read image-only PDFs; ' +
        'use a PDF with a text layer instead.',
    );
  }
  return [`Format: PDF, ${doc.numPages} page(s)`, ...pages].join('\n');
}

// ---------------------------------------------------------------------------
// DOCX (mammoth)
// ---------------------------------------------------------------------------

async function extractDocx(buffer: Buffer): Promise<string> {
  assertZipContainer(buffer, 'DOCX');
  let html: string;
  try {
    const result = await mammoth.convertToHtml({ buffer });
    html = result.value;
  } catch (err) {
    throw new Error(`Could not read DOCX: ${(err as Error).message}`);
  }
  const text = htmlToPlainText(html);
  if (!text.trim()) {
    throw new Error('DOCX has no extractable text (the document may be empty).');
  }
  return `Format: DOCX\n${text}`;
}

// ---------------------------------------------------------------------------
// XLSX (SheetJS)
// ---------------------------------------------------------------------------

function extractXlsx(buffer: Buffer): string {
  assertZipContainer(buffer, 'XLSX');
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    const message = (err as Error).message;
    if (/password/i.test(message)) {
      throw new Error(
        'XLSX is password-protected (encrypted); open-bot cannot read encrypted spreadsheets. ' +
          'Remove the password and try again.',
      );
    }
    throw new Error(`Could not read XLSX: ${message}`);
  }
  const parts: string[] = [];
  let allText = '';
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
    });
    const lines = rows.map((row) =>
      row.map((cell) => String(cell ?? '').replace(/\t/g, ' ')).join('\t'),
    );
    const text = lines.join('\n').trim();
    allText += text;
    parts.push(`--- Sheet: ${name} (${rows.length} row(s)) ---\n${text || '(empty sheet)'}`);
  }
  if (workbook.SheetNames.length === 0 || !allText.trim()) {
    throw new Error('XLSX has no extractable text (no sheets, or all sheets are empty).');
  }
  return [
    `Format: XLSX, ${workbook.SheetNames.length} sheet(s): ${workbook.SheetNames.join(', ')}`,
    ...parts,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entry point (called by read_file in tools.ts)
// ---------------------------------------------------------------------------

/**
 * Extract readable text from an office document. `ext` must be one of
 * `.pdf` / `.docx` / `.xlsx` (checked by the caller via
 * `isOfficeExtension`). Throws an `Error` with a clear, user-facing
 * message for encrypted, corrupted or text-less files — never returns
 * partial garbage and never crashes the host.
 */
export async function extractOfficeText(
  ext: OfficeExtension,
  buffer: Buffer,
): Promise<string> {
  switch (ext) {
    case '.pdf':
      return extractPdf(buffer);
    case '.docx':
      return extractDocx(buffer);
    case '.xlsx':
      return extractXlsx(buffer);
    default:
      throw new Error(`Unsupported office format: "${ext}"`);
  }
}
