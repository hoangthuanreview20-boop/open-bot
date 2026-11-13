/**
 * Harness v2 tools for @open-bot/tools (v0.97, Team T5).
 *
 * Read-only tools so an agent can inspect the harness without
 * changing anything (all three are `needsApproval: false`):
 *  - `harness_health_check` — probe one bot computer right now
 *    (CPU/RAM/disk, process alive, last heartbeat) and report
 *    healthy / degraded / unhealthy / unknown with reasons.
 *  - `harness_routine_list` — list routines v2 from the state dir
 *    with their trigger, enabled flag, next run and latest run status.
 *  - `harness_webhook_status` — summarize the signed webhook
 *    delivery audit log (accepted / rejected by reason) from the
 *    state dir.
 *
 * Factory (same pattern as createCiTools):
 *   createHarnessV2Tools(opts?) -> Tool[]   (bound, usable)
 *   HARNESS_V2_TOOLS                       (unbound placeholders)
 *
 * Nothing here runs a bot, executes a routine or touches a secret:
 * the health probe only reads the machine, the other two only read
 * local JSON/NDJSON files under the state dir.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  JsonFileRoutineStore,
  probeBotComputerHealth,
} from '@open-bot/core';
import type { BotComputerHealth, RoutineRun } from '@open-bot/core';
import { resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export interface HarnessV2ToolOptions {
  /** Fixed state directory (routines + delivery log). Default: `<workspaceDir>/.open-bot`. */
  stateDir?: string;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalIntArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Argument "${name}" must be an integer, got ${typeof value}`);
  }
  return value;
}

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

function resolveStateDir(opts: HarnessV2ToolOptions, ctx: ToolContext): string {
  if (opts.stateDir) return opts.stateDir;
  return path.join(ctx.workspaceDir, '.open-bot');
}

function formatHealth(health: BotComputerHealth): string {
  const lines = [
    `Bot computer health for "${health.botId}"${health.computerId ? ` (computer ${health.computerId})` : ''}: ${health.status.toUpperCase()}`,
    `  probed at ${health.probedAt} (took ${health.probeDurationMs}ms)`,
  ];
  if (health.cpuLoad !== undefined) lines.push(`  CPU load: ${Math.round(health.cpuLoad * 100)}%`);
  if (health.memoryUsedRatio !== undefined) {
    lines.push(`  memory used: ${Math.round(health.memoryUsedRatio * 100)}%`);
  }
  if (health.diskUsedRatio !== undefined) {
    lines.push(`  disk used: ${Math.round(health.diskUsedRatio * 100)}%`);
  }
  if (health.processAlive !== undefined) {
    lines.push(`  bot process alive: ${health.processAlive ? 'yes' : 'NO'}`);
  }
  if (health.heartbeatAgeMs !== undefined) {
    lines.push(`  last heartbeat: ${Math.round(health.heartbeatAgeMs / 1000)}s ago`);
  }
  if (health.reasons.length > 0) {
    lines.push(`  reasons: ${health.reasons.join(' ')}`);
  }
  return lines.join('\n');
}

export const HARNESS_V2_TOOLS: Tool[] = [
  {
    definition: toolDef(
      'harness_health_check',
      'Probe one bot computer right now (CPU/RAM/disk, bot process alive, last heartbeat) and report healthy/degraded/unhealthy/unknown with reasons. Read-only.',
      {
        botId: { type: 'string', description: 'Bot id to probe.' },
        pid: { type: 'number', description: 'Bot process pid to check (optional; when omitted, process liveness is not checked).' },
        lastHeartbeatAt: { type: 'string', description: 'ISO timestamp of the bot process last heartbeat (optional).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    async execute() {
      return errorResult('harness_health_check is not bound — use createHarnessV2Tools().');
    },
  },
  {
    definition: toolDef(
      'harness_routine_list',
      'List harness v2 routines (schedule/trigger, enabled flag, next run, latest run status). Read-only.',
      {
        routineId: { type: 'string', description: 'Only show this routine id (optional; omit to list all).' },
      },
      [],
    ),
    needsApproval: false,
    async execute() {
      return errorResult('harness_routine_list is not bound — use createHarnessV2Tools().');
    },
  },
  {
    definition: toolDef(
      'harness_webhook_status',
      'Summarize the signed webhook delivery audit log (accepted vs rejected, rejections by reason, last delivery). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      return errorResult('harness_webhook_status is not bound — use createHarnessV2Tools().');
    },
  },
];

export function createHarnessV2Tools(opts: HarnessV2ToolOptions = {}): Tool[] {
  const healthCheck: Tool = {
    definition: toolDef(
      'harness_health_check',
      'Probe one bot computer right now (CPU/RAM/disk, bot process alive, last heartbeat) and report healthy/degraded/unhealthy/unknown with reasons. Read-only.',
      {
        botId: { type: 'string', description: 'Bot id to probe.' },
        pid: { type: 'number', description: 'Bot process pid to check (optional; when omitted, process liveness is not checked).' },
        lastHeartbeatAt: { type: 'string', description: 'ISO timestamp of the bot process last heartbeat (optional).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const botId = getStringArg(args, 'botId');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(botId)) {
          return errorResult('Invalid "botId": use only letters, digits, ".", "-" and "_".');
        }
        const pid = getOptionalIntArg(args, 'pid');
        const lastHeartbeatAt = getOptionalStringArg(args, 'lastHeartbeatAt');
        if (lastHeartbeatAt !== undefined && Number.isNaN(new Date(lastHeartbeatAt).getTime())) {
          return errorResult('Invalid "lastHeartbeatAt": must be an ISO timestamp.');
        }
        const health = await probeBotComputerHealth({
          botId,
          ...(pid !== undefined ? { pid } : {}),
          ...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
        });
        return truncate(formatHealth(health));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const routineList: Tool = {
    definition: toolDef(
      'harness_routine_list',
      'List harness v2 routines (schedule/trigger, enabled flag, next run, latest run status). Read-only.',
      {
        routineId: { type: 'string', description: 'Only show this routine id (optional; omit to list all).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const routineId = getOptionalStringArg(args, 'routineId');
        const store = new JsonFileRoutineStore(resolveStateDir(opts, ctx));
        const routines = routineId !== undefined
          ? store.list().filter((r) => r.id === routineId)
          : store.list();
        if (routines.length === 0) {
          return routineId !== undefined
            ? `No routine with id "${routineId}".`
            : 'No harness v2 routines yet.';
        }
        const lines: string[] = [];
        for (const routine of routines) {
          const runs: RoutineRun[] = store.listRuns(routine.id);
          const latest = runs.length > 0 ? runs[runs.length - 1] : undefined;
          const trigger =
            routine.trigger.kind === 'interval'
              ? `every ${routine.trigger.minutes} min`
              : routine.trigger.kind === 'cron'
                ? `cron ${routine.trigger.expression}`
                : routine.trigger.kind;
          lines.push(
            `- ${routine.name} (${routine.id}) [${routine.enabled ? 'enabled' : 'disabled'}] trigger: ${trigger}` +
              `, next run: ${routine.nextRunAt ?? '—'}` +
              `, last run: ${routine.lastRunAt ?? 'never'}` +
              (latest ? `, latest run ${latest.status} (attempt ${latest.attempt}/${latest.maxAttempts})` : ''),
          );
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const webhookStatus: Tool = {
    definition: toolDef(
      'harness_webhook_status',
      'Summarize the signed webhook delivery audit log (accepted vs rejected, rejections by reason, last delivery). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        const logFile = resolveWithin(resolveStateDir(opts, ctx), 'webhook-deliveries-v2.ndjson');
        let text: string;
        try {
          text = fs.readFileSync(logFile, 'utf8');
        } catch {
          return 'No webhook deliveries recorded yet.';
        }
        let accepted = 0;
        let rejected = 0;
        const byReason = new Map<string, number>();
        let last: { receivedAt?: string; targetId?: string } | undefined;
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue;
          try {
            const rec = JSON.parse(line) as { verified?: boolean; rejectReason?: string; receivedAt?: string; targetId?: string };
            if (rec.verified === true) accepted += 1;
            else {
              rejected += 1;
              const reason = rec.rejectReason ?? 'unknown';
              byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
            }
            last = rec;
          } catch {
            // Corrupt line — skip.
          }
        }
        // The delivery log uses the WebhookDelivery shape, parsed above.
        const lines = [
          `Webhook deliveries: ${accepted + rejected} total, ${accepted} accepted, ${rejected} rejected.`,
        ];
        if (byReason.size > 0) {
          lines.push(
            `Rejections by reason: ${[...byReason.entries()].map(([r, n]) => `${r} (${n})`).join(', ')}.`,
          );
        }
        if (last) {
          lines.push(`Last delivery: ${last.receivedAt ?? 'unknown time'} for target "${last.targetId ?? '?' }".`);
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [healthCheck, routineList, webhookStatus];
}
