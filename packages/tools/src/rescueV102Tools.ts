/**
 * Rescue v1.02 tools — agent-callable tools for the ported v0.99/v1.00
 * features (ACP discovery, context budget/pruning, durable resume,
 * orchestration, gateway, deep dream, substrate snapshots).
 *
 * Every tool is a thin wrapper over @open-bot/core: read-only tools
 * never write, and the tools that change outside state (orchestra
 * runs, gateway sends, dream runs, snapshots) set needsApproval.
 * Tools that need a store take their paths from the workspace
 * (`<workspaceDir>/.open-bot/...`) so they work without extra config.
 *
 * Factory:
 *   createRescueV102Tools(opts?) -> Tool[]   (bound, usable)
 *   RESCUE_V102_TOOLS                        (unbound placeholders)
 */

import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  ActiveRunRegistry,
  DeepDreamEngine,
  GatewayManager,
  LongTermMemory,
  OrchestraService,
  detectAcpAgents,
  listBotSessionSnapshots,
  listRecoveryCandidates,
  measureContextBudget,
  pruneLowRelevanceTurns,
  resumeRunFromJournal,
  takeBotSessionSnapshot,
} from '@open-bot/core';

export const RESCUE_V102_TOOL_NAMES = [
  'context_measure_budget',
  'context_prune_history',
  'durable_list_resumable',
  'durable_resume_state',
  'orchestra_run',
  'orchestra_list_sessions',
  'gateway_status',
  'gateway_send',
  'dream_run',
  'substrate_snapshot',
  'substrate_list_snapshots',
  'acp_detect_agents',
] as const;

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function dataDir(ctx: ToolContext): string {
  return path.join(ctx.workspaceDir, '.open-bot');
}

/** Build the 12 rescue tools (bound to the workspace through ctx). */
export function createRescueV102Tools(): Tool[] {
  const contextMeasureBudget: Tool = {
    definition: toolDef(
      'context_measure_budget',
      'Measure how much of the model context window a prompt uses (system + messages + tools) and whether a reply still fits. Read-only.',
      {
        model: { type: 'string', description: 'Model id, e.g. gemini-2.5-flash.' },
        systemPrompt: { type: 'string', description: 'System prompt text (optional).' },
        messages: { type: 'string', description: 'JSON array of {role, content} messages.' },
      },
      ['model'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const model = getStringArg(args, 'model');
      const systemPrompt = getOptionalStringArg(args, 'systemPrompt') ?? '';
      let messages: Array<{ role: string; content?: string }> = [];
      const raw = getOptionalStringArg(args, 'messages');
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('messages must be a JSON array');
        messages = parsed as Array<{ role: string; content?: string }>;
      }
      const snapshot = measureContextBudget({ model, systemPrompt, messages });
      return JSON.stringify(snapshot, null, 2);
    },
  };

  const contextPruneHistory: Tool = {
    definition: toolDef(
      'context_prune_history',
      'Prune low-relevance turns from a message history until enough tokens are freed. Returns the kept messages + an extractive summary of the dropped ones. Pure computation, does not edit any file.',
      {
        messages: { type: 'string', description: 'JSON array of {role, content} messages.' },
        tokensToFree: { type: 'number', description: 'Tokens to free.' },
        latestUserText: { type: 'string', description: 'Latest user message (for relevance scoring).' },
      },
      ['messages', 'tokensToFree'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const raw = getStringArg(args, 'messages');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('messages must be a JSON array');
      const tokensToFree = args.tokensToFree;
      if (typeof tokensToFree !== 'number') throw new Error('tokensToFree must be a number');
      const result = pruneLowRelevanceTurns(parsed as Array<{ role: string; content?: string }>, tokensToFree, {
        latestUserText: getOptionalStringArg(args, 'latestUserText') ?? '',
      });
      return JSON.stringify(
        { kept: result.kept, droppedCount: result.dropped.length, freedTokens: result.freedTokens, summary: result.summary },
        null,
        2,
      );
    },
  };

  const durableListResumable: Tool = {
    definition: toolDef(
      'durable_list_resumable',
      'List agent runs that crashed or stopped mid-run and can be resumed (from the run journal + active-run registry). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async (_args, ctx) => {
      const dir = dataDir(ctx);
      const registry = new ActiveRunRegistry(path.join(dir, 'active-runs.json'));
      const candidates = listRecoveryCandidates(registry, path.join(dir, 'run-journals'));
      return JSON.stringify(candidates, null, 2);
    },
  };

  const durableResumeState: Tool = {
    definition: toolDef(
      'durable_resume_state',
      'Rebuild the resume state of a run from its journal file (messages from the last checkpoint, finished tool calls, next step). Read-only.',
      {
        runId: { type: 'string', description: 'Run id (journal file <runId>.journal.jsonl).' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const runId = getStringArg(args, 'runId');
      const journalPath = path.join(dataDir(ctx), 'run-journals', `${runId}.journal.jsonl`);
      const state = resumeRunFromJournal(journalPath, runId);
      if (!state) return `No journal found for run ${runId}.`;
      return JSON.stringify(state, null, 2);
    },
  };

  const orchestraRun: Tool = {
    definition: toolDef(
      'orchestra_run',
      'Run a goal with a supervisor that splits it into subtasks and fans them out to subagents in parallel, then merges the results. Each subtask runs as a subagent.',
      {
        goal: { type: 'string', description: 'Goal to achieve (one subtask per line when no decomposition is given).' },
        subtasks: { type: 'string', description: 'Optional JSON array of subtask titles to run instead of decomposing the goal.' },
      },
      ['goal'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      if (!ctx.runSubagent) throw new Error('orchestra_run needs a runner with runSubagent support');
      const goal = getStringArg(args, 'goal');
      const raw = getOptionalStringArg(args, 'subtasks');
      const subtaskTitles: string[] = raw ? (JSON.parse(raw) as string[]) : [];
      const service = new OrchestraService({
        storeDir: path.join(dataDir(ctx), 'orchestra'),
        runBot: async (_worker, envelope) => {
          const output = await ctx.runSubagent!(
            `Subtask: ${envelope.title}\n${envelope.detail ?? ''}\n\nContext:\n${JSON.stringify(envelope.context)}`,
            {},
          );
          return { output };
        },
      });
      const titles = subtaskTitles.length > 0 ? subtaskTitles : goal.split('\n').map((l) => l.trim()).filter(Boolean);
      // One worker entry per subtask: a wave runs subtasks in
      // parallel and each needs a distinct worker (all backed by the
      // same subagent runner, so this just fans the work out).
      const workers = titles.map((_, i) => ({
        id: `subagent-${i + 1}`,
        name: 'subagent',
        description: 'runs a subtask as a subagent',
        tools: [] as string[],
      }));
      const result = await service.runSession({
        goal,
        workers,
        ...(subtaskTitles.length > 0 ? { subtasks: subtaskTitles.map((title) => ({ title })) } : {}),
      });
      return JSON.stringify(
        { sessionId: result.session.id, status: result.session.status, merged: result.merged },
        null,
        2,
      );
    },
  };

  const orchestraListSessions: Tool = {
    definition: toolDef(
      'orchestra_list_sessions',
      'List orchestration sessions (goal, status, subtask counts). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async (_args, ctx) => {
      const service = new OrchestraService({ storeDir: path.join(dataDir(ctx), 'orchestra') });
      return JSON.stringify(service.list(), null, 2);
    },
  };

  const gatewayStatus: Tool = {
    definition: toolDef(
      'gateway_status',
      'Show the multi-channel gateway status (Telegram / Slack / Discord / WhatsApp: disabled, ready, or mock). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async (_args, ctx) => {
      const manager = new GatewayManager({ dataDir: path.join(dataDir(ctx), 'gateway') });
      return JSON.stringify(manager.channelStatus(), null, 2);
    },
  };

  const gatewaySend: Tool = {
    definition: toolDef(
      'gateway_send',
      'Send a message out through a gateway channel (Telegram / Slack / Discord / WhatsApp). Uses the mock transport unless the host wired a real one.',
      {
        channel: { type: 'string', description: 'Channel: telegram, slack, discord, or whatsapp.' },
        chatId: { type: 'string', description: 'Chat/room id on that channel.' },
        text: { type: 'string', description: 'Message text.' },
      },
      ['channel', 'chatId', 'text'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const channel = getStringArg(args, 'channel');
      if (!['telegram', 'slack', 'discord', 'whatsapp'].includes(channel)) {
        throw new Error(`unknown gateway channel: ${channel}`);
      }
      const manager = new GatewayManager({ dataDir: path.join(dataDir(ctx), 'gateway') });
      const id = await manager.send({
        channel: channel as 'telegram' | 'slack' | 'discord' | 'whatsapp',
        chatId: getStringArg(args, 'chatId'),
        text: getStringArg(args, 'text'),
      });
      return `Sent via ${channel} (message id ${id}).`;
    },
  };

  const dreamRun: Tool = {
    definition: toolDef(
      'dream_run',
      'Run one Deep Dream pass: distill today\'s daily notes into durable long-term facts (deterministic rules, no model) and promote high-confidence facts to the human memory block. Writes memory + a journal entry.',
      {},
      [],
    ),
    needsApproval: true,
    execute: async (_args, ctx) => {
      const memory = new LongTermMemory(ctx.workspaceDir);
      const engine = new DeepDreamEngine({ workspaceDir: ctx.workspaceDir, memory });
      const report = await engine.runOnce();
      return JSON.stringify(report, null, 2);
    },
  };

  const substrateSnapshot: Tool = {
    definition: toolDef(
      'substrate_snapshot',
      'Take a snapshot of this bot\'s working state (config + working files, checksummed). Sensitive files are never copied. Returns the snapshot id + manifest.',
      {
        botId: { type: 'string', description: 'Bot id to snapshot.' },
        note: { type: 'string', description: 'Optional note for the snapshot.' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const botId = getStringArg(args, 'botId');
      const state = {
        botId,
        config: {},
        memory: [],
        workDir: ctx.workspaceDir,
        createdAt: new Date().toISOString(),
      };
      const manifest = takeBotSessionSnapshot(ctx.workspaceDir, state, {
        ...(getOptionalStringArg(args, 'note') ? { note: getOptionalStringArg(args, 'note') } : {}),
      });
      return JSON.stringify(
        { snapshotId: manifest.snapshotId, files: manifest.files.length, excludedFiles: manifest.excludedFiles, checksum: manifest.checksum },
        null,
        2,
      );
    },
  };

  const substrateListSnapshots: Tool = {
    definition: toolDef(
      'substrate_list_snapshots',
      'List snapshots of a bot\'s working state (newest first). Read-only.',
      {
        botId: { type: 'string', description: 'Bot id.' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args, ctx) => {
      const snapshots = listBotSessionSnapshots(ctx.workspaceDir, getStringArg(args, 'botId'));
      return JSON.stringify(
        snapshots.map((s) => ({ snapshotId: s.snapshotId, createdAt: s.createdAt, files: s.files.length, note: s.note })),
        null,
        2,
      );
    },
  };

  const acpDetectAgents: Tool = {
    definition: toolDef(
      'acp_detect_agents',
      'Detect external ACP agents on this machine (binaries that answer a real ACP initialize handshake). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const probes = await detectAcpAgents();
      return JSON.stringify(probes, null, 2);
    },
  };

  return [
    contextMeasureBudget,
    contextPruneHistory,
    durableListResumable,
    durableResumeState,
    orchestraRun,
    orchestraListSessions,
    gatewayStatus,
    gatewaySend,
    dreamRun,
    substrateSnapshot,
    substrateListSnapshots,
    acpDetectAgents,
  ];
}

/** Unbound placeholders (same definitions, no host wiring). */
export const RESCUE_V102_TOOLS: Tool[] = createRescueV102Tools();
