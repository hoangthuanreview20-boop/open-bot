/**
 * Agent tools cho skill marketplace (v0.14, item 4).
 *
 * Hai tool nối module marketplace của @open-bot/core
 * (`packages/core/src/skills/marketplace.ts`) ra agent loop:
 *  - `skill_marketplace_preview` (chỉ đọc): xem trước skill từ URL
 *    (tên, mô tả, danh sách file, secret phát hiện) — chưa cài gì cả.
 *  - `skill_marketplace_install` (cần duyệt): cài skill từ URL vào
 *    skillsDir do host cấu hình qua `opts.getSkillsDir`.
 *
 * An toàn: tool không bao giờ in giá trị secret — marketplace chỉ báo
 * tên file + loại secret, và tool chỉ chuyển tiếp đúng những thông tin
 * đó. Tool không tự chọn thư mục cài: không có skillsDir thì báo lỗi
 * rõ ràng thay vì cài vào chỗ khiến skill vô hình với registry.
 *
 * Factory:
 *   createSkillMarketplaceTools(opts?) -> Tool[]   (bound, usable)
 *   SKILL_MARKETPLACE_TOOLS                        (unbound placeholder)
 *
 * Approval: preview chỉ đọc -> false; install thay đổi hệ thống -> true.
 * KHÔNG tự đăng ký vào ALL_TOOLS — điều phối viên nối factory vào
 * defaultToolFactory (cần opts.getSkillsDir).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  installSkillFromUrl,
  previewSkillFromUrl,
} from '@open-bot/core/dist/skills/marketplace.js';

/** Tuỳ chọn của factory — host cho biết skill được cài vào đâu. */
export interface SkillMarketplaceToolOptions {
  /**
   * Trả về thư mục chứa các skill đã cài (`<skillsDir>/<tên-skill>/`).
   * Trả `null` khi chưa cấu hình — tool install sẽ báo lỗi rõ ràng
   * thay vì tự cài vào một chỗ khác.
   */
  getSkillsDir?: () => string | null;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Thiếu tham số bắt buộc: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Tham số "${name}" phải là chuỗi, nhận được ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Tham số "${name}" phải là boolean, nhận được ${typeof value}`);
  }
  return value;
}

/** Chỉ chấp nhận URL http(s) — mọi scheme khác (file:, ftp:, ...) đều lỗi rõ ràng. */
function assertHttpUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL không hợp lệ: ${JSON.stringify(rawUrl)}.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Chỉ chấp nhận URL http(s), nhận được scheme ${JSON.stringify(url.protocol)} từ ${JSON.stringify(rawUrl)}.`,
    );
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} byte`;
  return `${(size / 1024).toFixed(1)} KB`;
}

/** Đếm số file trong một thư mục (đệ quy, bỏ qua .git). */
function countFilesRecursive(dir: string): number {
  let count = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count++;
    }
  };
  walk(dir);
  return count;
}

export function createSkillMarketplaceTools(
  opts: SkillMarketplaceToolOptions = {},
): Tool[] {
  const previewTool: Tool = {
    definition: {
      name: 'skill_marketplace_preview',
      description:
        'Xem trước một skill từ URL (.zip hoặc repo git) TRƯỚC KHI cài: trả tên skill, mô tả, ' +
        'danh sách file (tên + kích thước) và secret nào bị phát hiện (chỉ tên file + loại, không lộ giá trị). ' +
        'Chỉ đọc — không cài gì cả. Chỉ chấp nhận URL http(s).',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL http(s) trỏ tới file .zip của skill hoặc repo git chứa skill.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const url = getStringArg(args, 'url');
        if (url.trim() === '') return errorResult('URL không được rỗng.');
        assertHttpUrl(url);
        const preview = await previewSkillFromUrl(url);
        const lines: string[] = [
          `Xem trước skill "${preview.skillName}" từ ${JSON.stringify(url)}:`,
          `Mô tả: ${preview.manifest.description}`,
        ];
        if (preview.manifest.version) {
          lines.push(`Phiên bản: ${preview.manifest.version}`);
        }
        lines.push(`File (${preview.files.length}):`);
        for (const file of preview.files) {
          lines.push(`  - ${file.path} (${formatBytes(file.size)})`);
        }
        // Preview chỉ thành công khi quét secret không phát hiện gì
        // (marketplace dừng ngay khi có secret) nên ở đây luôn là "không có".
        lines.push('Secret: không phát hiện secret nào.');
        if (preview.readme) {
          lines.push(`README (rút gọn):\n${preview.readme.slice(0, 500)}`);
        }
        lines.push('Chưa cài gì cả — dùng skill_marketplace_install để cài skill này.');
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const installTool: Tool = {
    definition: {
      name: 'skill_marketplace_install',
      description:
        'Cài một skill từ URL (.zip hoặc repo git) vào thư mục skills đã cấu hình. ' +
        'Trước khi cài sẽ quét secret — phát hiện secret là dừng ngay, không ghi file nào. ' +
        'Trả đường dẫn đã cài, tên skill, số file và cảnh báo (nếu có). Cần duyệt vì đây là hành động thay đổi hệ thống.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL http(s) trỏ tới file .zip của skill hoặc repo git chứa skill.',
          },
          overwrite: {
            type: 'boolean',
            description: 'Ghi đè skill cùng tên đã tồn tại (mặc định false — trùng tên thì báo lỗi).',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const url = getStringArg(args, 'url');
        if (url.trim() === '') return errorResult('URL không được rỗng.');
        assertHttpUrl(url);
        const overwrite = getBoolArg(args, 'overwrite', false);
        const skillsDir = opts.getSkillsDir?.() ?? null;
        if (!skillsDir || typeof skillsDir !== 'string' || skillsDir.trim() === '') {
          return errorResult(
            'Chưa cấu hình thư mục skills (skillsDir) nên không biết cài skill vào đâu — ' +
              'host cần truyền getSkillsDir cho createSkillMarketplaceTools. Không tự cài vào thư mục khác.',
          );
        }
        const result = await installSkillFromUrl(url, { skillsDir, overwrite });
        const fileCount = countFilesRecursive(result.installedPath);
        const lines: string[] = [
          `Đã cài skill "${result.manifest.name}" vào ${JSON.stringify(result.installedPath)}.`,
          `Mô tả: ${result.manifest.description}`,
          `Số file đã cài: ${fileCount} (đã quét secret: ${result.scannedFiles.length} file, không phát hiện secret).`,
        ];
        if (result.warnings.length > 0) {
          lines.push('Cảnh báo:');
          for (const warning of result.warnings) lines.push(`  - ${warning}`);
        } else {
          lines.push('Cảnh báo: không có.');
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [previewTool, installTool];
}

/**
 * Placeholder chưa bound (không có getSkillsDir — install sẽ báo lỗi
 * rõ ràng cho tới khi host tạo lại bằng factory kèm getSkillsDir).
 * Điều phối viên nối factory vào defaultToolFactory, không dùng const này.
 */
export const SKILL_MARKETPLACE_TOOLS: Tool[] = createSkillMarketplaceTools();
