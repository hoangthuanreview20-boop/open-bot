/**
 * Sleep-time consolidation agent — agent nền gom memory lúc rảnh
 * (v0.98, Đội T1).
 *
 * Ý tưởng kiểu "sleep-time compute" của Letta/MemGPT: khi bot rảnh
 * (đủ N turn kể từ lần chạy trước, hoặc khi context bị compact),
 * agent nền review các episode chưa xử lý, rút fact, consolidate vào
 * đồ thị, đẩy fact quan trọng lên block `human`.
 *
 * Khác với ConsolidationScheduler v0.96 (chỉ luật xác định trên
 * long-term memory), agent này:
 *  - Có VÒNG LẶP TOOL GIỚI HẠN: mỗi lần chạy tối đa `maxSteps`
 *    batch (mỗi batch = tối đa `batchSize` episode). Hết bước thì
 *    dừng, để phần còn lại cho lần chạy sau — không bao giờ chạy
 *    vô hạn, không bao giờ chặn turn của user.
 *  - Ghi RUN LOG append-only (`.open-bot/memory-graph-runs.jsonl`):
 *    mỗi lần chạy ghi 1 dòng (trigger, số episode, số fact
 *    ADD/UPDATE/DELETE/QUARANTINE, lỗi nếu có) để UI/debug xem lại.
 *  - FAIL-OPEN: lỗi ở batch nào chỉ ghi log, không throw ra caller
 *    (coordinator gọi best-effort lúc setup turn).
 *  - Không gọi model mặc định: dùng `RuleBasedFactExtractor`. Muốn
 *    LLM thì caller inject `OllamaFactExtractor` qua options.
 *
 * Trigger:
 *  - `noteTurn()` — coordinator gọi sau mỗi turn; khi
 *    `turnsSinceLastRun >= afterTurns` và đã qua `cooldownMs` thì
 *    `maybeRun()` chạy.
 *  - `runOnCompact()` — gọi khi context compact (turn bị tóm tắt):
 *    episode sắp mất khỏi context nên consolidate NGAY để khỏi mất
 *    fact.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FactExtractor } from './extract';
import { RuleBasedFactExtractor } from './extract';
import type { ConsolidateGraphOptions, ConsolidateGraphResult } from './consolidateGraph';
import { consolidateCandidates, promoteToHumanBlock, suspiciousCandidateForText } from './consolidateGraph';
import { TemporalGraphStore, MEMORY_GRAPH_RUNS_REL_PATH } from './store';
import { MemoryBlockStore } from '../blocks';
import type { MemoryScope } from './types';

export type SleepTrigger = 'turns' | 'compact' | 'manual';

export interface SleepAgentConfig {
  /** Bật/tắt agent nền (mặc định TẮT — user bật trong Settings). */
  enabled: boolean;
  /** Số turn kể từ lần chạy trước thì chạy lại (mặc định 10). */
  afterTurns: number;
  /** Số batch tối đa mỗi lần chạy (mặc định 5). */
  maxSteps: number;
  /** Số episode mỗi batch (mặc định 10). */
  batchSize: number;
  /** Khoảng nghỉ tối thiểu giữa 2 lần chạy (ms, mặc định 5 phút). */
  cooldownMs: number;
  /** Confidence tối thiểu để đẩy fact lên block human (mặc định 0.9). */
  promoteMinConfidence: number;
  /**
   * Bộ đếm PERSISTED (ghi cùng file config): số turn kể từ lần chạy
   * trước. Lưu xuống đĩa để agent không phụ thuộc vào instance trong
   * bộ nhớ — defaultToolFactory và coordinator đều dựng agent mới
   * từ cùng file config mà vẫn thấy đúng đếm.
   */
  turnsSinceLastRun: number;
  /** Timestamp lần chạy gần nhất (ms epoch, 0 = chưa chạy bao giờ). */
  lastRunAtMs: number;
}

export const DEFAULT_SLEEP_CONFIG: SleepAgentConfig = {
  enabled: false,
  afterTurns: 10,
  maxSteps: 5,
  batchSize: 10,
  cooldownMs: 5 * 60_000,
  promoteMinConfidence: 0.9,
  turnsSinceLastRun: 0,
  lastRunAtMs: 0,
};

export interface SleepRunLog {
  at: string;
  trigger: SleepTrigger;
  botId: string;
  episodesExamined: number;
  added: number;
  updated: number;
  deleted: number;
  quarantined: number;
  skipped: number;
  promoted: number;
  stepsUsed: number;
  /** true = còn episode chưa xử lý (hết bước, để lần sau). */
  hasMore: boolean;
  extractor: string;
  error?: string;
  details: string[];
}

export interface SleepAgentOptions {
  store: TemporalGraphStore;
  /** Thư mục workspace của bot (để ghi run log). */
  workspaceDir: string;
  scope: MemoryScope;
  extractor?: FactExtractor;
  config?: Partial<SleepAgentConfig>;
  consolidateOpts?: ConsolidateGraphOptions;
  /** Adapter đẩy fact lên block human (vắng = không promote). */
  humanBlockAdapter?: { appendHumanFact(text: string): boolean };
  /** Clock inject được (test dùng clock giả). */
  now?: () => number;
}

/** File cấu hình sleep agent trong workspace của bot. */
export const MEMORY_GRAPH_CONFIG_REL_PATH = path.join('.open-bot', 'memory-graph-config.json');

/** Đọc cấu hình sleep agent từ workspace (thiếu file / hỏng → mặc định). */
export function loadSleepConfig(workspaceDir: string): SleepAgentConfig {
  try {
    const raw = fs.readFileSync(path.join(workspaceDir, MEMORY_GRAPH_CONFIG_REL_PATH), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SleepAgentConfig>;
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SLEEP_CONFIG };
    return { ...DEFAULT_SLEEP_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_SLEEP_CONFIG };
  }
}

/** Ghi cấu hình sleep agent xuống workspace (atomic, mode 0600). */
export function saveSleepConfig(workspaceDir: string, patch: Partial<SleepAgentConfig>): SleepAgentConfig {
  const next = { ...loadSleepConfig(workspaceDir), ...patch };
  const filePath = path.join(workspaceDir, MEMORY_GRAPH_CONFIG_REL_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return { ...next };
}

/**
 * Agent nền consolidation. Một instance cho một bot (giữ đếm turn
 * trong bộ nhớ; khởi động lại app thì đếm lại từ 0 — an toàn vì
 * episode chưa xử lý vẫn còn trong store).
 */
export class SleepConsolidationAgent {
  private readonly store: TemporalGraphStore;
  private readonly workspaceDir: string;
  private readonly scope: MemoryScope;
  private readonly extractor: FactExtractor;
  private readonly config: SleepAgentConfig;
  private readonly consolidateOpts: ConsolidateGraphOptions;
  private readonly humanBlockAdapter?: { appendHumanFact(text: string): boolean };
  private readonly now: () => number;
  private turnsSinceLastRun = 0;
  private lastRunAtMs = 0;
  private running = false;

  constructor(opts: SleepAgentOptions) {
    this.store = opts.store;
    this.workspaceDir = opts.workspaceDir;
    this.scope = opts.scope;
    this.extractor = opts.extractor ?? new RuleBasedFactExtractor();
    this.config = { ...DEFAULT_SLEEP_CONFIG, ...(opts.config ?? {}) };
    this.consolidateOpts = opts.consolidateOpts ?? {};
    this.humanBlockAdapter = opts.humanBlockAdapter;
    this.now = opts.now ?? Date.now;
    this.turnsSinceLastRun = this.config.turnsSinceLastRun;
    this.lastRunAtMs = this.config.lastRunAtMs;
  }

  getConfig(): SleepAgentConfig {
    return { ...this.config };
  }

  /** Cập nhật cấu hình lúc chạy (UI đổi Settings → coordinator áp lại). */
  setConfig(patch: Partial<SleepAgentConfig>): SleepAgentConfig {
    Object.assign(this.config, patch);
    this.turnsSinceLastRun = this.config.turnsSinceLastRun;
    this.lastRunAtMs = this.config.lastRunAtMs;
    this.persistCounters();
    return this.getConfig();
  }

  /** Ghi bộ đếm xuống file config (best-effort, không throw). */
  private persistCounters(): void {
    try {
      saveSleepConfig(this.workspaceDir, {
        turnsSinceLastRun: this.turnsSinceLastRun,
        lastRunAtMs: this.lastRunAtMs,
      });
    } catch {
      // Ghi config lỗi thì đếm trong bộ nhớ vẫn đúng cho instance này.
    }
  }

  getTurnsSinceLastRun(): number {
    return this.turnsSinceLastRun;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Coordinator gọi sau mỗi turn của bot. */
  noteTurn(): void {
    this.turnsSinceLastRun += 1;
    this.persistCounters();
  }

  /** Đủ điều kiện chạy chưa (bật + đủ turn + qua cooldown + không đang chạy). */
  isDue(): boolean {
    if (!this.config.enabled || this.running) return false;
    if (this.turnsSinceLastRun < this.config.afterTurns) return false;
    if (this.lastRunAtMs > 0 && this.now() - this.lastRunAtMs < this.config.cooldownMs) return false;
    return true;
  }

  /**
   * Chạy nếu tới hạn (best-effort: trả null khi chưa tới hạn, trả
   * log khi đã chạy; không bao giờ throw).
   */
  async maybeRun(): Promise<SleepRunLog | null> {
    if (!this.isDue()) return null;
    return this.run('turns');
  }

  /** Chạy ngay khi context compact (bỏ qua đếm turn + cooldown). */
  async runOnCompact(): Promise<SleepRunLog | null> {
    if (!this.config.enabled || this.running) return null;
    return this.run('compact');
  }

  /** Chạy tay (nút "Chạy consolidation" trong UI) — bỏ qua mọi điều kiện. */
  async runManual(): Promise<SleepRunLog> {
    return this.run('manual');
  }

  private async run(trigger: SleepTrigger): Promise<SleepRunLog> {
    this.running = true;
    const startedAt = new Date(this.now()).toISOString();
    const log: SleepRunLog = {
      at: startedAt,
      trigger,
      botId: this.scope.botId,
      episodesExamined: 0,
      added: 0,
      updated: 0,
      deleted: 0,
      quarantined: 0,
      skipped: 0,
      promoted: 0,
      stepsUsed: 0,
      hasMore: false,
      extractor: this.extractor.name,
      details: [],
    };
    try {
      let steps = 0;
      while (steps < this.config.maxSteps) {
        const batch = this.store.listUnprocessedEpisodes(this.scope, this.config.batchSize);
        if (batch.length === 0) break;
        steps += 1;
        for (const episode of batch) {
          log.episodesExamined += 1;
          try {
            const candidates = await this.extractor.extract(episode.text, this.scope, episode.text);
            // Text nghi ngờ mà extractor không rút được fact nào vẫn
            // phải vào quarantine (kẻo "quên hết bộ nhớ" trôi qua
            // im lặng) — tổng hợp một ứng viên để consolidation xử lý.
            const suspicious =
              candidates.length === 0 ? suspiciousCandidateForText(episode.text, episode.text) : null;
            const result: ConsolidateGraphResult = consolidateCandidates(
              this.store,
              suspicious ? [...candidates, suspicious] : candidates,
              this.scope,
              { turnId: episode.turnId, runId: episode.runId, episodeId: episode.id, at: startedAt },
              this.consolidateOpts,
            );
            log.added += result.added;
            log.updated += result.updated;
            log.deleted += result.deleted;
            log.quarantined += result.quarantined;
            log.skipped += result.skipped;
            if (this.humanBlockAdapter) {
              const promoted = promoteToHumanBlock(result, this.store, this.humanBlockAdapter, this.config.promoteMinConfidence);
              log.promoted += promoted.promoted;
            }
            const factIds = result.actions
              .map((a) => a.factId)
              .filter((id): id is string => typeof id === 'string');
            this.store.markEpisodeProcessed(episode.id, factIds);
            log.details.push(...result.details);
          } catch (err) {
            // Lỗi một episode không chặn batch: ghi log rồi đi tiếp.
            log.details.push(`Lỗi episode ${episode.id}: ${(err as Error).message}`);
            // Đánh dấu episode đã xử lý (không còn fact) để lần chạy
            // sau không thử lại mãi episode lỗi này — nếu không vòng
            // lặp sẽ xem lại nó mỗi bước và episodesExamined phình
            // vô hạn, hasMore không bao giờ hết.
            try {
              this.store.markEpisodeProcessed(episode.id, []);
            } catch {
              // Ghi processed lỗi thì bỏ qua — episode thử lại lần sau.
            }
          }
        }
      }
      log.stepsUsed = steps;
      log.hasMore = this.store.listUnprocessedEpisodes(this.scope, 1).length > 0;
      if (log.hasMore) {
        log.details.push(`Còn episode chưa xử lý (hết ${steps} bước) — để lần chạy sau.`);
      }
    } catch (err) {
      log.error = (err as Error).message;
    } finally {
      this.running = false;
      this.turnsSinceLastRun = 0;
      this.lastRunAtMs = this.now();
      this.persistCounters();
      this.appendRunLog(log);
    }
    return log;
  }

  private appendRunLog(log: SleepRunLog): void {
    try {
      const filePath = path.join(this.workspaceDir, MEMORY_GRAPH_RUNS_REL_PATH);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(log)}\n`, { mode: 0o600 });
    } catch {
      // Ghi log lỗi cũng không được thì bỏ qua — consolidation đã xong.
    }
  }
}

/** Đọc run log gần nhất (mới nhất trước) — dùng cho UI/status. */
export function readSleepRunLogs(workspaceDir: string, limit = 20): SleepRunLog[] {
  try {
    const raw = fs.readFileSync(path.join(workspaceDir, MEMORY_GRAPH_RUNS_REL_PATH), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const logs: SleepRunLog[] = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        logs.push(JSON.parse(line) as SleepRunLog);
      } catch {
        // Bỏ dòng log hỏng.
      }
    }
    return logs.reverse();
  } catch {
    return [];
  }
}

/**
 * Dựng sleep agent chuẩn cho một bot từ workspace của nó: đọc config
 * từ đĩa, store đồ thị của workspace, adapter đẩy fact quan trọng lên
 * block `human` (tạo mới nếu chưa có; block đầy/read-only thì bỏ qua
 * fact đó, trả false). Dùng chung cho defaultToolFactory (tool
 * memory_graph_consolidate) và hook setup-turn của coordinator — cả
 * hai đều đọc cùng file config nên không lệch trạng thái.
 */
export function createGraphSleepAgent(
  workspaceDir: string,
  botId: string,
  userId?: string,
): SleepConsolidationAgent {
  const store = TemporalGraphStore.fromWorkspace(workspaceDir);
  const blocksStore = new MemoryBlockStore(workspaceDir);
  return new SleepConsolidationAgent({
    store,
    workspaceDir,
    scope: { userId: userId ?? '', botId, runId: '' },
    config: loadSleepConfig(workspaceDir),
    humanBlockAdapter: {
      appendHumanFact(text: string): boolean {
        try {
          let human = blocksStore.get('human');
          if (!human) {
            human = blocksStore.create(
              { label: 'human', description: 'Sự thật về người dùng (do consolidation đẩy lên).', content: '', charLimit: 10000, createdByBotId: botId },
              'system:consolidate',
            );
          }
          if (human.readOnly) return false;
          if (human.content.includes(text)) return true;
          blocksStore.append(human.id, `\n${text}`, 'system:consolidate');
          return true;
        } catch {
          return false;
        }
      },
    },
  });
}
