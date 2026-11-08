/**
 * @open-bot/core — public surface.
 * Shared types, LLM providers, agent loop, SQLite memory and routines.
 */

export type * from './types';

export {
  createProvider,
  PROVIDERS,
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAIProvider,
  OpenAICompatibleProvider,
  XAIProvider,
} from './providers/index';
export type { ProviderMeta } from './providers/index';

export { AgentRunner } from './agent/loop';
export type { AgentRunnerOptions } from './agent/loop';

export { BotMemory } from './agent/memory';
export type { BotRow, TaskItem, TaskStatus } from './agent/memory';

export { isRoutineDue, loadRoutines, routinesDue, saveRoutine } from './agent/routines';
export type { Routine } from './agent/routines';
