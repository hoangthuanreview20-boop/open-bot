/**
 * AST support for code tools (v0.86, P2-4): extract code symbols
 * (functions, classes, methods, interfaces, types, enums) with 1-based
 * line/column positions from a real tree-sitter parse — not text search.
 *
 * Engine: `web-tree-sitter` (WASM, no native build) + prebuilt grammar
 * WASM files from the official `tree-sitter-*` npm packages
 * (javascript, typescript, python). Grammars are loaded lazily and
 * cached per language; `Parser.init()` runs once per process.
 *
 * Fail-closed by design:
 *  - an unsupported language / extension throws a clear error listing
 *    what IS supported — never a guessed result;
 *  - a file with syntax errors still returns the symbols that parsed,
 *    flagged with `hasError: true`, instead of crashing;
 *  - an empty file parses to zero symbols, not an error.
 *
 * Honest limits (also stated on the `code_symbols` tool):
 *  - only JavaScript, TypeScript, TSX and Python have grammars installed;
 *    Go, Rust, Java, C/C++ and the rest are NOT supported yet — adding
 *    one is a new `tree-sitter-<lang>` dependency + one row in GRAMMARS;
 *  - object-literal methods are reported as `method` under the variable
 *    they are assigned to (`const o = { m() {} }` → `o.m`); free
 *    `assignment_expression` targets (`exports.foo = function () {}`)
 *    are NOT reported;
 *  - the grammar `.wasm` files are resolved out of `node_modules`
 *    (via `<grammar>/package.json`); a packaged build that prunes
 *    them will fail with a clear "grammar not found" error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/** Ngôn ngữ có grammar tree-sitter đã cài (WASM). */
export const SUPPORTED_AST_LANGUAGES = ['javascript', 'typescript', 'tsx', 'python'] as const;
export type AstLanguage = (typeof SUPPORTED_AST_LANGUAGES)[number];

export type AstSymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum';

export interface CodeSymbol {
  kind: AstSymbolKind;
  /** Tên ngắn, vd `bar`. */
  name: string;
  /** Tên đầy đủ theo scope, vd `Foo.bar` (method) hay `Outer.Inner` (class lồng). */
  qualifiedName: string;
  /** Dòng bắt đầu, 1-based. */
  line: number;
  /** Cột bắt đầu, 1-based. */
  column: number;
  /** Dòng kết thúc, 1-based. */
  endLine: number;
}

export interface ParseCodeSymbolsResult {
  language: AstLanguage;
  symbols: CodeSymbol[];
  /** true khi cây parse có node lỗi (file lỗi cú pháp) — symbols vẫn trả về phần parse được. */
  hasError: boolean;
}

interface GrammarSpec {
  packageName: string;
  wasmFile: string;
  extensions: string[];
}

const GRAMMARS: Record<AstLanguage, GrammarSpec> = {
  javascript: {
    packageName: 'tree-sitter-javascript',
    wasmFile: 'tree-sitter-javascript.wasm',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  },
  typescript: {
    packageName: 'tree-sitter-typescript',
    wasmFile: 'tree-sitter-typescript.wasm',
    extensions: ['.ts', '.mts', '.cts'],
  },
  tsx: {
    packageName: 'tree-sitter-typescript',
    wasmFile: 'tree-sitter-tsx.wasm',
    extensions: ['.tsx'],
  },
  python: {
    packageName: 'tree-sitter-python',
    wasmFile: 'tree-sitter-python.wasm',
    extensions: ['.py'],
  },
};

/** Mô tả ngắn gọn các ngôn ngữ hỗ trợ, dùng trong thông báo lỗi fail-closed. */
export function supportedAstLanguagesText(): string {
  return (Object.keys(GRAMMARS) as AstLanguage[])
    .map((lang) => `${lang} (${GRAMMARS[lang]!.extensions.join(', ')})`)
    .join(', ');
}

/** Nhận diện ngôn ngữ từ đuôi file; trả null khi đuôi chưa được hỗ trợ. */
export function detectAstLanguage(filePath: string): AstLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  for (const lang of Object.keys(GRAMMARS) as AstLanguage[]) {
    if (GRAMMARS[lang]!.extensions.includes(ext)) return lang;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WASM engine: lazy init + cached languages
// ---------------------------------------------------------------------------

const requireForWasm = createRequire(__filename);

let initPromise: Promise<void> | null = null;
function ensureParserInit(): Promise<void> {
  if (initPromise === null) initPromise = Parser.init();
  return initPromise;
}

const languageCache = new Map<AstLanguage, Language>();

function resolveGrammarWasm(lang: AstLanguage): string {
  const spec = GRAMMARS[lang]!;
  let pkgJsonPath: string;
  try {
    pkgJsonPath = requireForWasm.resolve(`${spec.packageName}/package.json`);
  } catch {
    throw new Error(
      `Không tìm thấy grammar tree-sitter cho "${lang}": gói npm "${spec.packageName}" chưa được cài. ` +
        `Chạy "npm install" ở thư mục gốc của repo rồi thử lại.`,
    );
  }
  const wasmPath = path.join(path.dirname(pkgJsonPath), spec.wasmFile);
  if (!fs.existsSync(wasmPath)) {
    throw new Error(
      `Không tìm thấy file grammar WASM cho "${lang}": ${wasmPath} (gói "${spec.packageName}" đã cài nhưng thiếu file này).`,
    );
  }
  return wasmPath;
}

async function loadLanguage(lang: AstLanguage): Promise<Language> {
  const cached = languageCache.get(lang);
  if (cached) return cached;
  await ensureParserInit();
  const loaded = await Language.load(resolveGrammarWasm(lang));
  languageCache.set(lang, loaded);
  return loaded;
}

// ---------------------------------------------------------------------------
// Symbol extraction: recursive walk over the parse tree
// ---------------------------------------------------------------------------

interface Scope {
  name: string;
  kind: 'class' | 'function' | 'namespace';
}

function nameNodeOf(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('name');
}

function nodeName(node: SyntaxNode): string | null {
  const nameNode = nameNodeOf(node);
  return nameNode === null ? null : nameNode.text;
}

/**
 * Vị trí báo cáo là vị trí của TÊN symbol (điểm nhảy tới khi mở file),
 * còn `endLine` là dòng kết thúc của cả khai báo.
 */
function makeSymbol(
  kind: AstSymbolKind,
  name: string,
  nameNode: SyntaxNode,
  scopes: Scope[],
  node: SyntaxNode,
): CodeSymbol {
  return {
    kind,
    name,
    qualifiedName: [...scopes.map((s) => s.name), name].join('.'),
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
  };
}

function walkChildren(node: SyntaxNode, scopes: Scope[], out: CodeSymbol[]): void {
  for (const child of node.children) walkNode(child, scopes, out);
}

/**
 * Walk one node, recording a symbol when the node declares one, then
 * recursing into its children (nested declarations keep their enclosing
 * scope in `qualifiedName`).
 */
function walkNode(node: SyntaxNode, scopes: Scope[], out: CodeSymbol[]): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = nodeName(node);
      const nameNode = nameNodeOf(node);
      if (name !== null && nameNode !== null) {
        out.push(makeSymbol('function', name, nameNode, scopes, node));
      }
      walkChildren(node, name !== null ? [...scopes, { name, kind: 'function' }] : scopes, out);
      return;
    }
    case 'function_definition': {
      // Python: a def inside a class is a method, otherwise a function.
      const name = nodeName(node);
      const nameNode = nameNodeOf(node);
      const enclosing = scopes.length > 0 ? scopes[scopes.length - 1] : undefined;
      const kind: AstSymbolKind = enclosing !== undefined && enclosing.kind === 'class' ? 'method' : 'function';
      if (name !== null && nameNode !== null) {
        out.push(makeSymbol(kind, name, nameNode, scopes, node));
      }
      walkChildren(node, name !== null ? [...scopes, { name, kind: 'function' }] : scopes, out);
      return;
    }
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class_definition': {
      const name = nodeName(node);
      const nameNode = nameNodeOf(node);
      if (name !== null && nameNode !== null) {
        out.push(makeSymbol('class', name, nameNode, scopes, node));
      }
      walkChildren(node, name !== null ? [...scopes, { name, kind: 'class' }] : scopes, out);
      return;
    }
    case 'method_definition': {
      const name = nodeName(node);
      const nameNode = nameNodeOf(node);
      if (name !== null && nameNode !== null) {
        out.push(makeSymbol('method', name, nameNode, scopes, node));
      }
      walkChildren(node, name !== null ? [...scopes, { name, kind: 'function' }] : scopes, out);
      return;
    }
    case 'variable_declarator': {
      // `const f = () => {}`, `const f = function () {}`, `const C = class {}`.
      const name = nodeName(node);
      const nameNode = nameNodeOf(node);
      const value = node.childForFieldName('value');
      let kind: AstSymbolKind | null = null;
      if (value !== null) {
        if (value.type === 'arrow_function' || value.type === 'function_expression') {
          kind = 'function';
        } else if (value.type === 'class') {
          kind = 'class';
        }
      }
      if (name !== null && nameNode !== null && kind !== null) {
        out.push(makeSymbol(kind, name, nameNode, scopes, node));
      }
      walkChildren(
        node,
        name !== null && kind !== null ? [...scopes, { name, kind }] : scopes,
        out,
      );
      return;
    }
    case 'interface_declaration': {
      const name = nodeName(node);
      const nameNode = nameNodeOf(node);
      if (name !== null && nameNode !== null) {
        out.push(makeSymbol('interface', name, nameNode, scopes, node));
      }
      walkChildren(node, scopes, out);
      return;
    }
    case 'type_alias_declaration': {
      const name = nodeName(node);
      const nameNode = nameNodeOf(node);
      if (name !== null && nameNode !== null) {
        out.push(makeSymbol('type', name, nameNode, scopes, node));
      }
      walkChildren(node, scopes, out);
      return;
    }
    case 'enum_declaration': {
      const name = nodeName(node);
      const nameNode = nameNodeOf(node);
      if (name !== null && nameNode !== null) {
        out.push(makeSymbol('enum', name, nameNode, scopes, node));
      }
      walkChildren(node, scopes, out);
      return;
    }
    case 'internal_module': {
      // TypeScript `namespace Foo { ... }` — a scope, not a symbol kind we report.
      const name = nodeName(node);
      walkChildren(node, name !== null ? [...scopes, { name, kind: 'namespace' }] : scopes, out);
      return;
    }
    default:
      walkChildren(node, scopes, out);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse source code with tree-sitter and extract its symbols.
 * Throws only for engine/grammar failures; a syntactically broken file
 * parses to `hasError: true` with whatever symbols survived.
 */
export async function parseCodeSymbols(
  source: string,
  language: AstLanguage,
): Promise<ParseCodeSymbolsResult> {
  if (!(Object.keys(GRAMMARS) as string[]).includes(language)) {
    throw new Error(
      `Ngôn ngữ không hỗ trợ cho AST: "${language}". Hỗ trợ: ${supportedAstLanguagesText()}.`,
    );
  }
  const lang = await loadLanguage(language);
  const parser = new Parser();
  try {
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    if (tree === null) {
      throw new Error(`tree-sitter không parse được source (${language}): parser.parse() trả về null.`);
    }
    try {
      const symbols: CodeSymbol[] = [];
      walkNode(tree.rootNode, [], symbols);
      return { language, symbols, hasError: tree.rootNode.hasError };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
