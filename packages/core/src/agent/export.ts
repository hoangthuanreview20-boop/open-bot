/**
 * Agent data export / import — LOCAL equivalent of "lấy dữ liệu của
 * agent chạy trên cloud" (ROADMAP §2b, v0.7).
 *
 * There is no open-bot cloud: a bot's data lives in the local workspace
 * (BotMemory SQLite + CanvasStore files). This module bundles one bot —
 * config, history, memories, tasks, goals, todos, projects, canvases —
 * into ONE versioned JSON bundle with a SHA-256 checksum, and imports
 * such a bundle back as a bot (same id, or a new id when the caller
 * renames it). Tools that expose this MUST say in their description
 * that it is the local equivalent, not cloud data.
 *
 * Safety:
 *  - Import validates `version` (only 1 is supported) and the checksum
 *    before writing anything.
 *  - Import refuses to overwrite an existing bot id unless the caller
 *    passes `overwrite: true` explicitly.
 *  - The bundle never contains secrets: BotMemory holds no API keys
 *    (they live in the Vault) and canvases are user documents. The
 *    bundle is still written inside the workspace (`.open-bot/exports/`
 *    by default) and must not be committed when it holds private chats.
 *  - Imported tasks/goals/todos/projects get FRESH ids (BotMemory
 *    generates ids on create); their titles/statuses/detail are
 *    preserved. Canvases keep their ids (CanvasStore.write upserts).
 *  - Overwrite replaces the config, memories and canvases, and
 *    APPENDS history/tasks/goals/todos/projects (BotMemory has no
 *    delete for those rows) — re-importing the same bundle with
 *    overwrite on will duplicate those rows. Import into a fresh
 *    workspace/bot id for an exact copy.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BotMemory } from './memory';
import { CanvasStore } from '../canvas/store';

export const AGENT_BUNDLE_VERSION = 1;
export const AGENT_BUNDLE_KIND = 'open-bot-agent-bundle';

export interface AgentBundleMemoryEntry {
  key: string;
  value: string;
  updatedAt?: string;
}

export interface AgentBundleData {
  config: {
    id: string;
    name: string;
    providerId: string;
    model: string;
    systemPrompt: string;
  };
  history: Array<{ role: string; content: string }>;
  memories: AgentBundleMemoryEntry[];
  tasks: Array<{ title: string; status: string; tags: string }>;
  goals: Array<{ title: string; detail: string; status: string }>;
  todos: Array<{ title: string; done: boolean }>;
  projects: Array<{ title: string; detail: string; status: string; updatesEnabled: boolean; lastUpdateAt: string | null }>;
  canvases: Array<{ id: string; title: string; blocks: unknown; version: number }>;
}

export interface AgentBundle {
  kind: typeof AGENT_BUNDLE_KIND;
  version: number;
  exportedAt: string;
  botId: string;
  /** SHA-256 hex of the canonical JSON of `data`. */
  checksum: string;
  data: AgentBundleData;
}

/** Deterministic JSON: object keys sorted recursively, so checksums are stable. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** SHA-256 hex checksum of a bundle's `data` section. */
export function computeBundleChecksum(data: AgentBundleData): string {
  return createHash('sha256').update(stableStringify(data), 'utf8').digest('hex');
}

export interface ExportAgentDataOptions {
  memory: BotMemory;
  botId: string;
  workspaceDir: string;
  /**
   * Free-form memory entries for the bot. BotMemory has no list-all
   * API, so the host supplies them (e.g. from its own key list) or
   * leaves them out — the bundle then simply has no memories.
   */
  memories?: AgentBundleMemoryEntry[];
  /** How much history to include. Default: 1000 messages. */
  historyLimit?: number;
  /** Include canvases (CanvasStore). Default: true. */
  includeCanvases?: boolean;
}

/** Build a bundle for one bot. Throws when the bot id is unknown. */
export async function exportAgentData(options: ExportAgentDataOptions): Promise<AgentBundle> {
  const { memory, botId, workspaceDir } = options;
  const bot = memory.getBot(botId);
  if (!bot) {
    throw new Error(`Cannot export: no bot with id "${botId}" in this workspace's memory.`);
  }
  const history = memory
    .getHistory(botId, options.historyLimit ?? 1000)
    .map((m) => ({ role: m.role, content: m.content }));

  let canvases: AgentBundleData['canvases'] = [];
  if (options.includeCanvases !== false) {
    const store = new CanvasStore(workspaceDir, botId);
    const summaries = await store.list();
    for (const summary of summaries) {
      const doc = await store.read(summary.id);
      if (!doc) continue;
      canvases.push({
        id: doc.id,
        title: doc.title,
        blocks: doc.blocks,
        version: doc.version,
      });
    }
  }

  const data: AgentBundleData = {
    config: {
      id: bot.id,
      name: bot.name,
      providerId: bot.providerId,
      model: bot.model,
      systemPrompt: bot.systemPrompt,
    },
    history,
    memories: [...(options.memories ?? [])].map((m) => ({
      key: m.key,
      value: m.value,
      ...(m.updatedAt ? { updatedAt: m.updatedAt } : {}),
    })),
    tasks: memory.listTasks(botId).map((t) => ({ title: t.title, status: t.status, tags: t.tags })),
    goals: memory.listGoals(botId).map((g) => ({ title: g.title, detail: g.detail, status: g.status })),
    todos: memory.listTodos(botId).map((t) => ({ title: t.title, done: t.done })),
    projects: memory
      .listProjects(botId)
      .map((p) => ({ title: p.title, detail: p.detail, status: p.status, updatesEnabled: p.updatesEnabled, lastUpdateAt: p.lastUpdateAt })),
    canvases,
  };

  return {
    kind: AGENT_BUNDLE_KIND,
    version: AGENT_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    botId: bot.id,
    checksum: computeBundleChecksum(data),
    data,
  };
}

/** Parse + validate a bundle object (version + checksum). Throws on any problem. */
export function validateAgentBundle(value: unknown): AgentBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Agent bundle must be a JSON object.');
  }
  const obj = value as Record<string, unknown>;
  if (obj['kind'] !== AGENT_BUNDLE_KIND) {
    throw new Error(
      `Not an open-bot agent bundle (expected kind "${AGENT_BUNDLE_KIND}").`,
    );
  }
  if (obj['version'] !== AGENT_BUNDLE_VERSION) {
    throw new Error(
      `Unsupported agent bundle version: ${JSON.stringify(obj['version'])} ` +
        `(this build reads version ${AGENT_BUNDLE_VERSION}).`,
    );
  }
  if (typeof obj['botId'] !== 'string' || !obj['botId']) {
    throw new Error('Agent bundle has no botId.');
  }
  if (typeof obj['checksum'] !== 'string' || !obj['checksum']) {
    throw new Error('Agent bundle has no checksum.');
  }
  const data = obj['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Agent bundle has no data section.');
  }
  const actual = computeBundleChecksum(data as AgentBundleData);
  if (actual !== obj['checksum']) {
    throw new Error(
      'Agent bundle checksum mismatch: the file was modified or corrupted after export. Import refused.',
    );
  }
  return obj as unknown as AgentBundle;
}

/** Parse bundle JSON text (throws a clear error on bad JSON). */
export function parseAgentBundleJson(text: string): AgentBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Agent bundle is not valid JSON: ${(err as Error).message}`);
  }
  return validateAgentBundle(parsed);
}

export interface ImportAgentDataOptions {
  memory: BotMemory;
  workspaceDir: string;
  bundle: AgentBundle;
  /** Import under a different bot id (renames the bot). Default: the bundle's botId. */
  newBotId?: string;
  /**
   * When the target bot id already exists: false (default) refuses;
   * true replaces the config/memories/canvases and appends
   * history/tasks/goals/todos/projects (see module header).
   */
  overwrite?: boolean;
}

export interface ImportAgentDataResult {
  botId: string;
  name: string;
  counts: {
    history: number;
    memories: number;
    tasks: number;
    goals: number;
    todos: number;
    projects: number;
    canvases: number;
  };
  overwritten: boolean;
}

/**
 * Import a validated bundle into BotMemory (+ CanvasStore).
 * Call `validateAgentBundle` / `parseAgentBundleJson` first when the
 * bundle comes from a file — this function re-validates the checksum
 * itself, so passing an unvalidated object is also safe.
 */
export async function importAgentData(
  options: ImportAgentDataOptions,
): Promise<ImportAgentDataResult> {
  const bundle = validateAgentBundle(options.bundle);
  const targetId = options.newBotId ?? bundle.botId;
  if (!targetId.trim()) throw new Error('Import target bot id must not be empty.');
  const existing = options.memory.getBot(targetId);
  if (existing && options.overwrite !== true) {
    throw new Error(
      `A bot with id "${targetId}" already exists in this workspace. ` +
        'Import refused to avoid overwriting it — pass overwrite: true to replace it, ' +
        'or import under a different id (newBotId).',
    );
  }
  const data = bundle.data;
  const config = {
    ...data.config,
    id: targetId,
  };
  options.memory.saveBot(config);
  for (const message of data.history) {
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
      continue; // skip malformed rows instead of failing the whole import
    }
    options.memory.saveMessage(targetId, message.role, message.content);
  }
  for (const entry of data.memories) {
    if (typeof entry.key !== 'string' || typeof entry.value !== 'string') continue;
    options.memory.setMemory(targetId, entry.key, entry.value);
  }
  for (const task of data.tasks) {
    const id = options.memory.createTask(targetId, task.title, task.tags ?? '');
    if (task.status === 'in_progress' || task.status === 'done' || task.status === 'cancelled') {
      options.memory.updateTask(id, task.status);
    }
  }
  for (const goal of data.goals) {
    const id = options.memory.createGoal(targetId, goal.title, goal.detail ?? '');
    if (goal.status === 'paused' || goal.status === 'done' || goal.status === 'cancelled') {
      options.memory.updateGoal(id, { status: goal.status });
    }
  }
  for (const todo of data.todos) {
    const id = options.memory.createTodo(targetId, todo.title);
    if (todo.done) options.memory.updateTodo(id, { done: true });
  }
  for (const project of data.projects) {
    const id = options.memory.createProject(targetId, project.title, project.detail ?? '');
    if (project.status === 'paused' || project.status === 'done' || project.status === 'cancelled') {
      options.memory.updateProject(id, { status: project.status });
    }
    if (project.updatesEnabled) options.memory.setProjectUpdates(id, true);
    if (project.lastUpdateAt) {
      options.memory.setProjectLastUpdateAt(id, new Date(project.lastUpdateAt));
    }
  }
  const store = new CanvasStore(options.workspaceDir, targetId);
  for (const canvas of data.canvases) {
    await store.write(canvas.id, canvas.blocks, { title: canvas.title });
  }
  return {
    botId: targetId,
    name: config.name,
    counts: {
      history: data.history.length,
      memories: data.memories.length,
      tasks: data.tasks.length,
      goals: data.goals.length,
      todos: data.todos.length,
      projects: data.projects.length,
      canvases: data.canvases.length,
    },
    overwritten: existing !== null,
  };
}

/** File name for an export bundle (under `.open-bot/exports/` by default). */
export function defaultBundleFileName(botId: string, when: Date = new Date()): string {
  const safeId = botId.replace(/[^A-Za-z0-9._-]/g, '_');
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  return `agent-${safeId}-${stamp}-${randomUUID().slice(0, 8)}.json`;
}
