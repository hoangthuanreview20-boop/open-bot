/**
 * ACP client side — talk ACP v1 to an external agent (v1.02 rescue
 * port of the v0.99 work).
 *
 * `AcpClient` drives an outside agent process over stdio (spawned
 * with `spawnAcpAgent`) or over in-memory streams (tests). It is the
 * mirror of `AcpAgentServer`: initialize, create/load/resume
 * sessions, stream prompts (`session/prompt` with `session/update`
 * notifications), cancel turns, and answer the agent's permission
 * requests and file reads/writes through host callbacks.
 *
 * Safety: the client never auto-approves a permission request — the
 * host's `onPermissionRequest` decides (default: reject). File access
 * the agent asks for is answered only through the host-provided
 * callbacks, so the host keeps full control of what the agent may
 * read or write.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

import {
  ACP_JSON_RPC_INVALID_PARAMS,
  ACP_PROTOCOL_VERSION,
  AcpError,
  isRecord,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpPromptResult,
  type AcpSessionInfo,
  type AcpSessionUpdate,
} from './types';
import { AcpJsonRpcPeer, AcpJsonRpcError } from './transport';

export interface AcpPermissionRequest {
  sessionId: string;
  toolCallId?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface AcpClientOptions {
  /** Peer logger (default: silent). */
  logger?: (message: string) => void;
  /** Decide permission requests (default: cancel — fail-closed). */
  onPermissionRequest?: (request: AcpPermissionRequest) => Promise<string | null>;
  /** Read a file the agent asks for (undefined = refuse). */
  onReadTextFile?: (filePath: string, sessionId: string) => Promise<string>;
  /** Write a file the agent asks for (undefined = refuse). */
  onWriteTextFile?: (filePath: string, content: string, sessionId: string) => Promise<void>;
  /** Called for every streaming session update. */
  onSessionUpdate?: (sessionId: string, update: AcpSessionUpdate) => void;
  /** Client capabilities advertised in `initialize`. */
  clientCapabilities?: { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean };
  /** Timeout for `initialize` (default 30s). */
  initializeTimeoutMs?: number;
}

/** A running external ACP agent process (stdio). */
export interface AcpAgentProcess {
  process: ChildProcessWithoutNullStreams;
  client: AcpClient;
}

/**
 * Spawn an external ACP agent binary and return a client attached to
 * its stdio. The caller owns the process (kill it when done).
 */
export function spawnAcpAgent(
  command: string,
  args: string[] = [],
  options: AcpClientOptions & { cwd?: string; env?: Record<string, string> } = {},
): AcpAgentProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const peer = new AcpJsonRpcPeer(child.stdout, child.stdin, { logger: options.logger });
  const client = new AcpClient(peer, options);
  return { process: child, client };
}

/** Client for one external ACP agent. */
export class AcpClient {
  private readonly peer: AcpJsonRpcPeer;
  private readonly options: AcpClientOptions;
  private initializedResult?: AcpInitializeResult;
  private readonly pendingTurns = new Map<string, AbortController>();
  /** Per-turn update callbacks (registered by prompt's onUpdate argument). */
  private readonly turnUpdateHandlers = new Map<string, Set<(update: AcpSessionUpdate) => void>>();

  constructor(peer: AcpJsonRpcPeer, options: AcpClientOptions = {}) {
    this.peer = peer;
    this.options = options;
    this.peer.onRequest('session/request_permission', (params) => this.handlePermissionRequest(params));
    this.peer.onRequest('fs/read_text_file', (params) => this.handleReadTextFile(params));
    this.peer.onRequest('fs/write_text_file', (params) => this.handleWriteTextFile(params));
    this.peer.onNotification('session/update', (params) => {
      const sessionId = params?.sessionId;
      const update = params?.update;
      if (typeof sessionId === 'string' && isRecord(update)) {
        const typed = update as unknown as AcpSessionUpdate;
        this.options.onSessionUpdate?.(sessionId, typed);
        for (const handler of this.turnUpdateHandlers.get(sessionId) ?? []) handler(typed);
      }
    });
  }

  /** Run the `initialize` handshake. Must be called first. */
  async initialize(): Promise<AcpInitializeResult> {
    const timeoutMs = this.options.initializeTimeoutMs ?? 30_000;
    const result = await this.withTimeout(
      this.peer.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: this.options.clientCapabilities ?? {
          fs: {
            readTextFile: Boolean(this.options.onReadTextFile),
            writeTextFile: Boolean(this.options.onWriteTextFile),
          },
        },
        clientInfo: { name: 'open-bot', version: '1.02.0' },
      }),
      timeoutMs,
      'ACP initialize timed out',
    );
    if (!isRecord(result) || result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpError('agent speaks an unsupported ACP protocol version', ACP_JSON_RPC_INVALID_PARAMS);
    }
    this.initializedResult = result as unknown as AcpInitializeResult;
    return this.initializedResult;
  }

  get agentInfo(): AcpInitializeResult | undefined {
    return this.initializedResult;
  }

  get isInitialized(): boolean {
    return this.initializedResult !== undefined;
  }

  private requireInitialized(): void {
    if (!this.initializedResult) throw new AcpError('initialize first', ACP_JSON_RPC_INVALID_PARAMS);
  }

  /** Create a session in an absolute working directory. */
  async newSession(cwd: string, mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }>): Promise<AcpSessionInfo> {
    this.requireInitialized();
    if (!path.isAbsolute(cwd)) {
      throw new AcpError('session/new requires an absolute cwd', ACP_JSON_RPC_INVALID_PARAMS);
    }
    const result = await this.peer.request('session/new', { cwd, ...(mcpServers ? { mcpServers } : {}) });
    return result as unknown as AcpSessionInfo;
  }

  /** Load a session (the agent replays its recorded messages). */
  async loadSession(sessionId: string): Promise<AcpSessionInfo> {
    this.requireInitialized();
    const result = await this.peer.request('session/load', { sessionId });
    return result as unknown as AcpSessionInfo;
  }

  /** Resume a session without replay. */
  async resumeSession(sessionId: string): Promise<AcpSessionInfo> {
    this.requireInitialized();
    const result = await this.peer.request('session/resume', { sessionId });
    return result as unknown as AcpSessionInfo;
  }

  /** Send a prompt and await the turn result (updates stream via onSessionUpdate). */
  async prompt(
    sessionId: string,
    prompt: AcpContentBlock[],
    onUpdateOrSignal?: ((update: AcpSessionUpdate) => void) | AbortSignal,
    signal?: AbortSignal,
  ): Promise<AcpPromptResult> {
    this.requireInitialized();
    if (this.pendingTurns.has(sessionId)) {
      throw new AcpError(`a turn is already running for session ${sessionId}`, ACP_JSON_RPC_INVALID_PARAMS);
    }
    // The 3rd argument is either a per-turn update callback (the shape
    // the A2A adapter's runner interface uses) or an AbortSignal.
    const onUpdate = typeof onUpdateOrSignal === 'function' ? onUpdateOrSignal : undefined;
    const abortSignal = typeof onUpdateOrSignal === 'function' ? signal : onUpdateOrSignal;
    const controller = new AbortController();
    this.pendingTurns.set(sessionId, controller);
    if (onUpdate) {
      let handlers = this.turnUpdateHandlers.get(sessionId);
      if (!handlers) {
        handlers = new Set();
        this.turnUpdateHandlers.set(sessionId, handlers);
      }
      handlers.add(onUpdate);
    }
    const onAbort = () => {
      void this.peer.sendNotification('session/cancel', { sessionId });
      controller.abort();
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.peer.request('session/prompt', { sessionId, prompt }, controller.signal);
      return result as unknown as AcpPromptResult;
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      if (onUpdate) this.turnUpdateHandlers.get(sessionId)?.delete(onUpdate);
      this.pendingTurns.delete(sessionId);
    }
  }

  /** Cancel the running turn of a session. */
  async cancelSession(sessionId: string): Promise<boolean> {
    this.requireInitialized();
    const result = (await this.peer.request('session/cancel', { sessionId })) as { cancelled?: boolean } | undefined;
    return result?.cancelled === true;
  }

  /** List sessions known to the agent. */
  async listSessions(): Promise<AcpSessionInfo[]> {
    this.requireInitialized();
    const result = (await this.peer.request('session/list', {})) as { sessions?: unknown } | undefined;
    return Array.isArray(result?.sessions) ? (result.sessions as AcpSessionInfo[]) : [];
  }

  /** Close a session (kept on the agent side for later `load`). */
  async closeSession(sessionId: string): Promise<boolean> {
    this.requireInitialized();
    const result = (await this.peer.request('session/close', { sessionId })) as { closed?: boolean } | undefined;
    return result?.closed === true;
  }

  /** Delete a session from the agent side. */
  async deleteSession(sessionId: string): Promise<boolean> {
    this.requireInitialized();
    const result = (await this.peer.request('session/delete', { sessionId })) as { deleted?: boolean } | undefined;
    return result?.deleted === true;
  }

  /** Change one config option; returns the full option list. */
  async setConfigOption(sessionId: string, optionId: string, value: unknown): Promise<unknown> {
    this.requireInitialized();
    const result = (await this.peer.request('session/set_config_option', { sessionId, optionId, value })) as
      | { configOptions?: unknown }
      | undefined;
    return result?.configOptions;
  }

  /** Transport counters (useful for diagnostics). */
  getStats() {
    return this.peer.getStats();
  }

  /** Close the underlying peer (pending requests fail). */
  close(): void {
    this.peer.close();
  }

  private async handlePermissionRequest(
    params: Record<string, unknown> | undefined,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    const options = Array.isArray(params?.options)
      ? (params.options as Array<{ optionId: string; name: string; kind: string }>)
      : [];
    const chosen = this.options.onPermissionRequest
      ? await this.options.onPermissionRequest({ sessionId, options })
      : null;
    if (chosen && options.some((o) => o.optionId === chosen)) {
      return { outcome: { outcome: 'selected', optionId: chosen } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  private async handleReadTextFile(params: Record<string, unknown> | undefined): Promise<{ content: string }> {
    if (!this.options.onReadTextFile) {
      throw new AcpJsonRpcError({ code: ACP_JSON_RPC_INVALID_PARAMS, message: 'fs/read_text_file is not available' });
    }
    const filePath = typeof params?.path === 'string' ? params.path : '';
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    const content = await this.options.onReadTextFile(filePath, sessionId);
    return { content };
  }

  private async handleWriteTextFile(params: Record<string, unknown> | undefined): Promise<Record<string, never>> {
    if (!this.options.onWriteTextFile) {
      throw new AcpJsonRpcError({ code: ACP_JSON_RPC_INVALID_PARAMS, message: 'fs/write_text_file is not available' });
    }
    const filePath = typeof params?.path === 'string' ? params.path : '';
    const content = typeof params?.content === 'string' ? params.content : '';
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    await this.options.onWriteTextFile(filePath, content, sessionId);
    return {};
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AcpError(message, ACP_JSON_RPC_INVALID_PARAMS)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
