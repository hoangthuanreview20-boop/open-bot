/**
 * Tool-call history store (v0.53, P1-7 — REA deep-dive lần 2 §3.3:
 * Grok's `ConversationHistoryToolCall` carries `tool_call_id` +
 * `tool_name` + `args_json` so an old tool call can be REPLAYED).
 *
 * Original code, same idea: every tool call the agent loop runs is
 * appended (JSONL, one record per line) to
 * `<workspace>/.open-bot/tool-calls.jsonl`, with the same three
 * replay fields plus `started_at_ms` / `completed_at_ms` (Grok
 * `ToolCall` #59/#60) and a short result preview. `tool_call_replay`
 * (agentDataTools.ts) looks a call up by `tool_call_id` here and
 * re-executes it. The file is capped at MAX_TOOL_CALL_RECORDS
 * (oldest records dropped on rewrite) so it can never grow
 * unbounded; records hold args + a preview only — never secrets
 * (args that look like secrets are the loop's business; this store
 * never logs values itself, it only persists what the loop hands it,
 * and the file lives inside the workspace with the workspace's own
 * permissions).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Max records kept in the history file (oldest dropped first). */
export const MAX_TOOL_CALL_RECORDS = 1000;

/** File name (inside `<workspace>/.open-bot/`). */
export const TOOL_CALL_HISTORY_FILE = 'tool-calls.jsonl';

/** Outcome of a recorded tool call. */
export type ToolCallRecordStatus = 'ok' | 'error' | 'denied';

/**
 * One recorded tool call — the replay triple (`tool_call_id` /
 * `tool_name` / `args_json`) plus timing and a result preview.
 * `args_json` is the JSON string of the args object the tool ran with.
 */
export interface ToolCallRecord {
  tool_call_id: string;
  tool_name: string;
  args_json: string;
  started_at_ms?: number;
  completed_at_ms?: number;
  status?: ToolCallRecordStatus;
  /** First ~500 chars of the tool result (never a secret by itself). */
  result_preview?: string;
}

/** Structural shape a history store must satisfy (for injection). */
export interface ToolCallHistoryLike {
  record(record: ToolCallRecord): void;
  findById(toolCallId: string): ToolCallRecord | null;
  listRecent(limit?: number): ToolCallRecord[];
  count(): number;
}

function parseRecord(line: string): ToolCallRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r['tool_call_id'] !== 'string' || typeof r['tool_name'] !== 'string') return null;
  if (typeof r['args_json'] !== 'string') return null;
  return {
    tool_call_id: r['tool_call_id'] as string,
    tool_name: r['tool_name'] as string,
    args_json: r['args_json'] as string,
    ...(typeof r['started_at_ms'] === 'number' ? { started_at_ms: r['started_at_ms'] } : {}),
    ...(typeof r['completed_at_ms'] === 'number' ? { completed_at_ms: r['completed_at_ms'] } : {}),
    ...(r['status'] === 'ok' || r['status'] === 'error' || r['status'] === 'denied'
      ? { status: r['status'] as ToolCallRecordStatus }
      : {}),
    ...(typeof r['result_preview'] === 'string' ? { result_preview: r['result_preview'] } : {}),
  };
}

export class ToolCallHistoryStore implements ToolCallHistoryLike {
  private readonly filePath: string;

  /** @param workspaceDir workspace whose `.open-bot/` holds the file. */
  constructor(workspaceDir: string) {
    if (!workspaceDir) throw new Error('ToolCallHistoryStore needs a workspaceDir.');
    this.filePath = path.join(workspaceDir, '.open-bot', TOOL_CALL_HISTORY_FILE);
  }

  /** Path of the history file. */
  get path(): string {
    return this.filePath;
  }

  private readAll(): ToolCallRecord[] {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: ToolCallRecord[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = parseRecord(trimmed);
      if (record) out.push(record);
    }
    return out;
  }

  /** Append one record; compacts the file when it passes the cap. */
  record(record: ToolCallRecord): void {
    if (!record || typeof record.tool_call_id !== 'string' || record.tool_call_id === '') {
      throw new Error('ToolCallHistoryStore.record needs a tool_call_id.');
    }
    if (typeof record.tool_name !== 'string' || record.tool_name === '') {
      throw new Error('ToolCallHistoryStore.record needs a tool_name.');
    }
    if (typeof record.args_json !== 'string') {
      throw new Error('ToolCallHistoryStore.record needs args_json as a string.');
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const existing = this.readAll();
    if (existing.length + 1 > MAX_TOOL_CALL_RECORDS) {
      const kept = [...existing, record].slice(-MAX_TOOL_CALL_RECORDS);
      fs.writeFileSync(
        this.filePath,
        kept.map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8',
      );
      return;
    }
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** Newest record with this id, or null. Later records win on duplicates. */
  findById(toolCallId: string): ToolCallRecord | null {
    if (typeof toolCallId !== 'string' || toolCallId === '') return null;
    const all = this.readAll();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i]!.tool_call_id === toolCallId) return all[i]!;
    }
    return null;
  }

  /** Newest `limit` records, newest first. Default 20. */
  listRecent(limit = 20): ToolCallRecord[] {
    const all = this.readAll();
    return all.slice(-Math.max(1, limit)).reverse();
  }

  /** Number of records currently stored. */
  count(): number {
    return this.readAll().length;
  }
}
