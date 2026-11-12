/**
 * Portable team bundle — export / import a whole team as ONE file
 * (v0.80, Ưu tiên 2).
 *
 * A team bundle holds: the team config (`team.json`), the shared bots'
 * full configs, the automations of those bots, and the user's custom
 * skills (name + SKILL.md content). It follows the agent-bundle
 * pattern already in the repo (`agent/export.ts` — versioned JSON +
 * SHA-256 checksum over a canonical serialization), so the same
 * validation discipline applies: version + kind + checksum are
 * checked BEFORE anything is written, and import never overwrites
 * existing data unless the caller confirms (`overwrite: true`).
 *
 * What a bundle NEVER contains:
 *  - Secrets. Bot configs hold no API keys (keys live in the Vault),
 *    service-account tokens are NOT exported (their records stay
 *    local-only — a bundle team keeps its members/shared bots, but
 *    service accounts must be recreated on the target machine), and
 *    webhook HMAC keys are NOT exported (webhook automations import
 *    as disabled — see `applyTeamBundle` in main/teamPortable.ts).
 *    A defensive scan rejects any bundle whose JSON contains a
 *    secret-looking field name.
 *  - Run history, traces, vault contents, usage data.
 *
 * This module is PURE (no I/O): it builds, parses and conflict-checks
 * bundles. The host (desktop main) does the file dialogs, the reads/
 * writes and the actual apply — see `apps/desktop/src/main/
 * teamPortable.ts` for the apply decisions and `team:export` /
 * `team:import` / `team:import-apply` in main.ts.
 */
import { createHash } from 'node:crypto';
import type { Automation } from '../automations/types';
import type { BotConfig } from '../types';
import { stableStringify } from '../agent/export';
import { validateTeamConfig } from './team';
import type { TeamConfig } from './types';

/** Bundle format version. Only 1 is supported (see `parseTeamBundle`). */
export const TEAM_BUNDLE_VERSION = 1;
/** Bundle kind marker — a file of another kind is rejected outright. */
export const TEAM_BUNDLE_KIND = 'open-bot-team-bundle';
/** Largest bundle accepted on import (10 MiB of JSON text). */
export const TEAM_BUNDLE_MAX_BYTES = 10 * 1024 * 1024;
/** Largest single skill body accepted (SKILL.md cap, same as v0.66b). */
export const TEAM_BUNDLE_MAX_SKILL_CHARS = 200_000;

/** Why a user skill was left out of a bundle (v0.82, follow-up 3a). */
export type TeamBundleSkippedSkillReason = 'oversize' | 'empty';

/** One skill the export skipped, with the reason and the size. */
export interface TeamBundleSkippedSkill {
  name: string;
  reason: TeamBundleSkippedSkillReason;
  /** Content length in characters (0 for an empty/unreadable skill). */
  chars: number;
}

/**
 * Why a skill is skipped at export — null when it exports fine.
 *
 * NOTE — deliberately NOT chunked: the skill registry itself refuses
 * to read/install any SKILL.md over MAX_SKILL_TEXT_CHARS (200.000,
 * see skills/registry.ts — read + install paths both reject), so a
 * chunked export would reassemble on import into a file the target
 * machine cannot load. The honest behaviour is to skip it and say
 * exactly why + how big it is (main.ts `team:export` returns these
 * records; TeamView shows them; the export hint states the limit up
 * front). A skill that fits exports whole, as before.
 */
export function describeSkippedSkill(
  name: string,
  content: string,
): TeamBundleSkippedSkill | null {
  if (typeof content !== 'string' || !content.trim()) {
    return { name, reason: 'empty', chars: typeof content === 'string' ? content.length : 0 };
  }
  if (content.length > TEAM_BUNDLE_MAX_SKILL_CHARS) {
    return { name, reason: 'oversize', chars: content.length };
  }
  return null;
}

/** One custom skill in a bundle: its name + full SKILL.md content. */
export interface TeamBundleSkill {
  name: string;
  content: string;
}

export interface TeamBundleData {
  team: TeamConfig;
  bots: BotConfig[];
  automations: Automation[];
  skills: TeamBundleSkill[];
}

export interface TeamBundle {
  kind: typeof TEAM_BUNDLE_KIND;
  version: number;
  exportedAt: string;
  /** teamId of the exported team ('' when the source team had none). */
  teamId: string;
  /** SHA-256 hex of the canonical JSON of `data`. */
  checksum: string;
  data: TeamBundleData;
}

/** SHA-256 hex checksum of a bundle's `data` section. */
export function computeTeamBundleChecksum(data: TeamBundleData): string {
  return createHash('sha256').update(stableStringify(data), 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Team bundle không hợp lệ: ${message}`);
}

/**
 * Field names that must never appear in a bundle (defence in depth —
 * a bundle built by this module never contains them, so their presence
 * means a hand-edited or foreign file). Checked against the raw JSON
 * text, key by key.
 */
const SECRET_FIELD_RE = /"(api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|private[_-]?key|bearer|auth[_-]?token|webhook[_-]?key)"\s*:/i;

/** Build a bundle from validated parts. Throws on bad input. */
export function buildTeamBundle(input: {
  team: TeamConfig;
  bots: BotConfig[];
  automations?: Automation[];
  skills?: TeamBundleSkill[];
}): TeamBundle {
  const validatedTeam = validateTeamConfig(input.team);
  // Service accounts NEVER travel in a bundle: their tokens live in
  // the source machine's Vault and cannot be recreated from the
  // record alone. The target machine recreates its own accounts.
  const team: TeamConfig = { ...validatedTeam, serviceAccounts: [] };
  const bots = Array.isArray(input.bots) ? input.bots : fail('bots phải là một mảng.');
  const automations = Array.isArray(input.automations) ? input.automations : [];
  const skills = Array.isArray(input.skills) ? input.skills : [];
  const botIds = new Set<string>();
  for (const [i, bot] of bots.entries()) {
    if (!isRecord(bot) || typeof bot.id !== 'string' || !bot.id) {
      fail(`bot #${i} thiếu id.`);
    }
    if (typeof bot.name !== 'string' || !bot.name.trim()) fail(`bot "${bot.id}" thiếu tên.`);
    if (typeof bot.providerId !== 'string' || !bot.providerId) fail(`bot "${bot.id}" thiếu providerId.`);
    if (typeof bot.model !== 'string') fail(`bot "${bot.id}" thiếu model.`);
    if (typeof bot.systemPrompt !== 'string') fail(`bot "${bot.id}" thiếu systemPrompt.`);
    if (typeof bot.workspaceDir !== 'string') fail(`bot "${bot.id}" thiếu workspaceDir.`);
    if (botIds.has(bot.id)) fail(`trùng bot id "${bot.id}".`);
    botIds.add(bot.id);
  }
  for (const [i, auto] of automations.entries()) {
    if (!isRecord(auto) || typeof auto.id !== 'string' || !auto.id) {
      fail(`automation #${i} thiếu id.`);
    }
    if (typeof auto.name !== 'string' || !auto.name.trim()) fail(`automation "${auto.id}" thiếu tên.`);
    if (typeof auto.botId !== 'string') fail(`automation "${auto.id}" thiếu botId.`);
  }
  const skillNames = new Set<string>();
  for (const [i, skill] of skills.entries()) {
    if (!isRecord(skill) || typeof skill.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skill.name)) {
      fail(`skill #${i} có tên không hợp lệ (chỉ chữ/số/_/-).`);
    }
    if (typeof skill.content !== 'string' || !skill.content.trim()) {
      fail(`skill "${skill.name}" thiếu nội dung SKILL.md.`);
    }
    if (skill.content.length > TEAM_BUNDLE_MAX_SKILL_CHARS) {
      fail(`skill "${skill.name}" vượt ${TEAM_BUNDLE_MAX_SKILL_CHARS} ký tự.`);
    }
    if (skillNames.has(skill.name)) fail(`trùng skill "${skill.name}".`);
    skillNames.add(skill.name);
  }
  const data: TeamBundleData = { team, bots: bots as BotConfig[], automations: automations as Automation[], skills };
  const text = JSON.stringify(data);
  if (SECRET_FIELD_RE.test(text)) {
    fail('chứa trường nhạy cảm (api key / token / secret / password) — bundle không bao giờ chứa secret.');
  }
  return {
    kind: TEAM_BUNDLE_KIND,
    version: TEAM_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    teamId: team.teamId ?? '',
    checksum: computeTeamBundleChecksum(data),
    data,
  };
}

/**
 * Parse + validate a bundle from unknown input (parsed JSON or raw
 * text). Throws with a clear message on: wrong kind/version, bad
 * checksum (file bị sửa / hỏng), bad team config, bad bot/automation/
 * skill shape, secret-looking fields, or oversize input. Returns the
 * bundle (with a FRESH checksum verification — the checksum is
 * recomputed from `data`, never trusted from the file).
 */
export function parseTeamBundle(input: unknown): TeamBundle {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > TEAM_BUNDLE_MAX_BYTES) {
      fail(`file vượt ${TEAM_BUNDLE_MAX_BYTES / 1024 / 1024} MiB.`);
    }
    try {
      raw = JSON.parse(input);
    } catch {
      fail('không phải JSON hợp lệ.');
    }
  }
  if (!isRecord(raw)) fail('phải là một object JSON.');
  if (raw['kind'] !== TEAM_BUNDLE_KIND) {
    fail(`kind phải là "${TEAM_BUNDLE_KIND}" (nhận được ${JSON.stringify(raw['kind'] ?? null)}).`);
  }
  if (raw['version'] !== TEAM_BUNDLE_VERSION) {
    fail(`version phải là ${TEAM_BUNDLE_VERSION} (nhận được ${JSON.stringify(raw['version'] ?? null)}).`);
  }
  if (typeof raw['exportedAt'] !== 'string' || Number.isNaN(Date.parse(raw['exportedAt']))) {
    fail('thiếu exportedAt hợp lệ.');
  }
  if (typeof raw['checksum'] !== 'string' || !/^[0-9a-f]{64}$/.test(raw['checksum'])) {
    fail('thiếu checksum SHA-256 hợp lệ.');
  }
  if (!isRecord(raw['data'])) fail('thiếu data.');
  if (SECRET_FIELD_RE.test(JSON.stringify(raw['data']))) {
    fail('chứa trường nhạy cảm (api key / token / secret / password) — bundle không bao giờ chứa secret.');
  }
  let data: TeamBundleData;
  try {
    data = buildTeamBundle({
      team: raw['data']['team'] as TeamConfig,
      bots: raw['data']['bots'] as BotConfig[],
      automations: raw['data']['automations'] as Automation[],
      skills: raw['data']['skills'] as TeamBundleSkill[],
    }).data;
  } catch (err) {
    // buildTeamBundle đã có tiền tố "Team bundle không hợp lệ: " —
    // giữ nguyên message của nó, không bọc thêm.
    throw err;
  }
  // buildTeamBundle đã validate shape; giờ kiểm tra checksum của data
  // TRONG FILE (data đã chuẩn hoá qua validateTeamConfig — checksum
  // tính trên data đã chuẩn hoá phải khớp file, nếu không file đã bị
  // sửa sau khi xuất).
  if (computeTeamBundleChecksum(data) !== raw['checksum']) {
    fail('checksum không khớp — file đã bị sửa hoặc hỏng sau khi xuất.');
  }
  return {
    kind: TEAM_BUNDLE_KIND,
    version: TEAM_BUNDLE_VERSION,
    exportedAt: raw['exportedAt'],
    teamId: typeof raw['teamId'] === 'string' ? raw['teamId'] : '',
    checksum: raw['checksum'],
    data,
  };
}

export type TeamImportConflictKind = 'team' | 'bot' | 'automation' | 'skill';

export interface TeamImportConflict {
  kind: TeamImportConflictKind;
  id: string;
  /** Human-readable detail (Vietnamese) for the confirm dialog. */
  detail: string;
}

export interface TeamImportExisting {
  /** teamId of the local team ('' = no team yet / default team). */
  teamId?: string;
  /** True when the local team already has members/shared bots (non-empty). */
  teamNonEmpty?: boolean;
  botIds: ReadonlySet<string>;
  automationIds: ReadonlySet<string>;
  skillNames: ReadonlySet<string>;
}

/** A local team counts as "existing" when it has a teamId or content. */
export function isNonEmptyTeam(team: TeamConfig): boolean {
  return (
    (team.members?.length ?? 0) > 0 ||
    (team.sharedBots?.length ?? 0) > 0 ||
    (team.serviceAccounts?.length ?? 0) > 0 ||
    Boolean(team.teamId)
  );
}

/**
 * Conflicts between a bundle and local data — what import would
 * overwrite or collide with. Empty = clean import (nothing exists
 * yet). A 'team' conflict means the local team is a DIFFERENT team
 * (different teamId, non-empty): importing without overwrite would
 * merge into the wrong team.
 */
export function checkTeamImportConflicts(
  bundle: TeamBundle,
  existing: TeamImportExisting,
): TeamImportConflict[] {
  const conflicts: TeamImportConflict[] = [];
  const localTeamId = existing.teamId ?? '';
  if (
    existing.teamNonEmpty &&
    localTeamId !== '' &&
    bundle.teamId !== '' &&
    localTeamId !== bundle.teamId
  ) {
    conflicts.push({
      kind: 'team',
      id: bundle.teamId,
      detail: `Team hiện tại (id ${localTeamId}) khác team trong file (id ${bundle.teamId}) — nhập sẽ thay team hiện tại.`,
    });
  }
  for (const bot of bundle.data.bots) {
    if (existing.botIds.has(bot.id)) {
      conflicts.push({ kind: 'bot', id: bot.id, detail: `Bot "${bot.name}" (id ${bot.id}) đã có trên máy này.` });
    }
  }
  for (const auto of bundle.data.automations) {
    if (existing.automationIds.has(auto.id)) {
      conflicts.push({
        kind: 'automation',
        id: auto.id,
        detail: `Automation "${auto.name}" (id ${auto.id}) đã có trên máy này.`,
      });
    }
  }
  for (const skill of bundle.data.skills) {
    if (existing.skillNames.has(skill.name)) {
      conflicts.push({ kind: 'skill', id: skill.name, detail: `Skill "${skill.name}" đã có trên máy này.` });
    }
  }
  return conflicts;
}

/** One-line summary of a bundle for the import confirm dialog. */
export function summarizeTeamBundle(bundle: TeamBundle): {
  teamName: string;
  teamId: string;
  bots: number;
  automations: number;
  skills: number;
  exportedAt: string;
} {
  return {
    teamName: bundle.data.team.name,
    teamId: bundle.teamId,
    bots: bundle.data.bots.length,
    automations: bundle.data.automations.length,
    skills: bundle.data.skills.length,
    exportedAt: bundle.exportedAt,
  };
}
