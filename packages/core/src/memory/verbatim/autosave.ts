/**
 * Auto-save hook cho verbatim memory (v1.01, Đội T4).
 *
 * Ý tưởng (học ở mức khái niệm từ hook auto-save của MemPalace cho
 * Claude Code/Codex/Cursor): khi session kết thúc, tự lưu những câu
 * đáng nhớ trong transcript — không cần user nhớ phải lưu. Khác biệt
 * quan trọng so với "ghi lén": hook này MẶC ĐỊNH TẮT (opt-in), chỉ
 * lưu turn của user khớp pattern tường minh, có giới hạn số record/
 * session, dedup, và bỏ secret — xem `VerbatimAutosaveOptions`.
 *
 * Tích hợp với hook system của repo:
 * - `createVerbatimAutosaveHook(store, opts)` trả `HookDefinition`
 *   cho event `SessionEnd` (+ `Stop` tuỳ chọn) để đăng ký vào
 *   `HookRegistry`. Hook system chỉ đưa (event, ctx) — KHÔNG đưa
 *   transcript — nên transcript lấy qua callback `getTurns` do host
 *   cung cấp (vd agent loop giữ transcript của session). Host chưa
 *   nối callback thì hook không làm gì (log, không throw).
 * - `VerbatimAutosave.ingestTurns(turns, meta)` là lõi xử lý, gọi
 *   được trực tiếp từ host (vd cuối `AgentRunner.executeCall`) mà
 *   không cần qua hook registry.
 *
 * LLM extraction là TUỲ CHỌN: host truyền `llmExtractor` (gọi model
 * local qua Ollama, hoặc bất kỳ model nào) — extractor này phải trả
 * candidate CÙNG shape (text nguyên văn + kind + confidence); nếu
 * nó lỗi/timeout → fallback về rule-based, không bao giờ throw ra
 * ngoài hook (hook lỗi không được crash session).
 */
import type { HookContext, HookDefinition, HookEvent } from '../../hooks/types';
import { extractVerbatimCandidates, type VerbatimCandidate, type VerbatimTurn } from './extract';
import type { VerbatimMemoryStore } from './store';
import type { SaveVerbatimInput, VerbatimSource } from './types';

/** Extractor LLM tuỳ chọn: nhận turn, trả candidate nguyên văn. */
export type VerbatimLlmExtractor = (
  turns: VerbatimTurn[],
) => Promise<VerbatimCandidate[]> | VerbatimCandidate[];

/** Callback host cung cấp transcript của session vừa kết thúc. */
export type VerbatimTurnsProvider = (
  ctx: HookContext,
) => VerbatimTurn[] | Promise<VerbatimTurn[]> | undefined;

export interface VerbatimAutosaveOptions {
  /** BẬT autosave (mặc định false — opt-in, host/user phải bật tường minh). */
  enabled?: boolean;
  /** Nguồn transcript (bắt buộc khi enabled — không có thì hook không làm gì). */
  getTurns?: VerbatimTurnsProvider;
  /** Extractor LLM tuỳ chọn (vắng = chỉ rule-based). */
  llmExtractor?: VerbatimLlmExtractor;
  /** Wing gán cho record autosave (mặc định 'default'). */
  wing?: string;
  /** Room gán cho record autosave (mặc định 'general'). */
  room?: string;
  /** Bot id gán cho record (mặc định lấy từ HookContext.botId). */
  botId?: string;
  /** Số record tối đa lưu mỗi session (mặc định 20). */
  maxPerSession?: number;
  /** Chỉ lưu candidate có confidence ≥ ngưỡng (mặc định 0.6). */
  minConfidence?: number;
  /** Chạy cả khi event là Stop (mặc định true — Stop cũng là cuối session). */
  onStop?: boolean;
  /** Ghi log qua hàm này (mặc định console.error cho lỗi, im lặng cho info). */
  onLog?: (message: string) => void;
  /** Callback sau mỗi lần ingest (để host cập nhật UI/stats). */
  onIngested?: (result: VerbatimIngestResult) => void;
}

export interface VerbatimIngestResult {
  /** Số candidate rule-based + LLM tìm được. */
  candidates: number;
  /** Số record mới lưu vào store. */
  created: number;
  /** Số candidate trùng record đã có (dedup). */
  duplicates: number;
  /** Số candidate bị bỏ (confidence thấp / vượt maxPerSession). */
  skipped: number;
  /** Có dùng LLM extractor không (false = rule-based thuần). */
  usedLlm: boolean;
  /** Session id (khi biết). */
  sessionId?: string;
}

export const VERBATIM_AUTOSAVE_HOOK_NAME = 'verbatim-autosave';
export const VERBATIM_AUTOSAVE_DEFAULT_MAX_PER_SESSION = 20;
export const VERBATIM_AUTOSAVE_DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Lõi autosave: xử lý một loạt turn → lưu candidate vào store.
 * Dùng được độc lập với hook registry (host gọi trực tiếp cuối run).
 */
export class VerbatimAutosave {
  private readonly store: VerbatimMemoryStore;
  private readonly opts: Required<Pick<VerbatimAutosaveOptions, 'wing' | 'room' | 'maxPerSession' | 'minConfidence'>> &
    Pick<VerbatimAutosaveOptions, 'llmExtractor' | 'onLog' | 'onIngested'>;

  constructor(store: VerbatimMemoryStore, opts: VerbatimAutosaveOptions = {}) {
    this.store = store;
    this.opts = {
      wing: opts.wing ?? 'default',
      room: opts.room ?? 'general',
      maxPerSession: opts.maxPerSession ?? VERBATIM_AUTOSAVE_DEFAULT_MAX_PER_SESSION,
      minConfidence: opts.minConfidence ?? VERBATIM_AUTOSAVE_DEFAULT_MIN_CONFIDENCE,
      llmExtractor: opts.llmExtractor,
      onLog: opts.onLog,
      onIngested: opts.onIngested,
    };
  }

  async ingestTurns(
    turns: VerbatimTurn[],
    meta: { sessionId?: string; botId?: string } = {},
  ): Promise<VerbatimIngestResult> {
    const result: VerbatimIngestResult = {
      candidates: 0,
      created: 0,
      duplicates: 0,
      skipped: 0,
      usedLlm: false,
      sessionId: meta.sessionId,
    };
    if (turns.length === 0) return result;

    // 1. Rule-based trước (luôn chạy, không cần model).
    let candidates = extractVerbatimCandidates(turns);

    // 2. LLM extractor tuỳ chọn (lỗi → fallback rule-based, không throw).
    if (this.opts.llmExtractor !== undefined) {
      try {
        const llmCandidates = await this.opts.llmExtractor(turns);
        result.usedLlm = true;
        const seen = new Set(candidates.map((c) => c.text.toLowerCase()));
        for (const candidate of llmCandidates) {
          if (typeof candidate.text !== 'string' || candidate.text.trim() === '') continue;
          if (seen.has(candidate.text.toLowerCase())) continue;
          seen.add(candidate.text.toLowerCase());
          candidates.push(sanitizeLlmCandidate(candidate));
        }
      } catch (err) {
        this.opts.onLog?.(
          `[verbatim-autosave] LLM extractor lỗi (${err instanceof Error ? err.message : String(err)}) — dùng rule-based.`,
        );
      }
    }

    result.candidates = candidates.length;
    // Confidence cao trước; giới hạn số record / session.
    candidates.sort((a, b) => b.confidence - a.confidence);
    const kept = candidates.filter((c) => c.confidence >= this.opts.minConfidence);
    result.skipped += candidates.length - kept.length;
    const limited = kept.slice(0, this.opts.maxPerSession);
    result.skipped += kept.length - limited.length;

    for (const candidate of limited) {
      const input: SaveVerbatimInput = {
        text: candidate.text,
        source: 'autosave',
        wing: this.opts.wing,
        room: this.opts.room,
        tags: ['autosave', ...candidate.tags],
        botId: meta.botId ?? '',
        sessionId: meta.sessionId,
        turnIndex: candidate.turnIndex,
      };
      try {
        const saved = await this.store.save(input);
        if (saved.created) result.created += 1;
        else result.duplicates += 1;
      } catch (err) {
        // Một record lỗi (vd quá dài) không dừng cả đợt.
        result.skipped += 1;
        this.opts.onLog?.(
          `[verbatim-autosave] Bỏ candidate (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
    }
    this.opts.onIngested?.(result);
    return result;
  }
}

/**
 * Tạo HookDefinition để đăng ký vào HookRegistry (event SessionEnd,
 * + Stop nếu `onStop`). Hook KHÔNG throw: mọi lỗi đều log + nuốt để
 * session kết thúc bình thường.
 */
export function createVerbatimAutosaveHook(
  store: VerbatimMemoryStore,
  opts: VerbatimAutosaveOptions = {},
): HookDefinition {
  const enabled = opts.enabled ?? false;
  const onStop = opts.onStop ?? true;
  const autosave = new VerbatimAutosave(store, opts);
  const log = opts.onLog ?? ((message: string): void => {
    console.error(message);
  });
  return {
    name: VERBATIM_AUTOSAVE_HOOK_NAME,
    description:
      'Tự lưu câu đáng nhớ (nguyên văn) vào verbatim memory khi session kết thúc. ' +
      'Mặc định TẮT (opt-in); chỉ lưu turn user khớp pattern, tối đa 20 record/session, không lưu secret.',
    events: onStop ? ['SessionEnd', 'Stop'] : ['SessionEnd'],
    source: 'builtin',
    enabled,
    handler: async (event: HookEvent, ctx: HookContext) => {
      if (!enabled) return;
      if (event.event !== 'SessionEnd' && event.event !== 'Stop') return;
      const provider = opts.getTurns;
      if (provider === undefined) {
        log('[verbatim-autosave] Chưa nối transcript provider (getTurns) — bỏ qua.');
        return;
      }
      let turns: VerbatimTurn[] | undefined;
      try {
        turns = await provider(ctx);
      } catch (err) {
        log(`[verbatim-autosave] Lấy transcript lỗi (${err instanceof Error ? err.message : String(err)}) — bỏ qua.`);
        return;
      }
      if (turns === undefined || turns.length === 0) return;
      try {
        const result = await autosave.ingestTurns(turns, {
          sessionId: ctx.sessionId ?? ctx.runId,
          botId: opts.botId ?? ctx.botId,
        });
        if (result.created > 0) {
          log(
            `[verbatim-autosave] Đã lưu ${result.created} memory nguyên văn ` +
              `(trùng ${result.duplicates}, bỏ ${result.skipped}) từ session ${result.sessionId ?? '?'} .`,
          );
        }
      } catch (err) {
        log(`[verbatim-autosave] Ingest lỗi (${err instanceof Error ? err.message : String(err)}) — bỏ qua.`);
      }
    },
  };
}

/** Chuẩn hoá candidate do LLM trả về: ép kind/confidence/tags về miền hợp lệ. */
function sanitizeLlmCandidate(candidate: VerbatimCandidate): VerbatimCandidate {
  const kinds: VerbatimCandidate['kind'][] = [
    'explicit-remember',
    'preference',
    'identity',
    'work',
    'decision',
    'goal',
    'statement',
  ];
  const kind = kinds.includes(candidate.kind) ? candidate.kind : 'statement';
  const confidence =
    typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
      ? Math.min(1, Math.max(0, candidate.confidence))
      : 0.6;
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.filter((t): t is string => typeof t === 'string').slice(0, 5)
    : [];
  const source: VerbatimSource = candidate.source === 'user' ? 'user' : 'autosave';
  return {
    text: candidate.text.trim(),
    kind,
    confidence,
    tags,
    turnIndex: typeof candidate.turnIndex === 'number' ? candidate.turnIndex : undefined,
    source,
  };
}
