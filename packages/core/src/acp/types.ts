/**
 * ACP (Agent Client Protocol) v1 — shared types for the agent side and
 * the client side (v1.02 rescue port of the v0.99 work).
 *
 * The wire format follows the public ACP v1 specification
 * (agentclientprotocol.com, Zed; stable v1): JSON-RPC 2.0,
 * newline-delimited (NDJSON) over the agent subprocess stdio. One
 * stdout line = one message; nothing else may be printed to stdout
 * (logs go to stderr). `protocolVersion` is a single integer, currently
 * 1. New features are optional capabilities; a capability that is
 * omitted means NOT supported — neither side may guess.
 *
 * Lifecycle: `initialize` -> (`authenticate` when needed) ->
 * `session/new` (absolute cwd + `mcpServers`) or `session/load`
 * (replay history) / `session/resume` (re-attach, no replay) ->
 * `session/prompt` <-> `session/update` (streaming) ->
 * `session/close` / `session/list` / `session/delete`.
 *
 * NOTE on the overloaded "ACP" acronym: IBM's Agent Communication
 * Protocol (REST, BeeAI) merged into A2A in August 2025 and is no
 * longer a standalone spec. The ACP implemented here is Zed's Agent
 * Client Protocol (editor <-> coding agent). See
 * docs/repo-survey-v102.md for the distinction.
 *
 * Only method/field names and semantics are taken from the public
 * docs; all code here is written fresh for open-bot. No third-party
 * ACP SDK is used (the transport is plain Node stdlib).
 */

/** The ACP protocol version open-bot speaks (v1 stable, integer). */
export const ACP_PROTOCOL_VERSION = 1;

/** Display name of the built-in agent in `agentInfo`. */
export const ACP_AGENT_NAME = 'open-bot';
/** Version written into `agentInfo`. */
export const ACP_AGENT_VERSION = '1.02.0';

/** Standard JSON-RPC 2.0 error codes (same set MCP/A2A servers use). */
export const ACP_JSON_RPC_PARSE_ERROR = -32700;
export const ACP_JSON_RPC_INVALID_REQUEST = -32600;
export const ACP_JSON_RPC_METHOD_NOT_FOUND = -32601;
export const ACP_JSON_RPC_INVALID_PARAMS = -32602;
export const ACP_JSON_RPC_INTERNAL_ERROR = -32603;
/** Request cancelled (LSP -32800, used for `$/cancel_request`). */
export const ACP_JSON_RPC_REQUEST_CANCELLED = -32800;

/** A JSON-RPC id (number or string — ACP clients use numbers). */
export type JsonRpcId = string | number;

/** One JSON-RPC 2.0 message (request / response / notification). */
export type JsonRpcMessage =
  | {
      jsonrpc: '2.0';
      id: JsonRpcId;
      method: string;
      params?: Record<string, unknown>;
    }
  | {
      jsonrpc: '2.0';
      id: JsonRpcId;
      result?: unknown;
      error?: JsonRpcErrorObject;
    }
  | { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> };

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** ACP error — always carries a JSON-RPC code for the other side. */
export class AcpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(message: string, code: number = ACP_JSON_RPC_INTERNAL_ERROR, data?: unknown) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}

/** True for plain JSON objects (params / result payloads). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Content blocks (prompt input / message chunk)
// ---------------------------------------------------------------------------

/** One content block inside a prompt (ACP v1). */
export type AcpContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'resource';
      resource: { uri: string; mimeType?: string; text?: string };
    }
  | {
      type: 'resource_link';
      uri: string;
      name?: string;
      mimeType?: string;
    }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

/** stopReason returned when `session/prompt` finishes a turn. */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/** Terminal stop reasons — the turn is over and will not change. */
export const ACP_TERMINAL_STOP_REASONS: readonly AcpStopReason[] = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
];

// ---------------------------------------------------------------------------
// Capabilities (initialize handshake)
// ---------------------------------------------------------------------------

export interface AcpLoadSessionCapabilities {
  loadSession?: boolean;
}

export interface AcpSessionCapabilities {
  resume?: boolean;
  close?: boolean;
  delete?: boolean;
  list?: boolean;
  setConfigOption?: boolean;
  setMode?: boolean;
}

export interface AcpPromptCapabilities {
  embeddedContext?: boolean;
  image?: boolean;
  audio?: boolean;
}

export interface AcpMcpCapabilities {
  http?: boolean;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: AcpSessionCapabilities;
  promptCapabilities?: AcpPromptCapabilities;
  mcpCapabilities?: AcpMcpCapabilities;
}

export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
}

/** What the agent advertises in `initialize`. */
export interface AcpAgentInfo {
  name: string;
  version: string;
  /** Extra agent metadata (free-form, shown by the client). */
  meta?: Record<string, unknown>;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: { name: string; version?: string };
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo: AcpAgentInfo;
  agentCapabilities: AcpAgentCapabilities;
  authMethods?: AcpAuthMethod[];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** An MCP server configured for a session (`session/new`). */
export interface AcpMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** A config option the client may change mid-session. */
export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  /** Current value (string | number | boolean). */
  value: unknown;
  /** Allowed values when the option is an enum. */
  options?: Array<{ id: string; name: string; description?: string }>;
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers?: Record<string, AcpMcpServerConfig>;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  mcpServers: Record<string, AcpMcpServerConfig>;
  configOptions: AcpConfigOption[];
  /** Number of recorded agent messages (for `session/load` replay). */
  messageCount: number;
}

/** One recorded agent message kept for `session/load` replay. */
export interface AcpRecordedMessage {
  role: 'user' | 'agent';
  text: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Prompt / updates
// ---------------------------------------------------------------------------

/** Streaming update pushed to the client as `session/update`. */
export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: 'pending' | 'in_progress' | 'completed' | 'failed';
      content?: AcpContentBlock[];
      rawInput?: Record<string, unknown>;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      status?: 'pending' | 'in_progress' | 'completed' | 'failed';
      content?: AcpContentBlock[];
      rawOutput?: unknown;
    }
  | { sessionUpdate: 'plan'; entries: Array<{ content: string; priority?: string; status?: string }> }
  | { sessionUpdate: 'available_commands_update'; availableCommands: Array<{ name: string; description?: string }> }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: 'usage_update'; usage?: Record<string, unknown> };

export interface AcpPromptResult {
  stopReason: AcpStopReason;
}

// ---------------------------------------------------------------------------
// Permissions (agent asks the client)
// ---------------------------------------------------------------------------

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCallId?: string;
  options: AcpPermissionOption[];
}

export interface AcpRequestPermissionResult {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}

// ---------------------------------------------------------------------------
// Client-side methods the agent may call (fs / terminal)
// ---------------------------------------------------------------------------

export interface AcpFsReadParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface AcpFsWriteParams {
  sessionId: string;
  path: string;
  content: string;
}

/** ACP method names (single source of truth for both sides). */
export const ACP_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionResume: 'session/resume',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionClose: 'session/close',
  sessionDelete: 'session/delete',
  sessionList: 'session/list',
  sessionSetConfigOption: 'session/set_config_option',
  sessionSetMode: 'session/set_mode',
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission',
  fsReadTextFile: 'fs/read_text_file',
  fsWriteTextFile: 'fs/write_text_file',
  cancelRequest: '$/cancel_request',
} as const;
