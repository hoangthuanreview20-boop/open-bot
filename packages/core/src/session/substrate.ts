/**
 * Bot session snapshot / restore — full bot-state snapshots (v1.02
 * rescue port of the v1.00 work).
 *
 * Idea learned from agent-substrate designs (an actor whose state
 * can be snapshotted / restored quickly): ideas only, all code
 * written fresh for open-bot, local-first, no copying.
 *
 * Unlike the session box in v0.7 (`box.ts` — file snapshots of a
 * workspace only), a substrate snapshot captures the WHOLE working
 * state of a bot so it can resume exactly where it left off:
 *   - identity: botId, bot name
 *   - config: model, provider, system prompt, enabled tools
 *   - memory: long-term entries (key/value/tags/confidence — pure
 *     data the host extracts from BotMemory/LongTermMemory; this
 *     module never reads the DB itself)
 *   - pending task: the unfinished task (id, title, finished steps,
 *     next action) so the agent can resume after restore
 *   - working files: every file in the bot's working directory
 *     (with a sha256 per file)
 *
 * On-disk layout (version 2, checksummed — different from v0.7):
 *   `<root>/.open-bot/bot-sessions/<botId>/snapshots/<snapshotId>/`
 *     state.json     — BotSessionState (identity/config/memory/task)
 *     files/         — copies of the working files (keeps structure)
 *     manifest.json  — version, botId, createdAt, note, file list
 *                      (rel/size/sha256), stateSha256, whole-snapshot
 *                      checksum, count of files excluded as sensitive.
 *   manifest.json is written LAST (after state + files): a snapshot
 *   directory without a valid manifest is ignored by `list` — a
 *   crash mid-snapshot never leaves a half snapshot looking done.
 *
 * Checksum: sha256(canonical JSON of the state) + sha256 of each
 * file, combined into the snapshot checksum. `restore` verifies the
 * checksum BEFORE copying files back — a file edited by hand after
 * the snapshot makes restore refuse with a clear error (unless the
 * caller passes verify: false).
 *
 * Safety:
 *   - Sensitive files are NEVER copied into a snapshot: `.env*`,
 *     `*.pem`, `*.key`, `credentials*`, `*.p12`, `id_rsa*` — the
 *     excluded count is recorded in the manifest.
 *   - Symlinks are never followed (regular files only).
 *   - Every function is synchronous (fs sync), like session box v0.7.
 *
 * Honest limits (stated plainly, not exaggerated):
 *   - This is an APPLICATION-state snapshot, not a process/OS
 *     snapshot: running processes (shell, server, child process)
 *     are NOT frozen/restored — only the unfinished task is recorded
 *     so the agent can resume with tool calls in the next run.
 *   - No VM/container here — isolation belongs to the sandbox
 *     backend (`sandbox/backend.ts`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

/** Snapshot format version of this module (v0.7 used a different format, unversioned). */
export const BOT_SESSION_SNAPSHOT_VERSION = 2;

/** File/dir names that are never copied into a snapshot (sensitive). */
export const SUBSTRATE_SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /^credentials/i,
  /\.p12$/i,
  /^id_rsa/i,
];

export interface SubstrateBotConfig {
  model?: string;
  provider?: string;
  systemPrompt?: string;
  enabledTools?: string[];
}

export interface SubstrateMemoryEntry {
  key: string;
  value: string;
  tags?: string[];
  confidence?: number;
}

export interface SubstratePendingTask {
  id: string;
  title: string;
  stepsDone: string[];
  nextAction?: string;
}

/** The full working state of a bot (what gets snapshotted). */
export interface BotSessionState {
  botId: string;
  botName?: string;
  config: SubstrateBotConfig;
  memory: SubstrateMemoryEntry[];
  pendingTask?: SubstratePendingTask;
  /** Absolute working directory the snapshot was taken from. */
  workDir: string;
  createdAt: string;
}

export interface SubstrateSnapshotFile {
  rel: string;
  size: number;
  sha256: string;
}

export interface SubstrateManifest {
  version: number;
  snapshotId: string;
  botId: string;
  createdAt: string;
  note?: string;
  files: SubstrateSnapshotFile[];
  stateSha256: string;
  checksum: string;
  excludedFiles: number;
}

export interface SubstrateSnapshotInfo extends SubstrateManifest {
  path: string;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isSensitive(rel: string): boolean {
  const base = path.basename(rel);
  return SUBSTRATE_SENSITIVE_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(rel));
}

function collectFiles(workDir: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push({ rel: path.relative(workDir, abs), abs });
    }
  };
  walk(workDir);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * Take a snapshot of a bot's working state. Returns the manifest
 * (with the snapshot path). Sensitive files are excluded and counted.
 */
export function takeBotSessionSnapshot(
  root: string,
  state: BotSessionState,
  options: { note?: string; snapshotId?: string } = {},
): SubstrateSnapshotInfo {
  const snapshotId = options.snapshotId ?? randomUUID();
  const dir = path.join(root, '.open-bot', 'bot-sessions', state.botId, 'snapshots', snapshotId);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const stateJson = JSON.stringify(state, null, 2);
  const stateSha256 = sha256Hex(stateJson);
  fs.writeFileSync(path.join(dir, 'state.json'), stateJson, 'utf8');
  let excludedFiles = 0;
  const files: SubstrateSnapshotFile[] = [];
  // Never copy the snapshots directory itself: the snapshot being
  // written lives inside the work dir, and copying it would include
  // a stale copy of state.json in every snapshot.
  const ownSnapshotPrefix = ['.open-bot', 'bot-sessions', state.botId, 'snapshots'].join(path.sep) + path.sep;
  for (const { rel, abs } of collectFiles(state.workDir)) {
    if (rel.startsWith(ownSnapshotPrefix)) continue;
    if (isSensitive(rel)) {
      excludedFiles++;
      continue;
    }
    const content = fs.readFileSync(abs);
    const target = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    files.push({ rel, size: content.length, sha256: sha256Hex(content) });
  }
  const checksum = sha256Hex(
    [stateSha256, ...files.map((f) => `${f.rel}:${f.sha256}`)].join('\n'),
  );
  const manifest: SubstrateManifest = {
    version: BOT_SESSION_SNAPSHOT_VERSION,
    snapshotId,
    botId: state.botId,
    createdAt: state.createdAt,
    ...(options.note ? { note: options.note } : {}),
    files,
    stateSha256,
    checksum,
    excludedFiles,
  };
  // Manifest last: a directory without a valid manifest is not a snapshot.
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { ...manifest, path: dir };
}

/** Read a snapshot manifest (undefined when missing/invalid). */
export function readBotSessionManifest(snapshotDir: string): SubstrateManifest | undefined {
  try {
    const raw = fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const manifest = parsed as SubstrateManifest;
    if (manifest.version !== BOT_SESSION_SNAPSHOT_VERSION) return undefined;
    if (typeof manifest.snapshotId !== 'string' || typeof manifest.checksum !== 'string') return undefined;
    if (!Array.isArray(manifest.files)) return undefined;
    return manifest;
  } catch {
    return undefined;
  }
}

/** Read the state of a snapshot (undefined when missing/invalid). */
export function readBotSessionState(snapshotDir: string): BotSessionState | undefined {
  try {
    const raw = fs.readFileSync(path.join(snapshotDir, 'state.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const state = parsed as BotSessionState;
    if (typeof state.botId !== 'string' || typeof state.workDir !== 'string') return undefined;
    return state;
  } catch {
    return undefined;
  }
}

/**
 * Verify a snapshot's checksum (state + every file). Returns the
 * list of problems (empty = valid).
 */
export function verifyBotSessionSnapshot(snapshotDir: string): string[] {
  const problems: string[] = [];
  const manifest = readBotSessionManifest(snapshotDir);
  if (!manifest) return ['manifest is missing or invalid'];
  const state = readBotSessionState(snapshotDir);
  if (!state) return ['state.json is missing or invalid'];
  if (sha256Hex(JSON.stringify(state, null, 2)) !== manifest.stateSha256) {
    // State may have been written with different formatting; compare canonical JSON.
    if (sha256Hex(canonicalJson(state)) !== manifest.stateSha256) {
      problems.push('state.json checksum mismatch');
    }
  }
  for (const file of manifest.files) {
    const target = path.join(snapshotDir, 'files', file.rel);
    try {
      const content = fs.readFileSync(target);
      if (content.length !== file.size) problems.push(`file size mismatch: ${file.rel}`);
      else if (sha256Hex(content) !== file.sha256) problems.push(`file checksum mismatch: ${file.rel}`);
    } catch {
      problems.push(`file missing: ${file.rel}`);
    }
  }
  const expected = sha256Hex(
    [manifest.stateSha256, ...manifest.files.map((f) => `${f.rel}:${f.sha256}`)].join('\n'),
  );
  if (expected !== manifest.checksum) problems.push('snapshot checksum mismatch');
  return problems;
}

/** List valid snapshots of a bot (newest first). */
export function listBotSessionSnapshots(root: string, botId: string): SubstrateSnapshotInfo[] {
  const base = path.join(root, '.open-bot', 'bot-sessions', botId, 'snapshots');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: SubstrateSnapshotInfo[] = [];
  for (const name of dirs) {
    const dir = path.join(base, name);
    const manifest = readBotSessionManifest(dir);
    if (!manifest) continue;
    out.push({ ...manifest, path: dir });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Restore a snapshot: verify the checksum first (unless
 * `verify: false`), then copy the files back into `targetWorkDir`
 * and return the state. Files outside the snapshot are left alone.
 */
export function restoreBotSessionSnapshot(
  snapshotDir: string,
  targetWorkDir: string,
  options: { verify?: boolean } = {},
): BotSessionState {
  if (options.verify !== false) {
    const problems = verifyBotSessionSnapshot(snapshotDir);
    if (problems.length > 0) {
      throw new Error(`snapshot failed verification: ${problems.join('; ')}`);
    }
  }
  const manifest = readBotSessionManifest(snapshotDir);
  const state = readBotSessionState(snapshotDir);
  if (!manifest || !state) throw new Error('snapshot manifest or state is missing or invalid');
  for (const file of manifest.files) {
    const source = path.join(snapshotDir, 'files', file.rel);
    const target = path.resolve(targetWorkDir, file.rel);
    if (target !== path.resolve(targetWorkDir) && !target.startsWith(`${path.resolve(targetWorkDir)}${path.sep}`)) {
      throw new Error(`snapshot file escapes the target directory: ${file.rel}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return state;
}

/** Delete a snapshot directory (returns false when it did not exist). */
export function deleteBotSessionSnapshot(snapshotDir: string): boolean {
  try {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
