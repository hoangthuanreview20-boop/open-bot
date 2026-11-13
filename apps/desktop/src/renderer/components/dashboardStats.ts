/**
 * Dashboard aggregates (v0.96, Team T6).
 *
 * The dashboard reads ONLY what the app already has locally — the
 * harness thread log (NDJSON, sanitised upstream), the usage store
 * (`usage:get`), memory status, Composio state, and the automation
 * list. No network call, no new IPC: the view fetches those sources
 * through the existing preload methods and this module turns them
 * into the numbers the cards show.
 *
 * "Today" is the user's local calendar day. Token estimates come
 * from the usage store (provider-reported tokens), never from
 * re-reading message text. Router decisions are harness entries
 * whose payload marks a routing choice (`payload.router === true`
 * or a `lifecycle` entry with `payload.decision === 'route'`) —
 * the count is honest about what the log actually recorded.
 */

export interface DashboardLogEntry {
  at: string;
  botId: string;
  kind: string;
  payload?: Record<string, unknown>;
}

export interface DashboardUsage {
  today?: { inputTokens?: number; outputTokens?: number; costUsd?: number | null };
}

export interface DashboardInputs {
  /** Harness thread-log entries (all bots, already fetched). */
  entries: readonly DashboardLogEntry[];
  /** Bots the dashboard covers. */
  botIds: readonly string[];
  /** Usage per bot id (from `usage:get`). */
  usageByBot?: Record<string, DashboardUsage | undefined>;
  /** Long-term memory blocks per bot id (from `memory:status`). */
  memoryBlocksByBot?: Record<string, number | undefined>;
  /** Composio apps (from `composio:get-state`): enabled = connected. */
  composioApps?: ReadonlyArray<{ enabled: boolean }>;
  /** Total automations (from `automations:list`). */
  automationsTotal?: number;
  /** "Now" for the today window (tests inject a fixed clock). */
  now?: Date;
}

export interface DashboardStats {
  botsTotal: number;
  runsToday: number;
  toolCallsToday: number;
  errorsToday: number;
  approvalsToday: number;
  tokensToday: number;
  costUsdToday: number | null;
  memoryBlocks: number;
  routerDecisions: number;
  routerDecisionsToday: number;
  composioConnected: number;
  automationsTotal: number;
  /** Tool name → calls today (top 5 by the view). */
  topToolsToday: Array<{ tool: string; calls: number }>;
  /** Runs today per bot, bots with zero runs included. */
  runsTodayByBot: Array<{ botId: string; runs: number; toolCalls: number; errors: number }>;
}

function startOfDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

function isToday(at: string, dayStart: number): boolean {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms >= dayStart;
}

function toolNameOf(entry: DashboardLogEntry): string | null {
  const payload = entry.payload ?? {};
  const name = payload['tool'];
  return typeof name === 'string' && name ? name : null;
}

function isRouterDecision(entry: DashboardLogEntry): boolean {
  const payload = entry.payload ?? {};
  if (payload['router'] === true) return true;
  return entry.kind === 'lifecycle' && payload['decision'] === 'route';
}

/**
 * A "run" is one assistant turn: count `text` entries that start a
 * new turn is unreliable in a merged log, so a run is counted per
 * (bot, thread-day-bucket) of first activity — practically: the
 * number of distinct calendar days is not it either. The honest
 * approximation the log supports: a run starts at a `lifecycle`
 * entry with `payload.phase === 'run-start'`, falling back to
 * counting `text` entries that follow an `abort`/`result` boundary.
 * In practice the harness writes `run-start` lifecycle entries, so
 * the fallback rarely matters; when neither exists the count is 0
 * rather than a made-up number.
 */
function countRunsToday(entries: readonly DashboardLogEntry[], dayStart: number): number {
  let runs = 0;
  let sawLifecycle = false;
  for (const entry of entries) {
    if (!isToday(entry.at, dayStart)) continue;
    if (entry.kind === 'lifecycle' && entry.payload?.['phase'] === 'run-start') {
      sawLifecycle = true;
      runs++;
    }
  }
  if (sawLifecycle) return runs;
  // Fallback: a `text` entry after a terminal entry starts a turn.
  let inTurn = false;
  for (const entry of entries) {
    if (!isToday(entry.at, dayStart)) continue;
    if (entry.kind === 'text' && !inTurn) {
      runs++;
      inTurn = true;
    } else if (entry.kind === 'result' || entry.kind === 'abort' || entry.kind === 'error') {
      inTurn = false;
    }
  }
  return runs;
}

export function aggregateDashboard(input: DashboardInputs): DashboardStats {
  const now = input.now ?? new Date();
  const dayStart = startOfDay(now);
  const entries = input.entries;
  const botIds = [...input.botIds];

  const today = entries.filter((e) => isToday(e.at, dayStart));
  const toolCallsToday = today.filter((e) => e.kind === 'tool_call').length;
  const errorsToday = today.filter((e) => e.kind === 'error').length;
  const approvalsToday = today.filter(
    (e) => e.kind === 'approval_request' || e.kind === 'permission_request',
  ).length;
  const routerDecisions = entries.filter(isRouterDecision).length;
  const routerDecisionsToday = today.filter(isRouterDecision).length;

  const toolCounts = new Map<string, number>();
  for (const entry of today) {
    if (entry.kind !== 'tool_call') continue;
    const name = toolNameOf(entry) ?? 'unknown';
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }
  const topToolsToday = [...toolCounts.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
    .slice(0, 5);

  let tokensToday = 0;
  let costUsdToday: number | null = 0;
  for (const botId of botIds) {
    const usage = input.usageByBot?.[botId];
    const t = usage?.today;
    if (!t) continue;
    tokensToday += (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
    if (typeof t.costUsd === 'number') {
      costUsdToday = (costUsdToday ?? 0) + t.costUsd;
    } else {
      costUsdToday = null;
    }
  }

  let memoryBlocks = 0;
  for (const botId of botIds) {
    memoryBlocks += input.memoryBlocksByBot?.[botId] ?? 0;
  }

  const runsTodayByBot = botIds.map((botId) => {
    const mine = today.filter((e) => e.botId === botId);
    return {
      botId,
      runs: countRunsToday(mine, dayStart),
      toolCalls: mine.filter((e) => e.kind === 'tool_call').length,
      errors: mine.filter((e) => e.kind === 'error').length,
    };
  });
  const runsToday = runsTodayByBot.reduce((sum, b) => sum + b.runs, 0);

  return {
    botsTotal: botIds.length,
    runsToday,
    toolCallsToday,
    errorsToday,
    approvalsToday,
    tokensToday,
    costUsdToday,
    memoryBlocks,
    routerDecisions,
    routerDecisionsToday,
    composioConnected: (input.composioApps ?? []).filter((a) => a.enabled).length,
    automationsTotal: input.automationsTotal ?? 0,
    topToolsToday,
    runsTodayByBot,
  };
}
