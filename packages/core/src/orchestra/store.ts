/**
 * Orchestra store — JSON file persistence for sessions + subtasks
 * (v1.02 rescue port of the v0.99 work).
 *
 * One file per session (`<dir>/<sessionId>.json`), written atomically
 * (temp + rename, mode 0600). A corrupt file loads as "session
 * missing" (fail-closed, never a half session).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { OrchestraSession, OrchestraSubtask } from './types';

export interface StoredOrchestraSession {
  session: OrchestraSession;
  subtasks: OrchestraSubtask[];
}

/** File-backed store for orchestration sessions. */
export class OrchestraStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  save(session: OrchestraSession, subtasks: OrchestraSubtask[]): void {
    const filePath = this.filePath(session.id);
    const tmp = `${filePath}.tmp-${process.pid}`;
    const payload: StoredOrchestraSession = { session, subtasks };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  get(sessionId: string): StoredOrchestraSession | undefined {
    try {
      const raw = fs.readFileSync(this.filePath(sessionId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const stored = parsed as StoredOrchestraSession;
      if (typeof stored.session?.id !== 'string' || !Array.isArray(stored.subtasks)) return undefined;
      return stored;
    } catch {
      return undefined;
    }
  }

  /** All stored sessions, newest first. */
  list(): OrchestraSession[] {
    const sessions: OrchestraSession[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    for (const file of files) {
      const stored = this.get(file.slice(0, -'.json'.length));
      if (stored) sessions.push(stored.session);
    }
    return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  delete(sessionId: string): boolean {
    try {
      fs.unlinkSync(this.filePath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }
}
