/**
 * v0.93b — pure merge helpers for EventLogView (no React, no I/O).
 *
 * The view mixes two sources for the same log, and both can return the
 * same event:
 *
 *   - paged reads of the NDJSON thread log (`harness:thread-log`,
 *     oldest-first, 100 rows per page), and
 *   - the live tail (`harness:event`), which appends events that are
 *     ALSO written to that same NDJSON file — so a later "load more"
 *     page, a refresh, or a resync re-fetches events the live tail
 *     already showed.
 *
 * Without dedupe the list shows the same event twice, and without
 * sorting a "load more" click after a live event appends OLDER rows
 * after the NEWER live row (the list stops being chronological).
 *
 * Identity of an entry is `at + kind + JSON(payload)`: the live
 * envelope and the NDJSON row carry the same sanitised payload (the
 * `engine` field is live-only and deliberately NOT part of the key,
 * so a live row and its on-disk twin still match). Two genuinely
 * identical events in the same millisecond collapse into one row —
 * accepted: in practice that is a re-delivery, not two turns.
 */
import type { HarnessThreadLogEntryView } from '../types';

/** Stable identity of one log entry (see header). */
export function eventLogEntryKey(entry: HarnessThreadLogEntryView): string {
  return `${entry.at}|${entry.kind}|${JSON.stringify(entry.payload)}`;
}

/**
 * Merge freshly paged (or resynced) entries into the displayed list:
 * entries already shown are dropped, the rest are appended, and the
 * result is kept in chronological order (stable sort by `at` — rows
 * that share a timestamp keep their first-seen order). Never drops
 * entries: paging is an explicit user action, so the live cap does
 * NOT apply here.
 */
export function mergeEventLogEntries(
  prev: HarnessThreadLogEntryView[],
  incoming: HarnessThreadLogEntryView[],
): HarnessThreadLogEntryView[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map(eventLogEntryKey));
  const fresh: HarnessThreadLogEntryView[] = [];
  for (const entry of incoming) {
    const key = eventLogEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(entry);
  }
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Append live-tail entries (new events, or resync catch-up) with the
 * bounded-list cap: after the merge the OLDEST rows drop off so a
 * long run cannot grow the list without bound. Dropped rows stay on
 * disk (NDJSON) and come back through paging, so nothing is lost.
 */
export function appendLiveEventLogEntries(
  prev: HarnessThreadLogEntryView[],
  incoming: HarnessThreadLogEntryView[],
  cap: number,
): HarnessThreadLogEntryView[] {
  const merged = mergeEventLogEntries(prev, incoming);
  if (merged.length <= cap) return merged;
  return merged.slice(merged.length - cap);
}
