/**
 * Detecting + probing external ACP agents (v1.02 rescue port of the
 * v0.99 work).
 *
 * An "ACP agent" here is a command-line program that speaks ACP v1
 * over stdio (the Zed Agent Client Protocol). Detection is deliberately
 * conservative: a binary is only treated as an ACP agent after it
 * answers a real `initialize` handshake over a spawned process —
 * a `--version` string match alone is never enough.
 *
 * Known agent commands are a starting list only; users can register
 * any command through `registerKnownAcpAgent`. Nothing here executes
 * an agent without the host explicitly spawning it.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ACP_PROTOCOL_VERSION } from './types';
import { AcpJsonRpcPeer } from './transport';
import { AcpClient } from './client';

export interface KnownAcpAgent {
  /** Stable id (also used as the provider id). */
  id: string;
  /** Display name. */
  name: string;
  /** Binary name(s) to look for on PATH, in priority order. */
  commands: string[];
  /** Default args used when spawning the agent. */
  args?: string[];
  /** Short description shown in the UI. */
  description?: string;
}

/** Built-in list of known ACP agent commands (editors / CLIs that speak ACP). */
export const KNOWN_ACP_AGENTS: KnownAcpAgent[] = [
  { id: 'zed', name: 'Zed', commands: ['zed'], description: 'Zed editor agent (ACP over stdio).' },
  { id: 'acp-agent', name: 'ACP agent', commands: ['acp-agent'], description: 'Generic ACP agent binary.' },
];

const extraAgents: KnownAcpAgent[] = [];

/** Register an additional known ACP agent command (user configuration). */
export function registerKnownAcpAgent(agent: KnownAcpAgent): void {
  if (!extraAgents.some((a) => a.id === agent.id)) extraAgents.push(agent);
}

/** All known ACP agents (built-in + registered). */
export function listKnownAcpAgents(): KnownAcpAgent[] {
  return [...KNOWN_ACP_AGENTS, ...extraAgents];
}

export interface AcpAgentProbe {
  id: string;
  name: string;
  command: string;
  resolvedPath: string;
  /** True when the binary answered a real ACP `initialize`. */
  speaksAcp: boolean;
  agentName?: string;
  agentVersion?: string;
  error?: string;
}

/**
 * Find a binary on PATH (POSIX `which` equivalent, no shell).
 * Returns the absolute path or undefined.
 */
export function findOnPath(command: string): string | undefined {
  if (path.isAbsolute(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next directory.
    }
  }
  return undefined;
}

/**
 * Probe one binary: spawn it, run `initialize`, and check that it
 * answers with protocolVersion 1. Kills the process afterwards.
 * `timeoutMs` bounds the whole probe (default 10s).
 */
export async function probeAcpAgent(
  command: string,
  args: string[] = [],
  timeoutMs = 10_000,
): Promise<AcpAgentProbe> {
  const resolved = findOnPath(command);
  const base: AcpAgentProbe = {
    id: command,
    name: command,
    command,
    resolvedPath: resolved ?? '',
    speaksAcp: false,
  };
  if (!resolved) return { ...base, error: 'not found on PATH' };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(resolved, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    if (!child.stdout || !child.stdin) {
      return { ...base, error: 'agent process has no stdio streams' };
    }
    const peer = new AcpJsonRpcPeer(child.stdout, child.stdin);
    const client = new AcpClient(peer, {});
    const info = await Promise.race([
      client.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timed out')), timeoutMs)),
    ]);
    peer.close();
    return {
      ...base,
      speaksAcp: info.protocolVersion === ACP_PROTOCOL_VERSION,
      agentName: info.agentInfo?.name,
      agentVersion: info.agentInfo?.version,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      child?.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Probe every known agent command found on PATH. */
export async function detectAcpAgents(timeoutMs = 10_000): Promise<AcpAgentProbe[]> {
  const results: AcpAgentProbe[] = [];
  for (const known of listKnownAcpAgents()) {
    for (const command of known.commands) {
      const resolved = findOnPath(command);
      if (!resolved) continue;
      const probe = await probeAcpAgent(command, known.args ?? [], timeoutMs);
      results.push({ ...probe, id: known.id, name: known.name });
    }
  }
  return results;
}
