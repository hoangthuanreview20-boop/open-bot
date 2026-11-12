/**
 * Lệnh slash (`/tên-lệnh args`) — v0.14 mục 3.
 *
 * Registry thuần túy cho lệnh slash: một lệnh là một prompt template
 * (đọc từ file Markdown, hoặc đi kèm plugin bundle) và/hoặc một hàm
 * `run` chạy ngay khi người dùng gõ lệnh. Module này KHÔNG import
 * loop/coordinator — điều phối viên sẽ gọi `parse()` trên input của
 * người dùng, lấy `promptTemplate` qua `renderPrompt()` (hoặc gọi
 * `run()`), rồi đưa kết quả vào vòng lặp agent như một user message.
 *
 * Nguồn lệnh:
 * - `registerFromMarkdown(dir)`: quét `*.md` trong một thư mục — tên
 *   lệnh = tên file, mô tả = dòng `# ...` đầu tiên (hoặc dòng đầu tiên
 *   không rỗng), nội dung file = prompt template.
 * - `registerFromBundle(parts)`: nhận kết quả `resolveBundleParts()`
 *   của plugin bundle — nhưng module này KHÔNG import bundle.ts (tránh
 *   phụ thuộc chéo tools → core); chỉ nhận object thuần theo
 *   `BundlePartsForSlash` dưới đây.
 * - `register(def)`: đăng ký trực tiếp một lệnh (template và/hoặc hàm run).
 *
 * Placeholder trong template: `{{args}}`, `{{arguments}}`, `$ARGUMENTS`
 * được thay bằng args người dùng gõ; template không có placeholder thì
 * args được gắn thêm ở cuối prompt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Tên lệnh slash: chữ thường, số, "-" — bắt đầu bằng chữ thường hoặc số. */
export const SLASH_COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Mô tả lệnh lấy từ Markdown bị cắt ở 200 ký tự (đủ cho menu `/`). */
export const MAX_SLASH_DESCRIPTION_CHARS = 200;

/** Ngữ cảnh truyền cho hàm `run` của một lệnh slash. */
export interface SlashCommandContext {
  /** Args người dùng gõ sau tên lệnh (đã trim). */
  args: string;
  /** Toàn bộ input gốc, vd "/review-code src/index.ts". */
  rawInput: string;
  /** Thư mục workspace của lần chạy (khi điều phối viên truyền vào). */
  workspaceDir?: string;
  /** Bot sở hữu lần chạy (khi biết). */
  botId?: string;
}

export type SlashCommandHandler = (
  args: string,
  ctx: SlashCommandContext,
) => string | void | Promise<string | void>;

/** Một lệnh slash đã đăng ký. */
export interface SlashCommandDef {
  name: string;
  description: string;
  /** 'markdown' = nạp từ file .md; 'plugin' = đi kèm plugin bundle. */
  source: 'markdown' | 'plugin';
  /** File Markdown gốc (đường dẫn tuyệt đối), khi có. */
  file?: string;
  /** Prompt template — args được thay vào placeholder (xem renderSlashPrompt). */
  promptTemplate?: string;
  /** Hàm chạy ngay khi gọi lệnh (thay cho / hoặc cùng với template). */
  run?: SlashCommandHandler;
}

/** Lệnh slash đi kèm một bundle đã resolve — input tối thiểu cho registerFromBundle. */
export interface BundleSlashCommandRef {
  name: string;
  description: string;
  /** Đường dẫn tuyệt đối tới file Markdown (đã resolve bởi bundle). */
  file: string;
}

/** Input tối thiểu của `registerFromBundle` — object thuần, không import bundle.ts. */
export interface BundlePartsForSlash {
  slashCommands?: BundleSlashCommandRef[];
}

/** Kết quả của `parseSlashInput()` / `registry.parse()`. */
export interface ParsedSlashCommand {
  name: string;
  args: string;
}

/** Thrown khi đăng ký / nạp lệnh slash thất bại (trùng tên, file lỗi, template rỗng, …). */
export class SlashCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlashCommandError';
  }
}

/**
 * Phân tích input người dùng: "/tên-lệnh args..." → `{ name, args }`.
 * Trả về null khi input không bắt đầu bằng `/`, chỉ có `/` trơ trọi,
 * hoặc tên lệnh chứa ký tự ngoài `[a-z0-9-]` (vd "/Review" → null).
 */
export function parseSlashInput(input: string): ParsedSlashCommand | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const rest = trimmed.slice(1).trim();
  if (rest === '') return null;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (match === null) return null;
  const name = match[1]!;
  if (!SLASH_COMMAND_NAME_RE.test(name)) return null;
  return { name, args: (match[2] ?? '').trim() };
}

const PLACEHOLDER_RES: RegExp[] = [
  /\{\{\s*args\s*\}\}/g,
  /\{\{\s*arguments\s*\}\}/g,
  /\$ARGUMENTS/g,
];

/**
 * Render prompt template với args: thay mọi `{{args}}` / `{{arguments}}` /
 * `$ARGUMENTS` bằng args. Template không có placeholder thì args được
 * gắn thêm ở cuối prompt (sau một dòng trống). Template rỗng → chỉ trả
 * về args (lệnh chỉ có hàm `run` vẫn render được).
 */
export function renderSlashPrompt(def: SlashCommandDef, args: string): string {
  const template = def.promptTemplate ?? '';
  const cleanArgs = typeof args === 'string' ? args.trim() : '';
  if (template.trim() === '') return cleanArgs;
  let out = template;
  let replaced = false;
  for (const pattern of PLACEHOLDER_RES) {
    // Tạo regex mới mỗi lần (regex /g giữ lastIndex giữa các lần test).
    const re = new RegExp(pattern.source, 'g');
    if (re.test(out)) {
      replaced = true;
      out = out.replace(new RegExp(pattern.source, 'g'), () => cleanArgs);
    }
  }
  if (!replaced && cleanArgs !== '') {
    out = `${out.replace(/\s+$/, '')}\n\n${cleanArgs}`;
  }
  return out;
}

/** Mô tả cho một lệnh nạp từ Markdown: dòng `# ...` đầu tiên, nếu không thì dòng đầu tiên không rỗng. */
function extractDescription(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const withoutHeading = trimmed.replace(/^#+\s*/, '').trim();
    if (withoutHeading === '') continue;
    return withoutHeading.slice(0, MAX_SLASH_DESCRIPTION_CHARS);
  }
  return '';
}

function validateDef(def: SlashCommandDef): void {
  if (typeof def.name !== 'string' || !SLASH_COMMAND_NAME_RE.test(def.name)) {
    throw new SlashCommandError(
      `Tên lệnh "/${String(def.name)}" không hợp lệ: chỉ dùng chữ thường, số và dấu "-" (vd "review-code").`,
    );
  }
  if (typeof def.description !== 'string' || def.description.trim() === '') {
    throw new SlashCommandError(`Lệnh "/${def.name}" cần mô tả (description) không rỗng.`);
  }
  if (
    (def.promptTemplate === undefined || def.promptTemplate.trim() === '') &&
    typeof def.run !== 'function'
  ) {
    throw new SlashCommandError(
      `Lệnh "/${def.name}" cần promptTemplate hoặc hàm run — thiếu cả hai.`,
    );
  }
}

/** Registry lệnh slash — thuần túy, không chạm tới loop/coordinator. */
export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommandDef>();

  /** Đăng ký một lệnh. Ném `SlashCommandError` khi trùng tên hoặc def không hợp lệ. */
  register(def: SlashCommandDef): SlashCommandDef {
    validateDef(def);
    if (this.commands.has(def.name)) {
      throw new SlashCommandError(
        `Đã có lệnh "/${def.name}" — không thể đăng ký trùng tên lệnh.`,
      );
    }
    const stored: SlashCommandDef = {
      name: def.name,
      description: def.description.trim(),
      source: def.source,
      ...(def.file !== undefined ? { file: def.file } : {}),
      ...(def.promptTemplate !== undefined ? { promptTemplate: def.promptTemplate } : {}),
      ...(typeof def.run === 'function' ? { run: def.run } : {}),
    };
    this.commands.set(def.name, stored);
    return stored;
  }

  /**
   * Quét `*.md` trong `dir` (không đệ quy, theo thứ tự tên file) và đăng
   * ký mỗi file thành một lệnh: tên lệnh = tên file (không đuôi .md),
   * mô tả = dòng `# ...` đầu tiên hoặc dòng đầu tiên không rỗng, nội
   * dung file = prompt template. Ném `SlashCommandError` khi thư mục
   * không tồn tại, file không đọc được, tên file không hợp lệ, template
   * rỗng, hoặc trùng tên lệnh.
   */
  registerFromMarkdown(dir: string): SlashCommandDef[] {
    const absDir = path.resolve(dir);
    let entries: string[];
    try {
      entries = fs.readdirSync(absDir);
    } catch (err) {
      throw new SlashCommandError(
        `Không đọc được thư mục lệnh slash "${absDir}": ${(err as Error).message}`,
      );
    }
    const files = entries.filter((e) => e.endsWith('.md')).sort();
    const registered: SlashCommandDef[] = [];
    for (const file of files) {
      const absPath = path.join(absDir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch (err) {
        throw new SlashCommandError(
          `Không đọc được file lệnh slash "${absPath}": ${(err as Error).message}`,
        );
      }
      if (!stat.isFile()) continue;
      const name = file.slice(0, -'.md'.length);
      if (!SLASH_COMMAND_NAME_RE.test(name)) {
        throw new SlashCommandError(
          `Tên file "${file}" không phải tên lệnh slash hợp lệ: chỉ dùng chữ thường, số và "-" ` +
            `(đổi tên file thành dạng "ten-lenh.md").`,
        );
      }
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch (err) {
        throw new SlashCommandError(
          `Không đọc được file lệnh slash "${absPath}": ${(err as Error).message}`,
        );
      }
      if (content.trim() === '') {
        throw new SlashCommandError(
          `File lệnh slash "${absPath}" rỗng — cần nội dung prompt template.`,
        );
      }
      const description = extractDescription(content);
      try {
        registered.push(
          this.register({
            name,
            description,
            source: 'markdown',
            file: absPath,
            promptTemplate: content,
          }),
        );
      } catch (err) {
        if (err instanceof SlashCommandError) {
          throw new SlashCommandError(`File "${file}": ${err.message}`);
        }
        throw err;
      }
    }
    return registered;
  }

  /**
   * Đăng ký các lệnh slash đi kèm một bundle đã resolve (kết quả của
   * `resolveBundleParts()` bên tools — truyền object thuần, module này
   * không import bundle.ts). Mỗi lệnh đọc template từ file Markdown đã
   * resolve. Ném `SlashCommandError` khi file không đọc được, template
   * rỗng, hoặc trùng tên lệnh.
   */
  registerFromBundle(parts: BundlePartsForSlash): SlashCommandDef[] {
    const refs = parts?.slashCommands ?? [];
    const registered: SlashCommandDef[] = [];
    for (const ref of refs) {
      const file = ref.file;
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (err) {
        throw new SlashCommandError(
          `Không đọc được file của lệnh slash "/${ref.name}" trong bundle ("${file}"): ${(err as Error).message}`,
        );
      }
      if (content.trim() === '') {
        throw new SlashCommandError(
          `Lệnh slash "/${ref.name}" trong bundle có file "${file}" rỗng — cần nội dung prompt template.`,
        );
      }
      try {
        registered.push(
          this.register({
            name: ref.name,
            description: ref.description,
            source: 'plugin',
            file: path.resolve(file),
            promptTemplate: content,
          }),
        );
      } catch (err) {
        if (err instanceof SlashCommandError) {
          throw new SlashCommandError(`Lệnh slash "/${ref.name}" trong bundle: ${err.message}`);
        }
        throw err;
      }
    }
    return registered;
  }

  /** Mọi lệnh đã đăng ký, theo thứ tự đăng ký. */
  list(): SlashCommandDef[] {
    return [...this.commands.values()];
  }

  /** Tìm một lệnh theo tên, hoặc `undefined` khi chưa đăng ký. */
  find(name: string): SlashCommandDef | undefined {
    return this.commands.get(name);
  }

  /** True khi lệnh đã đăng ký. */
  has(name: string): boolean {
    return this.commands.has(name);
  }

  /** Phân tích input người dùng (xem `parseSlashInput`). */
  parse(input: string): ParsedSlashCommand | null {
    return parseSlashInput(input);
  }

  /** Render prompt template của một lệnh với args (xem `renderSlashPrompt`). */
  renderPrompt(def: SlashCommandDef, args: string): string {
    return renderSlashPrompt(def, args);
  }
}
