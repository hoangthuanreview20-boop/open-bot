/**
 * Context pruning + extractive summaries (v1.02 rescue port of the
 * v0.99 work).
 *
 * When the budget does not fit, the loop prunes history instead of
 * failing: `pruneLowRelevanceTurns` drops the least useful turns
 * (old, long, and unrelated to the latest user message) while always
 * keeping the system prompt, the most recent turns, and any turn that
 * carries tool results the model still needs. Pruning is
 * deterministic (keyword overlap + recency), never model-based, so
 * the result is reproducible.
 *
 * `buildExtractiveSummary` compresses dropped turns into a short
 * extractive summary (first lines + lines matching the current
 * topic) that can be kept as a single system note.
 */

import { estimateMessageTokens } from './estimator';

export interface PrunableMessage {
  role: string;
  content?: string;
  toolCalls?: unknown[];
  /** True when the message holds tool results the run still needs. */
  pinned?: boolean;
}

export interface PruneResult {
  kept: PrunableMessage[];
  dropped: PrunableMessage[];
  freedTokens: number;
  summary: string;
}

/** Stop words ignored when scoring keyword overlap (English + Vietnamese). */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'what', 'how', 'why', 'when',
  'là', 'của', 'và', 'có', 'không', 'cho', 'với', 'trong', 'này', 'đó', 'làm', 'để', 'tôi', 'bạn',
]);

function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return new Set(words);
}

/** Relevance of a turn to the latest user message (0..1). */
export function relevanceScore(message: PrunableMessage, latestUserText: string): number {
  if (typeof message.content !== 'string' || message.content === '') return 0;
  const messageWords = keywords(message.content);
  const queryWords = keywords(latestUserText);
  if (queryWords.size === 0 || messageWords.size === 0) return 0;
  let overlap = 0;
  for (const word of queryWords) if (messageWords.has(word)) overlap++;
  return overlap / queryWords.size;
}

/**
 * Drop low-relevance turns until at least `tokensToFree` are freed.
 * Never drops pinned messages, the first message, or the last
 * `keepRecent` messages. Returns kept/dropped lists in original order.
 */
export function pruneLowRelevanceTurns(
  messages: PrunableMessage[],
  tokensToFree: number,
  options: { keepRecent?: number; latestUserText?: string } = {},
): PruneResult {
  const keepRecent = options.keepRecent ?? 4;
  const latestUserText = options.latestUserText ?? '';
  if (messages.length === 0 || tokensToFree <= 0) {
    return { kept: [...messages], dropped: [], freedTokens: 0, summary: '' };
  }
  const scored = messages.map((message, index) => {
    // Recency bonus: newer turns are worth more (0..0.5).
    const recency = messages.length > 1 ? (index / (messages.length - 1)) * 0.5 : 0.5;
    const relevance = relevanceScore(message, latestUserText);
    return { message, index, score: recency + relevance, tokens: estimateMessageTokens(message) };
  });
  const droppable = scored.filter(
    ({ message, index }) =>
      !message.pinned && index > 0 && index < messages.length - keepRecent,
  );
  droppable.sort((a, b) => a.score - b.score || b.tokens - a.tokens);
  const dropIndexes = new Set<number>();
  let freed = 0;
  for (const candidate of droppable) {
    if (freed >= tokensToFree) break;
    dropIndexes.add(candidate.index);
    freed += candidate.tokens;
  }
  const kept = messages.filter((_, index) => !dropIndexes.has(index));
  const dropped = messages.filter((_, index) => dropIndexes.has(index));
  return { kept, dropped, freedTokens: freed, summary: buildExtractiveSummary(dropped, latestUserText) };
}

/**
 * Extractive summary of dropped turns: the first line of each turn
 * plus lines matching the current topic, capped at `maxChars`.
 */
export function buildExtractiveSummary(messages: PrunableMessage[], topic = '', maxChars = 2000): string {
  if (messages.length === 0) return '';
  const topicWords = keywords(topic);
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    const contentLines = message.content.split('\n').map((line) => line.trim()).filter(Boolean);
    if (contentLines.length === 0) continue;
    const first = contentLines[0];
    if (first) lines.push(`- ${first}`);
    for (const line of contentLines.slice(1)) {
      const words = keywords(line);
      let overlap = 0;
      for (const word of topicWords) if (words.has(word)) overlap++;
      if (overlap > 0) lines.push(`  - ${line}`);
    }
  }
  let summary = lines.join('\n');
  if (summary.length > maxChars) summary = `${summary.slice(0, maxChars)}\n[... truncated]`;
  return summary;
}
