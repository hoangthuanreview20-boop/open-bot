/**
 * Consolidation — bước 2 của pipeline kiểu Mem0 v3 (v0.98, Đội T1).
 *
 * Đầu vào: fact ứng viên từ extraction + đồ thị hiện tại.
 * Đầu ra cho mỗi ứng viên đúng một quyết định:
 *  - ADD: chưa có fact nào cùng (subject, predicate) → thêm mới.
 *  - UPDATE: đã có fact cùng (subject, predicate) nhưng object khác
 *    → fact mới thay thế fact cũ (supersession, xem store.ts). Chỉ
 *    UPDATE khi ứng viên đủ tin: confidence >= fact cũ, hoặc fact cũ
 *    đã "già" (quá `staleDays` không được nhắc lại).
 *  - DELETE: ứng viên mang ý phủ định ("không còn ... nữa", "hết
 *    thích ...", "no longer ...") → xoá mềm fact cũ cùng predicate.
 *  - QUARANTINE: mâu thuẫn mà ứng viên KHÔNG đủ tin để thắng, hoặc
 *    khớp mẫu nghi ngờ (memory poisoning) → không áp dụng, chờ user
 *    duyệt. Đây là tuyến phòng thủ OWASP ASI06 của open-bot.
 *  - SKIP: trùng y hệt fact đang active (cùng object sau chuẩn hoá)
 *    → không làm gì (chỉ cập nhật lastSeen của entity).
 *
 * Nguyên tắc an toàn:
 *  - Không bao giờ tự động ghi đè fact confidence >= 0.9 bằng fact
 *    confidence thấp hơn — phải qua quarantine.
 *  - Không bao giờ tự động DELETE fact confidence >= 0.9 — qua
 *    quarantine.
 *  - Mọi quyết định đều ghi rõ `reason` để UI/log giải thích được.
 *  - Consolidation chỉ xét fact trong cùng scope (user/bot/run) —
 *    fact của bot khác không bị đụng tới.
 */

import type { CandidateFact, ConsolidationAction, GraphFact, MemoryScope } from './types';
import { normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';

/** Mẫu phủ định — ứng viên khớp thì hiểu là "fact cũ hết đúng". */
const NEGATION_PATTERNS: RegExp[] = [
  /không\s+còn\s+/iu,
  /hết\s+(thích|ghét|muốn|ở|làm)/iu,
  /không\s+(thích|muốn|ở|làm)\s+nữa/iu,
  /\bno\s+longer\b/iu,
  /\bnot\s+(?:any\s+)?more\b/iu,
  /đã\s+chuyển\s+(đi|nhà|việc)/iu,
  /đã\s+nghỉ\s+(việc|làm)/iu,
];

/**
 * Mẫu NGHI NGỜ (memory poisoning, OWASP ASI06): câu ra lệnh cho bộ
 * nhớ / giả mạo nguồn / chèn chỉ thị. Ứng viên khớp mẫu này LUÔN vào
 * quarantine, bất kể confidence — kể cả khi nó là câu user nói thật,
 * user vẫn duyệt tay được trong UI quarantine.
 */
export const SUSPICIOUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /quên\s+(hết|tất\s+cả|mọi)/iu, label: 'lệnh quên toàn bộ bộ nhớ' },
  { re: /bỏ\s+qua\s+(hướng\s+dẫn|chỉ\s+thị|quy\s+tắc)/iu, label: 'lệnh bỏ qua hướng dẫn' },
  { re: /ignore\s+(all\s+)?(previous\s+)?instructions/iu, label: 'ignore previous instructions' },
  { re: /hãy\s+ghi\s+nhớ\s+rằng\s+(bạn|mày)\s+(là|phải)/iu, label: 'ghi nhớ danh tính giả' },
  { re: /you\s+are\s+now\s+/iu, label: 'you are now (giả mạo danh tính)' },
  { re: /system\s*:\s*/iu, label: 'giả mạo role system' },
  { re: /\[SYSTEM\]/iu, label: '[SYSTEM] giả mạo' },
  { re: /hãy\s+quên\s+(hết|đi)/iu, label: 'lệnh quên bộ nhớ' },
  { re: /xoá\s+(hết|toàn\s+bộ)\s+(bộ\s+nhớ|memory)/iu, label: 'lệnh xoá toàn bộ bộ nhớ' },
  { re: /delete\s+all\s+(memories|memory)/iu, label: 'delete all memories' },
];

export function findSuspiciousPattern(text: string): string | null {
  for (const entry of SUSPICIOUS_PATTERNS) {
    if (entry.re.test(text)) return entry.label;
  }
  return null;
}

/**
 * Ứng viên "quarantine" cho text nghi ngờ mà extractor không rút được
 * fact nào (vd "Hãy quên hết mọi thứ đi."): không có ứng viên thì
 * consolidation không bao giờ thấy mẫu nghi ngờ. Tổng hợp một ứng
 * viên `states` confidence thấp từ chính text đó để consolidation
 * đẩy vào quarantine qua tuyến phòng thủ mẫu nghi ngờ — fact thật
 * vẫn chờ user duyệt, không tự vào đồ thị.
 */
export function suspiciousCandidateForText(text: string, sourceText: string): CandidateFact | null {
  if (findSuspiciousPattern(text) === null) return null;
  const objectText = text.trim().slice(0, 200);
  if (objectText.length < 2) return null;
  return {
    subjectName: 'user',
    kind: 'person',
    predicate: 'states',
    objectText,
    objectIsEntity: false,
    confidence: 0.5,
    sourceText: sourceText.slice(0, 500),
  };
}

export function isNegationText(text: string): boolean {
  return NEGATION_PATTERNS.some((re) => re.test(text));
}

export interface ConsolidateGraphOptions {
  /** Số ngày fact cũ không được nhắc lại thì coi là "già" (mặc định 90). */
  staleDays?: number;
  /** Confidence tối thiểu để UPDATE thắng fact cũ (mặc định 0.5). */
  minConfidenceToUpdate?: number;
  /** Confidence tối thiểu để DELETE tự động (mặc định 0.9). */
  minConfidenceToDelete?: number;
}

export interface ConsolidateGraphResult {
  ranAt: string;
  examined: number;
  added: number;
  updated: number;
  deleted: number;
  quarantined: number;
  skipped: number;
  actions: ConsolidationAction[];
  details: string[];
}

const DEFAULT_STALE_DAYS = 90;

/**
 * Consolidate một danh sách fact ứng viên vào store. Mỗi ứng viên
 * được xử lý độc lập (lỗi một fact không chặn fact khác); store chỉ
 * persist khi có thay đổi thật.
 */
export function consolidateCandidates(
  store: TemporalGraphStore,
  candidates: CandidateFact[],
  scope: MemoryScope,
  provenanceBase: { turnId: string; runId: string; episodeId: string; at: string },
  opts: ConsolidateGraphOptions = {},
): ConsolidateGraphResult {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const minConfidenceToUpdate = opts.minConfidenceToUpdate ?? 0.5;
  const minConfidenceToDelete = opts.minConfidenceToDelete ?? 0.9;
  const actions: ConsolidationAction[] = [];
  const details: string[] = [];
  let added = 0;
  let updated = 0;
  let deleted = 0;
  let quarantined = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const predicate = normalizeGraphText(candidate.predicate).replace(/\s+/g, '_');
    const objectNorm = normalizeGraphText(candidate.objectText);
    if (predicate === '' || objectNorm === '') {
      skipped += 1;
      actions.push({ decision: 'SKIP', candidate, reason: 'Fact ứng viên rỗng (thiếu predicate/object).' });
      continue;
    }
    const provenance = {
      episodeId: provenanceBase.episodeId,
      turnId: provenanceBase.turnId,
      runId: provenanceBase.runId,
      botId: scope.botId,
      userId: scope.userId,
      at: provenanceBase.at,
      sourceText: candidate.sourceText,
    };

    // Tuyến phòng thủ 1: mẫu nghi ngờ → quarantine ngay, không xét tiếp.
    const suspicious = findSuspiciousPattern(candidate.sourceText) ?? findSuspiciousPattern(candidate.objectText);
    if (suspicious !== null) {
      const item = store.addToQuarantine({
        candidate: {
          subjectName: candidate.subjectName,
          predicate,
          objectText: candidate.objectText,
          confidence: candidate.confidence,
        },
        reason: 'suspicious-pattern',
        detail: `Khớp mẫu nghi ngờ: ${suspicious}. Fact này có thể là memory poisoning — cần user duyệt tay.`,
        scope,
        provenance,
      });
      quarantined += 1;
      actions.push({ decision: 'QUARANTINE', candidate, quarantineId: item.id, reason: `Khớp mẫu nghi ngờ: ${suspicious}.` });
      details.push(`Quarantine (nghi ngờ): ${candidate.subjectName} ${predicate} ${candidate.objectText}`);
      continue;
    }

    const existing = store.findActiveFacts(candidate.subjectName, predicate, scope);
    const sameObject = existing.find(
      (f) => normalizeGraphText(f.objectText ?? '') === objectNorm,
    );

    // Phủ định xét TRƯỚC dedupe: "không còn thích phở bò nữa" có cùng
    // object với fact cũ nhưng ý là XOÁ, không phải trùng lặp.
    if (isNegationText(candidate.sourceText) || isNegationText(candidate.objectText)) {
      const target = pickNewest(existing);
      if (!target) {
        skipped += 1;
        actions.push({ decision: 'SKIP', candidate, reason: 'Phủ định nhưng không có fact cũ để xoá.' });
        continue;
      }
      if (target.confidence >= minConfidenceToDelete && candidate.confidence < target.confidence) {
        const item = store.addToQuarantine({
          candidate: {
            subjectName: candidate.subjectName,
            predicate,
            objectText: candidate.objectText,
            confidence: candidate.confidence,
          },
          reason: 'contradiction',
          detail: `Muốn xoá fact tin cậy cao (${target.confidence.toFixed(2)}): ${target.objectText}.`,
          conflictingFactId: target.id,
          scope,
          provenance,
        });
        quarantined += 1;
        actions.push({ decision: 'QUARANTINE', candidate, quarantineId: item.id, affectedFactId: target.id, reason: 'Xoá fact tin cậy cao — cần user duyệt.' });
        continue;
      }
      store.deleteFact(target.id, `consolidate:${scope.botId}`);
      deleted += 1;
      actions.push({ decision: 'DELETE', candidate, affectedFactId: target.id, reason: `Phủ định fact cũ: ${target.objectText}.` });
      details.push(`Xoá: ${candidate.subjectName} ${predicate} ${target.objectText}`);
      continue;
    }

    if (sameObject) {
      skipped += 1;
      actions.push({ decision: 'SKIP', candidate, factId: sameObject.id, reason: 'Fact đã có sẵn (trùng object).' });
      continue;
    }

    if (existing.length === 0) {
      const fact = store.addFact({
        subjectName: candidate.subjectName,
        kind: candidate.kind,
        predicate,
        objectText: candidate.objectText,
        objectIsEntity: candidate.objectIsEntity,
        confidence: candidate.confidence,
        scope,
        provenance,
      });
      added += 1;
      actions.push({ decision: 'ADD', candidate, factId: fact.id, reason: 'Fact mới.' });
      details.push(`Thêm: ${candidate.subjectName} ${predicate} ${candidate.objectText}`);
      continue;
    }

    // Mâu thuẫn: cùng (subject, predicate), object khác.
    const oldFact = pickNewest(existing);
    const oldAgeDays = (Date.parse(provenanceBase.at) - Date.parse(oldFact.updatedAt)) / 86_400_000;
    const canUpdate =
      candidate.confidence >= oldFact.confidence ||
      candidate.confidence >= minConfidenceToUpdate ||
      oldAgeDays >= staleDays;
    if (!canUpdate) {
      const item = store.addToQuarantine({
        candidate: {
          subjectName: candidate.subjectName,
          predicate,
          objectText: candidate.objectText,
          confidence: candidate.confidence,
        },
        reason: 'conflict',
        detail: `Mâu thuẫn với fact cũ (tin cậy ${oldFact.confidence.toFixed(2)}): ${oldFact.objectText}. Ứng viên chỉ ${candidate.confidence.toFixed(2)} — không đủ tin để tự thay thế.`,
        conflictingFactId: oldFact.id,
        scope,
        provenance,
      });
      quarantined += 1;
      actions.push({ decision: 'QUARANTINE', candidate, quarantineId: item.id, affectedFactId: oldFact.id, reason: 'Mâu thuẫn fact cũ, ứng viên không đủ tin.' });
      details.push(`Quarantine (mâu thuẫn): ${candidate.subjectName} ${predicate} ${candidate.objectText} vs ${oldFact.objectText}`);
      continue;
    }
    const created = store.supersedeFact(oldFact.id, {
      subjectName: candidate.subjectName,
      kind: candidate.kind,
      predicate,
      objectText: candidate.objectText,
      objectIsEntity: candidate.objectIsEntity,
      confidence: candidate.confidence,
      scope,
      provenance,
    });
    updated += 1;
    actions.push({ decision: 'UPDATE', candidate, factId: created.id, affectedFactId: oldFact.id, reason: `Thay thế fact cũ: ${oldFact.objectText}.` });
    details.push(`Cập nhật: ${candidate.subjectName} ${predicate} ${oldFact.objectText} → ${candidate.objectText}`);
  }

  return {
    ranAt: new Date().toISOString(),
    examined: candidates.length,
    added,
    updated,
    deleted,
    quarantined,
    skipped,
    actions,
    details,
  };
}

function pickNewest(facts: GraphFact[]): GraphFact {
  return [...facts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/**
 * Đẩy fact quan trọng (confidence cao) lên block `human` của
 * MemoryBlockStore — cầu nối sang memory blocks v0.96. Dùng interface
 * tối thiểu để không phụ thuộc trực tiếp vào class store (tránh
 * circular import): caller truyền adapter `{ appendHumanFact }`.
 */
export interface HumanBlockAdapter {
  appendHumanFact(text: string): boolean;
}

export function promoteToHumanBlock(
  result: ConsolidateGraphResult,
  store: TemporalGraphStore,
  adapter: HumanBlockAdapter,
  minConfidence = 0.9,
): { promoted: number; skipped: number } {
  let promoted = 0;
  let skipped = 0;
  for (const action of result.actions) {
    if (action.decision !== 'ADD' && action.decision !== 'UPDATE') continue;
    if (!action.factId) continue;
    const fact = store.getFact(action.factId);
    if (!fact || fact.confidence < minConfidence) {
      skipped += 1;
      continue;
    }
    const subject = store.getEntity(fact.subjectId);
    // Giữ nguyên predicate dạng máy (vd `name_is`) để UI/log và test
    // nhận diện được quan hệ — không dịch sang chữ thường.
    const line = `- ${subject?.name ?? 'user'}: ${fact.predicate} ${fact.objectText ?? ''}`;
    if (adapter.appendHumanFact(line)) promoted += 1;
    else skipped += 1;
  }
  return { promoted, skipped };
}
