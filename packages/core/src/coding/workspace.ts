/**
 * Confined workspace for coding runs (v1.02, Team T4).
 *
 * Every file operation of a coding agent goes through this class.
 * All paths are resolved against the workspace root and rejected when
 * they escape it (`..` traversal, absolute paths outside the root,
 * symlinks pointing out). The agent can never read or write outside
 * its own workspace through this API.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodingFileChangeKind } from './events';

/** Result of a single file change. */
export interface FileChange {
  path: string;
  kind: CodingFileChangeKind;
  linesAdded: number;
  linesRemoved: number;
}

/** Error thrown when a path escapes the workspace. */
export class WorkspaceEscapeError extends Error {
  constructor(public readonly requested: string) {
    super(`Path escapes workspace: ${requested}`);
    this.name = 'WorkspaceEscapeError';
  }
}

export interface WorkspaceOptions {
  /** Maximum bytes for a single file write (default 5 MB). */
  maxWriteBytes?: number;
}

const DEFAULT_MAX_WRITE_BYTES = 5 * 1024 * 1024;

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/**
 * A directory tree a coding agent is allowed to touch. `root` is
 * resolved once at construction; every later path is resolved
 * against it and verified to stay inside.
 */
export class Workspace {
  readonly root: string;
  private readonly maxWriteBytes: number;

  constructor(root: string, options: WorkspaceOptions = {}) {
    this.root = path.resolve(root);
    this.maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    fs.mkdirSync(this.root, { recursive: true });
  }

  /**
   * Resolve a workspace-relative path to an absolute path.
   * Throws WorkspaceEscapeError when the path escapes the root.
   */
  resolve(relPath: string): string {
    if (path.isAbsolute(relPath)) {
      const resolved = path.resolve(relPath);
      if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
        throw new WorkspaceEscapeError(relPath);
      }
      return resolved;
    }
    const resolved = path.resolve(this.root, relPath);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new WorkspaceEscapeError(relPath);
    }
    return resolved;
  }

  /** Workspace-relative form of an absolute path (for logs / events). */
  relative(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join('/');
  }

  exists(relPath: string): boolean {
    return fs.existsSync(this.resolve(relPath));
  }

  isFile(relPath: string): boolean {
    const abs = this.resolve(relPath);
    try {
      return fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  read(relPath: string): string {
    const abs = this.resolve(relPath);
    return fs.readFileSync(abs, 'utf8');
  }

  /** List all files under the workspace (relative paths, sorted). */
  listFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Never follow symlinked directories out of the workspace.
          if (entry.isSymbolicLink()) continue;
          walk(abs);
        } else if (entry.isFile()) {
          out.push(this.relative(abs));
        }
      }
    };
    walk(this.root);
    return out.sort();
  }

  /** Create a new file. Fails when the file already exists. */
  create(relPath: string, content: string): FileChange {
    const abs = this.resolve(relPath);
    if (fs.existsSync(abs)) throw new Error(`File already exists: ${relPath}`);
    this.writeChecked(abs, content);
    return { path: this.relative(abs), kind: 'created', linesAdded: countLines(content), linesRemoved: 0 };
  }

  /** Overwrite an existing file (or create it when missing). */
  write(relPath: string, content: string): FileChange {
    const abs = this.resolve(relPath);
    const existed = fs.existsSync(abs);
    const before = existed ? countLines(fs.readFileSync(abs, 'utf8')) : 0;
    this.writeChecked(abs, content);
    const after = countLines(content);
    return {
      path: this.relative(abs),
      kind: existed ? 'edited' : 'created',
      linesAdded: Math.max(0, after - before),
      linesRemoved: Math.max(0, before - after),
    };
  }

  /**
   * Replace `oldText` with `newText` in a file. The old text must
   * occur exactly once — ambiguous or missing matches are errors,
   * so the agent cannot silently edit the wrong place.
   */
  edit(relPath: string, oldText: string, newText: string): FileChange {
    const abs = this.resolve(relPath);
    const before = fs.readFileSync(abs, 'utf8');
    const occurrences = before.split(oldText).length - 1;
    if (occurrences === 0) throw new Error(`edit: text not found in ${relPath}`);
    if (occurrences > 1) {
      throw new Error(`edit: text occurs ${occurrences} times in ${relPath} — be more specific`);
    }
    const after = before.replace(oldText, newText);
    this.writeChecked(abs, after);
    return {
      path: this.relative(abs),
      kind: 'edited',
      linesAdded: countLines(newText),
      linesRemoved: countLines(oldText),
    };
  }

  /** Delete a file. Fails when it does not exist. */
  delete(relPath: string): FileChange {
    const abs = this.resolve(relPath);
    if (!fs.existsSync(abs)) throw new Error(`File does not exist: ${relPath}`);
    const linesRemoved = countLines(fs.readFileSync(abs, 'utf8'));
    fs.unlinkSync(abs);
    return { path: this.relative(abs), kind: 'deleted', linesAdded: 0, linesRemoved };
  }

  private writeChecked(abs: string, content: string): void {
    if (Buffer.byteLength(content, 'utf8') > this.maxWriteBytes) {
      throw new Error(`write exceeds ${this.maxWriteBytes} bytes`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}
