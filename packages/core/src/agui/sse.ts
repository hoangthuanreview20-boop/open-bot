/**
 * AG-UI SSE transport (v0.97, Team T3).
 *
 * Formats AG-UI events as Server-Sent Events for external frontends
 * (a dashboard, another web client on the same machine) and parses
 * the same format back for tests. The wire format follows the SSE
 * spec: `id: <sequence>` + `data: <JSON>` + blank line, with
 * `: heartbeat` comments between events.
 *
 * Transport rules (loopback only — the API server binds 127.0.0.1
 * and requires the Local API Bearer token, exactly like the existing
 * harness SSE endpoint; this module only formats bytes, it does no
 * auth and opens no socket itself):
 * - `id` is `<runId>:<sequence>` so a client can resume with
 *   `Last-Event-ID` and the server can tell which run the id belongs
 *   to. A bare numeric id is also accepted on parse (treated as a
 *   sequence for the requested run).
 * - `event:` is the AG-UI type, so an `EventSource` client can listen
 *   per type (`addEventListener('TOOL_CALL_START', ...)`).
 * - A client that sends `Last-Event-ID` gets a replay of the bus
 *   buffer from that sequence onward, then live events. Events at or
 *   below the last seen sequence are never re-sent.
 * - Heartbeats keep a long-lived stream alive through proxies and
 *   let a client detect a dead connection.
 * - A run-finished event (RUN_FINISHED / RUN_ERROR) is the natural
 *   end of a per-run stream: `isTerminalEvent` tells the server
 *   layer when it may close a stream that was opened for a single
 *   run (a stream opened without a run filter stays open).
 */

import type { AgUiEvent } from './types';
import { validateAgUiEvent } from './validate';

/** Default heartbeat interval for an AG-UI SSE stream (ms). */
export const AG_UI_SSE_HEARTBEAT_MS = 15_000;
/** Maximum events replayed to one connecting client. */
export const AG_UI_SSE_MAX_REPLAY = 1000;

/** One parsed SSE frame (what a client receives). */
export interface AgUiSseFrame {
  /** Raw `id:` line, e.g. `run-1:12`. Absent for heartbeats. */
  id?: string;
  /** Raw `event:` line — the AG-UI type. Absent for heartbeats. */
  event?: string;
  /** Parsed event, when the frame carries one. */
  data?: AgUiEvent;
  /** True for a `: heartbeat` comment frame. */
  heartbeat?: boolean;
  /** True for any other `:` comment frame (e.g. the stream-open line). */
  comment?: boolean;
  /** Raw data text, when the frame is not a heartbeat and not JSON. */
  rawData?: string;
}

/** Format one AG-UI event as an SSE frame (`id` + `event` + `data`). */
export function formatAgUiSseEvent(event: AgUiEvent): string {
  const id = event.sequence !== undefined ? `${event.runId}:${event.sequence}` : event.runId;
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Format a heartbeat comment frame. */
export function formatAgUiSseHeartbeat(): string {
  return ': heartbeat\n\n';
}

/** Format the opening frame of a stream (a comment with the protocol). */
export function formatAgUiSseOpen(runId?: string): string {
  return `: agui/1.0${runId !== undefined ? ` run=${runId}` : ''}\n\n`;
}

/**
 * Parse `Last-Event-ID` into `{ runId, sequence }`. Accepts
 * `runId:sequence`, a bare `sequence` (runId left undefined — the
 * caller fills in the requested run), and a bare run id. Returns
 * `null` for an empty or malformed value.
 */
export function parseAgUiLastEventId(
  value: string | undefined,
): { runId?: string; sequence?: number } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const colon = trimmed.lastIndexOf(':');
  if (colon > 0) {
    const runId = trimmed.slice(0, colon);
    const sequence = Number(trimmed.slice(colon + 1));
    if (runId.length === 0 || !Number.isInteger(sequence) || sequence < 0) return null;
    return { runId, sequence };
  }
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 0) return { sequence: asNumber };
  return { runId: trimmed };
}

/**
 * Parse one SSE text chunk into frames. A chunk may hold several
 * frames; a partial frame at the end is returned as `pending` so the
 * caller can prepend it to the next chunk. Heartbeat comments become
 * `{ heartbeat: true }` frames. A frame whose data is not valid
 * AG-UI JSON is returned with `rawData` set and no `data`, never
 * thrown — a stream must survive one bad frame.
 */
export function parseAgUiSseChunk(
  chunk: string,
  pending = '',
): { frames: AgUiSseFrame[]; pending: string } {
  const text = pending + chunk;
  const frames: AgUiSseFrame[] = [];
  let rest = text;
  while (true) {
    const sep = rest.indexOf('\n\n');
    if (sep < 0) break;
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    if (block.trim().length === 0) continue;
    if (block.startsWith(':')) {
      const trimmed = block.trim();
      frames.push(
        trimmed === ': heartbeat' ? { heartbeat: true } : { comment: true },
      );
      continue;
    }
    const frame: AgUiSseFrame = {};
    let dataText = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) frame.id = line.slice(3).trim();
      else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataText += line.slice(5).replace(/^ /, '');
      else if (line.startsWith(':')) {
        // Comment inside a frame — ignored.
      }
    }
    if (dataText.length > 0) {
      try {
        frame.data = validateAgUiEvent(JSON.parse(dataText));
      } catch {
        frame.rawData = dataText;
      }
    }
    frames.push(frame);
  }
  return { frames, pending: rest };
}

/** True when the event ends a run (a per-run stream may close after it). */
export function isTerminalAgUiEvent(event: AgUiEvent): boolean {
  return event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
}

/**
 * Pick the replay starting sequence for a connecting client: the
 * sequence after its Last-Event-ID, or 0 when it has none. When the
 * id belongs to a different run than the one requested, the caller
 * should replay from 0 for the requested run instead (a stale id
 * from another run must not hide this run's history).
 */
export function replayFromForLastEventId(
  lastEventId: string | undefined,
  requestedRunId: string | undefined,
): number {
  const parsed = parseAgUiLastEventId(lastEventId);
  if (!parsed || parsed.sequence === undefined) return 0;
  if (parsed.runId !== undefined && requestedRunId !== undefined && parsed.runId !== requestedRunId) {
    return 0;
  }
  return parsed.sequence + 1;
}

/**
 * Serialise a list of events into one SSE body (replay burst). Used
 * by the API server when a client connects with Last-Event-ID and by
 * tests that assert on the exact bytes a client receives.
 */
export function formatAgUiSseReplay(events: AgUiEvent[]): string {
  return events.slice(0, AG_UI_SSE_MAX_REPLAY).map((event) => formatAgUiSseEvent(event)).join('');
}
