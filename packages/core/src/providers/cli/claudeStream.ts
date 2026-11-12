/**
 * Parse stream-JSON của Claude Code (M1).
 *
 * Claude Code chạy với `--output-format stream-json --input-format
 * stream-json --verbose` (theo OpenMausBot `server/drivers/claude.ts`):
 * prompt đi qua stdin dạng NDJSON, CLI trả NDJSON — mỗi dòng là một
 * event. Module này dịch event đó về event chuẩn của open-bot
 * (`CliEvent`, xem types.ts).
 *
 * Shape event (theo docs Anthropic + code OpenMausBot — CHƯA kiểm chứng
 * trên CLI thật có đăng nhập, xem providers/cli/README.md):
 * - `{"type":"system","subtype":"init","session_id":"…","model":"…"}` — mở đầu.
 * - `{"type":"assistant","message":{"content":[
 *     {"type":"text","text":"…"},
 *     {"type":"tool_use","id":"…","name":"…","input":{…}}]}}`
 * - `{"type":"user","message":{"content":[{"type":"tool_result",…}]}}`
 *   — echo của tool result (M1 không gửi tool result nên thường không gặp).
 * - `{"type":"result","subtype":"success","result":"…","usage":{
 *     "input_tokens":n,"output_tokens":n},"session_id":"…"}` — cuối turn.
 *   `subtype:"error"` kèm `errors`/`is_error` = turn lỗi.
 * - `{"type":"stream_event",…}` — chỉ khi có `--include-partial-messages`
 *   (M1 không dùng cờ này nên bỏ qua).
 *
 * Parser phòng thủ: dòng không phải JSON thì bỏ qua và đếm (không crash
 * cả turn vì một dòng lạ); event lạ thì bỏ qua; field thiếu thì dùng
 * giá trị rỗng thay vì throw.
 */

import type { ToolCall } from '../../types';
import type { CliEvent } from './types';

export interface ClaudeStreamParseStats {
  /** Số dòng đã parse thành event. */
  events: number;
  /** Số dòng bỏ qua vì không phải JSON / không phải object. */
  malformedLines: number;
  /** Số event có type lạ (đã bỏ qua). */
  unknownEvents: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Dịch MỘT envelope stream-json đã parse thành 0..n CliEvent.
 * Trả thêm sessionId khi event mang nó (system init / result).
 */
export function mapClaudeEvent(raw: unknown): { events: CliEvent[]; sessionId?: string } {
  if (!isRecord(raw)) return { events: [] };
  const type = raw['type'];
  if (typeof type !== 'string') return { events: [] };

  if (type === 'system') {
    const sessionId = typeof raw['session_id'] === 'string' ? raw['session_id'] : undefined;
    return { events: [], sessionId };
  }

  if (type === 'assistant') {
    const message = raw['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) return { events: [] };
    const events: CliEvent[] = [];
    for (const block of message['content'] as unknown[]) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        if (block['text'].length > 0) events.push({ type: 'text', delta: block['text'] });
      } else if (block['type'] === 'tool_use') {
        const name = typeof block['name'] === 'string' ? block['name'] : '';
        const id = typeof block['id'] === 'string' ? block['id'] : '';
        if (name) {
          const input = isRecord(block['input']) ? (block['input'] as Record<string, unknown>) : {};
          const call: ToolCall = { id: id || `claude-${name}`, name, args: input };
          events.push({ type: 'tool_call', call });
        }
      }
      // Các block khác (thinking, image…) M1 bỏ qua.
    }
    return { events };
  }

  if (type === 'result') {
    const subtype = typeof raw['subtype'] === 'string' ? raw['subtype'] : 'success';
    const sessionId = typeof raw['session_id'] === 'string' ? raw['session_id'] : undefined;
    if (subtype === 'error' || raw['is_error'] === true) {
      const errors = raw['errors'];
      const detail = Array.isArray(errors)
        ? errors.map((e) => String(e)).join('; ')
        : typeof raw['result'] === 'string' && raw['result']
          ? raw['result']
          : 'Claude Code báo turn lỗi (không rõ chi tiết).';
      return { events: [{ type: 'error', message: detail.slice(0, 500) }], sessionId };
    }
    const text = typeof raw['result'] === 'string' ? raw['result'] : '';
    const usageRaw = raw['usage'];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    if (isRecord(usageRaw)) {
      const inputTokens = typeof usageRaw['input_tokens'] === 'number' ? usageRaw['input_tokens'] : 0;
      const outputTokens = typeof usageRaw['output_tokens'] === 'number' ? usageRaw['output_tokens'] : 0;
      usage = { inputTokens, outputTokens };
    }
    return { events: [{ type: 'result', text, usage, sessionId }], sessionId };
  }

  // 'user' (echo tool_result), 'stream_event', và type lạ: bỏ qua.
  return { events: [] };
}

/**
 * Parser NDJSON tăng dần: `feed()` nhận chunk stdout, `flush()` xử lý
 * dòng cuối còn dở. Mỗi dòng JSON parse được thì dịch thành CliEvent
 * qua `onEvent`; dòng hỏng thì đếm vào stats (không throw).
 */
export class NdjsonEventParser {
  private buffer = '';
  private readonly stats: ClaudeStreamParseStats = { events: 0, malformedLines: 0, unknownEvents: 0 };
  private sessionId?: string;

  constructor(private readonly onEvent: (event: CliEvent) => void) {}

  /** Session id đã thấy trong stream (system init / result), nếu có. */
  get lastSessionId(): string | undefined {
    return this.sessionId;
  }

  getStats(): ClaudeStreamParseStats {
    return { ...this.stats };
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Xử lý phần còn lại trong buffer (dòng cuối không có '\n'). */
  flush(): void {
    if (this.buffer.trim().length > 0) {
      this.handleLine(this.buffer);
    }
    this.buffer = '';
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      this.stats.malformedLines += 1;
      return;
    }
    if (!isRecord(parsed)) {
      this.stats.malformedLines += 1;
      return;
    }
    const { events, sessionId } = mapClaudeEvent(parsed);
    if (sessionId) this.sessionId = sessionId;
    if (events.length === 0 && typeof parsed['type'] === 'string') {
      const known = ['system', 'assistant', 'user', 'result', 'stream_event'];
      if (!known.includes(parsed['type'])) this.stats.unknownEvents += 1;
    }
    for (const event of events) {
      this.stats.events += 1;
      this.onEvent(event);
    }
  }
}

/** argv chuẩn để chạy Claude Code ở chế độ stream-JSON hai chiều. */
export const CLAUDE_STREAM_JSON_ARGS: readonly string[] = [
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
];

/** Một user message NDJSON gửi qua stdin của Claude Code. */
export function toClaudeInputLine(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}
