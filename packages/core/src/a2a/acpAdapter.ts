/**
 * A2A <-> ACP adapter — delegate an A2A task to an ACP agent (v1.02
 * rescue port of the v1.00 work).
 *
 * The two protocols meet here: an A2A task (message in, artifact
 * out) is executed by driving an ACP agent session (create session,
 * send the prompt, collect the streamed updates into one text
 * artifact). The adapter owns the translation only — it never runs
 * a model itself and never spawns an agent (the host injects an
 * `AcpSessionRunner` that already knows how to talk to an ACP
 * agent, e.g. `AcpClient`).
 *
 * Mapping:
 * - A2A task text (parts joined) -> ACP `session/prompt` text block.
 * - ACP `agent_message_chunk` updates -> appended to the artifact text.
 * - ACP `stopReason` -> A2A task state: `end_turn` -> `completed`,
 *   `cancelled` -> `cancelled`, anything else -> `failed`.
 * - ACP tool-call updates -> a short line in the artifact ("[tool: name]").
 */

import type { A2aTaskState } from './types';
import type { AcpContentBlock, AcpSessionUpdate, AcpStopReason } from '../acp/types';

/** What the host must provide: run one ACP prompt and stream updates back. */
export interface AcpSessionRunner {
  /** Send a prompt to an ACP session; calls onUpdate for each streamed update. */
  prompt(
    sessionId: string,
    prompt: AcpContentBlock[],
    onUpdate: (update: AcpSessionUpdate) => void,
    signal?: AbortSignal,
  ): Promise<{ stopReason: AcpStopReason }>;
}

/** Result of an A2A task executed through ACP. */
export interface AcpAdapterResult {
  state: A2aTaskState;
  /** Artifact text (agent messages + tool-call lines). */
  artifactText: string;
  stopReason: AcpStopReason;
  updatesSeen: number;
}

/** Map an ACP stop reason to an A2A task state. */
export function acpStopReasonToA2aState(stopReason: AcpStopReason): A2aTaskState {
  switch (stopReason) {
    case 'end_turn':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

/** Collect ACP session updates into artifact text (pure). */
export class AcpUpdateCollector {
  private readonly lines: string[] = [];
  private updatesSeen = 0;

  /** Feed one update (returns nothing; the text accumulates). */
  feed(update: AcpSessionUpdate): void {
    this.updatesSeen++;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.lines.push(update.content.text);
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      // Thoughts are not part of the artifact (they are internal).
    } else if (update.sessionUpdate === 'tool_call') {
      this.lines.push(`[tool: ${update.title ?? update.toolCallId}]`);
    }
  }

  get text(): string {
    return this.lines.join('\n');
  }

  get count(): number {
    return this.updatesSeen;
  }
}

/** Run one A2A task's message through an ACP agent session. */
export async function runA2aTaskViaAcp(
  runner: AcpSessionRunner,
  sessionId: string,
  messageText: string,
  signal?: AbortSignal,
): Promise<AcpAdapterResult> {
  const collector = new AcpUpdateCollector();
  const result = await runner.prompt(
    sessionId,
    [{ type: 'text', text: messageText }],
    (update) => collector.feed(update),
    signal,
  );
  return {
    state: acpStopReasonToA2aState(result.stopReason),
    artifactText: collector.text,
    stopReason: result.stopReason,
    updatesSeen: collector.count,
  };
}
