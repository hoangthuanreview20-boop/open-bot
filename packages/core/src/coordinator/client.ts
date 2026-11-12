/**
 * CoordinatorClient — parent-side handle for the node-agent-coordinator
 * child process.
 *
 * Spawns the coordinator with the current Node binary
 * (`process.execPath`) and the compiled entry next to this file
 * (`packages/core/dist/coordinator/coordinator.js`), speaks NDJSON-RPC
 * over its stdio, and routes `agent.event` notifications to subscribers.
 *
 * The child's stdout is NDJSON only; its stderr is piped through to this
 * process's stderr so coordinator diagnostics stay visible without
 * corrupting the protocol stream.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { InterruptDecision } from '../agent/interrupt';
import type { VisionAttachment } from '../types';
import type {
  AcceptHandoffResult,
  AddAutoApproveRuleParams,
  AddAutoApproveRuleResult,
  AddBotToGroupChatParams,
  AddBotToGroupChatResult,
  AgentEvent,
  ComposioState,
  GetComposioKeyStatusResult,
  GetComposioConnectionStatusParams,
  GetComposioConnectionStatusResult,
  GetComposioUserIdStatusResult,
  SetComposioApiKeyResult,
  SetComposioUserIdResult,
  CoordinatorNotification,
  CreateBotParams,
  CreateBotResult,
  CreateGroupChatParams,
  CreateGroupChatResult,
  CreateHandoffRecordParams,
  CreateHandoffRecordResult,
  CreateThreadResult,
  DaemonStatusResult,
  DeleteGroupChatParams,
  DeleteGroupChatResult,
  DeleteThreadResult,
  DeleteBotDataParams,
  DeleteBotDataResult,
  DestroyBotParams,
  DestroyBotResult,
  GetHandoffResult,
  GetHistoryResult,
  GetThreadHistoryResult,
  GetWorkspaceRulesResult,
  HarnessDecidePermissionParams,
  HarnessDecidePermissionResult,
  HarnessStatusResult,
  HarnessThreadLogParams,
  HarnessThreadLogResult,
  InterruptRunResult,
  ListBotCheckpointsResult,
  ListRunCheckpointsResult,
  ListThreadsResult,
  RenameThreadResult,
  ReplayRunResult,
  RespondInterruptResult,
  ListAutoApproveRulesResult,
  ListBotsResult,
  ListBotToolsResult,
  ListBotSkillsResult,
  ListSlashCommandsResult,
  SetBotToolEnabledResult,
  SetBotSkillEnabledResult,
  ListGroupChatsResult,
  GetGroupAttachmentParams,
  GetGroupAttachmentResult,
  ProjectUpdatesDueResult,
  ProjectUpdatesMarkSentParams,
  ProjectUpdatesMarkSentResult,
  GetGroupBotStatusParams,
  GetGroupBotStatusResult,
  DismissGroupBotInterruptedParams,
  DismissGroupBotInterruptedResult,
  ListGroupMessagesParams,
  ListGroupMessagesResult,
  ListHandoffsParams,
  ListHandoffsResult,
  ListTasksResult,
  PingResult,
  PostGroupMessageParams,
  PostGroupMessageResult,
  RemoveAutoApproveRuleResult,
  RemoveBotFromGroupChatParams,
  RemoveBotFromGroupChatResult,
  RespondApprovalResult,
  RespondAskUserResult,
  RespondElicitationResult,
  ReviewPlanResult,
  RunResult,
  SaveMessageResult,
  SearchThreadsResult,
  SetAutoApproveRuleEnabledResult,
  ShutdownResult,
  StopBotResult,
  StopRunResult,
  SuperviseParams,
  SuperviseResult,
  SwitchModelParams,
  SwitchModelResult,
  AppStatusView,
  TokenSet,
} from './types';
// (SetPluginEnabledResult đã được W6e khai báo local ở dưới — cùng shape
// với coordinator/types.ts, không import lại để tránh xung đột.)

/**
 * v0.14: result of the `setPluginEnabled` RPC (implemented server-side
 * in coordinator.ts). `appliedToRunning` is true only when the running
 * bot actually picked the change up; false when the bot does not exist
 * (yet) in the coordinator, so the caller can fall back to the persisted
 * `enabled.json` state for bots created later.
 */
export interface SetPluginEnabledResult {
  ok: boolean;
  enabled: boolean;
  appliedToRunning: boolean;
}

export interface CoordinatorClientOptions {
  /** Path to the compiled coordinator entry. Default: coordinator.js next to this file. */
  coordinatorPath?: string;
  /** Extra argv passed to the coordinator child. */
  spawnArgs?: string[];
  /**
   * Environment for the child process. Default: `process.env`.
   * Electron main MUST pass `{...process.env, ELECTRON_RUN_AS_NODE: '1'}`:
   * the main process's `process.execPath` is the Electron binary, and
   * without that flag it would load the entry as an Electron app instead
   * of running it as plain Node (no stdio loop, requests would hang).
   */
  env?: NodeJS.ProcessEnv;
  /** Default event handler (in addition to per-run / subscribed handlers). */
  onEvent?: (event: AgentEvent) => void;
  /** How long a request may wait for its response, ms. Default 10 minutes (long agent runs). */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DISPOSE_TIMEOUT_MS = 5_000;

export class CoordinatorClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Set<(event: AgentEvent) => void>();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private disposed = false;
  private exitPromise: Promise<number | null>;

  constructor(opts: CoordinatorClientOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (opts.onEvent) this.eventHandlers.add(opts.onEvent);
    const coordinatorPath =
      opts.coordinatorPath ?? join(__dirname, 'coordinator.js');
    this.child = spawn(process.execPath, [coordinatorPath, ...(opts.spawnArgs ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });
    // Child stderr is diagnostics only — forward it, never parse it as RPC.
    this.child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    this.exitPromise = new Promise<number | null>((resolve) => {
      this.child.once('exit', (code) => resolve(code));
    });
    // A dead child must fail every in-flight request instead of hanging.
    this.child.once('exit', () => {
      const err = new Error('Coordinator đã thoát trước khi trả lời request.');
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.onLine(line));
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg: {
      id?: unknown;
      result?: unknown;
      error?: { message?: string; code?: string };
      event?: unknown;
      data?: unknown;
    };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      // A non-JSON line on stdout is a protocol violation; ignore it
      // rather than crashing the client.
      return;
    }
    if (typeof msg.id === 'string') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error !== undefined && msg.error !== null) {
        const err = new Error(msg.error.message ?? 'Coordinator trả lỗi không rõ.');
        (err as Error & { code?: string }).code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.event === 'string') {
      const notification = msg as unknown as CoordinatorNotification;
      if (notification.event === 'agent.event') {
        const event = notification.data as AgentEvent;
        for (const handler of [...this.eventHandlers]) {
          try {
            handler(event);
          } catch {
            // A throwing subscriber must not break event delivery.
          }
        }
      }
    }
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** Wait for the child process to exit (resolves with its exit code). */
  waitForExit(): Promise<number | null> {
    return this.exitPromise;
  }

  private request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('CoordinatorClient đã dispose — không gửi được request.'));
    }
    const id = `req-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hết thời gian chờ coordinator trả lời "${method}".`));
      }, timeoutMs ?? this.requestTimeoutMs);
      // Don't let a lone pending timer keep the parent alive forever.
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v: unknown) => resolve(v as T),
        reject,
        timer,
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  createBot(params: CreateBotParams): Promise<CreateBotResult> {
    return this.request<CreateBotResult>('createBot', params as unknown as Record<string, unknown>);
  }

  /**
   * Run one turn. `onEvent` (optional) receives only this run's events
   * for this bot, in addition to any global subscribers. `opts.silent`
   * (v0.4) marks a background run: the child suppresses informational
   * events for it (approval / ask-user still come through).
   */
  async run(
    botId: string,
    text: string,
    onEvent?: (event: AgentEvent) => void,
    opts?: {
      silent?: boolean;
      runId?: string;
      cwd?: string;
      handoffId?: string;
      threadId?: string;
      /** v0.62 (vision channel): images for this turn (see RunParams.attachments). */
      attachments?: VisionAttachment[];
    },
  ): Promise<RunResult> {
    let unsubscribe: (() => void) | undefined;
    if (onEvent) {
      unsubscribe = this.onEvent((event) => {
        if (event.botId === botId) onEvent(event);
      });
    }
    try {
      return await this.request<RunResult>('run', {
        botId,
        text,
        silent: opts?.silent === true,
        runId: opts?.runId,
        cwd: opts?.cwd,
        ...(opts?.handoffId !== undefined ? { handoffId: opts.handoffId } : {}),
        ...(opts?.threadId !== undefined ? { threadId: opts.threadId } : {}),
        ...(opts?.attachments !== undefined ? { attachments: opts.attachments } : {}),
      });
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * v0.34 (P1-6): xem AGENTS.md đang có hiệu lực cho một bot — nội dung
   * đã gộp + nguồn từng file + file bị bỏ qua/cắt ngắn (debug, không
   * chạy run). `cwd` mặc định là workspaceDir của bot.
   */
  getWorkspaceRules(botId: string, cwd?: string): Promise<GetWorkspaceRulesResult> {
    return this.request<GetWorkspaceRulesResult>('getWorkspaceRules', { botId, cwd });
  }

  /**
   * v0.37 (P1-3): handoff phiên làm việc — liệt kê / đọc / tạo / nhận
   * record (RPC cho UI sau này; xem `packages/core/src/handoff/`).
   * `acceptHandoff` chỉ đánh dấu đã nhận + trả khối ngữ cảnh — muốn nạp
   * record rồi chạy luôn thì dùng `run(..., { handoffId })` (xem `run`
   * với `RunParams.handoffId`).
   */
  listHandoffs(params: ListHandoffsParams = {}): Promise<ListHandoffsResult> {
    return this.request<ListHandoffsResult>(
      'listHandoffs',
      params as unknown as Record<string, unknown>,
    );
  }

  getHandoff(id: string): Promise<GetHandoffResult> {
    return this.request<GetHandoffResult>('getHandoff', { id });
  }

  createHandoffRecord(params: CreateHandoffRecordParams): Promise<CreateHandoffRecordResult> {
    return this.request<CreateHandoffRecordResult>(
      'createHandoffRecord',
      params as unknown as Record<string, unknown>,
    );
  }

  acceptHandoff(id: string, botId: string): Promise<AcceptHandoffResult> {
    return this.request<AcceptHandoffResult>('acceptHandoff', { id, botId });
  }

  /** v0.4: run one tool by name inside the coordinator (automation). */
  runTool(botId: string, tool: string, args: Record<string, unknown> = {}): Promise<{ output: string }> {
    return this.request<{ output: string }>('runTool', { botId, tool, args });
  }

  /**
   * v0.20 (W13a): duyệt plan trực tiếp từ màn hình Kế hoạch (RPC
   * `reviewPlan` — không qua tool-call plan_update trong run nên không
   * hiện thẻ approval cho hành động duyệt). `note` chỉ dùng cho
   * request-changes. Server side trong coordinator.ts.
   */
  reviewPlan(
    botId: string,
    projectId: string,
    decision: 'approve' | 'reject' | 'request-changes',
    note?: string,
  ): Promise<ReviewPlanResult> {
    return this.request<ReviewPlanResult>('reviewPlan', {
      botId,
      projectId,
      decision,
      ...(note !== undefined ? { note } : {}),
    });
  }

  /**
   * M4: đổi model/provider của bot giữa chừng (không mất thread).
   * `provider` là ProviderConfig đầy đủ do main dựng qua
   * providerConfigFor. Khi bot đang chạy, coordinator trả
   * `{pending: true}` và áp dụng ở đầu run kế tiếp.
   */
  switchModel(params: SwitchModelParams): Promise<SwitchModelResult> {
    return this.request<SwitchModelResult>('switchModel', params as unknown as Record<string, unknown>);
  }

  /** v0.4: create a plan task for a bot (automation / dream). */
  createTask(botId: string, title: string): Promise<{ id: string }> {
    return this.request<{ id: string }>('createTask', { botId, title });
  }

  /** v0.4: reload the coordinator-side skill registry. */
  reloadSkills(): Promise<{ skills: string[]; errors: Array<{ file: string; error: string }> }> {
    return this.request<{ skills: string[]; errors: Array<{ file: string; error: string }> }>(
      'reloadSkills',
      {},
    );
  }

  /**
   * v0.35 (P1-7): quản lý rule auto-approve (RPC — xem
   * `packages/core/src/approval/rules.ts` về mô hình an toàn). Rule do
   * người dùng tạo tường minh; store bắt đầu rỗng nên mặc định không
   * có gì tự duyệt (fail-closed).
   */
  listAutoApproveRules(): Promise<ListAutoApproveRulesResult> {
    return this.request<ListAutoApproveRulesResult>('listAutoApproveRules', {});
  }

  addAutoApproveRule(params: AddAutoApproveRuleParams): Promise<AddAutoApproveRuleResult> {
    return this.request<AddAutoApproveRuleResult>(
      'addAutoApproveRule',
      params as unknown as Record<string, unknown>,
    );
  }

  removeAutoApproveRule(id: string): Promise<RemoveAutoApproveRuleResult> {
    return this.request<RemoveAutoApproveRuleResult>('removeAutoApproveRule', { id });
  }

  setAutoApproveRuleEnabled(id: string, enabled: boolean): Promise<SetAutoApproveRuleEnabledResult> {
    return this.request<SetAutoApproveRuleEnabledResult>('setAutoApproveRuleEnabled', {
      id,
      enabled,
    });
  }

  /** v0.4: tool-result cache stats (Settings performance section). */
  cacheStats(): Promise<{
    entries: number;
    hits: number;
    misses: number;
    evictions: number;
    maxEntries: number;
  }> {
    return this.request('cache.stats', {});
  }

  /** v0.4: clear the tool-result cache. */
  clearCache(): Promise<{ cleared: boolean }> {
    return this.request<{ cleared: boolean }>('cache.clear', {});
  }

  stopBot(botId: string): Promise<StopBotResult> {
    return this.request<StopBotResult>('stopBot', { botId });
  }

  /** v0.9a: stop ONE run by its id (see coordinator `stopRun`). */
  stopRun(runId: string): Promise<StopRunResult> {
    return this.request<StopRunResult>('stopRun', { runId });
  }

  /** Answer a pending approval request (from an `approval-needed` event). v0.12: kèm args đã sửa. */
  respondApproval(callId: string, approved: boolean, args?: Record<string, unknown>): Promise<RespondApprovalResult> {
    return this.request<RespondApprovalResult>('respondApproval', { callId, approved, args });
  }

  /**
   * v0.54 (P1-8): yêu cầu run đang chạy dừng ở biên an toàn tiếp theo
   * để hỏi user (HITL) — không abort như stopRun; run dừng có checkpoint
   * và tiếp tục được theo quyết định trả về qua `respondInterrupt`.
   */
  interruptRun(runId: string, question?: string): Promise<InterruptRunResult> {
    return this.request<InterruptRunResult>('interruptRun', { runId, question });
  }

  /** v0.54 (P1-8): trả lời một yêu cầu interrupt đang chờ (từ event `interrupt-needed`). */
  respondInterrupt(requestId: string, decision: InterruptDecision): Promise<RespondInterruptResult> {
    return this.request<RespondInterruptResult>('respondInterrupt', { requestId, decision });
  }

  /** v0.54 (P1-8): tóm tắt checkpoint của một run (cho UI resume/time-travel). */
  listRunCheckpoints(runId: string): Promise<ListRunCheckpointsResult> {
    return this.request<ListRunCheckpointsResult>('listRunCheckpoints', { runId });
  }

  /** v0.54 (P1-8): tóm tắt checkpoint của mọi run của một bot. */
  listBotCheckpoints(botId: string): Promise<ListBotCheckpointsResult> {
    return this.request<ListBotCheckpointsResult>('listBotCheckpoints', { botId });
  }

  /** v0.54 (P1-8): chạy lại một run từ checkpoint cũ (time-travel replay). */
  replayRun(botId: string, runId: string, stepIndex?: number | 'latest'): Promise<ReplayRunResult> {
    return this.request<ReplayRunResult>('replayRun', { botId, runId, stepIndex });
  }

  /**
   * M7: lưu TokenSet của một app vào kho dùng chung của coordinator —
   * mọi bot (kể cả bot đã tạo) dùng chung token này ngay. Trả trạng
   * thái app sau khi lưu (không chứa token).
   */
  setSharedAppToken(
    appId: string,
    token: TokenSet,
    accountLabel?: string,
  ): Promise<AppStatusView> {
    return this.request<AppStatusView>('apps.setSharedToken', {
      appId,
      token: token as unknown as Record<string, unknown>,
      ...(accountLabel !== undefined ? { accountLabel } : {}),
    });
  }

  /**
   * M7 (v0.68b): lưu token PAT thô của một app token (vd GitHub) vào
   * kho dùng chung của coordinator — mọi bot dùng chung token này
   * ngay. Trả trạng thái app sau khi lưu (không chứa token).
   */
  setPlainAppToken(
    appId: string,
    token: string,
    accountLabel?: string,
  ): Promise<AppStatusView> {
    return this.request<AppStatusView>('apps.setPlainToken', {
      appId,
      token,
      ...(accountLabel !== undefined ? { accountLabel } : {}),
    });
  }

  /**
   * M7: xóa token của một app khỏi kho dùng chung — mọi bot mất quyền
   * ngay. Trả trạng thái app sau khi xóa.
   */
  revokeSharedAppToken(appId: string): Promise<AppStatusView> {
    return this.request<AppStatusView>('apps.revokeSharedToken', { appId });
  }

  /** M7: trạng thái đầy đủ mọi app trong catalog (không chứa token). */
  listAppStatuses(): Promise<AppStatusView[]> {
    return this.request<AppStatusView[]>('apps.listStatuses', {});
  }

  /**
   * v0.58: bật/tắt Composio + chọn toolkit trong tiến trình
   * coordinator — toggle `ComposioAppSource` trên `defaultAppRegistry`,
   * cập nhật gate meta-tool (bot đã tạo được rebuild tool list ngay,
   * bot tạo sau thấy trạng thái mới), huỷ session Composio cũ. Trả
   * trạng thái đã áp dụng + app id đã đăng ký (không chứa key).
   * Toolkit lạ → coordinator trả lỗi rõ ràng.
   */
  setComposioState(state: { enabled: boolean; toolkits: string[] }): Promise<ComposioState> {
    return this.request<ComposioState>('composio.setState', {
      enabled: state.enabled,
      toolkits: state.toolkits,
    });
  }

  /** v0.58: trạng thái Composio hiện tại trong tiến trình coordinator. */
  getComposioState(): Promise<ComposioState> {
    return this.request<ComposioState>('composio.getState', {});
  }

  /**
   * v0.59: seed Composio API key cho coordinator (main đọc Vault bằng
   * safeStorage trong main process rồi truyền bản sao trong bộ nhớ —
   * đúng mẫu `xBearer` / `githubToken` qua `createBot`). Key mới ghi
   * đè key cũ (xoay key không cần destroyBot); `null` = xoá key đã
   * seed (main gọi khi user xoá key trong Vault — coordinator về
   * fallback đọc file, hoặc fail-closed khi Vault dùng safeStorage /
   * NO_STORAGE). Trả trạng thái key (không chứa key). Key không log.
   */
  setComposioApiKey(apiKey: string | null): Promise<SetComposioApiKeyResult> {
    return this.request<SetComposioApiKeyResult>('composio.setApiKey', { apiKey });
  }

  /**
   * v0.59: trạng thái key Composio trong coordinator — có key không,
   * có phải key đã seed không, nguồn nào (`seeded` / `vault-file` /
   * `none`). Không chứa key.
   */
  getComposioKeyStatus(): Promise<GetComposioKeyStatusResult> {
    return this.request<GetComposioKeyStatusResult>('composio.getKeyStatus', {});
  }

  /**
   * v0.88b: seed Composio user id cho coordinator (main đọc Vault
   * bằng safeStorage trong main process rồi truyền bản sao trong bộ
   * nhớ — đúng mẫu `setComposioApiKey`). User id mới ghi đè id cũ
   * (đổi id → session cũ bị huỷ ngay, lần gọi tool sau tạo session
   * mới đúng id, không cần restart app); `null` = về mặc định
   * 'local-user'. Trả trạng thái user id (không chứa giá trị).
   */
  setComposioUserId(userId: string | null): Promise<SetComposioUserIdResult> {
    return this.request<SetComposioUserIdResult>('composio.setUserId', { userId });
  }

  /**
   * v0.88b: trạng thái user id Composio trong coordinator — đã cấu
   * hình id thật chưa, có đang dùng mặc định 'local-user' không.
   * Không chứa user id.
   */
  getComposioUserIdStatus(): Promise<GetComposioUserIdStatusResult> {
    return this.request<GetComposioUserIdStatusResult>('composio.getUserIdStatus', {});
  }

  /**
   * v0.89c (Team E): trạng thái connection từng toolkit Composio
   * trong session hiện tại (chỉ toolkit + trạng thái + nhãn tài
   * khoản; không chứa user id, link OAuth hay key). `toolkits`
   * vắng = toolkit đang bật.
   */
  getComposioConnectionStatus(
    toolkits?: string[],
  ): Promise<GetComposioConnectionStatusResult> {
    return this.request<GetComposioConnectionStatusResult>('composio.getConnectionStatus', {
      ...(toolkits !== undefined ? { toolkits } : {}),
    });
  }

  /** Answer a pending ask-user question (from an `ask-user` event). */
  respondAskUser(requestId: string, answer: string): Promise<RespondAskUserResult> {
    return this.request<RespondAskUserResult>('respondAskUser', { requestId, answer });
  }

  /** Answer a pending MCP elicitation request (from an `mcp.elicitation-needed` event). */
  respondElicitation(
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ): Promise<RespondElicitationResult> {
    return this.request<RespondElicitationResult>('respondElicitation', {
      elicitationId,
      action,
      content,
    });
  }

  /**
   * v0.14: enable/disable one plugin for a RUNNING bot (server side in
   * coordinator.ts — it must implement the `setPluginEnabled` RPC with
   * the same contract: params `{botId, pluginId, enabled}`, result
   * `{ok, enabled, appliedToRunning}`).
   */
  setPluginEnabled(
    botId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<SetPluginEnabledResult> {
    return this.request<SetPluginEnabledResult>('setPluginEnabled', {
      botId,
      pluginId,
      enabled,
    });
  }

  /**
   * v0.14: route a task to the best bot(s) by capability (supervisor).
   * Server side in coordinator.ts (`supervise` RPC).
   */
  supervise(params: SuperviseParams): Promise<SuperviseResult> {
    return this.request<SuperviseResult>('supervise', params as unknown as Record<string, unknown>);
  }

  /** Persist one chat message in the bot's BotMemory (owned by the child). */
  saveMessage(
    botId: string,
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    threadId?: string,
    attachments?: VisionAttachment[],
  ): Promise<SaveMessageResult> {
    return this.request<SaveMessageResult>('saveMessage', {
      botId,
      role,
      content,
      threadId,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  }

  /** Read chat history from the bot's BotMemory (oldest first). */
  getHistory(
    botId: string,
    limit = 50,
    threadId?: string,
    includeAttachments = false,
  ): Promise<GetHistoryResult> {
    return this.request<GetHistoryResult>('getHistory', {
      botId,
      limit,
      threadId,
      ...(includeAttachments ? { includeAttachments: true } : {}),
    });
  }

  /**
   * v0.59 (UI-5): threads — one bot has many conversations.
   * `listThreads` always returns at least the bot's default thread
   * (created + legacy history migrated on first call). `locale` names
   * the default thread when one has to be created ('en' → 'New
   * conversation', otherwise the Vietnamese default).
   */
  listThreads(botId: string, locale?: string): Promise<ListThreadsResult> {
    return this.request<ListThreadsResult>('listThreads', { botId, locale });
  }

  createThread(botId: string, title?: string, locale?: string): Promise<CreateThreadResult> {
    return this.request<CreateThreadResult>('createThread', { botId, title, locale });
  }

  renameThread(threadId: string, title: string): Promise<RenameThreadResult> {
    return this.request<RenameThreadResult>('renameThread', { threadId, title });
  }

  deleteThread(threadId: string): Promise<DeleteThreadResult> {
    return this.request<DeleteThreadResult>('deleteThread', { threadId });
  }

  getThreadHistory(
    threadId: string,
    limit = 50,
    includeAttachments = false,
  ): Promise<GetThreadHistoryResult> {
    return this.request<GetThreadHistoryResult>('getThreadHistory', {
      threadId,
      limit,
      ...(includeAttachments ? { includeAttachments: true } : {}),
    });
  }

  /** Search threads by title/content; omit botId to search every bot. */
  searchThreads(query: string, botId?: string): Promise<SearchThreadsResult> {
    return this.request<SearchThreadsResult>('searchThreads', { query, botId });
  }

  /** List plan tasks for a bot. */
  listTasks(botId: string): Promise<ListTasksResult> {
    return this.request<ListTasksResult>('listTasks', { botId });
  }

  /**
   * v0.59 (UI-3): liệt kê tool của một bot đã tạo (màn Tools) — RPC
   * `listBotTools` (xem coordinator.ts).
   */
  listBotTools(botId: string): Promise<ListBotToolsResult> {
    return this.request<ListBotToolsResult>('listBotTools', { botId });
  }

  /**
   * v0.60 (UI-6): liệt kê lệnh slash của một bot đã tạo (popup
   * autocomplete) — RPC `listSlashCommands` (xem coordinator.ts).
   * Trả tên + mô tả, theo đúng registry resolve lệnh dùng.
   */
  listSlashCommands(botId: string): Promise<ListSlashCommandsResult> {
    return this.request<ListSlashCommandsResult>('listSlashCommands', { botId });
  }

  /**
   * v0.59 (UI-3): bật/tắt một tool của bot (màn Tools) — RPC
   * `setBotToolEnabled`, ghi vào denyTools của policy (xem
   * coordinator.ts). Persist bền do main lo (IPC `tools:toggle`).
   */
  setBotToolEnabled(
    botId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<SetBotToolEnabledResult> {
    return this.request<SetBotToolEnabledResult>('setBotToolEnabled', {
      botId,
      toolName,
      enabled,
    });
  }

  /**
   * v0.64 (skills per-bot): liệt kê skill của một bot đã tạo (màn
   * Tools) — RPC `listBotSkills` (xem coordinator.ts).
   */
  listBotSkills(botId: string): Promise<ListBotSkillsResult> {
    return this.request<ListBotSkillsResult>('listBotSkills', { botId });
  }

  /**
   * v0.64 (skills per-bot): bật/tắt một skill của bot (màn Tools) —
   * RPC `setBotSkillEnabled`, ghi vào denySkills của policy (xem
   * coordinator.ts). Persist bền do main lo (IPC `bot-skills:toggle`).
   */
  setBotSkillEnabled(
    botId: string,
    skillName: string,
    enabled: boolean,
  ): Promise<SetBotSkillEnabledResult> {
    return this.request<SetBotSkillEnabledResult>('setBotSkillEnabled', {
      botId,
      skillName,
      enabled,
    });
  }

  /** Health of the exec daemon owned by the coordinator child. */
  daemonStatus(): Promise<DaemonStatusResult> {
    return this.request<DaemonStatusResult>('daemonStatus', {});
  }

  /** M5 — trạng thái harness (registry instance + permission đang chờ). */
  harnessStatus(): Promise<HarnessStatusResult> {
    return this.request<HarnessStatusResult>('harnessStatus', {});
  }

  /** M5 — đọc lại NDJSON log theo thread (phân trang, lọc theo kind). */
  harnessThreadLog(params: HarnessThreadLogParams): Promise<HarnessThreadLogResult> {
    return this.request<HarnessThreadLogResult>(
      'harnessThreadLog',
      params as unknown as Record<string, unknown>,
    );
  }

  /** M5 — UI quyết một permission request đang chờ (thẻ Allow/Deny). */
  harnessDecidePermission(
    params: HarnessDecidePermissionParams,
  ): Promise<HarnessDecidePermissionResult> {
    return this.request<HarnessDecidePermissionResult>(
      'harnessDecidePermission',
      params as unknown as Record<string, unknown>,
    );
  }

  /** v0.50 (M8) — group chat bot-bot. */
  createGroupChat(params: CreateGroupChatParams): Promise<CreateGroupChatResult> {
    return this.request<CreateGroupChatResult>(
      'createGroupChat',
      params as unknown as Record<string, unknown>,
    );
  }

  listGroupChats(): Promise<ListGroupChatsResult> {
    return this.request<ListGroupChatsResult>('listGroupChats', {});
  }

  addBotToGroupChat(params: AddBotToGroupChatParams): Promise<AddBotToGroupChatResult> {
    return this.request<AddBotToGroupChatResult>(
      'addBotToGroupChat',
      params as unknown as Record<string, unknown>,
    );
  }

  removeBotFromGroupChat(
    params: RemoveBotFromGroupChatParams,
  ): Promise<RemoveBotFromGroupChatResult> {
    return this.request<RemoveBotFromGroupChatResult>(
      'removeBotFromGroupChat',
      params as unknown as Record<string, unknown>,
    );
  }

  deleteGroupChat(params: DeleteGroupChatParams): Promise<DeleteGroupChatResult> {
    return this.request<DeleteGroupChatResult>(
      'deleteGroupChat',
      params as unknown as Record<string, unknown>,
    );
  }

  postGroupMessage(params: PostGroupMessageParams): Promise<PostGroupMessageResult> {
    return this.request<PostGroupMessageResult>(
      'postGroupMessage',
      params as unknown as Record<string, unknown>,
    );
  }

  listGroupMessages(params: ListGroupMessagesParams): Promise<ListGroupMessagesResult> {
    return this.request<ListGroupMessagesResult>(
      'listGroupMessages',
      params as unknown as Record<string, unknown>,
    );
  }

  /** v0.94c: đọc lại bytes của một ảnh đính kèm trong message nhóm. */
  getGroupAttachment(params: GetGroupAttachmentParams): Promise<GetGroupAttachmentResult> {
    return this.request<GetGroupAttachmentResult>(
      'getGroupAttachment',
      params as unknown as Record<string, unknown>,
    );
  }

  /** v0.94c: digest của mọi project đang tới hạn (main tick 15 phút). */
  projectUpdatesDue(): Promise<ProjectUpdatesDueResult> {
    return this.request<ProjectUpdatesDueResult>('projectUpdatesDue', {});
  }

  /** v0.94c: ghi dấu đã gửi digest cho một project. */
  projectUpdatesMarkSent(
    params: ProjectUpdatesMarkSentParams,
  ): Promise<ProjectUpdatesMarkSentResult> {
    return this.request<ProjectUpdatesMarkSentResult>(
      'projectUpdatesMarkSent',
      params as unknown as Record<string, unknown>,
    );
  }

  /** v0.79a: các bot đang chạy trong một nhóm (GroupView poll). */
  getGroupBotStatus(params: GetGroupBotStatusParams): Promise<GetGroupBotStatusResult> {
    return this.request<GetGroupBotStatusResult>(
      'getGroupBotStatus',
      params as unknown as Record<string, unknown>,
    );
  }

  /** v0.82: bỏ qua ghi nhận "chạy dở thì app dừng" của một bot trong nhóm. */
  dismissGroupBotInterrupted(
    params: DismissGroupBotInterruptedParams,
  ): Promise<DismissGroupBotInterruptedResult> {
    return this.request<DismissGroupBotInterruptedResult>(
      'dismissGroupBotInterrupted',
      params as unknown as Record<string, unknown>,
    );
  }

  listBots(): Promise<ListBotsResult> {
    return this.request<ListBotsResult>('listBots', {});
  }

  /**
   * Fix v0.59 leftover (b): `deleteData: true` wipes the bot's
   * BotMemory rows too (real delete). Omit it to tear down the runtime
   * only and KEEP the data (bot edit / provider change / MCP install).
   */
  destroyBot(botId: string, opts?: { deleteData?: boolean }): Promise<DestroyBotResult> {
    const params: DestroyBotParams = { botId };
    if (opts?.deleteData === true) params.deleteData = true;
    return this.request<DestroyBotResult>(
      'destroyBot',
      params as unknown as Record<string, unknown>,
    );
  }

  /**
   * Fix v0.59 leftover (b): wipe one bot's BotMemory rows by workspace
   * dir — works even with no live runtime entry. Main's `bots:delete`
   * calls this after invalidating the runtime.
   */
  deleteBotData(params: DeleteBotDataParams): Promise<DeleteBotDataResult> {
    return this.request<DeleteBotDataResult>(
      'deleteBotData',
      params as unknown as Record<string, unknown>,
    );
  }

  ping(): Promise<PingResult> {
    return this.request<PingResult>('ping', {});
  }

  private disposePromise: Promise<void> | undefined;

  /**
   * Shut the coordinator down and wait for it to exit; after 5s the
   * child is killed. Safe to call more than once.
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    try {
      await Promise.race([
        this.request<ShutdownResult>('shutdown', {}, DISPOSE_TIMEOUT_MS).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS)),
      ]);
    } finally {
      this.disposed = true;
      // Give a cooperative shutdown a moment, then force-kill.
      const exited = await Promise.race([
        this.exitPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), DISPOSE_TIMEOUT_MS)),
      ]);
      if (exited === null) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // Already dead — nothing to do.
        }
        await this.exitPromise;
      }
      try {
        this.child.stdin.end();
      } catch {
        // Already closed — nothing to do.
      }
    }
  }
}
