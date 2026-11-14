import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import ChatView, { type ChatMessageWithVision, type ChatStatus, type ToolEvent } from './components/ChatView';
import type { VisionAttachment } from './components/composer';
import TaskPanel from './components/TaskPanel';
import TasksToggleButton from './components/TasksToggleButton';
import ApprovalTray from './components/ApprovalTray';
import { countPendingByBot } from './components/botList';
import { diffTurnUsage } from './components/turnUsage';
import GroupView from './components/GroupView';
import ChannelsView from './components/ChannelsView';
import AskUserCard from './components/AskUserCard';
import ElicitationModal, {
  type ElicitationRequestView,
  type ElicitationResultView,
} from './components/ElicitationModal';
import SettingsView from './components/SettingsView';
import ConnectedAppsView from './components/ConnectedAppsView';
import SkillsView from './components/SkillsView';
import MemoryView from './components/MemoryView';
import CanvasView from './components/CanvasView';
import AutomationsView from './components/AutomationsView';
import HarnessV2View from './components/HarnessV2View';
import TraceView from './components/TraceView';
import EventLogView from './components/EventLogView';
import RunReplayView from './components/RunReplayView';
import AgUiPanel from './components/agui/AgUiPanel';
import InternetDataView from './components/InternetDataView';
import PlanReviewView, { type PendingPlan } from './components/PlanReviewView';
import AgentMarketplaceView from './components/AgentMarketplaceView';
import McpMarketplaceView from './components/McpMarketplaceView';
import McpAppsView from './components/McpAppsView';
import McpTasksView from './components/McpTasksView';
import A2aClientView from './components/A2aClientView';
import TeamView from './components/TeamView';
import ComputersView from './components/ComputersView';
import FleetView from './components/FleetView';
// v1.02 (Team T6): fleet console v2 + bot/plugin marketplaces.
import FleetConsoleView from './components/FleetConsoleView';
import BotMarketplaceView from './components/BotMarketplaceView';
import PluginMarketplaceView from './components/PluginMarketplaceView';
// v1.03 (Team T6): event-stream viewer + eval harness.
import EventStreamView from './components/EventStreamView';
import EvalHarnessView from './components/EvalHarnessView';
import ToolsView from './components/ToolsView';
import BotForm from './components/BotForm';
import BudgetMeter from './components/BudgetMeter';
import ModelPicker from './components/ModelPicker';
import A2aPersistAlert from './components/A2aPersistAlert';
import AppErrorBanner from './components/AppErrorBanner';
import UpdateBanner from './components/UpdateBanner';
import CheckpointPanel from './components/CheckpointPanel';
import OnboardingView from './components/OnboardingView';
import CommandPalette from './components/CommandPalette';
import DashboardView from './components/DashboardView';
import PlanView from './components/PlanView';
import {
  conversationIdForCopy,
  parseBotMeta,
  setBotHidden,
  setBotUnread,
  stringifyBotMeta,
  togglePin,
  type BotMetaMap,
} from './components/botManager';
import {
  buildSampleBotConfig,
  markOnboardingDone,
  readOnboardingDone,
  shouldShowOnboarding,
} from './components/onboarding';
import type { A2aPersistStatusView, AgentTemplateLike, ApprovalRequest, AskUserRequest, BotConfigLike, BudgetAlertView, BudgetSnapshotView, ChatMessageView, DeepLinkRouteView, HarnessPermissionRequestView, InterruptDecisionView, InterruptRequestView, Notice, ProviderRailEntryView, ProviderRailView, SpendStatusData, TaskView, ThreadSearchHitView, ThreadView, UpdateStatusView } from './types';
import { setLocale } from './i18n';
import { applyThemeMode, readThemeMode } from './components/theme';
import { useT } from './i18n/useT';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** v0.60 (UI-10): localStorage may be unavailable — never crash on it. */
function safeLocalStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export default function App() {
  const t = useT();
  const [bots, setBots] = useState<BotConfigLike[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  // v0.59 (UI-5): threads of the selected bot — one bot has many
  // conversations. `threadSearchResults` is null when no search is
  // active (sidebar shows the full list); a non-null array replaces
  // the list while searching.
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadSearchResults, setThreadSearchResults] = useState<ThreadSearchHitView[] | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  // v1.01 (Team T3, risk budget): budget snapshot per bot (from the
  // coordinator's budget-alert event) + bots waiting for approval
  // (run-state event).
  const [budgetByBot, setBudgetByBot] = useState<Record<string, BudgetSnapshotView>>({});
  const [waitingBots, setWaitingBots] = useState<ReadonlySet<string>>(new Set());
  // v0.50 (M8): permission requests from a CLI engine via the harness broker.
  const [harnessPermissions, setHarnessPermissions] = useState<HarnessPermissionRequestView[]>([]);
  const [askUser, setAskUser] = useState<AskUserRequest | null>(null);
  // v0.13: MCP elicitation request awaiting the user's answer (form / URL).
  const [elicitation, setElicitation] = useState<ElicitationRequestView | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [view, setView] = useState<'chat' | 'dashboard' | 'planner' | 'settings' | 'marketplace' | 'bot-marketplace' | 'plugin-marketplace' | 'mcp' | 'mcp-apps' | 'mcp-tasks' | 'team' | 'computers' | 'fleet' | 'fleet-console' | 'skills' | 'memory' | 'automations' | 'agui' | 'harness2' | 'traces' | 'eventlog' | 'runlog' | 'event-stream' | 'eval-harness' | 'plans' | 'a2a' | 'group' | 'channels' | 'tools' | 'connected-apps' | 'canvas' | 'internet-data'>('chat');
  // v0.98 (Team T4 — planning v2): run plan attached to the NEXT chat
  // run (one-shot — `send` consumes it). The plan's owner bot must
  // match the bot being sent to, otherwise the run ignores it.
  const [activeRunPlan, setActiveRunPlan] = useState<{
    planId: string;
    botId: string | null;
    title: string;
  } | null>(null);
  const [formBot, setFormBot] = useState<BotConfigLike | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // v0.62 (UI-13): bot awaiting delete confirmation — the in-app modal
  // below replaces the old `window.confirm` (system dialog, off-brand,
  // no clear warning). Set by deleteBot, cleared by cancel/confirm/Esc.
  const [deleteBotTarget, setDeleteBotTarget] = useState<BotConfigLike | null>(null);
  const [loadError, setLoadError] = useState('');
  // M4: model picker (switch mid-chat) + provider rail for the chat
  // header source line. The rail is reloaded when the selected bot
  // changes and when main pushes a new engines snapshot.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [rail, setRail] = useState<ProviderRailView | null>(null);
  // v0.28: A2A task persist status — warning banner when saving fails
  // after all retries. `dismissed` only hides the banner for this
  // session (a later failed save pushes a new status and the banner
  // shows again).
  const [a2aPersistStatus, setA2aPersistStatus] = useState<A2aPersistStatusView | null>(null);
  const [a2aPersistDismissed, setA2aPersistDismissed] = useState(false);
  // v0.54 (P1-8): interrupt HITL — a run pauses at a safe boundary to ask the user.
  const [interrupts, setInterrupts] = useState<InterruptRequestView[]>([]);
  // v0.60 (UI-9): the approval tray (right dock, all bots) is open, and
  // the pending count at the last render — the tray auto-opens on the
  // 0 -> N transition (a run waits at most 10 minutes for an answer)
  // and never re-opens after the user closes it while cards are pending.
  const [approvalTrayOpen, setApprovalTrayOpen] = useState(false);
  const prevPendingTotalRef = useRef(0);
  // v0.79c (UI parity §7, responsive): collapsed sidebar (icon rail).
  // Narrow windows (< 760px) start collapsed so the chat keeps usable
  // width; the toggle in the sidebar flips it. No resize listener —
  // auto-flipping on resize would fight the user's explicit choice.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 760,
  );
  // v0.60 (UI-11): bots with a chat turn in flight (streaming events or
  // an open sendChat) — the sidebar running dot. A bot leaves the set
  // when its send() settles (or it is deleted); runs from automations /
  // group chat emit no renderer stream, so they never pollute it.
  const [runningBotIds, setRunningBotIds] = useState<ReadonlySet<string>>(new Set());
  const markBotRunning = useCallback((botId: string) => {
    setRunningBotIds((prev) => {
      if (prev.has(botId)) return prev;
      const next = new Set(prev);
      next.add(botId);
      return next;
    });
  }, []);
  const clearBotRunning = useCallback((botId: string) => {
    setRunningBotIds((prev) => {
      if (!prev.has(botId)) return prev;
      const next = new Set(prev);
      next.delete(botId);
      return next;
    });
  }, []);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  // v0.54 (P1-9): per-track update status (banner when a new version exists).
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusView | null>(null);
  // v0.11: plans awaiting review — captured from plan_create results in
  // toolEvents. Plans from earlier sessions are NOT kept here: they are
  // loaded from disk by PlanReviewView itself via the `plans:list` IPC
  // (UI-12, v0.60; main reads `<workspace>/.open-bot/plans/*.md`).
  const [pendingPlans, setPendingPlans] = useState<PendingPlan[]>([]);
  const seenPlanCallsRef = useRef<Set<string>>(new Set());
  // v0.60 (UI-10): first-run onboarding — shown instead of the chat while
  // there is no bot yet and the user never finished/dismissed it.
  // `botsLoaded` guards the first paint so existing users never see a
  // flash of onboarding while the bot list is still loading.
  const [botsLoaded, setBotsLoaded] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => {
    try {
      return readOnboardingDone(localStorage);
    } catch {
      return false;
    }
  });
  const [sampleCreating, setSampleCreating] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  // v0.62 (UI-13): command palette (Cmd/Ctrl+K) + text the palette asks
  // the composer to insert (a picked slash command). `nonce` dedupes:
  // ChatView applies each insert once, even across re-renders.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [composerInsert, setComposerInsert] = useState<{ text: string; nonce: number } | null>(null);
  // v0.96 (T6): per-bot UI state — pinned / unread / hidden (see
  // botManager.ts). Kept in localStorage, never in the bot config.
  const [botMeta, setBotMeta] = useState<BotMetaMap>(() => {
    try {
      return parseBotMeta(localStorage.getItem('open-bot:bot-meta'));
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('open-bot:bot-meta', stringifyBotMeta(botMeta));
    } catch {
      // Storage unavailable — the meta still works for this session.
    }
  }, [botMeta]);

  const selectedBotIdRef = useRef<string | null>(null);
  selectedBotIdRef.current = selectedBotId;

  // v0.86 (P2-6): deep-link — the botId in the route may arrive before
  // the bot list finishes loading; keep it here so loadBots applies it
  // once the list arrives. botsRef lets the onDeepLink handler
  // (registered once at mount) always see the latest list without
  // re-registering.
  const pendingDeepLinkBotIdRef = useRef<string | null>(null);
  const botsRef = useRef<BotConfigLike[]>([]);
  botsRef.current = bots;

  const selectedThreadIdRef = useRef<string | null>(null);
  selectedThreadIdRef.current = selectedThreadId;

  // v0.59 (UI-2): true once the in-flight run streamed at least one
  // delta. send() uses it to tell a stopped run with partial text
  // (needs an explicit stopped notice) from one with no text yet
  // (the assistant bubble already carries the stopped text from main).
  const streamedRef = useRef(false);

  // v0.59 (integration): sequence guard for history loads. A stale
  // loadHistory resolving after send() must not clobber the optimistic
  // messages — every load takes a new sequence number and only applies
  // its result while still the latest; send() bumps the sequence
  // before appending optimistic messages (UI-5 race, found by the
  // UI-1/2 smoke: a late loadHistory wiped a just-sent message).
  const historyLoadSeq = useRef(0);

  // v0.63 (pending-stop): a send in flight for this bot. The sequence
  // guard above only stops loads that STARTED before send() — the
  // bot-switch effect's loadHistory starts only after its loadThreads
  // resolves, and under load that can be after send() (createBot is
  // slow), so the load still applies rows that predate the assistant
  // message main has not saved yet and wipes the optimistic assistant
  // bubble. send()'s result then has nowhere to land and the stopped
  // text is silently dropped — the full-suite failure of the UI-2
  // smoke (run returned stopped:true, DB held the stopped text, UI showed
  // nothing). A load that fires while a send is in flight is skipped;
  // once the send settles its rows are fresh anyway (they include the
  // saved assistant message), so skipping loses nothing.
  const sendInFlightRef = useRef<{ botId: string } | null>(null);

  // v0.86 (P2-6): apply a deep-link `open-bot://` route (from IPC
  // `deep-link:open` while running, or `deep-link:pending` at mount).
  // Bot route: select immediately if the bot is loaded; otherwise keep
  // the botId so loadBots applies it once the list arrives (main already
  // checked the bot exists before delivering the route; this is extra
  // defense).
  const applyDeepLinkRoute = useCallback((route: DeepLinkRouteView | null) => {
    if (!route) return;
    if (route.kind === 'settings') {
      setView('settings');
    } else if (route.kind === 'canvas') {
      setView('canvas');
    } else if (route.kind === 'chat') {
      setView('chat');
    } else if (route.kind === 'bot') {
      setView('chat');
      if (botsRef.current.some((b) => b.id === route.botId)) {
        setSelectedBotId(route.botId);
      } else {
        pendingDeepLinkBotIdRef.current = route.botId;
      }
    }
  }, []);

  const loadBots = useCallback(async () => {
    try {
      const list = await window.openBot.listBots();
      setBots(list);
      // v0.86 (P2-6): a deep-link to a specific bot wins over the default
      // selection (saved bot / first bot) — only while that bot is still
      // in the list.
      const pendingBotId = pendingDeepLinkBotIdRef.current;
      if (pendingBotId && list.some((b) => b.id === pendingBotId)) {
        pendingDeepLinkBotIdRef.current = null;
        setSelectedBotId(pendingBotId);
        return list;
      }
      if (list.length > 0 && !selectedBotIdRef.current) {
        // v0.59 (integration): reopen the bot the user was on instead
        // of always picking list[0] after a reload; fall back to the
        // first bot when the saved one is gone.
        let saved: string | null = null;
        try {
          saved = localStorage.getItem('open-bot:selectedBotId');
        } catch {
          saved = null;
        }
        setSelectedBotId(
          saved && list.some((b) => b.id === saved) ? saved : list[0].id,
        );
      }
      return list;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('app.loadBotsError'));
      return [];
    }
  }, [t]);

  const loadHistory = useCallback(async (botId: string, threadId?: string) => {
    const seq = ++historyLoadSeq.current;
    try {
      const rows = await window.openBot.getHistory(botId, 50, threadId);
      if (historyLoadSeq.current !== seq) return;
      // v0.63 (pending-stop): never apply over an in-flight send —
      // the rows predate the assistant message main has not saved yet
      // (see sendInFlightRef). A later load sees the saved rows.
      if (sendInFlightRef.current?.botId === botId) return;
      setMessages(rows);
    } catch {
      if (historyLoadSeq.current !== seq) return;
      if (sendInFlightRef.current?.botId === botId) return;
      setMessages([]);
    }
  }, []);

  /**
   * v0.59 (UI-5): load the bot's threads (newest first). Always
   * returns at least the default thread — the first call creates it
   * and migrates the bot's old single-thread history into it. Keeps
   * the current selection when it still exists, otherwise selects the
   * newest thread. Returns the selected thread id (null on error).
   */
  const loadThreads = useCallback(async (botId: string, selectId?: string): Promise<string | null> => {
    try {
      const list = await window.openBot.listThreads(botId);
      setThreads(list);
      const wanted = selectId ?? selectedThreadIdRef.current;
      const chosen = (wanted && list.some((th) => th.id === wanted) ? wanted : list[0]?.id) ?? null;
      setSelectedThreadId(chosen);
      return chosen;
    } catch {
      setThreads([]);
      setSelectedThreadId(null);
      setLoadError(t('thread.loadError'));
      return null;
    }
  }, [t]);

  /** v0.59 (UI-5): resume a thread — load exactly its messages. */
  const selectThread = useCallback(async (threadId: string) => {
    const botId = selectedBotIdRef.current;
    if (!botId) return;
    setSelectedThreadId(threadId);
    setMessages([]);
    setToolEvents([]);
    setStatus('idle');
    void loadHistory(botId, threadId);
  }, [loadHistory]);

  /** v0.59 (UI-5): search the selected bot's threads (title/content). */
  const searchThreads = useCallback(async (query: string) => {
    const botId = selectedBotIdRef.current;
    if (!botId) return;
    if (!query.trim()) {
      setThreadSearchResults(null);
      return;
    }
    try {
      setThreadSearchResults(await window.openBot.searchThreads({ botId, query: query.trim() }));
    } catch {
      setThreadSearchResults([]);
      setLoadError(t('thread.searchError'));
    }
  }, [t]);

  const loadTasks = useCallback(async (botId: string) => {
    setTasksLoading(true);
    try {
      setTasks(await window.openBot.listTasks(botId));
    } catch {
      setTasks([]);
    } finally {
      setTasksLoading(false);
    }
  }, []);

  // Load the saved UI locale first so the app starts in the right language.
  useEffect(() => {
    window.openBot
      .getSettings()
      .then((s) => {
        if (s.locale) setLocale(s.locale);
      })
      .catch(() => {});
  }, []);

  // v0.62 (UI-13): apply the stored manual theme on mount (System =
  // no data-theme attribute, the CSS media query follows the OS and
  // flips by itself when the OS changes — no JS listener needed).
  useEffect(() => {
    try {
      applyThemeMode(readThemeMode(safeLocalStorage()), document.documentElement);
    } catch {
      // No document (tests) — the app still works in system theme.
    }
  }, []);

  // v0.62 (UI-13): global shortcuts — Cmd/Ctrl+K toggles the command
  // palette; Esc closes the topmost layer (palette, then the delete-bot
  // modal, then the bot form, then the model picker). Esc inside the
  // composer textarea belongs to ChatView (autocomplete popup), so this
  // handler ignores it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.chat-input textarea')) return;
      if (paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      if (deleteBotTarget) {
        setDeleteBotTarget(null);
        return;
      }
      if (formOpen) {
        setFormOpen(false);
        setFormBot(null);
        return;
      }
      if (modelPickerOpen) setModelPickerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, deleteBotTarget, formOpen, modelPickerOpen]);

  // Load bots on first render.
  useEffect(() => {
    // v0.60 (UI-10): the onboarding guard needs to know the list really
    // loaded (empty because there is no bot, not because it is still
    // loading) — set the flag whether the load succeeded or not.
    void loadBots().finally(() => setBotsLoaded(true));
  }, [loadBots]);

  // v0.11: plans awaiting review — each successful plan_create result
  // (status "pending") becomes an entry in PlanReviewView. Only adds;
  // never clears when toolEvents reset (on send / bot switch) — only
  // the user's decision removes a plan from the list.
  useEffect(() => {
    const fresh: PendingPlan[] = [];
    for (const ev of toolEvents) {
      if (!ev.done || !ev.result) continue;
      const callName = ev.call.name ?? ev.call.tool;
      if (callName !== 'plan_create') continue;
      if (seenPlanCallsRef.current.has(ev.id)) continue;
      const result = ev.result as { ok?: unknown; output?: unknown };
      if (result.ok !== true || typeof result.output !== 'string') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.output);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const p = parsed as Record<string, unknown>;
      if (p['status'] !== 'pending' || typeof p['projectId'] !== 'string') continue;
      seenPlanCallsRef.current.add(ev.id);
      const stringList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
      const taskTitles = Array.isArray(p['tasks'])
        ? (p['tasks'] as Array<Record<string, unknown>>)
            .map((t) => t['title'])
            .filter((s): s is string => typeof s === 'string')
        : [];
      const steps = stringList(p['steps']);
      fresh.push({
        projectId: p['projectId'],
        botId: selectedBotIdRef.current ?? '',
        title: typeof p['title'] === 'string' && p['title'] ? p['title'] : t('plan.button'),
        detail: typeof p['detail'] === 'string' ? p['detail'] : undefined,
        filePath: typeof p['filePath'] === 'string' ? p['filePath'] : null,
        steps: steps.length > 0 ? steps : taskTitles,
        decisions: stringList(p['decisions']),
        status: 'pending',
      });
    }
    if (fresh.length > 0) {
      setPendingPlans((prev) => {
        const byId = new Map(prev.map((plan) => [plan.projectId, plan]));
        for (const plan of fresh) byId.set(plan.projectId, plan);
        return [...byId.values()];
      });
    }
  }, [toolEvents]);

  // Switching bots -> load threads + the selected thread's history + tasks.
  // v0.60 (UI-9): approvals are NOT cleared here any more — the old
  // M8 loss shape (switch bot, a waiting card vanishes while its run
  // keeps waiting until timeout). The tray owns the cards for all bots;
  // only selected-bot-scoped state (ask-user, elicitation, notices)
  // is reset on switch.
  useEffect(() => {
    if (!selectedBotId) return;
    setMessages([]);
    setToolEvents([]);
    setAskUser(null);
    setElicitation(null);
    setNotices([]);
    setStatus('idle');
    setThreadSearchResults(null);
    void (async () => {
      const threadId = await loadThreads(selectedBotId);
      void loadHistory(selectedBotId, threadId ?? undefined);
    })();
    void loadTasks(selectedBotId);
  }, [selectedBotId, loadHistory, loadTasks, loadThreads]);

  // v0.59 (integration): remember the last-used bot across reloads.
  useEffect(() => {
    if (!selectedBotId) return;
    try {
      localStorage.setItem('open-bot:selectedBotId', selectedBotId);
    } catch {
      // Storage unavailable — the app still works, it just reopens
      // the first bot next time.
    }
  }, [selectedBotId]);

  // M4: provider rail for the chat header source line + model picker.
  const loadRail = useCallback(async () => {
    try {
      setRail(await window.openBot.listModelRail());
    } catch {
      setRail(null);
    }
  }, []);

  useEffect(() => {
    void loadRail();
    if (typeof window.openBot.onEnginesChanged !== 'function') return undefined;
    return window.openBot.onEnginesChanged(() => void loadRail());
  }, [loadRail, selectedBotId]);

  /** Source line for the selected bot's running model (label only, never a secret). */
  const railSourceLabel = (entry: ProviderRailEntryView | undefined): string | null => {
    if (!entry) return null;
    switch (entry.sourceKind) {
      case 'account':
        if (entry.accountLabel) return t('modelPicker.sourceAccount', { account: entry.accountLabel });
        if (entry.status === 'unknown') return t('modelPicker.sourceUnknown');
        return null;
      case 'api-key':
        return t('modelPicker.sourceApiKey');
      case 'local':
        return t('modelPicker.sourceLocal');
      case 'custom':
        return t('modelPicker.sourceCustom');
    }
  };

  // M4: switch the selected bot's model mid-chat (thread kept — see
  // coordinator.switchModel). A run in flight is not interrupted: the
  // switch applies from the next turn and the notice says so.
  const switchBotModel = async (providerId: string, model: string) => {
    const bot = bots.find((b) => b.id === selectedBotIdRef.current);
    if (!bot) return;
    try {
      const res = await window.openBot.switchModel({ botId: bot.id, providerId, model });
      setBots((prev) => prev.map((b) => (b.id === res.bot.id ? res.bot : b)));
      setModelPickerOpen(false);
      const label = rail?.entries.find((e) => e.providerId === providerId)?.label ?? providerId;
      setNotices((prev) => [
        ...prev.slice(-9),
        {
          id: uid(),
          kind: 'summary',
          text: res.pending
            ? t('modelPicker.switchPending', { label, model })
            : t('modelPicker.switchApplied', { label, model }),
        },
      ]);
      void loadRail();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('modelPicker.switchError'));
    }
  };

  // Subscribe to main-process streams (once).
  useEffect(() => {
    const offDelta = window.openBot.onChatDelta(({ botId, delta }) => {
      // v0.60 (UI-11): a streaming bot is running even when it is not
      // the selected one (user switched mid-run) — mark it, but only
      // append text to the open chat.
      markBotRunning(botId);
      // v0.96 (T6): a bot that streams while it is NOT selected has
      // unread activity — the sidebar dot until the user opens it.
      if (botId !== selectedBotIdRef.current) {
        setBotMeta((prev) => setBotUnread(prev, botId, true));
        return;
      }
      streamedRef.current = true;
      setStatus('thinking');
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
        }
        return [...prev, { id: uid(), role: 'assistant', text: delta, createdAt: Date.now() }];
      });
    });
    const offToolCall = window.openBot.onToolCall(({ botId, call }) => {
      // v0.60 (UI-11): same as onChatDelta — a tool call from any bot
      // marks that bot running; only the selected bot's cards render.
      markBotRunning(botId);
      if (botId !== selectedBotIdRef.current) return;
      setStatus('tool');
      setToolEvents((prev) => [...prev, { id: uid(), call, done: false }]);
    });
    const offToolResult = window.openBot.onToolResult(({ botId, result }) => {
      if (botId !== selectedBotIdRef.current) return;
      setStatus('thinking');
      setToolEvents((prev) => {
        // Match by call id (ToolResult.callId); fall back to the newest open event.
        let i = prev.findIndex((ev) => !ev.done && ev.call.id === result.callId);
        if (i === -1) {
          const rev = [...prev].reverse().findIndex((ev) => !ev.done);
          i = rev === -1 ? -1 : prev.length - 1 - rev;
        }
        if (i === -1) return prev;
        const next = [...prev];
        next[i] = { ...next[i], result, done: true };
        return next;
      });
    });
    const offApproval = window.openBot.onApprovalNeeded((req) => {
      // v0.50 (M8): keep cards from EVERY bot (no longer filtered to the
      // selected bot — a card from another bot used to be dropped silently
      // while its run kept waiting until timeout). Cards name their bot.
      setApprovals((prev) => (prev.some((a) => a.callId === req.callId) ? prev : [...prev, req]));
    });
    // v0.50 (M8): permission from a CLI engine via the harness broker.
    const offHarnessPermission = window.openBot.onHarnessPermissionNeeded((req) => {
      setHarnessPermissions((prev) =>
        prev.some((p) => p.requestId === req.requestId) ? prev : [...prev, req],
      );
    });
    const offAskUser = window.openBot.onAskUser((req) => {
      if (req.botId !== selectedBotIdRef.current) return;
      setAskUser(req);
    });
    // v0.13: MCP elicitation — main forwards `elicitation/create` as
    // `chat:elicitation-needed` (same shape as `chat:ask-user`). The
    // preload bridge lands with the coordinator wiring, so subscribe
    // defensively like onAutomationNotify above.
    const elicitationApi = window.openBot as unknown as {
      onElicitation?: (cb: (req: ElicitationRequestView) => void) => () => void;
    };
    const offElicitation =
      typeof elicitationApi.onElicitation === 'function'
        ? elicitationApi.onElicitation((req) => {
            if (req.botId !== selectedBotIdRef.current) return;
            setElicitation(req);
          })
        : () => {};
    const offProgress = window.openBot.onProgress(({ botId, message }) => {
      if (botId !== selectedBotIdRef.current) return;
      setNotices((prev) => [...prev.slice(-9), { id: uid(), kind: 'progress', text: message }]);
    });
    const offSummary = window.openBot.onFinalSummary(({ botId, summary }) => {
      if (botId !== selectedBotIdRef.current) return;
      setNotices((prev) => [...prev.slice(-9), { id: uid(), kind: 'summary', text: summary }]);
    });
    // v0.4 voice/automation IPC may not be exposed yet while the main
    // process is updated in parallel; guard the newest subscription.
    const offAutomationNotify =
      typeof window.openBot.onAutomationNotify === 'function'
        ? window.openBot.onAutomationNotify((payload) => {
            setNotices((prev) => [...prev.slice(-9), { id: uid(), kind: 'summary', text: payload.message }]);
          })
        : () => {};
    // v0.6: bot created by an agent (create_agent tool) — reload the bot list.
    const offBotsChanged =
      typeof window.openBot.onBotsChanged === 'function'
        ? window.openBot.onBotsChanged(() => {
            void loadBots();
          })
        : () => {};
    // v0.86 (P2-6): deep-link `open-bot://` — routes arriving while the
    // app is running (main pushes via `deep-link:open`) and a route
    // pending from startup (pulled once via `deep-link:pending`).
    // Guarded like onAutomationNotify because preload may not expose
    // the new API yet.
    const offDeepLink =
      typeof window.openBot.onDeepLink === 'function'
        ? window.openBot.onDeepLink((route) => applyDeepLinkRoute(route))
        : () => {};
    if (typeof window.openBot.getPendingDeepLink === 'function') {
      window.openBot
        .getPendingDeepLink()
        .then((route) => applyDeepLinkRoute(route))
        .catch(() => undefined);
    }
    // v0.28: A2A task persist status — main pushes it when a save
    // fails after all retries, or when a save succeeds again after a
    // failure streak; also ask once on app open so a failure from the
    // previous session (e.g. the last save before quitting failed) is
    // visible. Guarded like onAutomationNotify because preload may
    // not expose the new API yet.
    const offA2aPersistStatus =
      typeof window.openBot.onA2aPersistStatus === 'function'
        ? window.openBot.onA2aPersistStatus((status) => {
            setA2aPersistStatus(status);
            // A new status (new failure / recovered) clears the old dismiss.
            setA2aPersistDismissed(false);
          })
        : () => {};
    if (typeof window.openBot.getA2aPersistStatus === 'function') {
      window.openBot
        .getA2aPersistStatus()
        .then((status) => setA2aPersistStatus(status))
        .catch(() => undefined);
    }
    // v0.54 (P1-8): a run pauses at the interrupt point to ask the user (HITL) —
    // the coordinator emits an `interrupt-needed` event, main forwards it here.
    // Guarded like onA2aPersistStatus because preload may not expose it yet.
    const offInterrupt =
      typeof window.openBot.onInterruptNeeded === 'function'
        ? window.openBot.onInterruptNeeded((req) => {
            setInterrupts((prev) =>
              prev.some((r) => r.requestId === req.requestId) ? prev : [...prev, req],
            );
          })
        : () => {};
    // v1.01 (Team T3, risk budget): budget alert + run state — the
    // preload bridge may not expose these two yet when main is updated
    // after the renderer, so guard like onAutomationNotify above.
    const openBotRisk = window.openBot as unknown as {
      onBudgetAlert?: (cb: (payload: BudgetAlertView) => void) => () => void;
      onRunState?: (cb: (payload: { botId: string; state?: string }) => void) => () => void;
    };
    const offBudgetAlert =
      typeof openBotRisk.onBudgetAlert === 'function'
        ? openBotRisk.onBudgetAlert((payload) => {
            setBudgetByBot((prev) => ({ ...prev, [payload.botId]: payload.snapshot }));
          })
        : () => {};
    const offRunState =
      typeof openBotRisk.onRunState === 'function'
        ? openBotRisk.onRunState((payload) => {
            setWaitingBots((prev) => {
              const next = new Set(prev);
              if (payload.state === 'waiting-for-confirmation') next.add(payload.botId);
              else next.delete(payload.botId);
              return next;
            });
          })
        : () => {};
    // v0.54 (P1-9): update status when the app opens (banner when a new version exists).
    if (typeof window.openBot.getUpdateStatus === 'function') {
      window.openBot
        .getUpdateStatus()
        .then((status) => setUpdateStatus(status))
        .catch(() => undefined);
    }
    return () => {
      offDelta();
      offToolCall();
      offToolResult();
      offApproval();
      offHarnessPermission();
      offAskUser();
      offElicitation();
      offProgress();
      offSummary();
      offAutomationNotify();
      offBudgetAlert();
      offRunState();
      offBotsChanged();
      offDeepLink();
      offA2aPersistStatus();
      offInterrupt();
    };
  }, []);

  // v0.60 (UI-9): pending decision cards across all bots. The tray
  // auto-opens on the 0 -> N transition (a run waits for an answer);
  // closing it while cards are pending does not re-open it.
  const pendingTotal = approvals.length + harnessPermissions.length + interrupts.length;
  useEffect(() => {
    if (prevPendingTotalRef.current === 0 && pendingTotal > 0) setApprovalTrayOpen(true);
    prevPendingTotalRef.current = pendingTotal;
  }, [pendingTotal]);

  const send = async (text: string, visionAttachments?: VisionAttachment[]) => {
    const botId = selectedBotIdRef.current;
    if (!botId) return;
    // v0.63 (vision channel): the optimistic user bubble carries the
    // images so they show immediately (thumbnails in ChatView); the
    // same attachments go to main via sendChat.
    const userMsg: ChatMessageWithVision = {
      id: uid(),
      role: 'user',
      text,
      createdAt: Date.now(),
      ...(visionAttachments && visionAttachments.length > 0
        ? { attachments: visionAttachments }
        : {}),
    };
    const assistantMsg: ChatMessageView = { id: uid(), role: 'assistant', text: '', createdAt: Date.now() };
    // v0.59 (integration): invalidate any in-flight history load so
    // its late resolve cannot wipe these optimistic messages (UI-5 race).
    historyLoadSeq.current++;
    // v0.63 (pending-stop): mark the send in flight so a history load
    // that starts after this point (slow bot-switch effect) does not
    // apply over the turn (see sendInFlightRef). Cleared in finally.
    sendInFlightRef.current = { botId };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStatus('thinking');
    setToolEvents([]);
    streamedRef.current = false;
    // v0.60 (UI-8 + UI-11): snapshot this bot's usage BEFORE the run
    // (the after-snapshot in finally diffs into the turn footer) and
    // mark the bot running for the sidebar dot. A failed snapshot only
    // loses the footer, never the send.
    markBotRunning(botId);
    let usageBefore: SpendStatusData | null = null;
    try {
      usageBefore = (await window.openBot.getUsage(botId)) as unknown as SpendStatusData;
    } catch {
      usageBefore = null;
    }
    try {
      // v0.59 (UI-5): the turn is saved into the selected thread.
      // v0.63 (vision channel): the composer's images ride along.
      // v0.98 (Team T4 — planning v2): a plan attached in PlanView
      // rides on this run only. The plan's owner bot must match the
      // bot being sent to; a mismatch drops the attachment (the
      // banner in the chat view already says which bot it is for).
      // The attachment is consumed once the run starts.
      const attachedPlanId =
        activeRunPlan && activeRunPlan.botId === botId ? activeRunPlan.planId : undefined;
      if (activeRunPlan && !attachedPlanId) setActiveRunPlan(null);
      const res = await window.openBot.sendChat(
        botId,
        text,
        selectedThreadIdRef.current ?? undefined,
        visionAttachments,
        attachedPlanId,
      );
      if (attachedPlanId) setActiveRunPlan(null);
      if (!res.ok) {
        // Replace the optimistic assistant bubble with the error —
        // unless a late history load already wiped it, in which case
        // append instead of dropping the last (user) message.
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === assistantMsg.id);
          const errMsg = {
            ...assistantMsg,
            text: t('common.error', { message: res.error ?? t('app.sendError') }),
          };
          if (i === -1) return [...prev, errMsg];
          return [...prev.slice(0, i), errMsg, ...prev.slice(i + 1)];
        });
      } else if (res.text) {
        // If main did not stream (onText never fired), use the returned text.
        // Find the optimistic bubble by id: a history load that landed
        // mid-run may have wiped it — then append the result instead of
        // dropping it (a wiped bubble used to swallow the stopped text
        // whole: run returned stopped:true, DB held the stopped text, the UI
        // showed nothing). Streamed text already in the bubble stays.
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === assistantMsg.id);
          if (i === -1) return [...prev, { ...assistantMsg, text: res.text ?? '' }];
          const found = prev[i];
          if (!found || found.text) return prev;
          return [...prev.slice(0, i), { ...assistantMsg, text: res.text ?? '' }, ...prev.slice(i + 1)];
        });
      }
      // v0.59 (UI-2): the run ended by Stop, not by finishing. Close
      // every still-open tool card as stopped (never leave one showing
      // "running"), drop this bot's pending approval / ask-user /
      // interrupt cards (their run is gone), and say so in the chat.
      // The notice is needed whenever the bubble does not already
      // carry the stopped text from main: streamed partial text, or no
      // text at all (stopped with an empty reply). When nothing
      // streamed and the bubble holds the stopped text, no extra
      // notice is needed.
      if (res.stopped) {
        setToolEvents((prev) => prev.map((ev) => (ev.done ? ev : { ...ev, done: true, stopped: true })));
        setApprovals((prev) => prev.filter((a) => a.botId !== botId));
        setAskUser((prev) => (prev && prev.botId === botId ? null : prev));
        setInterrupts((prev) => prev.filter((r) => r.botId !== botId));
        if (streamedRef.current || !res.text) {
          setNotices((prev) => [
            ...prev.slice(-9),
            { id: uid(), kind: 'summary', text: t('chat.runStopped') },
          ]);
        }
      }
    } catch (e) {
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === assistantMsg.id);
        const errMsg = {
          ...assistantMsg,
          text: t('common.error', { message: e instanceof Error ? e.message : t('app.sendError') }),
        };
        if (i === -1) return [...prev, errMsg];
        return [...prev.slice(0, i), errMsg, ...prev.slice(i + 1)];
      });
    } finally {
      sendInFlightRef.current = null;
      setStatus('idle');
      clearBotRunning(botId);
      // v0.60 (UI-8): attach this turn's usage to the assistant bubble
      // (diff of the usage snapshots; null when the provider reported
      // no usage or the store reset mid-run — then no footer appears).
      if (usageBefore) {
        void (async () => {
          let after: SpendStatusData | null = null;
          try {
            after = (await window.openBot.getUsage(botId)) as unknown as SpendStatusData;
          } catch {
            return;
          }
          const usage = diffTurnUsage(usageBefore, after);
          if (!usage) return;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            return [...prev.slice(0, -1), { ...last, usage }];
          });
        })();
      }
      // v0.59 (UI-5): the first user message auto-titles a new thread —
      // refresh the list so the sidebar shows the new title. The
      // selection is kept (loadThreads falls back to the newest thread
      // only when the selected one is gone).
      void loadThreads(botId);
    }
  };

  /** v0.59 (UI-5): start a new thread for the selected bot and open it. */
  const createThread = async () => {
    const botId = selectedBotIdRef.current;
    if (!botId) return;
    try {
      // No title passed: the thread keeps the core default title until
      // its first user message auto-titles it (a passed title would
      // count as hand-picked and never be auto-titled).
      const thread = await window.openBot.createThread(botId);
      const chosen = await loadThreads(botId, thread.id);
      setView('chat');
      void loadHistory(botId, chosen ?? thread.id);
    } catch {
      setLoadError(t('thread.createError'));
    }
  };

  /** v0.59 (UI-5): rename a thread (hand-picked title, never auto-titled after). */
  const renameThread = async (threadId: string, title: string) => {
    try {
      const updated = await window.openBot.renameThread(threadId, title);
      setThreads((prev) => prev.map((th) => (th.id === updated.id ? updated : th)));
    } catch {
      setLoadError(t('thread.renameError'));
    }
  };

  /** v0.59 (UI-5): delete a thread (its messages go with it) and open the newest remaining one. */
  const deleteThread = async (threadId: string) => {
    const botId = selectedBotIdRef.current;
    if (!botId) return;
    try {
      await window.openBot.deleteThread(threadId);
      const chosen = await loadThreads(botId);
      void loadHistory(botId, chosen ?? undefined);
    } catch {
      setLoadError(t('thread.deleteError'));
    }
  };

  // v0.59 (UI-2): Stop button handler — asks main to abort the bot's
  // current run (IPC `chat:stop`). The run settles through the normal
  // sendChat path with stopped:true, so status still returns to idle
  // in send()'s finally and the stopped branch above marks everything
  // closed. A stopped:false answer means the run had just finished on
  // its own; send() then completes normally, so nothing is reported.
  const stopCurrentRun = async () => {
    const botId = selectedBotIdRef.current;
    if (!botId) return;
    try {
      await window.openBot.stopChat(botId);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('chat.stopFailed'));
    }
  };

  const saveBot = async (config: Partial<BotConfigLike> & { id?: string }) => {
    let saved: BotConfigLike;
    if (config.id) {
      const existing = bots.find((b) => b.id === config.id);
      if (!existing) throw new Error(t('app.botNotFound'));
      saved = await window.openBot.updateBot({ ...existing, ...config, id: config.id });
    } else {
      saved = await window.openBot.createBot(config);
    }
    setBots((prev) => {
      const exists = prev.some((b) => b.id === saved.id);
      return exists ? prev.map((b) => (b.id === saved.id ? saved : b)) : [...prev, saved];
    });
    setSelectedBotId(saved.id);
    setFormOpen(false);
    setFormBot(null);
    // v0.60 (UI-10): creating the first bot finishes onboarding — the
    // screen never comes back, even if the last bot is deleted later.
    // Edits (config.id set) do not touch the flag.
    if (!config.id) {
      markOnboardingDone(safeLocalStorage());
      setOnboardingDone(true);
    }
  };

  /** v0.60 (UI-10): "Skip for now" — the screen never shows again. */
  const dismissOnboarding = () => {
    markOnboardingDone(safeLocalStorage());
    setOnboardingDone(true);
  };

  /** v0.60 (UI-10): one-click sample bot from the built-in templates. */
  const createSampleBot = async () => {
    setSampleError(null);
    setSampleCreating(true);
    try {
      let templates: AgentTemplateLike[] = [];
      try {
        const listed = await window.openBot.listTemplates();
        if (Array.isArray(listed)) templates = listed as AgentTemplateLike[];
      } catch {
        // No templates — buildSampleBotConfig falls back to a bare bot.
        templates = [];
      }
      await saveBot(buildSampleBotConfig(templates, t('onboarding.sampleBotName')));
    } catch (e) {
      setSampleError(e instanceof Error ? e.message : t('app.loadBotsError'));
    } finally {
      setSampleCreating(false);
    }
  };

  /** v0.62 (UI-13): delete starts at the in-app confirm modal (the old
      `window.confirm` is gone) — confirmDeleteBot does the real work. */
  const deleteBot = (bot: BotConfigLike) => {
    setDeleteBotTarget(bot);
  };

  const confirmDeleteBot = async () => {
    const bot = deleteBotTarget;
    if (!bot) return;
    setDeleteBotTarget(null);
    await window.openBot.deleteBot(bot.id);
    // v0.60 (UI-11): a deleted bot is never running any more.
    clearBotRunning(bot.id);
    setBots((prev) => prev.filter((b) => b.id !== bot.id));
    if (selectedBotId === bot.id) {
      setSelectedBotId(null);
      // v0.59 (UI-5): the deleted bot's threads leave with it.
      setThreads([]);
      setSelectedThreadId(null);
      setThreadSearchResults(null);
    }
  };

  const cloneBot = async (bot: BotConfigLike) => {
    try {
      const cloned = await window.openBot.cloneAgent(bot.id);
      setBots((prev) => [...prev, cloned]);
      setSelectedBotId(cloned.id);
      setView('chat');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('app.loadBotsError'));
    }
  };

  /** A bot created from a template or installed from the marketplace. */
  const handleBotInstalled = async (bot: BotConfigLike) => {
    const list = await loadBots();
    if (list.some((b) => b.id === bot.id)) setSelectedBotId(bot.id);
    setView('chat');
  };

  // v0.60 (UI-9): jump from a tray card to its bot's chat, so the user
  // answers the card in the right context.
  const jumpToBot = (botId: string) => {
    setSelectedBotId(botId);
    setView('chat');
  };

  const respondApproval = (
    callId: string,
    approved: boolean,
    args?: Record<string, unknown>,
    allowAlways?: boolean,
  ) => {
    // v0.50 (M8): "Allow always" = create a bot-scoped auto-approve rule
    // for this tool BEFORE answering (the rule only covers this tool +
    // this bot; a rule-creation failure still answers allow-once and
    // never blocks the run).
    if (approved && allowAlways) {
      const approval = approvals.find((a) => a.callId === callId);
      const toolName = String(approval?.call.name ?? approval?.call.tool ?? '');
      if (approval && toolName) {
        void window.openBot
          .addAutoApproveRule({ kind: 'tool', scope: 'bot', botId: approval.botId, tool: toolName })
          .catch(() => undefined);
      }
    }
    window.openBot.respondApproval(callId, approved, args);
    setApprovals((prev) => prev.filter((a) => a.callId !== callId));
  };

  // v0.50 (M8): answer a CLI-engine permission (PermissionCard).
  const respondHarnessPermission = (requestId: string, allowed: boolean) => {
    window.openBot.respondHarnessPermission(requestId, allowed);
    setHarnessPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
  };

  // v0.54 (P1-8): answering the InterruptCard — the run pauses at a safe boundary
  // and resumes exactly there per the decision (checkpoint already saved).
  const respondInterrupt = (requestId: string, decision: InterruptDecisionView) => {
    window.openBot.respondInterrupt(requestId, decision);
    setInterrupts((prev) => prev.filter((r) => r.requestId !== requestId));
  };

  // v0.54 (P1-9): re-check for a new version (banner) + open the release page.
  const checkUpdatesAgain = async () => {
    try {
      const status = await window.openBot.checkForUpdates('manual');
      setUpdateStatus(status);
    } catch {
      // Keep the old banner; a manual check error does not crash the UI.
    }
  };
  const openUpdateDownload = async (url: string) => {
    try {
      await window.openBot.openUpdateDownload(url);
    } catch {
      // Ignore it.
    }
  };

  // v0.20 (W13a): plan review decisions — call the coordinator RPC
  // `reviewPlan` DIRECTLY via IPC `plans:review`, NO LONGER sending a
  // chat message for the agent to call plan_update inside a run (the old
  // path showed an extra approval card for that very plan_update
  // tool-call). Only remove the plan from the list when the RPC
  // succeeds — on error it throws so PlanReviewView can show a notice
  // and keep the plan. After approve / request-changes one chat message
  // is still sent so the agent executes / revises the plan: that run is
  // auto-approved for tool calls thanks to the plan-approved mark the
  // approve RPC just recorded (W12e), so no approval card appears for
  // the review itself.
  const approvePlan = async (plan: PendingPlan): Promise<void> => {
    await window.openBot.reviewPlan({
      botId: plan.botId,
      projectId: plan.projectId,
      decision: 'approve',
    });
    setPendingPlans((prev) => prev.filter((p) => p.projectId !== plan.projectId));
    setView('chat');
    void send(
      t('plan.executeMessage', { title: plan.title, projectId: plan.projectId }),
    );
  };

  const rejectPlan = async (plan: PendingPlan): Promise<void> => {
    await window.openBot.reviewPlan({
      botId: plan.botId,
      projectId: plan.projectId,
      decision: 'reject',
    });
    setPendingPlans((prev) => prev.filter((p) => p.projectId !== plan.projectId));
    setView('chat');
  };

  const requestPlanChanges = async (plan: PendingPlan, note: string): Promise<void> => {
    await window.openBot.reviewPlan({
      botId: plan.botId,
      projectId: plan.projectId,
      decision: 'request-changes',
      note,
    });
    setPendingPlans((prev) => prev.filter((p) => p.projectId !== plan.projectId));
    setView('chat');
    void send(
      t('plan.reviseMessage', { title: plan.title, projectId: plan.projectId, note }),
    );
  };

  const respondAskUser = (requestId: string, answer: string) => {
    window.openBot.respondAskUser(requestId, answer);
    setAskUser((prev) => (prev && prev.requestId === requestId ? null : prev));
  };

  // v0.13: answer an MCP elicitation request (form submit / URL done /
  // decline / cancel). The `respondElicitation` bridge lands with the
  // coordinator wiring; until then the modal still clears locally.
  const respondElicitation = (elicitationId: string, result: ElicitationResultView) => {
    const elicitationApi = window.openBot as unknown as {
      respondElicitation?: (elicitationId: string, result: ElicitationResultView) => void;
    };
    if (typeof elicitationApi.respondElicitation === 'function') {
      elicitationApi.respondElicitation(elicitationId, result);
    }
    setElicitation((prev) => (prev && prev.elicitationId === elicitationId ? null : prev));
  };

  // v0.96 (T6): copy the conversation id (thread id when the user is
  // in a thread of this bot, otherwise the bot id) to the clipboard.
  // Clipboard may be unavailable (permissions) — then report, never crash.
  const copyConversationId = async (botId: string) => {
    const id = conversationIdForCopy(
      botId,
      selectedBotIdRef.current === botId ? selectedThreadIdRef.current : null,
    );
    try {
      await navigator.clipboard.writeText(id);
      setNotices((prev) => [
        ...prev.slice(-9),
        { id: uid(), kind: 'summary', text: t('botMgmt.copiedId', { id }) },
      ]);
    } catch {
      setLoadError(t('botMgmt.copyFailed'));
    }
  };

  // v0.96 (T6): run an automation right now from the palette.
  const runAutomationNow = async (automationId: string) => {
    try {
      await window.openBot.runAutomationNow(automationId);
      setNotices((prev) => [
        ...prev.slice(-9),
        { id: uid(), kind: 'summary', text: t('palette.automationStarted') },
      ]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('palette.automationFailed'));
    }
  };

  const selectedBot = bots.find((b) => b.id === selectedBotId) ?? null;

  // v0.60 (UI-10): first-run screen — chat view, bot list loaded, no bot
  // yet, onboarding never finished or dismissed.
  const showOnboarding =
    view === 'chat' && botsLoaded && shouldShowOnboarding(bots.length, onboardingDone);

  return (
    <div className="app">
      <Sidebar
        bots={bots}
        selectedBotId={selectedBotId}
        onSelect={(id) => {
          setSelectedBotId(id);
          // v0.96 (T6): opening a bot clears its unread dot.
          setBotMeta((prev) => setBotUnread(prev, id, false));
          setView('chat');
        }}
        onCreate={() => {
          setFormBot(null);
          setFormOpen(true);
        }}
        onEdit={(bot) => {
          setFormBot(bot);
          setFormOpen(true);
        }}
        onDelete={(bot) => void deleteBot(bot)}
        onClone={(bot) => void cloneBot(bot)}
        botMeta={botMeta}
        onTogglePin={(botId) => setBotMeta((prev) => togglePin(prev, botId))}
        onToggleHide={(botId) => setBotMeta((prev) => setBotHidden(prev, botId, !(prev[botId]?.hidden ?? false)))}
        onCopyConversationId={(botId) => void copyConversationId(botId)}
        onOpenDashboard={() => setView('dashboard')}
        onOpenPlanner={() => setView('planner')}
        onOpenSettings={() => setView('settings')}
        onOpenConnectedApps={() => setView('connected-apps')}
        onOpenMarketplace={() => setView('marketplace')}
        onOpenMcpMarketplace={() => setView('mcp')}
        onOpenMcpApps={() => setView('mcp-apps')}
        onOpenMcpTasks={() => setView('mcp-tasks')}
        onOpenA2a={() => setView('a2a')}
        onOpenTeam={() => setView('team')}
        onOpenComputers={() => setView('computers')}
        onOpenFleet={() => setView('fleet')}
        onOpenFleetConsole={() => setView('fleet-console')}
        onOpenBotMarketplace={() => setView('bot-marketplace')}
        onOpenPluginMarketplace={() => setView('plugin-marketplace')}
        onOpenGroupChat={() => setView('group')}
        onOpenChannels={() => setView('channels')}
        onOpenSkills={() => setView('skills')}
        onOpenMemory={() => setView('memory')}
        onOpenCanvas={() => setView('canvas')}
        onOpenAutomations={() => setView('automations')}
        onOpenHarness2={() => setView('harness2')}
        onOpenTools={() => setView('tools')}
        onOpenInternetData={() => setView('internet-data')}
        onOpenEventLog={() => setView('eventlog')}
        onOpenEventStream={() => setView('event-stream')}
        onOpenEvalHarness={() => setView('eval-harness')}
        onOpenRunLog={() => setView('runlog')}
        onOpenAgUi={() => setView('agui')}
        threads={threads}
        selectedThreadId={selectedThreadId}
        threadSearchResults={threadSearchResults}
        onSelectThread={(id) => void selectThread(id)}
        onCreateThread={() => void createThread()}
        onRenameThread={(id, title) => void renameThread(id, title)}
        onDeleteThread={(id) => void deleteThread(id)}
        onSearchThreads={(query) => void searchThreads(query)}
        runningBotIds={runningBotIds}
        pendingCounts={countPendingByBot(approvals, harnessPermissions, interrupts)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
      />

      {/* v0.28: A2A persist-failure banner — shown in every view, not
          just the chat pane, so the error never goes unnoticed. */}
      {/* v0.79c: `app-body` — the tray stacks UNDER the main pane on
          narrow windows (see the 720px breakpoint in styles.css). */}
      <div className="app-body" style={{ flex: 1, display: 'flex', minWidth: 0, minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {a2aPersistStatus && !a2aPersistStatus.ok && !a2aPersistDismissed && (
          <A2aPersistAlert status={a2aPersistStatus} onDismiss={() => setA2aPersistDismissed(true)} />
        )}
        {/* v0.62 (UI-13): unified error banner — same shape as the A2A
            banner above. Replaces the old fixed bottom-right error line
            (easy to miss, no close button). */}
        {loadError && (
          <AppErrorBanner message={loadError} onDismiss={() => setLoadError('')} />
        )}
        {/* v0.54 (P1-9): banner for a new version / forced update. */}
        {updateStatus && (
          <UpdateBanner
            status={updateStatus}
            onCheckAgain={() => void checkUpdatesAgain()}
            onOpenDownload={(url) => void openUpdateDownload(url)}
          />
        )}
        <div style={{ flex: 1, display: 'flex', minWidth: 0, minHeight: 0 }}>
          {view === 'dashboard' ? (
            <DashboardView
              bots={bots}
              onBack={() => setView('chat')}
              onOpenBot={(id) => {
                setSelectedBotId(id);
                setBotMeta((prev) => setBotUnread(prev, id, false));
                setView('chat');
              }}
              onOpenEventLog={() => setView('eventlog')}
              onOpenMemory={() => setView('memory')}
              onOpenAutomations={() => setView('automations')}
              onOpenConnectedApps={() => setView('connected-apps')}
            />
          ) : view === 'planner' ? (
            <PlanView
              bots={bots}
              onBack={() => setView('chat')}
              activeRunPlanId={activeRunPlan?.planId ?? null}
              onRunPlanChange={(planId, botId, title) =>
                setActiveRunPlan(planId ? { planId, botId, title: title ?? '' } : null)
              }
            />
          ) : view === 'settings' ? (
          <div className="main">
            <SettingsView botId={selectedBotId} onBack={() => setView('chat')} onOpenConnectedApps={() => setView('connected-apps')} />
          </div>
        ) : view === 'connected-apps' ? (
          <div className="main">
            <ConnectedAppsView onBack={() => setView('chat')} />
          </div>
        ) : view === 'marketplace' ? (
          <div className="main">
            <AgentMarketplaceView
              bots={bots}
              onBack={() => setView('chat')}
              onBotInstalled={(bot) => void handleBotInstalled(bot)}
            />
          </div>
        ) : view === 'mcp' ? (
          <div className="main">
            <McpMarketplaceView botId={selectedBotId} onBack={() => setView('chat')} />
          </div>
        ) : view === 'mcp-apps' ? (
          <div className="main">
            <McpAppsView onBack={() => setView('chat')} />
          </div>
        ) : view === 'mcp-tasks' ? (
          <div className="main">
            <McpTasksView onBack={() => setView('chat')} />
          </div>
        ) : view === 'a2a' ? (
          <div className="main">
            <A2aClientView onBack={() => setView('chat')} />
          </div>
        ) : view === 'team' ? (
          <div className="main">
            <TeamView bots={bots} onBack={() => setView('chat')} />
          </div>
        ) : view === 'computers' ? (
          <div className="main">
            <ComputersView bots={bots} onBack={() => setView('chat')} />
          </div>
        ) : view === 'fleet' ? (
          <div className="main">
            <FleetView onBack={() => setView('chat')} />
          </div>
        ) : view === 'fleet-console' ? (
          <div className="main">
            <FleetConsoleView onBack={() => setView('chat')} />
          </div>
        ) : view === 'bot-marketplace' ? (
          <div className="main">
            <BotMarketplaceView
              onBack={() => setView('chat')}
              onBotInstalled={(bot) => void handleBotInstalled(bot)}
            />
          </div>
        ) : view === 'plugin-marketplace' ? (
          <div className="main">
            <PluginMarketplaceView onBack={() => setView('chat')} />
          </div>
        ) : view === 'group' ? (
          <div className="main">
            <GroupView bots={bots} onBack={() => setView('chat')} />
          </div>
        ) : view === 'channels' ? (
          <div className="main">
            <ChannelsView bots={bots} onBack={() => setView('chat')} />
          </div>
        ) : view === 'skills' ? (
          <div className="main">
            <SkillsView onBack={() => setView('chat')} />
          </div>
        ) : view === 'memory' ? (
          <div className="main">
            <MemoryView
              bots={bots}
              botId={selectedBotId}
              onBack={() => setView('chat')}
              onSelectBot={(id) => setSelectedBotId(id)}
            />
          </div>
        ) : view === 'canvas' ? (
          <div className="main">
            <CanvasView
              bots={bots}
              botId={selectedBotId}
              onBack={() => setView('chat')}
              onSelectBot={(id) => setSelectedBotId(id)}
            />
          </div>
        ) : view === 'automations' ? (
          <div className="main">
            <AutomationsView
              bots={bots}
              botId={selectedBotId}
              onBack={() => setView('chat')}
              onSelectBot={(id) => setSelectedBotId(id)}
            />
          </div>
        ) : view === 'harness2' ? (
          <div className="main">
            <HarnessV2View
              bots={bots}
              botId={selectedBotId}
              onBack={() => setView('chat')}
              onSelectBot={(id) => setSelectedBotId(id)}
            />
          </div>
        ) : view === 'traces' ? (
          <div className="main">
            <TraceView onBack={() => setView('chat')} botId={selectedBotId} />
          </div>
        ) : view === 'eventlog' ? (
          <div className="main">
            <EventLogView
              bots={bots}
              botId={selectedBotId}
              onBack={() => setView('chat')}
              onSelectBot={(id) => setSelectedBotId(id)}
            />
          </div>
        ) : view === 'runlog' ? (
          <div className="main">
            <RunReplayView onBack={() => setView('chat')} />
          </div>
        ) : view === 'event-stream' ? (
          <div className="main">
            <EventStreamView onBack={() => setView('chat')} />
          </div>
        ) : view === 'eval-harness' ? (
          <div className="main">
            <EvalHarnessView onBack={() => setView('chat')} />
          </div>
        ) : view === 'agui' ? (
          <div className="main">
            <AgUiPanel
              bots={bots}
              botId={selectedBotId}
              onBack={() => setView('chat')}
              onSelectBot={(id) => setSelectedBotId(id)}
            />
          </div>
        ) : view === 'tools' ? (
          <div className="main">
            <ToolsView
              botId={selectedBotId}
              botName={selectedBot?.name ?? null}
              onBack={() => setView('chat')}
            />
          </div>
        ) : view === 'internet-data' ? (
          <div className="main">
            <InternetDataView onBack={() => setView('chat')} />
          </div>
        ) : view === 'plans' ? (
          <div className="main">
            <PlanReviewView
              plans={pendingPlans.filter((p) => !selectedBotId || p.botId === selectedBotId)}
              botId={selectedBotId}
              botName={selectedBot?.name ?? null}
              onBack={() => setView('chat')}
              onApprove={(plan) => approvePlan(plan)}
              onReject={(plan) => rejectPlan(plan)}
              onRequestChanges={(plan, note) => requestPlanChanges(plan, note)}
            />
          </div>
        ) : showOnboarding ? (
          <div className="main">
            <OnboardingView
              onCreateSample={() => void createSampleBot()}
              onCreateBot={() => {
                setFormBot(null);
                setFormOpen(true);
              }}
              onDismiss={dismissOnboarding}
              creatingSample={sampleCreating}
              sampleError={sampleError}
            />
          </div>
        ) : (
          <>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {/* v0.98 (Team T4 — planning v2): a plan attached in
                  PlanView rides on the next chat run. */}
              {activeRunPlan && (
                <div
                  role="status"
                  data-testid="active-run-plan-banner"
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 13,
                  }}
                >
                  <span>
                    {t('planner.attachedBanner', {
                      title: activeRunPlan.title,
                      bot:
                        bots.find((b) => b.id === activeRunPlan.botId)?.name ??
                        activeRunPlan.botId ??
                        '',
                    })}
                  </span>
                  <button className="btn secondary" onClick={() => setActiveRunPlan(null)}>
                    {t('planner.detachRun')}
                  </button>
                </div>
              )}
              {selectedBotId && budgetByBot[selectedBotId] && (
                <div style={{ padding: '8px 20px 0', background: 'var(--bg-panel)' }}>
                  <BudgetMeter
                    snapshot={budgetByBot[selectedBotId]}
                    botName={selectedBot?.name}
                  />
                </div>
              )}
              {selectedBotId && waitingBots.has(selectedBotId) && (
                <div
                  role="status"
                  data-testid="waiting-confirmation-banner"
                  style={{ padding: '8px 20px 0', fontSize: 13, color: '#8a6d00' }}
                >
                  {t('risk.waitingForConfirmation')}
                </div>
              )}
              <ChatView
                bot={selectedBot}
                messages={messages}
                status={status}
                toolEvents={toolEvents}
                onSend={(text, visionAttachments) => void send(text, visionAttachments)}
                onStop={() => void stopCurrentRun()}
                onVoiceError={(message) => setLoadError(message)}
                externalInsert={composerInsert}
                sourceLabel={
                  selectedBot
                    ? railSourceLabel(rail?.entries.find((e) => e.providerId === selectedBot.providerId))
                    : null
                }
                onSwitchModel={() => setModelPickerOpen(true)}
              />
              {/* v0.60 (UI-9): approval / permission / interrupt cards
                  no longer pile up under this chat — they live in the
                  ApprovalTray dock (all bots, every view). Ask-user and
                  elicitation stay here: they are scoped to the selected
                  bot's run, so they cannot be answered in the wrong
                  context. */}
              {askUser && (
                <AskUserCard request={askUser} onRespond={respondAskUser} />
              )}
              {elicitation && (
                <ElicitationModal
                  key={elicitation.elicitationId}
                  request={elicitation}
                  onRespond={respondElicitation}
                />
              )}
              {notices.map((n) => (
                <div key={n.id} className={`notice ${n.kind}`}>
                  {n.kind === 'summary' ? '✅ ' : '⏳ '}{n.text}
                </div>
              ))}
              <div style={{ padding: '0 20px 10px', background: 'var(--bg-panel)' }}>
                {/* v0.77 (UI parity §3.7): toggle with a running-task badge. */}
                <TasksToggleButton
                  showTasks={showTasks}
                  runningCount={tasks.filter((task) => task.status === 'running').length}
                  onToggle={() => setShowTasks((v) => !v)}
                />{' '}
                {/* v0.60 (UI-9): toggle the approval tray dock. */}
                <button
                  className="btn secondary"
                  data-testid="approval-tray-toggle"
                  onClick={() => setApprovalTrayOpen((v) => !v)}
                >
                  {t('approval.trayToggle')}
                  {pendingTotal > 0 ? ` (${pendingTotal})` : ''}
                </button>{' '}
                <button className="btn secondary" onClick={() => setView('traces')}>
                  {t('trace.title')}
                </button>{' '}
                <button className="btn secondary" onClick={() => setView('plans')}>
                  {t('plan.button')}
                  {pendingPlans.filter((p) => !selectedBotId || p.botId === selectedBotId).length > 0
                    ? ` (${pendingPlans.filter((p) => !selectedBotId || p.botId === selectedBotId).length})`
                    : ''}
                </button>{' '}
                {/* v0.54 (P1-8): resume/time-travel panel from checkpoint. */}
                <button
                  className="btn secondary"
                  disabled={!selectedBot}
                  onClick={() => setShowCheckpoints((v) => !v)}
                >
                  {showCheckpoints ? t('checkpoint.hide') : t('checkpoint.show')}
                </button>
              </div>
              {showCheckpoints && selectedBot && (
                <CheckpointPanel
                  botId={selectedBot.id}
                  botName={selectedBot.name}
                  onReplayed={(text) => {
                    setMessages((prev) => [
                      ...prev,
                      { id: uid(), role: 'assistant', text, createdAt: Date.now() },
                    ]);
                    setShowCheckpoints(false);
                  }}
                />
              )}
            </div>
            {showTasks && selectedBot && (
              <div style={{ width: 340, borderLeft: '1px solid var(--border)', background: 'var(--bg-panel)', overflow: 'hidden' }}>
                <TaskPanel tasks={tasks} loading={tasksLoading} onRefresh={() => void loadTasks(selectedBot.id)} />
              </div>
            )}
          </>
        )}
        </div>
        </div>
        {/* v0.60 (UI-9): approval tray — right dock, all bots, every
            view (not just chat). Mounted only while cards are pending;
            the toggle button under the chat re-opens it, and it
            auto-opens on the 0 -> N transition. */}
        {approvalTrayOpen && pendingTotal > 0 && (
          <ApprovalTray
            approvals={approvals}
            harnessPermissions={harnessPermissions}
            interrupts={interrupts}
            botName={(botId) => bots.find((b) => b.id === botId)?.name}
            onRespondApproval={respondApproval}
            onRespondPermission={respondHarnessPermission}
            onRespondInterrupt={respondInterrupt}
            onJumpToBot={jumpToBot}
            onClose={() => setApprovalTrayOpen(false)}
          />
        )}
      </div>

      {paletteOpen && (
        <CommandPalette
          bots={bots}
          selectedBotId={selectedBotId}
          onSelectBot={(id) => {
            setSelectedBotId(id);
            setView('chat');
            setPaletteOpen(false);
          }}
          onOpenView={(view) => {
            setView(view);
            setPaletteOpen(false);
          }}
          onInsertSlash={(text) => {
            setComposerInsert({ text, nonce: Date.now() });
            setView('chat');
            setPaletteOpen(false);
          }}
          onCreateBot={() => {
            setFormBot(null);
            setFormOpen(true);
            setPaletteOpen(false);
          }}
          onOpenModelPicker={() => {
            setModelPickerOpen(true);
            setPaletteOpen(false);
          }}
          onRunAutomation={(automationId) => {
            setPaletteOpen(false);
            void runAutomationNow(automationId);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {deleteBotTarget && (
        <div className="modal-backdrop" onClick={() => setDeleteBotTarget(null)}>
          <div
            className="modal"
            role="alertdialog"
            aria-label={t('app.deleteBotTitle')}
            data-testid="delete-bot-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{t('app.deleteBotTitle')}</h2>
            <p>{t('app.deleteBotConfirm', { name: deleteBotTarget.name })}</p>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setDeleteBotTarget(null)}>
                {t('botForm.cancel')}
              </button>
              <button
                className="btn danger"
                data-testid="delete-bot-confirm"
                onClick={() => void confirmDeleteBot()}
              >
                {t('automations.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
      {formOpen && <BotForm initial={formBot} onSave={saveBot} onCancel={() => { setFormOpen(false); setFormBot(null); }} onOpenEngines={() => { setFormOpen(false); setFormBot(null); setView('settings'); }} />}
      {modelPickerOpen && selectedBot && (
        <div className="modal-backdrop" onClick={() => setModelPickerOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('modelPicker.title')}</h2>
            <ModelPicker
              value={{ providerId: selectedBot.providerId, model: selectedBot.model }}
              onSelect={(sel) => void switchBotModel(sel.providerId, sel.model)}
              onToggleEngine={async (kind, enabled) => {
                await window.openBot.setEngineEnabled({ kind, enabled });
                await loadRail();
              }}
              onOpenEngines={() => { setModelPickerOpen(false); setView('settings'); }}
              disabledProviders={selectedBot.disabledProviders}
            />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setModelPickerOpen(false)}>{t('botForm.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
