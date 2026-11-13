/**
 * A2A client tools for @open-bot/tools (P1-2, v0.31).
 *
 * Lets an agent inside open-bot hand work to an EXTERNAL A2A agent
 * (A2A 1.0: Agent Card + JSON-RPC `message:send` / `tasks/get` /
 * `tasks/cancel` / `tasks/list`, SSE via `A2aClient.streamMessage`).
 * The client itself lives in @open-bot/core (`a2a/client.ts`, v0.13);
 * this file only wraps it as tools.
 *
 * Security — trust gate (fail-closed):
 *  - The agent can only call agents the USER has explicitly trusted
 *    (trusted-agent store, managed from the A2A Agents view in the UI).
 *  - There is deliberately NO tool that adds trust: `a2a_discover`
 *    only reads a card, it never trusts. Trust is a user decision
 *    made in the UI (IPC `a2a:trusted-add` in main), never by the model.
 *  - `a2a_send` / `a2a_cancel` change outside state -> needsApproval.
 *    `a2a_status` / `a2a_list_agents` / `a2a_list_tasks` only read.
 *  - No token is ever stored by these tools. A per-call `token` is
 *    accepted by `a2a_discover` only (passed through, never persisted).
 *
 * Factory:
 *   createA2aTools(opts?) -> Tool[]   (bound, usable)
 *   A2A_TOOLS                          (unbound placeholder, empty store)
 *
 * Store: pass a `TrustedA2aAgentStore` (or a `trustedAgentsFile` path
 * for the JSON file store) — otherwise an in-memory store is used.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  A2aClient,
  A2aDelegator,
  createA2aDelegator,
  fetchAgentCard,
  fetchCheckedAgentCard,
  isA2aTerminalState,
  partsToText,
  verifyAgentCardTrust,
} from '@open-bot/core';
import type {
  A2aAgentCard,
  A2aArtifact,
  A2aLocalBotTarget,
  A2aNetworkPolicy,
  A2aTask,
} from '@open-bot/core';

/** Tối đa ký tự của message gửi qua `a2a_send` (tránh đốt token/kẹt turn). */
export const A2A_MAX_MESSAGE_CHARS = 20_000;
/** Timeout mặc định khi chờ task tới trạng thái cuối trong `a2a_send` (2 phút). */
export const A2A_DEFAULT_WAIT_MS = 120_000;
/** Timeout mặc định mỗi request HTTP (30s, cùng A2A client). */
export const A2A_DEFAULT_TIMEOUT_MS = 30_000;

/** Một agent ngoài mà user đã tin tưởng (lưu card của nó). */
export interface TrustedA2aAgent {
  /** URL gốc đã chuẩn hoá (không trailing slash) — key duy nhất. */
  baseUrl: string;
  /** Tên từ Agent Card. */
  name: string;
  /** Mô tả từ Agent Card. */
  description?: string;
  /** Endpoint JSON-RPC từ card (thường = baseUrl). */
  url: string;
  /** Skill mà agent khai trong card (để model chọn đúng agent). */
  skills?: Array<{ id: string; name: string; description: string }>;
  /** Card có hỗ trợ streaming không. */
  streaming?: boolean;
  /** ISO-8601 lúc user tin tưởng agent này. */
  trustedAt: string;
}

/** Store cho agent đã tin tưởng — memory hoặc file JSON. */
export interface TrustedA2aAgentStore {
  list(): TrustedA2aAgent[] | Promise<TrustedA2aAgent[]>;
  get(baseUrl: string): TrustedA2aAgent | undefined | Promise<TrustedA2aAgent | undefined>;
  add(agent: TrustedA2aAgent): void | Promise<void>;
  remove(baseUrl: string): boolean | Promise<boolean>;
}

export interface A2aToolOptions {
  /** Store agent đã tin tưởng (thắng `trustedAgentsFile` khi cả hai có). */
  store?: TrustedA2aAgentStore;
  /** Đường dẫn file JSON lưu agent đã tin tưởng (vd userData/a2a-trusted-agents.json). */
  trustedAgentsFile?: string;
  /** Timeout mặc định mỗi request HTTP (ms). */
  timeoutMs?: number;
  /**
   * v0.97: policy mạng A2A — khi truyền vào, client/delegation chặn
   * URL ngoài loopback nếu policy chưa cho phép expose ngoài.
   */
  networkPolicy?: A2aNetworkPolicy;
  /**
   * v0.97: bot đích nội bộ cho `a2a_delegate` (botId + runner nội bộ
   * hoặc baseUrl). Không truyền → tool delegate báo chưa có bot đích
   * nào đăng ký. Thắng `delegator` khi cả hai có? Không — `delegator`
   * có sẵn thì dùng nó, `localBots` chỉ dùng khi chưa có delegator.
   */
  localBots?: A2aLocalBotTarget[];
  /** v0.97: delegator có sẵn (coordinator tạo một lần, dùng chung). */
  delegator?: A2aDelegator;
  /**
   * v0.97: provider của bot đang chạy tool này (vd 'mock') — coordinator
   * điền khi tạo tool theo bot; delegator từ chối bot nguồn mock/cli
   * (bài học hồi quy v0.96). Không điền → không áp miễn trừ.
   */
  sourceProvider?: string;
  /** v0.97: kind của bot đang chạy tool (vd 'cli'). Xem `sourceProvider`. */
  sourceKind?: string;
  /** v0.97: fingerprint key card đã trust (để `a2a_verify_card` báo key mới/cũ). */
  knownCardKeyIds?: readonly string[];
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`URL agent không hợp lệ: "${raw}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`A2A chỉ gọi qua http(s) — URL "${raw}" dùng protocol khác.`);
  }
  return url.toString().replace(/\/+$/, '');
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

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function clampTimeout(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(Math.max(Math.floor(value), 1_000), max);
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

/** Store trong bộ nhớ — dùng cho test và khi chưa có file. */
export function createMemoryTrustedAgentStore(
  initial: TrustedA2aAgent[] = [],
): TrustedA2aAgentStore {
  const agents = new Map<string, TrustedA2aAgent>();
  for (const a of initial) agents.set(normalizeBaseUrl(a.baseUrl), { ...a, baseUrl: normalizeBaseUrl(a.baseUrl) });
  return {
    list: () => [...agents.values()],
    get: (baseUrl: string) => {
      try {
        return agents.get(normalizeBaseUrl(baseUrl));
      } catch {
        return undefined;
      }
    },
    add: (agent: TrustedA2aAgent) => {
      const key = normalizeBaseUrl(agent.baseUrl);
      agents.set(key, { ...agent, baseUrl: key });
    },
    remove: (baseUrl: string) => {
      try {
        return agents.delete(normalizeBaseUrl(baseUrl));
      } catch {
        return false;
      }
    },
  };
}

interface TrustedAgentsFileShape {
  agents?: unknown;
}

/** Store file JSON `{ agents: TrustedA2aAgent[] }` — ghi qua tmp + rename. */
export function createFileTrustedAgentStore(filePath: string): TrustedA2aAgentStore {
  function readAll(): TrustedA2aAgent[] {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Không đọc được file agent A2A đã tin tưởng (${filePath}): ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as TrustedAgentsFileShape;
    } catch {
      throw new Error(`File agent A2A đã tin tưởng (${filePath}) không phải JSON hợp lệ — sửa hoặc xoá file rồi thử lại.`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as TrustedAgentsFileShape).agents)) {
      throw new Error(`File agent A2A đã tin tưởng (${filePath}) sai định dạng: cần { agents: [...] }.`);
    }
    const out: TrustedA2aAgent[] = [];
    for (const entry of (parsed as { agents: unknown[] }).agents) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec['baseUrl'] !== 'string' || typeof rec['name'] !== 'string') continue;
      try {
        out.push({ ...(rec as unknown as TrustedA2aAgent), baseUrl: normalizeBaseUrl(rec['baseUrl'] as string) });
      } catch {
        continue;
      }
    }
    return out;
  }

  function writeAll(agents: TrustedA2aAgent[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ agents }, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  return {
    list: () => readAll(),
    get: (baseUrl: string) => {
      try {
        return readAll().find((a) => a.baseUrl === normalizeBaseUrl(baseUrl));
      } catch {
        return undefined;
      }
    },
    add: (agent: TrustedA2aAgent) => {
      const agents = readAll().filter((a) => a.baseUrl !== normalizeBaseUrl(agent.baseUrl));
      agents.push({ ...agent, baseUrl: normalizeBaseUrl(agent.baseUrl) });
      writeAll(agents);
    },
    remove: (baseUrl: string) => {
      const key = normalizeBaseUrl(baseUrl);
      const agents = readAll();
      const kept = agents.filter((a) => a.baseUrl !== key);
      if (kept.length === agents.length) return false;
      writeAll(kept);
      return true;
    },
  };
}

/** Agent Card -> bản ghi trusted (ghi rõ lúc tin tưởng). */
export function trustedAgentFromCard(
  card: A2aAgentCard,
  baseUrl: string,
): TrustedA2aAgent {
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    name: card.name,
    description: card.description,
    url: card.url,
    skills: (card.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description })),
    streaming: card.capabilities?.streaming,
    trustedAt: new Date().toISOString(),
  };
}

/** Text kết quả chính của một task (gộp text các artifact, fallback status message). */
export function taskResultText(task: A2aTask): string {
  const fromArtifacts = (task.artifacts ?? [])
    .map((a: A2aArtifact) => partsToText(a.parts))
    .filter((t) => t.length > 0)
    .join('\n');
  if (fromArtifacts) return fromArtifacts;
  return partsToText(task.status.message?.parts ?? []);
}

function summarizeTask(task: A2aTask): Record<string, unknown> {
  return {
    taskId: task.id,
    state: task.status.state,
    text: taskResultText(task),
    artifacts: (task.artifacts ?? []).map((a: A2aArtifact) => ({
      artifactId: a.artifactId,
      name: a.name ?? null,
      text: partsToText(a.parts),
    })),
    updatedAt: task.updatedAt ?? task.status.timestamp ?? null,
  };
}

export function createA2aTools(opts: A2aToolOptions = {}): Tool[] {
  const store: TrustedA2aAgentStore =
    opts.store ??
    (opts.trustedAgentsFile
      ? createFileTrustedAgentStore(opts.trustedAgentsFile)
      : createMemoryTrustedAgentStore());
  const defaultTimeoutMs = opts.timeoutMs ?? A2A_DEFAULT_TIMEOUT_MS;

  async function resolveTrustedAgent(ref: string): Promise<TrustedA2aAgent> {
    const agents = await store.list();
    const byUrl = (() => {
      try {
        const key = normalizeBaseUrl(ref);
        return agents.find((a) => a.baseUrl === key);
      } catch {
        return undefined;
      }
    })();
    if (byUrl) return byUrl;
    const byName = agents.find((a) => a.name === ref);
    if (byName) return byName;
    if (agents.length === 0) {
      throw new Error(
        `Chưa có agent A2A nào được tin tưởng — mở màn hình "A2A Agents" trong app, nhập URL agent rồi bấm tin tưởng trước.`,
      );
    }
    throw new Error(
      `Agent "${ref}" chưa được tin tưởng. Agent đã tin tưởng: ${agents.map((a) => `${a.name} (${a.baseUrl})`).join(', ')}. ` +
        `Chỉ user mới được thêm agent tin tưởng (màn hình "A2A Agents") — agent không tự tin tưởng agent ngoài.`,
    );
  }

  function clientFor(agent: TrustedA2aAgent, timeoutMs: number): A2aClient {
    return new A2aClient({ baseUrl: agent.baseUrl, timeoutMs });
  }

  const discover: Tool = {
    definition: toolDef(
      'a2a_discover',
      'Đọc Agent Card của một agent A2A ngoài từ URL gốc của nó (/.well-known/agent-card.json) để xem nó tên gì, làm được gì (skills), có hỗ trợ streaming không. CHỈ ĐỌC — không tin tưởng agent này; chỉ user mới được tin tưởng agent ở màn hình "A2A Agents".',
      {
        url: { type: 'string', description: 'URL gốc của agent ngoài, vd http://127.0.0.1:8080/.' },
        token: { type: 'string', description: 'Bearer token tuỳ chọn (chỉ dùng cho lần gọi này, không lưu).' },
      },
      ['url'],
    ),
    needsApproval: true,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const url = normalizeBaseUrl(getStringArg(args, 'url'));
        const token = getOptionalStringArg(args, 'token');
        const card = await fetchAgentCard(url, { timeoutMs: defaultTimeoutMs, token });
        return JSON.stringify(
          {
            name: card.name,
            description: card.description,
            url: card.url,
            version: card.version ?? null,
            streaming: card.capabilities?.streaming ?? false,
            pushNotifications: card.capabilities?.pushNotifications ?? false,
            skills: (card.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description })),
            trusted: (await store.list()).some((a) => a.baseUrl === url),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const listAgents: Tool = {
    definition: toolDef(
      'a2a_list_agents',
      'Liệt kê các agent A2A ngoài mà user đã tin tưởng (tên, URL, skill) — chỉ những agent này mới giao việc được qua a2a_send.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async (): Promise<string> => {
      try {
        const agents = await store.list();
        if (agents.length === 0) {
          return 'Chưa có agent A2A nào được tin tưởng. User thêm agent ở màn hình "A2A Agents" trong app.';
        }
        return JSON.stringify(
          agents.map((a) => ({
            name: a.name,
            baseUrl: a.baseUrl,
            description: a.description ?? null,
            skills: (a.skills ?? []).map((s) => s.id),
            streaming: a.streaming ?? false,
            trustedAt: a.trustedAt,
          })),
          null,
          2,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const send: Tool = {
    definition: toolDef(
      'a2a_send',
      'Giao một việc cho agent A2A ngoài ĐÃ ĐƯỢC user tin tưởng: gửi message, đợi task chạy xong (poll khi server trả task chưa xong), trả về trạng thái + artifact (kết quả). Agent chỉ được gọi agent trong danh sách tin tưởng — không gọi URL lạ.',
      {
        agent: { type: 'string', description: 'Tên hoặc URL gốc của agent đã tin tưởng (xem a2a_list_agents).' },
        message: { type: 'string', description: 'Việc cần giao (mô tả rõ ràng cho agent ngoài).' },
        contextId: { type: 'string', description: 'ID hội thoại tuỳ chọn để nối tiếp task cũ.' },
        timeoutMs: { type: 'number', description: 'Timeout mỗi request HTTP, ms. Mặc định 30000 (kẹp 1000–300000).' },
        waitMs: { type: 'number', description: 'Thời gian tối đa chờ task xong, ms. Mặc định 120000 (kẹp 1000–600000).' },
      },
      ['agent', 'message'],
    ),
    needsApproval: true,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const agent = await resolveTrustedAgent(getStringArg(args, 'agent'));
        const message = getStringArg(args, 'message');
        if (message.length > A2A_MAX_MESSAGE_CHARS) {
          return errorResult(`Message dài ${message.length} ký tự, vượt giới hạn ${A2A_MAX_MESSAGE_CHARS} ký tự — rút ngắn rồi gửi lại.`);
        }
        const timeoutMs = clampTimeout(getNumberArg(args, 'timeoutMs'), defaultTimeoutMs, 300_000);
        const waitMs = clampTimeout(getNumberArg(args, 'waitMs'), A2A_DEFAULT_WAIT_MS, 600_000);
        const contextId = getOptionalStringArg(args, 'contextId');
        const client = clientFor(agent, timeoutMs);
        let task = await client.sendMessage(message, { contextId, timeoutMs });
        if (!isA2aTerminalState(task.status.state)) {
          task = await client.pollTask(task.id, { timeoutMs: waitMs });
        }
        return JSON.stringify({ agent: agent.name, ...summarizeTask(task) }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const status: Tool = {
    definition: toolDef(
      'a2a_status',
      'Xem trạng thái một task đã giao cho agent A2A ngoài (tasks/get): trạng thái (submitted/working/completed/failed/…) + artifact đã có.',
      {
        agent: { type: 'string', description: 'Tên hoặc URL gốc của agent đã tin tưởng.' },
        taskId: { type: 'string', description: 'ID task (trả về từ a2a_send).' },
      },
      ['agent', 'taskId'],
    ),
    needsApproval: false,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const agent = await resolveTrustedAgent(getStringArg(args, 'agent'));
        const taskId = getStringArg(args, 'taskId');
        const client = clientFor(agent, defaultTimeoutMs);
        const task = await client.getTask(taskId);
        return JSON.stringify({ agent: agent.name, ...summarizeTask(task) }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const cancel: Tool = {
    definition: toolDef(
      'a2a_cancel',
      'Huỷ một task đang chạy trên agent A2A ngoài (tasks/cancel). Task đã tới trạng thái cuối thì không huỷ được nữa.',
      {
        agent: { type: 'string', description: 'Tên hoặc URL gốc của agent đã tin tưởng.' },
        taskId: { type: 'string', description: 'ID task cần huỷ.' },
      },
      ['agent', 'taskId'],
    ),
    needsApproval: true,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const agent = await resolveTrustedAgent(getStringArg(args, 'agent'));
        const taskId = getStringArg(args, 'taskId');
        const client = clientFor(agent, defaultTimeoutMs);
        const task = await client.cancelTask(taskId);
        return JSON.stringify({ agent: agent.name, ...summarizeTask(task) }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const listTasks: Tool = {
    definition: toolDef(
      'a2a_list_tasks',
      'Liệt kê task trên agent A2A ngoài đã tin tưởng (tasks/list), mới nhất trước — để xem task nào đang chạy / đã xong mà không cần nhớ taskId.',
      {
        agent: { type: 'string', description: 'Tên hoặc URL gốc của agent đã tin tưởng.' },
        limit: { type: 'number', description: 'Số task tối đa, mặc định 10 (kẹp 1–100).' },
        contextId: { type: 'string', description: 'Chỉ liệt kê task thuộc context này.' },
      },
      ['agent'],
    ),
    needsApproval: false,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const agent = await resolveTrustedAgent(getStringArg(args, 'agent'));
        const limitRaw = getNumberArg(args, 'limit');
        const limit = limitRaw === undefined ? 10 : Math.min(Math.max(Math.floor(limitRaw), 1), 100);
        const contextId = getOptionalStringArg(args, 'contextId');
        const client = clientFor(agent, defaultTimeoutMs);
        const res = await client.listTasks({ limit, contextId });
        return JSON.stringify(
          {
            agent: agent.name,
            total: res.total,
            tasks: res.tasks.map((t) => ({
              taskId: t.id,
              state: t.status.state,
              text: taskResultText(t),
              updatedAt: t.updatedAt ?? t.status.timestamp ?? null,
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const delegate: Tool = {
    definition: toolDef(
      'a2a_delegate',
      'Ủy thác một subtask cho một bot khác trong open-bot qua giao thức A2A (bot-bot delegation): bot đích chạy qua A2A server tạm trên loopback với runner của nó, hoặc qua HTTP khi bot đích có baseUrl. Bot nguồn mock/CLI bị từ chối (không ủy thác giả). Trả trạng thái + kết quả task của bot đích.',
      {
        toBot: { type: 'string', description: 'Bot đích nhận subtask (botId đã đăng ký nhận ủy thác).' },
        message: { type: 'string', description: 'Việc cần ủy thác (mô tả rõ ràng cho bot đích).' },
        contextId: { type: 'string', description: 'ID hội thoại tùy chọn để nối tiếp task cũ ở bot đích.' },
        timeoutMs: { type: 'number', description: 'Timeout mỗi request HTTP, ms. Mặc định 30000 (kẹp 1000–300000).' },
        waitMs: { type: 'number', description: 'Thời gian tối đa chờ bot đích xong, ms. Mặc định 120000 (kẹp 1000–600000).' },
      },
      ['toBot', 'message'],
    ),
    needsApproval: true,
    execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      try {
        const toBot = getStringArg(args, 'toBot');
        const message = getStringArg(args, 'message');
        if (message.length > A2A_MAX_MESSAGE_CHARS) {
          return errorResult(`Message dài ${message.length} ký tự, vượt giới hạn ${A2A_MAX_MESSAGE_CHARS} ký tự — rút ngắn rồi gửi lại.`);
        }
        const timeoutMs = clampTimeout(getNumberArg(args, 'timeoutMs'), defaultTimeoutMs, 300_000);
        const waitMs = clampTimeout(getNumberArg(args, 'waitMs'), A2A_DEFAULT_WAIT_MS, 600_000);
        const contextId = getOptionalStringArg(args, 'contextId');
        const delegator =
          opts.delegator ??
          createA2aDelegator(opts.localBots ?? [], { networkPolicy: opts.networkPolicy });
        // v0.97: bot đích chưa đăng ký nội bộ → thử agent ngoài mà user
        // đã tin tưởng (a2a_list_agents): đăng ký tạm thời với baseUrl
        // của nó (không token — token của agent ngoài không lưu).
        if (!delegator.bots.get(toBot)) {
          try {
            const trusted = await resolveTrustedAgent(toBot);
            delegator.bots.register({ botId: toBot, name: trusted.name, baseUrl: trusted.baseUrl });
          } catch {
            // Không phải agent tin tưởng → delegate() dưới đây báo
            // lỗi "chưa đăng ký" rõ ràng (kèm danh sách bot đã biết).
          }
        }
        const result = await delegator.delegate({
          fromBotId: ctx?.botId ?? 'unknown-bot',
          fromProvider: opts.sourceProvider,
          fromKind: opts.sourceKind,
          toBotId: toBot,
          message,
          contextId,
          timeoutMs,
          waitMs,
        });
        return JSON.stringify(
          {
            fromBot: ctx?.botId ?? 'unknown-bot',
            targetBot: result.targetBotId,
            depth: result.depth,
            via: result.via,
            endpoint: result.endpoint,
            ...summarizeTask(result.task),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const verifyCard: Tool = {
    definition: toolDef(
      'a2a_verify_card',
      'Đọc Agent Card của một agent A2A ngoài rồi kiểm tra: protocol version có tương thích không (đàm phán 1.x) và chữ ký Ed25519 của card có khớp nội dung không (card ký bằng key local, key mới thì báo firstSeen). CHỈ ĐỌC — không tin tưởng agent này.',
      {
        url: { type: 'string', description: 'URL gốc của agent ngoài, vd http://127.0.0.1:8080/.' },
        token: { type: 'string', description: 'Bearer token tùy chọn (chỉ dùng cho lần gọi này, không lưu).' },
      },
      ['url'],
    ),
    needsApproval: false,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const url = normalizeBaseUrl(getStringArg(args, 'url'));
        const token = getOptionalStringArg(args, 'token');
        const checked = await fetchCheckedAgentCard(url, {
          timeoutMs: defaultTimeoutMs,
          token,
          networkPolicy: opts.networkPolicy,
        });
        const trust = verifyAgentCardTrust(
          checked.card as unknown as Record<string, unknown>,
          opts.knownCardKeyIds ?? [],
        );
        return JSON.stringify(
          {
            name: checked.card.name,
            description: checked.card.description,
            url: checked.card.url,
            version: {
              cardVersion: checked.version.cardVersion,
              negotiated: checked.version.negotiated,
              compatible: checked.version.ok,
              warnings: checked.version.warnings,
              ...(checked.version.reason ? { reason: checked.version.reason } : {}),
            },
            signature: {
              present: !checked.signature.unsigned,
              valid: checked.signature.ok,
              keyId: checked.signature.keyId,
              trustedBefore: trust.trustedBefore,
              firstSeen: trust.firstSeen,
              ...(checked.signature.reason ? { reason: checked.signature.reason } : {}),
            },
            streaming: checked.card.capabilities?.streaming ?? false,
            pushNotifications: checked.card.capabilities?.pushNotifications ?? false,
            stateTransitionHistory: checked.card.capabilities?.stateTransitionHistory ?? false,
            skills: (checked.card.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description })),
            trusted: (await store.list()).some((a) => a.baseUrl === url),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [discover, listAgents, send, status, cancel, listTasks, delegate, verifyCard];
}

/** Placeholder chưa gắn store (theo mẫu SUBAGENT_TOOLS) — dùng createA2aTools(opts) để có store thật. */
export const A2A_TOOLS: Tool[] = createA2aTools();

/** Tên các tool A2A (để filter/gom tool theo ngữ cảnh dùng khi cần). */
export const A2A_TOOL_NAMES: readonly string[] = [
  'a2a_discover',
  'a2a_list_agents',
  'a2a_send',
  'a2a_status',
  'a2a_cancel',
  'a2a_list_tasks',
  'a2a_delegate',
  'a2a_verify_card',
];

export type { Tool, ToolContext };
