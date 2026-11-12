/**
 * Sidebar bot list (UI-9 + UI-11) — pure helpers, no React, no IPC.
 *
 * - `filterBots`: search by name / provider (model included in the
 *   haystack — searching "gemini" finds bots running gemini even when
 *   their provider id is an engine alias). Diacritic-insensitive, so
 *   "quan ly" matches "Quản lý" (same normalisation as the Settings
 *   search in components/settings/settingsTabs.ts).
 * - `countPendingByBot`: how many decision cards (tool approval, CLI
 *   permission, interrupt) are waiting per bot — the sidebar badge
 *   number (UI-9).
 */
import type {
  ApprovalRequest,
  BotConfigLike,
  HarnessPermissionRequestView,
  InterruptRequestView,
} from '../types';

/** Lowercase + strip diacritics so "bao mat" matches "bảo mật". */
export function normalizeBotQuery(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd');
}

/**
 * Bots whose name / provider / model contains every whitespace token
 * of the query. An empty query returns the list unchanged.
 */
export function filterBots(bots: BotConfigLike[], query: string): BotConfigLike[] {
  const tokens = normalizeBotQuery(query).split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return bots;
  return bots.filter((bot) => {
    const haystack = normalizeBotQuery(`${bot.name} ${bot.providerId} ${bot.model ?? ''}`);
    return tokens.every((token) => haystack.includes(token));
  });
}

/** Pending decision cards per bot id (bots with none are absent). */
export function countPendingByBot(
  approvals: ApprovalRequest[],
  permissions: HarnessPermissionRequestView[],
  interrupts: InterruptRequestView[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (botId: string) => {
    counts[botId] = (counts[botId] ?? 0) + 1;
  };
  for (const a of approvals) add(a.botId);
  for (const p of permissions) add(p.botId);
  for (const r of interrupts) add(r.botId);
  return counts;
}
