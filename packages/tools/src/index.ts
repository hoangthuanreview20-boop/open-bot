/**
 * @open-bot/tools — sandboxed tools for the open-bot agent.
 *
 * `createDefaultTools()` returns the 10 built-in tools. The agent core
 * (package `@open-bot/core`) imports the `Tool` / `ToolContext` /
 * `ToolDefinition` types and calls `tool.execute(args, ctx)`, handling
 * user approval from each tool's `needsApproval` flag.
 */
export { createDefaultTools, ALL_TOOLS } from './tools';
export {
  resolveWithin,
  runShell,
  assertCommandAllowed,
  DENYLIST_COMMANDS,
  MAX_OUTPUT_CHARS,
  DEFAULT_SHELL_TIMEOUT_MS,
} from './sandbox';
export type { RunShellOptions, RunShellResult } from './sandbox';
export type { Tool, ToolContext, ToolDefinition } from '@open-bot/core';
