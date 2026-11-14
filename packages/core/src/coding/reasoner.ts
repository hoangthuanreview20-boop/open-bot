/**
 * Reasoners: the "brain" of a coding agent (v1.02, Team T4).
 *
 * The agent loop does not care which model thinks — it only needs a
 * `Reasoner` that turns the current state into the next action. Three
 * implementations ship here:
 *
 * - `ScriptedReasoner`: replays a fixed script of thought+action
 *   pairs. Deterministic; used by tests and the eval harness.
 * - `RuleReasoner`: a model-free heuristic. It walks the plan, runs
 *   the scripted file edits a task carries, runs the verify command,
 *   retries a failed check once, then finishes. No model needed, so
 *   the loop is fully testable offline.
 * - `ProviderReasoner`: wraps any open-bot `Provider` (any model can
 *   be the brain — Grok, OpenAI, Anthropic, Gemini, Ollama, CLI
 *   logins). It asks the model for one JSON action per step and
 *   validates the result before the loop executes it.
 */

import type { CodingAction } from './actions';
import { describeAction } from './actions';
import { estimateTokensFromChars } from './budget';
import type { CodingPlan } from './planner';
import type { ActionObservation } from './actions';
import type { ChatMessage, Provider } from '../types';

/** What the reasoner sees before deciding the next action. */
export interface ReasonInput {
  task: string;
  plan: CodingPlan;
  /** Loop step about to run (1-based). */
  step: number;
  /** Files currently in the workspace (relative paths). */
  files: string[];
  /** Recent observations, newest last (capped by the caller). */
  history: ActionObservation[];
  /** Last failed check, if the loop is in fix mode. */
  lastCheckFailure?: { name: string; detail: string };
  /** Fix attempts already used. */
  fixAttempts: number;
  /** Whether another fix attempt is allowed. */
  canFix: boolean;
}

/** What a reasoner returns: one thought + one action. */
export interface ReasonOutput {
  thought: string;
  action: CodingAction;
  /** Tokens the reasoning consumed (0 for local reasoners). */
  inputTokens: number;
  outputTokens: number;
}

/** A reasoner: state in, next action out. */
export interface Reasoner {
  /** Model id for budgeting / events ('scripted' / 'rule' for local ones). */
  readonly model: string;
  reason(input: ReasonInput): Promise<ReasonOutput>;
}

/** A scripted step: fixed thought + fixed action. */
export interface ScriptedStep {
  thought: string;
  action: CodingAction;
}

/**
 * Deterministic reasoner: returns the scripted steps in order, then
 * finishes. The backbone of tests and evals.
 */
export class ScriptedReasoner implements Reasoner {
  readonly model = 'scripted';
  private readonly steps: ScriptedStep[];
  private index = 0;

  constructor(steps: ScriptedStep[]) {
    this.steps = steps;
  }

  async reason(_input: ReasonInput): Promise<ReasonOutput> {
    const step = this.steps[this.index];
    this.index += 1;
    if (!step) {
      return {
        thought: 'Script exhausted — finishing.',
        action: { kind: 'finish', summary: 'Script exhausted.', success: false },
        inputTokens: 0,
        outputTokens: 0,
      };
    }
    return { thought: step.thought, action: step.action, inputTokens: 0, outputTokens: 0 };
  }
}

/** File edits a task carries for the RuleReasoner to execute. */
export interface RuleTaskFile {
  path: string;
  content: string;
}

/**
 * Model-free heuristic reasoner. It drives the plan mechanically:
 * explore (no-op, plan advances), implement (apply the task's file
 * edits in order, creating or overwriting), verify (run the task's
 * verify command), then finish. A failed check is retried once when
 * the budget allows; a second failure finishes with failure.
 */
export class RuleReasoner implements Reasoner {
  readonly model = 'rule';
  private readonly files: RuleTaskFile[];
  private readonly verifyArgv: string[] | null;
  private fileIndex = 0;
  private verifyTried = false;

  constructor(options: { files?: RuleTaskFile[]; verifyArgv?: string[] } = {}) {
    this.files = options.files ?? [];
    this.verifyArgv = options.verifyArgv ?? null;
  }

  async reason(input: ReasonInput): Promise<ReasonOutput> {
    const noTokens = { inputTokens: 0, outputTokens: 0 };
    // Fix mode: a check failed. Retry the verify command once, else give up.
    if (input.lastCheckFailure) {
      if (input.canFix && this.verifyArgv && !this.verifyTried) {
        this.verifyTried = true;
        return {
          thought: `Check "${input.lastCheckFailure.name}" failed; retrying the verify command once.`,
          action: { kind: 'run_command', argv: this.verifyArgv },
          ...noTokens,
        };
      }
      return {
        thought: 'Check failed and no fix is available — finishing with failure.',
        action: {
          kind: 'finish',
          summary: `Verification failed: ${input.lastCheckFailure.name}. ${input.lastCheckFailure.detail}`,
          success: false,
        },
        ...noTokens,
      };
    }
    // Implement: apply the next carried file edit.
    if (this.fileIndex < this.files.length) {
      const file = this.files[this.fileIndex] as RuleTaskFile;
      this.fileIndex += 1;
      const exists = input.files.includes(file.path);
      return {
        thought: exists
          ? `Applying carried edit to existing file ${file.path}.`
          : `Creating carried file ${file.path}.`,
        action: exists
          ? { kind: 'write_file', path: file.path, content: file.content }
          : { kind: 'create_file', path: file.path, content: file.content },
        ...noTokens,
      };
    }
    // Verify: run the task's check command.
    if (this.verifyArgv && !this.verifyTried) {
      this.verifyTried = true;
      return {
        thought: 'All edits applied; running the verify command.',
        action: { kind: 'run_command', argv: this.verifyArgv },
        ...noTokens,
      };
    }
    return {
      thought: 'No more work in the plan — finishing.',
      action: { kind: 'finish', summary: 'Task completed by rule reasoner.', success: true },
      ...noTokens,
    };
  }
}

const PROVIDER_SYSTEM_PROMPT = [
  'You are a coding agent. You work in a loop: reason, then take exactly ONE action.',
  'Reply with a single JSON object and nothing else, using one of these shapes:',
  '  {"thought": "...", "action": {"kind": "create_file", "path": "src/a.ts", "content": "..."}}',
  '  {"thought": "...", "action": {"kind": "write_file", "path": "src/a.ts", "content": "..."}}',
  '  {"thought": "...", "action": {"kind": "edit_file", "path": "src/a.ts", "oldText": "...", "newText": "..."}}',
  '  {"thought": "...", "action": {"kind": "delete_file", "path": "src/a.ts"}}',
  '  {"thought": "...", "action": {"kind": "run_command", "argv": ["npm", "run", "typecheck"]}}',
  '  {"thought": "...", "action": {"kind": "finish", "summary": "...", "success": true}}',
  'Rules: paths are relative to the workspace root. edit_file oldText must match exactly once.',
  'Prefer small, verifiable steps. When the task is done and checks pass, finish with success=true.',
].join('\n');

/** Parse the model's reply into a thought + action. Throws on bad JSON / bad shape. */
export function parseProviderReasoning(text: string): { thought: string; action: CodingAction } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned) as { thought?: unknown; action?: unknown };
  if (typeof parsed.thought !== 'string' || !parsed.thought) {
    throw new Error('provider reasoning has no thought string');
  }
  const action = parsed.action as { kind?: unknown } | undefined;
  if (!action || typeof action.kind !== 'string') {
    throw new Error('provider reasoning has no action.kind');
  }
  const validKinds = new Set(['create_file', 'write_file', 'edit_file', 'delete_file', 'run_command', 'finish']);
  if (!validKinds.has(action.kind)) {
    throw new Error(`provider reasoning has unknown action kind: ${action.kind}`);
  }
  return { thought: parsed.thought, action: action as CodingAction };
}

/**
 * Model-backed reasoner: any open-bot Provider can be the brain.
 * The model sees the task, the plan, the file list and recent
 * observations, and answers with one JSON action. Invalid replies
 * (bad JSON, unknown action kind) surface as errors so the loop can
 * record them and — when fix attempts remain — ask again.
 */
export class ProviderReasoner implements Reasoner {
  readonly model: string;
  private readonly provider: Provider;
  private readonly systemPrompt: string;

  constructor(provider: Provider, model: string, systemPrompt: string = PROVIDER_SYSTEM_PROMPT) {
    this.provider = provider;
    this.model = model;
    this.systemPrompt = systemPrompt;
  }

  async reason(input: ReasonInput): Promise<ReasonOutput> {
    const planLines = input.plan.steps
      .map((s) => `- [${s.status}] ${s.description}`)
      .join('\n');
    const historyLines = input.history
      .slice(-6)
      .map((h) => `- ${h.ok ? 'ok' : 'FAIL'}: ${h.summary}`)
      .join('\n');
    const userText = [
      `Task: ${input.task}`,
      `Plan:\n${planLines}`,
      `Files in workspace:\n${input.files.join('\n') || '(empty)'}`,
      `Recent observations:\n${historyLines || '(none)'}`,
      input.lastCheckFailure
        ? `Last check failure: ${input.lastCheckFailure.name} — ${input.lastCheckFailure.detail}`
        : '',
      `Step ${input.step}. What is the single next action? Reply with JSON only.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userText },
    ];
    const response = await this.provider.chat({ model: this.model, messages });
    const { thought, action } = parseProviderReasoning(response.text);
    const usage = response.usage ?? {
      inputTokens: estimateTokensFromChars(this.systemPrompt + userText),
      outputTokens: estimateTokensFromChars(response.text),
    };
    return { thought, action, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  }
}

/** One-line summary used in traces: thought + action description. */
export function summarizeReasoning(output: ReasonOutput): string {
  return `${output.thought} → ${describeAction(output.action)}`;
}
