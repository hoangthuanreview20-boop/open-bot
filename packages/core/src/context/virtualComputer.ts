/**
 * Virtual computer — a scoped working directory the agent treats as
 * "its computer" (v1.02 rescue port of the v1.00 work).
 *
 * There is deliberately NO real VM here: the virtual computer is a
 * directory on the local machine plus a command runner constrained
 * to it (cwd is always the computer's root, commands run with a
 * timeout, output is capped). Real isolation belongs to the sandbox
 * backend (`sandbox/`); this module is the bookkeeping + path safety
 * layer long tasks use to keep their files in one place.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface VirtualComputerOptions {
  /** Root directory of the virtual computer (created when missing). */
  root: string;
  /** Max stdout/stderr bytes kept per command (default 100 KB). */
  maxOutputBytes?: number;
  /** Default command timeout in ms (default 60s). */
  defaultTimeoutMs?: number;
}

export interface VirtualComputerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A scoped working directory + constrained command runner. */
export class VirtualComputer {
  readonly root: string;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: VirtualComputerOptions) {
    this.root = path.resolve(options.root);
    this.maxOutputBytes = options.maxOutputBytes ?? 100_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Resolve a relative path inside the computer (rejects escapes). */
  resolve(relPath: string): string {
    const resolved = path.resolve(this.root, relPath);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`path escapes the virtual computer: ${relPath}`);
    }
    return resolved;
  }

  /** Write a file inside the computer (creates parent dirs). */
  writeFile(relPath: string, content: string): string {
    const target = this.resolve(relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return target;
  }

  /** Read a file inside the computer. */
  readFile(relPath: string): string {
    return fs.readFileSync(this.resolve(relPath), 'utf8');
  }

  /** List files under a directory inside the computer (recursive). */
  listFiles(relDir = '.'): string[] {
    const dir = this.resolve(relDir);
    const out: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(path.relative(this.root, full));
      }
    };
    walk(dir);
    return out.sort();
  }

  /** Total bytes of files inside the computer. */
  sizeBytes(): number {
    let total = 0;
    for (const rel of this.listFiles()) {
      try {
        total += fs.statSync(this.resolve(rel)).size;
      } catch {
        // File vanished between list and stat; ignore.
      }
    }
    return total;
  }

  /**
   * Run a command inside the computer (no shell by default — pass an
   * argv array; the command inherits a minimal environment). The
   * command always runs with cwd = the computer root.
   */
  runCommand(argv: string[], options: { timeoutMs?: number } = {}): Promise<VirtualComputerRunResult> {
    if (argv.length === 0) return Promise.reject(new Error('runCommand requires a command'));
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: this.root, shell: false });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
      const append = (chunk: Buffer, into: 'stdout' | 'stderr'): void => {
        const text = chunk.toString('utf8');
        if (into === 'stdout') stdout = (stdout + text).slice(-this.maxOutputBytes);
        else stderr = (stderr + text).slice(-this.maxOutputBytes);
      };
      child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr: error.message, timedOut });
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      });
    });
  }
}
