/**
 * MemFS-lite (v0.96, Đội T1) — memory dưới dạng file Markdown mà user
 * đọc/sửa được bằng tay, 1 file / block (+ 1 file facts dài hạn).
 *
 * Định dạng file block `<label>.md`:
 *   ---
 *   label: human
 *   description: "..."
 *   scope: shared
 *   readOnly: false
 *   version: 3
 *   updatedAt: "2026-11-13T..."
 *   attachedBots:
 *     - bot-a
 *   ---
 *   <nội dung block>
 *
 * Frontmatter là YAML tối giản (scalar viết dạng JSON — chuỗi có dấu
 * ngoặc kép, số/boolean viết trần — nên parser chỉ cần xử lý `key:
 * value` và list `- item`). Export ghi đè file cùng tên (nội dung lấy
 * từ store, nguồn chân lý vẫn là store JSON); import MERGE không ghi
 * đè bừa: block đã có chỉ được cập nhật khi bản import MỚI HƠN
 * (updatedAt lớn hơn) và block không read-only — mọi trường hợp còn
 * lại đều ghi vào `conflicts`/`skipped` trong kết quả, không mất dữ
 * liệu lặng lẽ.
 *
 * Long-term facts xuất thành `longterm-facts.md` (một section `## key`
 * cho mỗi entry, kèm meta botId/confidence/tags/updatedAt); import
 * merge theo (botId, key), bản mới hơn thắng.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoryBlockStore, normalizeBlockLabel, isValidBlockLabel, type MemoryBlock } from './blocks';
import type { LongTermMemory, LongTermMemoryEntry } from './longterm';

export const MEMFS_FACTS_FILENAME = 'longterm-facts.md';
export const MEMFS_BLOCKS_DIR_NAME = 'memory-blocks';

export interface MemFsExportResult {
  dir: string;
  exportedAt: string;
  /** Tên file block đã ghi (kèm số block). */
  blockFiles: string[];
  blockCount: number;
  /** File facts (vắng khi không truyền longTerm store). */
  factsFile?: string;
  factCount: number;
}

export interface MemFsImportConflict {
  label: string;
  reason: string;
  importedUpdatedAt?: string;
  existingUpdatedAt?: string;
}

export interface MemFsImportResult {
  imported: number;
  updated: number;
  skipped: number;
  conflicts: MemFsImportConflict[];
}

export interface MemFsFactsImportResult {
  imported: number;
  updated: number;
  skipped: number;
}

/** Scalar YAML tối giản: chuỗi -> JSON.stringify (dấu ngoặc kép hợp lệ trong YAML). */
function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function yamlValue(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : String(parsed);
    } catch {
      return value;
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value ?? '');
}

/**
 * Parse frontmatter tối giản: trả { data, body }. Không có frontmatter
 * -> data rỗng, body là toàn bộ file. List YAML (`key:` rồi các dòng
 * `- item`) được gom thành mảng.
 */
export function parseMemFsFrontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { data: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text };
  const data: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? '';
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentListKey) {
      const arr = data[currentListKey] as unknown[];
      arr.push(yamlValue(listMatch[1]?.trim() ?? ''));
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) {
      currentListKey = null;
      continue;
    }
    const key = kvMatch[1] as string;
    const raw = (kvMatch[2] ?? '').trim();
    if (raw === '') {
      data[key] = [];
      currentListKey = key;
      continue;
    }
    currentListKey = null;
    try {
      data[key] = JSON.parse(raw);
    } catch {
      data[key] = raw;
    }
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '');
  return { data, body };
}

function renderBlockFile(block: MemoryBlock, attachedBots: string[]): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`label: ${yamlScalar(block.label)}`);
  lines.push(`description: ${yamlScalar(block.description)}`);
  lines.push(`scope: ${yamlScalar(block.createdByBotId === '' ? 'shared' : `bot:${block.createdByBotId}`)}`);
  lines.push(`readOnly: ${yamlScalar(block.readOnly)}`);
  lines.push(`version: ${yamlScalar(block.version)}`);
  lines.push(`updatedAt: ${yamlScalar(block.updatedAt)}`);
  lines.push(`charLimit: ${yamlScalar(block.charLimit)}`);
  if (attachedBots.length > 0) {
    lines.push('attachedBots:');
    for (const botId of attachedBots) lines.push(`  - ${yamlScalar(botId)}`);
  } else {
    lines.push('attachedBots: []');
  }
  lines.push('---');
  lines.push(block.content);
  return lines.join('\n') + '\n';
}

/** Tên file an toàn cho một block (label đã là slug; label lạ -> null). */
export function blockFileName(label: string): string | null {
  const slug = normalizeBlockLabel(label);
  if (!isValidBlockLabel(slug)) return null;
  return `${slug}.md`;
}

/**
 * Export toàn bộ block (+ facts dài hạn nếu có store) ra thư mục
 * MemFS. Ghi đè file cùng tên — store JSON vẫn là nguồn chân lý.
 */
export function exportBlocksToMemFs(
  blocks: MemoryBlockStore,
  dir: string,
  opts: { longTerm?: LongTermMemory } = {},
): MemFsExportResult {
  fs.mkdirSync(dir, { recursive: true });
  const exportedAt = new Date().toISOString();
  const all = blocks.list();
  const blockFiles: string[] = [];
  for (const block of all) {
    const fileName = blockFileName(block.label);
    if (!fileName) continue;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, renderBlockFile(block, blocks.attachedBotIds(block.id)), 'utf8');
    blockFiles.push(fileName);
  }
  let factsFile: string | undefined;
  let factCount = 0;
  if (opts.longTerm) {
    const entries = opts.longTerm.recall({ limit: 200 });
    factCount = entries.length;
    const lines: string[] = [];
    lines.push('# Long-term facts');
    lines.push('');
    lines.push(`<!-- exportedAt: ${exportedAt} -->`);
    lines.push('');
    for (const entry of entries) {
      lines.push(`## ${entry.key}`);
      lines.push(`- botId: ${entry.botId === '' ? 'shared' : entry.botId}`);
      lines.push(`- confidence: ${entry.confidence}`);
      lines.push(`- tags: ${entry.tags.join(', ')}`);
      lines.push(`- updatedAt: ${entry.updatedAt}`);
      lines.push('');
      lines.push(entry.value);
      lines.push('');
    }
    factsFile = MEMFS_FACTS_FILENAME;
    fs.writeFileSync(path.join(dir, MEMFS_FACTS_FILENAME), lines.join('\n'), 'utf8');
  }
  return { dir, exportedAt, blockFiles, blockCount: blockFiles.length, ...(factsFile ? { factsFile } : {}), factCount };
}

/**
 * Import block từ thư mục MemFS (merge, không ghi đè bừa):
 *  - file chưa có label tương ứng -> tạo mới (kèm attach theo frontmatter);
 *  - đã có + bản import mới hơn + không read-only -> cập nhật nội dung/mô tả;
 *  - đã có + bản import cũ hơn/bằng -> skip;
 *  - đã có + read-only -> conflict (không sửa).
 * File `longterm-facts.md` được bỏ qua ở đây (xem importFactsFromMemFs).
 */
export function importBlocksFromMemFs(
  blocks: MemoryBlockStore,
  dir: string,
  opts: { actor?: string } = {},
): MemFsImportResult {
  const actor = opts.actor ?? 'user';
  const result: MemFsImportResult = { imported: 0, updated: 0, skipped: 0, conflicts: [] };
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== MEMFS_FACTS_FILENAME);
  } catch {
    return result;
  }
  for (const name of names.sort()) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      result.skipped += 1;
      continue;
    }
    const { data, body } = parseMemFsFrontmatter(raw);
    const labelRaw = typeof data['label'] === 'string' ? (data['label'] as string) : name.replace(/\.md$/, '');
    const label = normalizeBlockLabel(labelRaw);
    if (!isValidBlockLabel(label)) {
      result.conflicts.push({ label: labelRaw, reason: `label không hợp lệ trong file ${name}` });
      continue;
    }
    const importedUpdatedAt = typeof data['updatedAt'] === 'string' ? (data['updatedAt'] as string) : undefined;
    const description = typeof data['description'] === 'string' ? (data['description'] as string) : '';
    const readOnly = data['readOnly'] === true;
    const charLimit =
      typeof data['charLimit'] === 'number' && Number.isFinite(data['charLimit'])
        ? (data['charLimit'] as number)
        : undefined;
    const attachedBots = Array.isArray(data['attachedBots'])
      ? (data['attachedBots'] as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim() !== '')
      : [];
    const existing = blocks.get(label);
    if (!existing) {
      try {
        const created = blocks.create(
          {
            label,
            description,
            content: body.replace(/\n$/, ''),
            ...(charLimit !== undefined ? { charLimit } : {}),
            readOnly,
          },
          actor,
        );
        for (const botId of attachedBots) {
          try {
            blocks.attach(botId, created.id, actor);
          } catch {
            // Attach lỗi (botId lạ) thì bỏ qua bot đó, block vẫn đã tạo.
          }
        }
        result.imported += 1;
      } catch (err) {
        result.conflicts.push({ label, reason: (err as Error).message });
      }
      continue;
    }
    // Đã có: chỉ cập nhật khi bản import mới hơn.
    const importedTime = importedUpdatedAt ? Date.parse(importedUpdatedAt) : NaN;
    const existingTime = Date.parse(existing.updatedAt);
    if (!Number.isFinite(importedTime) || importedTime <= existingTime) {
      result.skipped += 1;
      continue;
    }
    if (existing.readOnly) {
      result.conflicts.push({
        label,
        reason: 'block đang read-only — bản import mới hơn nhưng không được ghi đè',
        importedUpdatedAt,
        existingUpdatedAt: existing.updatedAt,
      });
      continue;
    }
    try {
      const content = body.replace(/\n$/, '');
      blocks.update(
        existing.id,
        {
          ...(content !== existing.content ? { content } : {}),
          ...(description !== '' && description !== existing.description ? { description } : {}),
          ...(charLimit !== undefined && charLimit !== existing.charLimit ? { charLimit } : {}),
        },
        actor,
      );
      for (const botId of attachedBots) {
        try {
          blocks.attach(botId, existing.id, actor);
        } catch {
          // Bỏ qua bot attach lỗi.
        }
      }
      result.updated += 1;
    } catch (err) {
      result.conflicts.push({ label, reason: (err as Error).message });
    }
  }
  return result;
}

// --- Long-term facts: export/import qua longterm-facts.md ---

interface ParsedFact {
  key: string;
  botId: string;
  confidence: number;
  tags: string[];
  updatedAt?: string;
  value: string;
}

/** Parse file longterm-facts.md thành danh sách fact (bỏ section hỏng). */
export function parseFactsFile(text: string): ParsedFact[] {
  const out: ParsedFact[] = [];
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section.split('\n');
    const key = (lines[0] ?? '').trim();
    if (key === '') continue;
    let botId = '';
    let confidence = 0.8;
    let tags: string[] = [];
    let updatedAt: string | undefined;
    let bodyStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const botMatch = line.match(/^-\s*botId:\s*(.*)$/);
      const confMatch = line.match(/^-\s*confidence:\s*([0-9.]+)$/);
      const tagsMatch = line.match(/^-\s*tags:\s*(.*)$/);
      const updatedMatch = line.match(/^-\s*updatedAt:\s*(.*)$/);
      if (botMatch) {
        const raw = (botMatch[1] ?? '').trim();
        botId = raw === 'shared' ? '' : raw;
      } else if (confMatch) {
        const parsed = Number(confMatch[1]);
        if (Number.isFinite(parsed)) confidence = Math.min(1, Math.max(0, parsed));
      } else if (tagsMatch) {
        tags = (tagsMatch[1] ?? '')
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
      } else if (updatedMatch) {
        updatedAt = (updatedMatch[1] ?? '').trim() || undefined;
      } else if (line.trim() === '') {
        bodyStart = i + 1;
        break;
      } else {
        bodyStart = i;
        break;
      }
    }
    const value = lines
      .slice(bodyStart)
      .join('\n')
      .replace(/\n+$/, '');
    if (value === '') continue;
    out.push({ key, botId, confidence, tags, ...(updatedAt ? { updatedAt } : {}), value });
  }
  return out;
}

/**
 * Import facts từ longterm-facts.md: merge theo (botId, key), bản mới
 * hơn (updatedAt) thắng; bản cũ hơn/bằng thì skip; key chưa có thì tạo.
 */
export function importFactsFromMemFs(
  longTerm: LongTermMemory,
  dir: string,
): MemFsFactsImportResult {
  const result: MemFsFactsImportResult = { imported: 0, updated: 0, skipped: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, MEMFS_FACTS_FILENAME), 'utf8');
  } catch {
    return result;
  }
  const facts = parseFactsFile(raw);
  for (const fact of facts) {
    const existing = longTerm
      .recall({ botId: fact.botId, limit: 200 })
      .find((e: LongTermMemoryEntry) => e.key === fact.key);
    if (!existing) {
      longTerm.remember({
        key: fact.key,
        value: fact.value,
        tags: fact.tags,
        confidence: fact.confidence,
        botId: fact.botId,
      });
      result.imported += 1;
      continue;
    }
    const importedTime = fact.updatedAt ? Date.parse(fact.updatedAt) : NaN;
    const existingTime = Date.parse(existing.updatedAt);
    if (!Number.isFinite(importedTime) || importedTime <= existingTime) {
      result.skipped += 1;
      continue;
    }
    longTerm.remember({
      key: fact.key,
      value: fact.value,
      tags: fact.tags,
      confidence: fact.confidence,
      botId: fact.botId,
    });
    result.updated += 1;
  }
  return result;
}
