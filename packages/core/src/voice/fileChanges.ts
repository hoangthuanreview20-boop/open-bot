/**
 * File-change history for `peek_changes` (v0.59).
 *
 * The agent loop already records EVERY tool call the agent runs into the
 * file-backed history `<workspace>/.open-bot/tool-calls.jsonl` (P1-7,
 * `ToolCallHistoryStore` in @open-bot/tools — the loop's
 * `toolCallRecorder`). `peek_changes` used to return an empty list
 * because main never read that log. This module derives the real
 * per-bot file changes from those records — no second store, no
 * watcher, no parallel log.
 *
 * Pure functions only: the caller (desktop main) reads the records
 * with the store and passes them in. Core must not import
 * @open-bot/tools, so records arrive as a structural shape mirroring
 * the loop's `ToolCallRecorder` record.
 */
import { FILE_WRITE_TOOLS } from '../agent/rules';

/** Kind of file change, from the tool that made it. */
export type FileChangeKind = 'write' | 'edit' | 'delete';

/** One real file change made by a bot's tool call. */
export interface FileChangeEntry {
  /** Workspace-relative path, as passed to the tool. */
  file: string;
  kind: FileChangeKind;
  /** ms epoch when the tool call completed (started, when unknown). */
  at: number;
  /** Bot that ran the tool call. */
  botId: string;
  /** Tool that made the change (`write_file` / `apply_diff` / `delete_file`). */
  tool: string;
  /** Outcome of the tool call (`ok` when the history did not record one). */
  status: 'ok' | 'error' | 'denied';
}

/** One recorded tool call, as stored by the loop (structural shape). */
export interface FileChangeSourceRecord {
  tool_name: string;
  args_json: string;
  started_at_ms?: number;
  completed_at_ms?: number;
  status?: 'ok' | 'error' | 'denied';
}

/** Payload `peek_changes` returns to the voice-call model. */
export interface PeekChangesResult {
  workspaceDir: string | null;
  botId: string;
  changes: FileChangeEntry[];
  /** Human note when there is nothing to show (never a fake change). */
  note?: string;
}

/** Max changes returned for one `peek_changes` call. */
export const PEEK_CHANGES_LIMIT = 20;

const KIND_BY_TOOL: Record<string, FileChangeKind> = {
  write_file: 'write',
  apply_diff: 'edit',
  delete_file: 'delete',
};

/**
 * Extract file changes from recorded tool calls. Only tools in
 * `FILE_WRITE_TOOLS` with a string `path`/`filePath` arg count; bad
 * args JSON, missing paths and non-file tools are skipped (never
 * thrown — a corrupt history line must not break a voice call).
 * Newest first.
 */
export function extractFileChanges(
  records: readonly FileChangeSourceRecord[],
  opts: { botId: string; file?: string; limit?: number } = { botId: '' },
): FileChangeEntry[] {
  const limit =
    typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : PEEK_CHANGES_LIMIT;
  const wantedFile = typeof opts.file === 'string' && opts.file.trim() !== '' ? opts.file.trim() : null;
  // Không dựa vào thứ tự đầu vào (listRecent trả mới-trước, file
  // JSONL đọc xuôi trả cũ-trước): sắp xếp theo thời gian hoàn thành.
  const byTime = [...records].sort((a, b) => atOf(b) - atOf(a));
  const out: FileChangeEntry[] = [];
  for (const record of byTime) {
    if (out.length >= limit) break;
    if (!record || typeof record.tool_name !== 'string') continue;
    if (!FILE_WRITE_TOOLS.includes(record.tool_name)) continue;
    const kind = KIND_BY_TOOL[record.tool_name];
    if (!kind) continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(record.args_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof args !== 'object' || args === null) continue;
    const rawPath = args['path'] ?? args['filePath'];
    if (typeof rawPath !== 'string' || rawPath.trim() === '') continue;
    const file = rawPath.replace(/\\/g, '/');
    if (wantedFile !== null && file !== wantedFile && !file.endsWith(`/${wantedFile}`)) continue;
    out.push({
      file,
      kind,
      at: atOf(record),
      botId: opts.botId,
      tool: record.tool_name,
      status: record.status ?? 'ok',
    });
  }
  return out;
}

/** Thời gian hoàn thành của một record (lùi về lúc bắt đầu, rồi 0). */
function atOf(record: FileChangeSourceRecord): number {
  if (typeof record.completed_at_ms === 'number') return record.completed_at_ms;
  if (typeof record.started_at_ms === 'number') return record.started_at_ms;
  return 0;
}

/**
 * Build the exact payload `peek_changes` returns: real changes from
 * the bot's tool-call history, or an honest empty list with a note
 * when the bot has not changed any file yet.
 */
export function buildPeekChangesResult(input: {
  botId: string;
  workspaceDir: string | null;
  records: readonly FileChangeSourceRecord[];
  file?: string;
}): PeekChangesResult {
  const changes = extractFileChanges(input.records, {
    botId: input.botId,
    ...(input.file !== undefined ? { file: input.file } : {}),
  });
  return {
    workspaceDir: input.workspaceDir,
    botId: input.botId,
    changes,
    ...(changes.length === 0
      ? {
          note:
            'Bot chưa đổi file nào được ghi lại trong lịch sử tool-call của workspace này; xem trace/checkpoint để biết thay đổi gần đây.',
        }
      : {}),
  };
}
