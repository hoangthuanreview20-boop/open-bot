/**
 * ACP runner — the thing that actually answers a prompt (v1.02 rescue
 * port of the v0.99 work).
 *
 * The agent server never calls a model directly: it hands the prompt
 * to a `AcpRunner` and streams the runner's updates back to the
 * client. Three runners ship here:
 * - `EchoRunner`: deterministic echo (tests + smoke checks, no model).
 * - `CallbackRunner`: wraps any async function the host provides.
 * - `RegistryRunner`: picks a runner by name from a registry, so the
 *   host (coordinator) can plug the real agent loop in later without
 *   touching the server.
 *
 * Runners receive an AbortSignal: a cancelled turn must stop promptly
 * and report `stopReason: 'cancelled'` (never surface AbortError as a
 * red error — the spec treats cancellation as a normal outcome).
 */

import type { AcpContentBlock, AcpSessionUpdate, AcpStopReason } from './types';

/** What a runner hands back when a turn ends. */
export interface AcpRunResult {
  stopReason: AcpStopReason;
  /** Full agent reply text (recorded for `session/load` replay). */
  text?: string;
}

/** Context given to a runner for one turn. */
export interface AcpRunContext {
  sessionId: string;
  cwd: string;
  prompt: AcpContentBlock[];
  /** Stream one update to the client (server forwards it). */
  onUpdate: (update: AcpSessionUpdate) => void;
  /** Ask the client for permission; resolves to the chosen optionId or null. */
  requestPermission: (options: Array<{ optionId: string; name: string }>) => Promise<string | null>;
  /** Read a file through the client (only when it advertised the capability). */
  readTextFile?: (filePath: string) => Promise<string>;
  /** Write a file through the client (only when it advertised the capability). */
  writeTextFile?: (filePath: string, content: string) => Promise<void>;
  signal: AbortSignal;
}

export interface AcpRunner {
  readonly name: string;
  run(prompt: AcpContentBlock[], context: AcpRunContext): Promise<AcpRunResult>;
}

function promptText(prompt: AcpContentBlock[]): string {
  return prompt
    .map((block) => (block.type === 'text' ? block.text : block.type === 'resource_link' ? block.uri : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/** Deterministic echo runner: repeats the prompt, no model, no network. */
export class EchoRunner implements AcpRunner {
  readonly name = 'echo';

  async run(prompt: AcpContentBlock[], context: AcpRunContext): Promise<AcpRunResult> {
    const text = `Echo: ${promptText(prompt)}`;
    context.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    return { stopReason: 'end_turn', text };
  }
}

/** Runner backed by a host-provided async function. */
export class CallbackRunner implements AcpRunner {
  readonly name: string;
  private readonly fn: (prompt: AcpContentBlock[], context: AcpRunContext) => Promise<AcpRunResult>;

  constructor(
    name: string,
    fn: (prompt: AcpContentBlock[], context: AcpRunContext) => Promise<AcpRunResult>,
  ) {
    this.name = name;
    this.fn = fn;
  }

  run(prompt: AcpContentBlock[], context: AcpRunContext): Promise<AcpRunResult> {
    return this.fn(prompt, context);
  }
}

/** Registry of named runners; `get` falls back to the echo runner. */
export class AcpRunnerRegistry {
  private readonly runners = new Map<string, AcpRunner>();

  constructor(runners: AcpRunner[] = [new EchoRunner()]) {
    for (const runner of runners) this.runners.set(runner.name, runner);
  }

  register(runner: AcpRunner): void {
    this.runners.set(runner.name, runner);
  }

  get(name?: string): AcpRunner {
    if (name && this.runners.has(name)) return this.runners.get(name)!;
    return this.runners.get('echo') ?? new EchoRunner();
  }

  list(): string[] {
    return [...this.runners.keys()];
  }
}
