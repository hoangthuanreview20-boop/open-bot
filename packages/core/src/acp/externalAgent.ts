/**
 * Managing external ACP agents (v1.02 rescue port of the v0.99 work).
 *
 * `ExternalAgentManager` spawns, routes prompts to, and kills
 * external ACP agent processes. Each managed agent has one client;
 * sessions are created per working directory and tracked so the host
 * can list / close them. Agents are only spawned from commands the
 * host explicitly passes — detection results are advisory, never
 * auto-executed.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AcpContentBlock, AcpPromptResult, AcpSessionInfo } from './types';
import { AcpClient, spawnAcpAgent, type AcpClientOptions } from './client';

export interface ManagedAcpAgent {
  id: string;
  name: string;
  command: string;
  args: string[];
  process: ChildProcessWithoutNullStreams;
  client: AcpClient;
  startedAt: string;
  sessions: Map<string, AcpSessionInfo>;
}

export interface ExternalAgentManagerOptions {
  /** Passed through to every spawned agent's client. */
  clientOptions?: AcpClientOptions;
  /** Kill the process when the manager is disposed (default true). */
  killOnDispose?: boolean;
}

/** Spawns and tracks external ACP agent processes. */
export class ExternalAgentManager {
  private readonly agents = new Map<string, ManagedAcpAgent>();
  private readonly clientOptions: AcpClientOptions;
  private readonly killOnDispose: boolean;

  constructor(options: ExternalAgentManagerOptions = {}) {
    this.clientOptions = options.clientOptions ?? {};
    this.killOnDispose = options.killOnDispose ?? true;
  }

  /** Spawn an agent and register it. Returns the managed agent id. */
  async spawn(name: string, command: string, args: string[] = []): Promise<ManagedAcpAgent> {
    const { process, client } = spawnAcpAgent(command, args, this.clientOptions);
    await client.initialize();
    const agent: ManagedAcpAgent = {
      id: randomUUID(),
      name,
      command,
      args,
      process,
      client,
      startedAt: new Date().toISOString(),
      sessions: new Map(),
    };
    this.agents.set(agent.id, agent);
    process.on('exit', () => {
      this.agents.delete(agent.id);
    });
    return agent;
  }

  get(agentId: string): ManagedAcpAgent | undefined {
    return this.agents.get(agentId);
  }

  list(): ManagedAcpAgent[] {
    return [...this.agents.values()];
  }

  /** Create a session on an agent (tracked for later close/delete). */
  async newSession(agentId: string, cwd: string): Promise<AcpSessionInfo> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`unknown ACP agent: ${agentId}`);
    const session = await agent.client.newSession(cwd);
    agent.sessions.set(session.sessionId, session);
    return session;
  }

  /** Send a prompt to a session on an agent. */
  async prompt(agentId: string, sessionId: string, prompt: AcpContentBlock[], signal?: AbortSignal): Promise<AcpPromptResult> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`unknown ACP agent: ${agentId}`);
    return agent.client.prompt(sessionId, prompt, signal);
  }

  /** Kill one agent (closes its client first). */
  kill(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    try {
      agent.client.close();
    } catch {
      // Ignore close errors; the process is being killed anyway.
    }
    try {
      agent.process.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    this.agents.delete(agentId);
    return true;
  }

  /** Kill every managed agent. */
  dispose(): void {
    if (!this.killOnDispose) {
      this.agents.clear();
      return;
    }
    for (const agent of [...this.agents.values()]) this.kill(agent.id);
  }

  get size(): number {
    return this.agents.size;
  }
}
