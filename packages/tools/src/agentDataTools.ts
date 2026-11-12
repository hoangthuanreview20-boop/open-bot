/**
 * Agent data tools for @open-bot/tools (v0.7, ROADMAP §2b):
 *  - `agent_export` — export one bot (config + history + tasks +
 *    memories + canvas list) to ONE versioned JSON bundle file with a
 *    SHA-256 checksum.
 *  - `agent_import` — import such a bundle back as a bot (same id, or
 *    a new id), validating version + checksum first, and refusing to
 *    overwrite an existing bot unless `overwrite` is passed.
 *
 * LOCAL EQUIVALENT, NOT CLOUD: there is no open-bot cloud. A bot's
 * data lives on this machine (BotMemory SQLite + CanvasStore files);
 * these tools are the local stand-in for "lấy dữ liệu của agent
 * chạy trên cloud" — the bundle file is what you copy to another
 * machine (or keep as a backup) instead of fetching it from a server.
 * Both tool descriptions say this explicitly.
 *
 * The bundle never contains secrets (BotMemory holds no API keys —
 * they live in the Vault). It can still hold private chats, so the
 * default location is `.open-bot/exports/` inside the workspace and
 * must not be committed.
 *
 * Factory (same pattern as createCiTools):
 *   createAgentDataTools(opts?) -> Tool[]   (bound, usable)
 *   AGENT_DATA_TOOLS                        (unbound placeholders)
 *
 * Approval: agent_export only reads the bot and writes its own bundle
 * file under .open-bot -> false. agent_import writes into BotMemory /
 * CanvasStore -> true.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotMemory, Tool, ToolContext } from '@open-bot/core';
import { BotMemory as BotMemoryImpl } from '@open-bot/core/dist/agent/memory';
import {
  defaultBundleFileName,
  exportAgentData,
  importAgentData,
  parseAgentBundleJson,
} from '@open-bot/core/dist/agent/export';
import type { AgentBundle, AgentBundleMemoryEntry } from '@open-bot/core/dist/agent/export';
import { resolveWithin } from './sandbox';
import { assertPublicUrl } from './ssrf';
import { ToolCallHistoryStore } from './toolCallHistory';
import type { ToolCallHistoryLike } from './toolCallHistory';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };

export interface AgentDataToolOptions {
  /** BotMemory for the workspace (built from ctx.workspaceDir when absent). */
  memory?: BotMemory;
  /**
   * Free-form memory entries for a bot. BotMemory has no list-all API,
   * so the host supplies them (e.g. from its own key list) or leaves
   * them out — the bundle then simply has no memories.
   */
  listMemories?: (botId: string) => AgentBundleMemoryEntry[] | Promise<AgentBundleMemoryEntry[]>;
  /** Fixed workspace directory. */
  workspaceDir?: string;
  /** Fetch injectable for cloud_agent_fetch_data source=url (tests use a mock; default global fetch). */
  fetchFn?: typeof fetch;
  /**
   * v0.53 (P1-7): history of past tool calls for `tool_call_replay`
   * (defaults to a file store in the workspace). The agent loop
   * records every call here via the coordinator (see
   * `AgentRunnerOptions.toolCallRecorder`); without a recorder the
   * history only holds replays themselves.
   */
  history?: ToolCallHistoryLike;
  /**
   * v0.53 (P1-7): tools the replay may dispatch into (the bot's live
   * registry — the coordinator passes `() => registry.list()`).
   * Without it, replay cannot find its target and refuses.
   */
  getTools?: () => Tool[];
}

const LOCAL_NOT_CLOUD =
  'LOCAL equivalent of cloud agent data (there is no open-bot cloud): this bundles the bot\'s ' +
  'on-machine data (BotMemory + canvases) into one file — it does NOT fetch anything from a server.';


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

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
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

export function createAgentDataTools(opts: AgentDataToolOptions = {}): Tool[] {
  const resolveWorkspace = (ctx: ToolContext): string => opts.workspaceDir || ctx.workspaceDir;

  function memoryFor(ctx: ToolContext): BotMemory {
    if (opts.memory) return opts.memory;
    return new BotMemoryImpl(resolveWorkspace(ctx));
  }

  const agentExport: Tool = {
    definition: toolDef(
      'agent_export',
      `${LOCAL_NOT_CLOUD} Export one bot to a single versioned JSON bundle file (config, history, ` +
        'tasks, goals, todos, projects, memories, canvases) with a SHA-256 checksum. ' +
        'Default location: .open-bot/exports/agent-<botId>-<timestamp>.json.',
      {
        botId: { type: 'string', description: 'Bot id to export (default: the calling bot).' },
        outputPath: { type: 'string', description: 'Workspace-relative output path (default: .open-bot/exports/agent-<botId>-<timestamp>.json).' },
        includeCanvases: { type: 'boolean', description: 'Include canvases (default true).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const workspaceDir = resolveWorkspace(ctx);
        const botId = getOptionalStringArg(args, 'botId') ?? ctx.botId;
        const memory = memoryFor(ctx);
        const memories = opts.listMemories ? await opts.listMemories(botId) : undefined;
        const bundle = await exportAgentData({
          memory,
          botId,
          workspaceDir,
          memories,
          includeCanvases: getBoolArg(args, 'includeCanvases', true),
        });
        const relPath =
          getOptionalStringArg(args, 'outputPath') ??
          path.join('.open-bot', 'exports', defaultBundleFileName(botId));
        const fullPath = resolveWithin(workspaceDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
        const c = bundle.data;
        return truncate(
          `Agent "${bundle.data.config.name}" (id ${bundle.botId}) exported to ${relPath}.\n` +
            `Bundle v${bundle.version}, checksum ${bundle.checksum.slice(0, 16)}…\n` +
            `Contents: ${c.history.length} message(s), ${c.memories.length} memor(ies), ` +
            `${c.tasks.length} task(s), ${c.goals.length} goal(s), ${c.todos.length} todo(s), ` +
            `${c.projects.length} project(s), ${c.canvases.length} canvas(es).\n` +
            `${LOCAL_NOT_CLOUD}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  /**
   * v0.41 (P0-3, REA deep-dive lần 2 §3.4 `FetchCloudAgentDataToolCall`):
   * lấy dữ liệu của một cloud agent. Open-bot không có cloud, nên tool
   * này là bản tương đương local, 2 nguồn:
   *  - source=local (mặc định): tóm tắt dữ liệu của bot trên chính máy
   *    này (config + history + tasks + goals + todos + projects +
   *    memories + canvases) bằng exportAgentData — chỉ đọc, KHÔNG ghi
   *    file bundle như agent_export.
   *  - source=url: tải một agent bundle (file agent_export) từ URL
   *    công khai, validate version + SHA-256 checksum bằng
   *    parseAgentBundleJson rồi trả tóm tắt — KHÔNG import (muốn nhập
   *    thì dùng agent_import sau khi đã tải file về). URL phải qua
   *    assertPublicUrl (chặn SSRF: localhost / LAN / metadata cloud).
   * Read-only, không cần approval. Không bao giờ trả secret: bundle
   * không chứa API key (key nằm trong Vault).
   */
  function summarizeBundle(bundle: AgentBundle, source: 'local' | 'url'): string {
    const c = bundle.data;
    const last = c.history.length > 0 ? c.history[c.history.length - 1] : undefined;
    return JSON.stringify(
      {
        agentId: bundle.botId,
        source,
        name: c.config.name,
        bundleVersion: bundle.version,
        checksum: `${bundle.checksum.slice(0, 16)}…`,
        counts: {
          history: c.history.length,
          memories: c.memories.length,
          tasks: c.tasks.length,
          goals: c.goals.length,
          todos: c.todos.length,
          projects: c.projects.length,
          canvases: c.canvases.length,
        },
        lastMessage:
          last === undefined
            ? null
            : { role: last.role, excerpt: last.content.slice(0, 200) },
        note: LOCAL_NOT_CLOUD,
      },
      null,
      2,
    );
  }

  const cloudAgentFetchData: Tool = {
    definition: toolDef(
      'cloud_agent_fetch_data',
      `${LOCAL_NOT_CLOUD} Fetch an agent's data and return a summary (config, counts of history/tasks/goals/todos/` +
        'projects/memories/canvases, last message excerpt). source=local reads the bot on this machine (no file written); ' +
        'source=url downloads an agent_export bundle from a public URL and validates its version + SHA-256 checksum first ' +
        '(SSRF-checked; localhost/private URLs are refused). Read-only.',
      {
        agent_id: { type: 'string', description: 'Bot id to fetch data for (default: the calling bot).' },
        source: { type: 'string', description: '"local" (default: read the bot on this machine) or "url" (download an agent bundle from bundle_url).' },
        bundle_url: { type: 'string', description: 'Public http(s) URL of an agent_export bundle JSON file (required when source=url).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const workspaceDir = resolveWorkspace(ctx);
        const source = getOptionalStringArg(args, 'source') ?? 'local';
        if (source !== 'local' && source !== 'url') {
          return errorResult('Argument "source" must be "local" or "url".');
        }
        if (source === 'url') {
          const bundleUrl = getOptionalStringArg(args, 'bundle_url');
          if (!bundleUrl) {
            return errorResult('source=url needs "bundle_url" (public http(s) URL of an agent_export bundle).');
          }
          // SSRF check trước khi fetch (localhost / LAN / metadata bị chặn).
          const url = await assertPublicUrl(bundleUrl);
          const fetchFn = opts.fetchFn ?? fetch;
          const res = await fetchFn(url.toString());
          if (!res.ok) {
            return errorResult(`GET ${url} failed with HTTP ${res.status}`);
          }
          const bundle = parseAgentBundleJson(await res.text());
          return truncate(summarizeBundle(bundle, 'url'));
        }
        const botId = getOptionalStringArg(args, 'agent_id') ?? ctx.botId;
        const memory = memoryFor(ctx);
        const memories = opts.listMemories ? await opts.listMemories(botId) : undefined;
        const bundle = await exportAgentData({
          memory,
          botId,
          workspaceDir,
          memories,
          includeCanvases: true,
        });
        return truncate(summarizeBundle(bundle, 'local'));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const agentImport: Tool = {
    definition: toolDef(
      'agent_import',
      `${LOCAL_NOT_CLOUD} Import an agent bundle file (from agent_export) as a bot. ` +
        'Validates the bundle version and SHA-256 checksum before writing anything. ' +
        'Refuses to overwrite an existing bot id unless overwrite=true; pass newBotId to import under a different id.',
      {
        bundlePath: { type: 'string', description: 'Workspace-relative path of the bundle JSON file.' },
        newBotId: { type: 'string', description: 'Import under a different bot id (optional).' },
        overwrite: { type: 'boolean', description: 'Replace an existing bot with the same id (default false).' },
      },
      ['bundlePath'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const workspaceDir = resolveWorkspace(ctx);
        const bundlePath = getStringArg(args, 'bundlePath');
        const fullPath = resolveWithin(workspaceDir, bundlePath);
        let text: string;
        try {
          text = fs.readFileSync(fullPath, 'utf8');
        } catch {
          return errorResult(`Cannot read agent bundle: "${bundlePath}" (missing or unreadable).`);
        }
        const bundle = parseAgentBundleJson(text);
        const memory = memoryFor(ctx);
        const result = await importAgentData({
          memory,
          workspaceDir,
          bundle,
          newBotId: getOptionalStringArg(args, 'newBotId'),
          overwrite: getBoolArg(args, 'overwrite', false),
        });
        const c = result.counts;
        return truncate(
          `Agent bundle imported as bot "${result.name}" (id ${result.botId})` +
            (result.overwritten ? ' — an existing bot with that id was replaced.' : '.') +
            `\nImported: ${c.history} message(s), ${c.memories} memor(ies), ${c.tasks} task(s), ` +
            `${c.goals} goal(s), ${c.todos} todo(s), ${c.projects} project(s), ${c.canvases} canvas(es).`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  /**
   * v0.53 (P1-7, REA deep-dive lần 2 §3.3 `ConversationHistoryToolCall`):
   * replay an old tool call by its `tool_call_id` (+ `tool_name` +
   * `args_json`). The call is looked up in the tool-call history
   * (recorded by the agent loop); a given `tool_name` must match the
   * record, and `args_json` (when given) must be a JSON object that
   * overrides the recorded args. The target tool is re-executed with
   * the SAME ctx — including its own approval flow — so replaying a
   * write/send still asks the user (this tool itself has
   * `needsApproval: true`). The replay is recorded as a new history
   * entry of its own. Refuses: unknown id, name mismatch, replaying
   * `tool_call_replay` itself (no infinite recursion), and targets
   * that are not in this bot's registry.
   */
  const toolCallReplay: Tool = {
    definition: toolDef(
      'tool_call_replay',
      'Replay a previous tool call by its tool_call_id (from the tool-call history recorded by the agent loop). ' +
        'tool_name (optional) must match the recorded call; args_json (optional) is a JSON object overriding the recorded args. ' +
        'The target tool runs again with the same arguments — writes/sends still go through approval. ' +
        'Refuses unknown ids, name mismatches, replaying tool_call_replay itself, and tools not in this bot\'s registry.',
      {
        tool_call_id: { type: 'string', description: 'Id of the recorded tool call to replay (from history).' },
        tool_name: { type: 'string', description: 'Expected tool name — must match the recorded call (optional, checked when given).' },
        args_json: { type: 'string', description: 'JSON object overriding the recorded args (optional; defaults to the recorded args).' },
      },
      ['tool_call_id'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const workspaceDir = resolveWorkspace(ctx);
        const toolCallId = getStringArg(args, 'tool_call_id');
        const toolNameArg = getOptionalStringArg(args, 'tool_name');
        const argsJsonArg = getOptionalStringArg(args, 'args_json');
        const history = opts.history ?? new ToolCallHistoryStore(workspaceDir);
        const record = history.findById(toolCallId);
        if (!record) {
          return errorResult(
            `No recorded tool call with tool_call_id "${toolCallId}" — nothing to replay. ` +
              'Only calls the agent loop recorded in this workspace can be replayed.',
          );
        }
        if (toolNameArg !== undefined && toolNameArg !== record.tool_name) {
          return errorResult(
            `tool_name mismatch: recorded call "${toolCallId}" is "${record.tool_name}", not "${toolNameArg}" — refusing to replay.`,
          );
        }
        let replayArgs: Record<string, unknown>;
        if (argsJsonArg !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(argsJsonArg);
          } catch {
            return errorResult('Argument "args_json" must be valid JSON.');
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return errorResult('Argument "args_json" must be a JSON object.');
          }
          replayArgs = parsed as Record<string, unknown>;
        } else {
          try {
            const parsed = JSON.parse(record.args_json) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              return errorResult(`Recorded args for "${toolCallId}" are not a JSON object — cannot replay.`);
            }
            replayArgs = parsed as Record<string, unknown>;
          } catch {
            return errorResult(`Recorded args for "${toolCallId}" are not valid JSON — cannot replay.`);
          }
        }
        const toolName = record.tool_name;
        if (toolName === 'tool_call_replay') {
          return errorResult('Refusing to replay tool_call_replay itself (no infinite recursion).');
        }
        const tools = opts.getTools?.() ?? [];
        const target = tools.find((t) => t.definition.name === toolName);
        if (!target) {
          return errorResult(
            `Tool "${toolName}" is not in this bot's registry — cannot replay call "${toolCallId}".`,
          );
        }
        const startedAtMs = Date.now();
        let output: string;
        let ok = true;
        try {
          output = await target.execute(replayArgs, ctx);
        } catch (err) {
          ok = false;
          output = `Error: ${(err as Error).message}`;
        }
        const completedAtMs = Date.now();
        // Record the replay itself (best-effort — never fail the result).
        try {
          history.record({
            tool_call_id: randomUUID(),
            tool_name: 'tool_call_replay',
            args_json: JSON.stringify({
              tool_call_id: toolCallId,
              ...(toolNameArg !== undefined ? { tool_name: toolNameArg } : {}),
              ...(argsJsonArg !== undefined ? { args_json: argsJsonArg } : {}),
            }),
            started_at_ms: startedAtMs,
            completed_at_ms: completedAtMs,
            status: ok ? 'ok' : 'error',
            result_preview: output.slice(0, 500),
          });
        } catch {
          // History write failure must not fail the replay.
        }
        return truncate(
          `Replayed "${toolName}" (original tool_call_id ${toolCallId}, ` +
            `${startedAtMs}→${completedAtMs}ms, ${ok ? 'ok' : 'error'}):\n${output}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [agentExport, agentImport, cloudAgentFetchData, toolCallReplay];
}

/** Unbound placeholders (same pattern as CI_TOOLS / GIT_TOOLS). */
export const AGENT_DATA_TOOLS: Tool[] = createAgentDataTools();
