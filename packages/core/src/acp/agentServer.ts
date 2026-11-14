/**
 * ACP agent side — open-bot as an ACP agent (v1.02 rescue port of the
 * v0.99 work).
 *
 * `AcpAgentServer` speaks ACP v1 over a `AcpJsonRpcPeer` (stdio in
 * production, in-memory streams in tests). Behavior:
 * - `initialize`: accepts only `protocolVersion` 1 (anything else is
 *   -32602); advertises `loadSession`, session capabilities
 *   (resume/close/delete/list/setConfigOption), prompt capability
 *   `embeddedContext`, MCP capability `http`. A second `initialize`
 *   is an error.
 * - `session/new`: `cwd` must be absolute, exist, and be a directory
 *   (and inside `allowedCwdRoots` when set). `mcpServers` are stored
 *   on the session and handed to the runner.
 * - `session/load`: restores a session and REPLAYS recorded agent
 *   messages via `agent_message_chunk`. (v1 has no replay kind for
 *   user messages, so user messages are not replayed — the client
 *   already holds the prompts it sent.)
 * - `session/resume`: re-attaches WITHOUT replay.
 * - `session/prompt`: one turn at a time per session (overlap is
 *   -32602); the runner streams through `onUpdate` and the turn ends
 *   with `{stopReason}`. Cancel via `session/cancel` or
 *   `$/cancel_request` -> the runner gets the AbortSignal and the
 *   turn reports `stopReason: 'cancelled'`.
 * - `session/list` / `close` / `delete`: `close` drops the session
 *   from memory only (the store keeps it for `load`); `delete`
 *   removes it from the store too.
 * - `session/set_config_option`: validates the value, returns the
 *   FULL option list. Default options: `mode` (default/plan) and
 *   `verbose` (boolean). `session/set_mode` (legacy) maps to `mode`.
 * - `authenticate` / `logout`: this agent has no auth methods, so
 *   both answer -32601 with a clear message (never pretend to log in).
 * - The agent asks the client for permission via
 *   `session/request_permission`, and reads/writes files via
 *   `fs/read_text_file` / `fs/write_text_file` ONLY when the client
 *   advertised the capability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ACP_AGENT_NAME,
  ACP_AGENT_VERSION,
  ACP_JSON_RPC_INVALID_PARAMS,
  ACP_JSON_RPC_METHOD_NOT_FOUND,
  ACP_PROTOCOL_VERSION,
  AcpError,
  isRecord,
  type AcpClientCapabilities,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpPromptResult,
  type AcpSessionInfo,
  type AcpSessionUpdate,
} from './types';
import { AcpJsonRpcPeer } from './transport';
import { AcpSessionStore, defaultAcpConfigOptions } from './sessionStore';
import { AcpRunnerRegistry, type AcpRunner } from './runner';

export interface AcpAgentServerOptions {
  /** Session persistence (a fresh in-memory store when omitted). */
  store?: AcpSessionStore;
  /** Runners available to prompts (echo is the default). */
  runners?: AcpRunnerRegistry;
  /** Name of the runner to use for prompts (default: 'echo'). */
  runnerName?: string;
  /** When set, new sessions must have their cwd under one of these roots. */
  allowedCwdRoots?: string[];
  /** Peer logger (default: silent). */
  logger?: (message: string) => void;
}

export interface AcpAgentServerStats {
  initialized: boolean;
  sessions: number;
  activeTurns: number;
  promptsCompleted: number;
  promptsCancelled: number;
}

/** open-bot as an ACP agent, speaking v1 over a JSON-RPC peer. */
export class AcpAgentServer {
  private readonly peer: AcpJsonRpcPeer;
  private readonly store: AcpSessionStore;
  private readonly runners: AcpRunnerRegistry;
  private readonly runnerName: string;
  private readonly allowedCwdRoots?: string[];
  private initialized = false;
  private clientCapabilities: AcpClientCapabilities = {};
  /** sessionId -> AbortController of the running turn (at most one). */
  private readonly activeTurns = new Map<string, AbortController>();
  private promptsCompleted = 0;
  private promptsCancelled = 0;

  constructor(peer: AcpJsonRpcPeer, options: AcpAgentServerOptions = {}) {
    this.peer = peer;
    this.store = options.store ?? new AcpSessionStore();
    this.runners = options.runners ?? new AcpRunnerRegistry();
    this.runnerName = options.runnerName ?? 'echo';
    this.allowedCwdRoots = options.allowedCwdRoots;
    this.registerHandlers();
  }

  /** Start serving (the peer already reads from its input stream). */
  start(): void {
    // Handlers are registered in the constructor; nothing else to do.
  }

  getStats(): AcpAgentServerStats {
    return {
      initialized: this.initialized,
      sessions: this.store.size,
      activeTurns: this.activeTurns.size,
      promptsCompleted: this.promptsCompleted,
      promptsCancelled: this.promptsCancelled,
    };
  }

  private registerHandlers(): void {
    this.peer.onRequest('initialize', (params) => this.handleInitialize(params));
    this.peer.onRequest('authenticate', () => {
      throw new AcpError('this agent has no authentication methods', ACP_JSON_RPC_METHOD_NOT_FOUND);
    });
    this.peer.onRequest('session/new', (params) => this.handleSessionNew(params));
    this.peer.onRequest('session/load', (params) => this.handleSessionLoad(params));
    this.peer.onRequest('session/resume', (params) => this.handleSessionResume(params));
    this.peer.onRequest('session/prompt', (params, signal) => this.handleSessionPrompt(params, signal));
    this.peer.onRequest('session/cancel', (params) => this.handleSessionCancel(params));
    this.peer.onRequest('session/close', (params) => this.handleSessionClose(params));
    this.peer.onRequest('session/delete', (params) => this.handleSessionDelete(params));
    this.peer.onRequest('session/list', () => this.handleSessionList());
    this.peer.onRequest('session/set_config_option', (params) => this.handleSetConfigOption(params));
    this.peer.onRequest('session/set_mode', (params) => this.handleSetMode(params));
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new AcpError('initialize first', ACP_JSON_RPC_INVALID_PARAMS);
    }
  }

  private handleInitialize(params: Record<string, unknown> | undefined): AcpInitializeResult {
    if (this.initialized) {
      throw new AcpError('already initialized', ACP_JSON_RPC_INVALID_PARAMS);
    }
    const version = params?.protocolVersion;
    if (version !== ACP_PROTOCOL_VERSION) {
      throw new AcpError(
        `unsupported protocolVersion ${String(version)} (expected ${ACP_PROTOCOL_VERSION})`,
        ACP_JSON_RPC_INVALID_PARAMS,
      );
    }
    if (isRecord(params?.clientCapabilities)) {
      this.clientCapabilities = params.clientCapabilities as AcpClientCapabilities;
    }
    this.initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: { name: ACP_AGENT_NAME, version: ACP_AGENT_VERSION },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          resume: true,
          close: true,
          delete: true,
          list: true,
          setConfigOption: true,
          setMode: true,
        },
        promptCapabilities: { embeddedContext: true },
        mcpCapabilities: { http: true },
      },
      authMethods: [],
    };
  }

  private validateCwd(cwd: unknown): string {
    if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd)) {
      throw new AcpError('session/new requires an absolute cwd', ACP_JSON_RPC_INVALID_PARAMS);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      throw new AcpError(`cwd does not exist: ${cwd}`, ACP_JSON_RPC_INVALID_PARAMS);
    }
    if (!stat.isDirectory()) {
      throw new AcpError(`cwd is not a directory: ${cwd}`, ACP_JSON_RPC_INVALID_PARAMS);
    }
    if (this.allowedCwdRoots && this.allowedCwdRoots.length > 0) {
      const resolved = path.resolve(cwd);
      const inside = this.allowedCwdRoots.some((root) => {
        const rootResolved = path.resolve(root);
        return resolved === rootResolved || resolved.startsWith(`${rootResolved}${path.sep}`);
      });
      if (!inside) {
        throw new AcpError(`cwd is outside the allowed roots: ${cwd}`, ACP_JSON_RPC_INVALID_PARAMS);
      }
    }
    return cwd;
  }

  private handleSessionNew(params: Record<string, unknown> | undefined): AcpSessionInfo {
    this.requireInitialized();
    const cwd = this.validateCwd(params?.cwd);
    const mcpServers = isRecord(params?.mcpServers)
      ? (params.mcpServers as Record<string, never>)
      : {};
    const session = this.store.create({ cwd, mcpServers: mcpServers as AcpSessionInfo['mcpServers'] });
    return this.toSessionInfo(session.sessionId);
  }

  private handleSessionLoad(params: Record<string, unknown> | undefined): AcpSessionInfo {
    this.requireInitialized();
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new AcpError('session/load requires sessionId', ACP_JSON_RPC_INVALID_PARAMS);
    }
    const session = this.store.get(sessionId);
    if (!session) throw new AcpError(`unknown session: ${sessionId}`, ACP_JSON_RPC_INVALID_PARAMS);
    // Replay recorded agent messages so the client rebuilds the transcript.
    for (const message of session.messages) {
      if (message.role !== 'agent') continue;
      void this.peer.sendNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: message.text },
        } satisfies AcpSessionUpdate,
      });
    }
    return this.toSessionInfo(sessionId);
  }

  private handleSessionResume(params: Record<string, unknown> | undefined): AcpSessionInfo {
    this.requireInitialized();
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new AcpError('session/resume requires sessionId', ACP_JSON_RPC_INVALID_PARAMS);
    }
    if (!this.store.has(sessionId)) {
      throw new AcpError(`unknown session: ${sessionId}`, ACP_JSON_RPC_INVALID_PARAMS);
    }
    return this.toSessionInfo(sessionId);
  }

  private async handleSessionPrompt(
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<AcpPromptResult> {
    this.requireInitialized();
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new AcpError('session/prompt requires sessionId', ACP_JSON_RPC_INVALID_PARAMS);
    }
    const session = this.store.get(sessionId);
    if (!session) throw new AcpError(`unknown session: ${sessionId}`, ACP_JSON_RPC_INVALID_PARAMS);
    if (this.activeTurns.has(sessionId)) {
      throw new AcpError(`a turn is already running for session ${sessionId}`, ACP_JSON_RPC_INVALID_PARAMS);
    }
    const prompt = Array.isArray(params?.prompt) ? (params.prompt as AcpContentBlock[]) : [];
    const controller = new AbortController();
    this.activeTurns.set(sessionId, controller);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    // Record the user prompt first so replay order matches the transcript.
    this.store.recordMessage(sessionId, {
      role: 'user',
      text: prompt.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n'),
      at: new Date().toISOString(),
    });
    try {
      const runner = this.runners.get(this.runnerName);
      const result = await runner.run(prompt, {
        sessionId,
        cwd: session.cwd,
        prompt,
        onUpdate: (update) => {
          void this.peer.sendNotification('session/update', { sessionId, update });
        },
        requestPermission: (options) => this.requestPermission(sessionId, options),
        readTextFile: this.clientCapabilities.fs?.readTextFile
          ? (filePath) => this.readClientFile(sessionId, filePath)
          : undefined,
        writeTextFile: this.clientCapabilities.fs?.writeTextFile
          ? (filePath, content) => this.writeClientFile(sessionId, filePath, content)
          : undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        this.promptsCancelled++;
        return { stopReason: 'cancelled' };
      }
      this.promptsCompleted++;
      if (result.text) {
        this.store.recordMessage(sessionId, { role: 'agent', text: result.text, at: new Date().toISOString() });
      }
      return { stopReason: result.stopReason };
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.activeTurns.delete(sessionId);
    }
  }

  private handleSessionCancel(params: Record<string, unknown> | undefined): { cancelled: boolean } {
    this.requireInitialized();
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new AcpError('session/cancel requires sessionId', ACP_JSON_RPC_INVALID_PARAMS);
    }
    const controller = this.activeTurns.get(sessionId);
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  private handleSessionClose(params: Record<string, unknown> | undefined): { closed: boolean } {
    this.requireInitialized();
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new AcpError('session/close requires sessionId', ACP_JSON_RPC_INVALID_PARAMS);
    }
    return { closed: this.store.close(sessionId) };
  }

  private handleSessionDelete(params: Record<string, unknown> | undefined): { deleted: boolean } {
    this.requireInitialized();
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new AcpError('session/delete requires sessionId', ACP_JSON_RPC_INVALID_PARAMS);
    }
    return { deleted: this.store.delete(sessionId) };
  }

  private handleSessionList(): { sessions: AcpSessionInfo[] } {
    this.requireInitialized();
    return { sessions: this.store.list().map((s) => this.toSessionInfo(s.sessionId)) };
  }

  private handleSetConfigOption(params: Record<string, unknown> | undefined): { configOptions: AcpConfigOption[] } {
    this.requireInitialized();
    const sessionId = params?.sessionId;
    const optionId = params?.optionId;
    if (typeof sessionId !== 'string' || typeof optionId !== 'string') {
      throw new AcpError('session/set_config_option requires sessionId and optionId', ACP_JSON_RPC_INVALID_PARAMS);
    }
    const options = this.store.setConfigOption(sessionId, optionId, params?.value);
    if (!options) {
      throw new AcpError(`unknown session or option: ${sessionId}/${optionId}`, ACP_JSON_RPC_INVALID_PARAMS);
    }
    return { configOptions: options };
  }

  private handleSetMode(params: Record<string, unknown> | undefined): { configOptions: AcpConfigOption[] } {
    // Legacy alias: set_mode maps onto the `mode` config option.
    return this.handleSetConfigOption({ ...(params ?? {}), optionId: 'mode', value: params?.modeId });
  }

  private async requestPermission(
    sessionId: string,
    options: Array<{ optionId: string; name: string }>,
  ): Promise<string | null> {
    const result = (await this.peer.request('session/request_permission', {
      sessionId,
      options: options.map((o) => ({ ...o, kind: 'allow_once' as const })),
    })) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
    if (result?.outcome?.outcome === 'selected' && typeof result.outcome.optionId === 'string') {
      return result.outcome.optionId;
    }
    return null;
  }

  private async readClientFile(sessionId: string, filePath: string): Promise<string> {
    const result = (await this.peer.request('fs/read_text_file', { sessionId, path: filePath })) as
      | { content?: string }
      | undefined;
    return typeof result?.content === 'string' ? result.content : '';
  }

  private async writeClientFile(sessionId: string, filePath: string, content: string): Promise<void> {
    await this.peer.request('fs/write_text_file', { sessionId, path: filePath, content });
  }

  private toSessionInfo(sessionId: string): AcpSessionInfo {
    const session = this.store.get(sessionId);
    if (!session) throw new AcpError(`unknown session: ${sessionId}`, ACP_JSON_RPC_INVALID_PARAMS);
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      mcpServers: session.mcpServers,
      configOptions: session.configOptions,
      messageCount: session.messageCount,
    };
  }
}

/** Default config options (re-exported for hosts/tests). */
export { defaultAcpConfigOptions };
