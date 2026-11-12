/**
 * CLI providers (M1–M3) — public surface of packages/core/src/providers/cli/.
 *
 * Driver cho các CLI agent trên máy user. M1: Claude Code; M2: Codex
 * (app-server JSON-RPC) + Grok CLI (ACP). M3: tách tầng ACP chung
 * (`BaseAcpCliProvider` ở acpProvider.ts + `AcpClient` ở acp.ts) cho
 * mọi CLI nói ACP — Grok (mỏng hoá), OpenCode, Gemini CLI, Cursor CLI
 * và Custom ACP CLI. M4 (sóng B): tầng one-shot text chung
 * (`BaseOneShotCliProvider` ở oneShot.ts) cho Aider / Continue /
 * Amazon Q, + driver ACP Copilot CLI và Windsurf (Devin CLI).
 * Các driver tái dùng event chuẩn + env sanitization + process
 * management + transport JSON-RPC NDJSON ở đây.
 */
export {
  ClaudeCodeCliProvider,
  CLAUDE_CLI_DEFAULT_TIMEOUT_MS,
} from './claude';
export type { ClaudeCodeCliProviderOptions } from './claude';
export { CLAUDE_STREAM_JSON_ARGS, NdjsonEventParser, mapClaudeEvent, toClaudeInputLine } from './claudeStream';
export type { ClaudeStreamParseStats } from './claudeStream';
export { CodexCliProvider, CODEX_CLI_DEFAULT_TIMEOUT_MS } from './codex';
export type { CodexCliProviderOptions } from './codex';
export {
  CodexAppServerClient,
  CODEX_APPROVAL_POLICY,
  denyCodexApproval,
  isCodexApprovalRequest,
} from './codexAppServer';
export type { CodexAppServerClientOptions, CodexTurnResult } from './codexAppServer';
export { GrokCliProvider, GROK_ACP_ARGS, GROK_CLI_DEFAULT_TIMEOUT_MS } from './grok';
export type { GrokCliProviderOptions } from './grok';
export { AcpClient, ACP_PROTOCOL_VERSION } from './acp';
export type { AcpClientOptions, AcpPromptResult, AcpStopReason } from './acp';
export {
  BaseAcpCliProvider,
  ACP_CLI_DEFAULT_TIMEOUT_MS,
} from './acpProvider';
export type { AcpCliProviderIdentity, AcpCliProviderOptions } from './acpProvider';
export { OpenCodeCliProvider, OPENCODE_ACP_ARGS, OPENCODE_CLI_DEFAULT_TIMEOUT_MS } from './opencode';
export type { OpenCodeCliProviderOptions } from './opencode';
export {
  GeminiCliProvider,
  GEMINI_ACP_ARGS,
  GEMINI_ACP_LEGACY_ARGS,
  GEMINI_CLI_DEFAULT_TIMEOUT_MS,
} from './geminiCli';
export type { GeminiCliProviderOptions } from './geminiCli';
export {
  CursorCliProvider,
  CURSOR_ACP_ARGS,
  CURSOR_ACP_AUTH_METHOD_ID,
  CURSOR_CLI_DEFAULT_TIMEOUT_MS,
} from './cursorCli';
export type { CursorCliProviderOptions } from './cursorCli';
export { CustomAcpCliProvider, CUSTOM_ACP_CLI_DEFAULT_TIMEOUT_MS } from './customAcp';
export type { CustomAcpCliProviderOptions } from './customAcp';
export {
  BaseOneShotCliProvider,
  ONE_SHOT_CLI_DEFAULT_TIMEOUT_MS,
  defaultParseOneShotOutput,
  renderOneShotPrompt,
  stripAnsi,
} from './oneShot';
export type { OneShotCliProviderIdentity, OneShotCliProviderOptions } from './oneShot';
export { AiderCliProvider, AIDER_CLI_DEFAULT_TIMEOUT_MS, AIDER_KEY_ENV_VARS, aiderOneShotArgs, parseAiderUsage } from './aider';
export type { AiderCliProviderOptions } from './aider';
export {
  ContinueCliProvider,
  CONTINUE_CLI_DEFAULT_TIMEOUT_MS,
  CONTINUE_CLI_ENV_VARS,
  continueCliOneShotArgs,
} from './continueCli';
export type { ContinueCliProviderOptions } from './continueCli';
export {
  AmazonQCliProvider,
  AMAZON_Q_CLI_DEFAULT_TIMEOUT_MS,
  AMAZON_Q_ENV_VARS,
  amazonQOneShotArgs,
} from './amazonQ';
export type { AmazonQCliProviderOptions } from './amazonQ';
export {
  KiroCliProvider,
  KIRO_CLI_DEFAULT_TIMEOUT_MS,
  KIRO_CLI_ENV_VARS,
  kiroCliOneShotArgs,
} from './kiroCli';
export type { KiroCliProviderOptions } from './kiroCli';
export {
  CopilotCliProvider,
  COPILOT_ACP_ARGS,
  COPILOT_CLI_DEFAULT_TIMEOUT_MS,
  COPILOT_CLI_ENV_VARS,
} from './copilotCli';
export type { CopilotCliProviderOptions } from './copilotCli';
export {
  WindsurfCliProvider,
  WINDSURF_ACP_ARGS,
  WINDSURF_CLI_DEFAULT_TIMEOUT_MS,
  isDevinCliBinary,
} from './windsurf';
export type { WindsurfCliProviderOptions } from './windsurf';
export { JsonRpcResponseError, JsonRpcStdioClient } from './jsonRpc';
export type { JsonRpcClientOptions, JsonRpcError, JsonRpcStats } from './jsonRpc';
export { killProcessGroup, spawnCli, waitForExit } from './process';
export type { SpawnCliOptions } from './process';
export { looksLikeSecret, sanitizeEnvForCli } from './env';
export type { CliEvent, CliPermissionHandler } from './types';
export {
  AIDER_MODEL_ID,
  AIDER_PROVIDER_ID,
  AMAZON_Q_MODEL_ID,
  AMAZON_Q_PROVIDER_ID,
  CLAUDE_CODE_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  CONTINUE_CLI_MODEL_ID,
  CONTINUE_CLI_PROVIDER_ID,
  COPILOT_CLI_MODEL_ID,
  COPILOT_CLI_PROVIDER_ID,
  CODEX_MODEL_ID,
  CODEX_PROVIDER_ID,
  CURSOR_CLI_MODEL_ID,
  CURSOR_CLI_PROVIDER_ID,
  CUSTOM_ACP_MODEL_ID,
  CUSTOM_ACP_PROVIDER_ID,
  GEMINI_CLI_MODEL_ID,
  GEMINI_CLI_PROVIDER_ID,
  GROK_CLI_MODEL_ID,
  GROK_CLI_PROVIDER_ID,
  KIRO_CLI_MODEL_ID,
  KIRO_CLI_PROVIDER_ID,
  OPENCODE_MODEL_ID,
  OPENCODE_PROVIDER_ID,
  WINDSURF_MODEL_ID,
  WINDSURF_PROVIDER_ID,
} from './types';
