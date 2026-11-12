/**
 * 1Password broker — OUT-OF-PROCESS (v0.53, P1-6 — REA deep-dive lần
 * 2 §7.4: Grok keeps 1Password behind `onepassword-connection-service`
 * + `DefaultOnePasswordConnectionService` — a broker in the main
 * process, so the renderer never holds 1Password credentials
 * directly).
 *
 * Original code, same pattern:
 *   - `OnePasswordBroker` (this file, runs in the main process) owns
 *     NOTHING secret: it spawns a separate worker process
 *     (`onepassword-broker-worker.js`, same directory after build)
 *     and talks to it over stdio NDJSON-RPC. Only the worker ever
 *     invokes the `op` CLI, and only the worker process's memory ever
 *     holds a 1Password session/item value.
 *   - The broker API never returns a whole item: `listItems` returns
 *     id/title/category only (no secret values); `getField` returns
 *     exactly ONE requested field value, and the desktop main is
 *     expected to hand that value straight to the Vault (see the
 *     `onepassword:import-field` IPC) — never to the renderer.
 *   - Every call has a 15s wire timeout (`VAULT_WIRE_TIMEOUT_MS`,
 *     same as Grok's `GrokBotVaultWireError`): on timeout the call
 *     fails closed with `VaultWireError` — never a fake result.
 *
 * When the `op` CLI is not installed (or no account is signed in)
 * the broker reports `available: false` / `signedIn: false` instead
 * of throwing, so the UI can show "1Password chưa kết nối" and the
 * app keeps working. Verified on this machine: open-bot had NO
 * 1Password integration before v0.53 and `op` is not installed.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VaultWireError, VAULT_WIRE_TIMEOUT_MS } from './refusals';

/** Broker connection state (mirrors Grok's `OnePasswordBrokerConnectionState`). */
export type OnePasswordBrokerState = 'unavailable' | 'signed-out' | 'signed-in';

export interface OnePasswordBrokerStatus {
  /** Broker state: CLI missing -> unavailable; CLI present but no account -> signed-out. */
  state: OnePasswordBrokerState;
  /** False when the `op` CLI is not installed. */
  available: boolean;
  /** True when at least one 1Password account is signed in via `op`. */
  signedIn: boolean;
  /** `op --version` output when the CLI exists. */
  cliVersion?: string;
  /** Account shorthands signed in (labels only, e.g. "my.1password.com" — no tokens). */
  accounts: string[];
  /** Short human-readable reason when not signed in / unavailable (no secrets). */
  reason?: string;
}

/** One 1Password item as listed — metadata only, NEVER a secret value. */
export interface OnePasswordItemSummary {
  id: string;
  title: string;
  category: string;
}

export interface OnePasswordBrokerOptions {
  /** Absolute path of the worker entry. Defaults to the worker next to this file. */
  workerPath?: string;
  /** Per-call timeout in ms. Default VAULT_WIRE_TIMEOUT_MS (15s). */
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export class OnePasswordBroker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private readonly timeoutMs: number;
  private readonly workerPath: string;
  private buffer = '';
  private disposed = false;
  private spawnError: Error | null = null;

  constructor(options: OnePasswordBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? VAULT_WIRE_TIMEOUT_MS;
    this.workerPath = options.workerPath ?? path.join(__dirname, 'onepassword-broker-worker.js');
  }

  /** Spawn the worker (once) and wire its stdio. Throws when it cannot start. */
  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    if (this.disposed) throw new Error('OnePasswordBroker is disposed.');
    if (this.spawnError) throw this.spawnError;
    const proc = spawn(process.execPath, [this.workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // The worker inherits NO secrets from our env on purpose: it
      // talks to `op`, which reads its own session from the OS
      // keychain / `~/.config/op`. Strip nothing else — `op` needs
      // HOME/PATH — but never add credentials here.
      env: { ...process.env },
    });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr.on('data', () => {
      // Worker diagnostics only; never forwarded (may name accounts,
      // never secrets — the worker itself never logs values).
    });
    proc.on('exit', () => {
      this.proc = null;
      const err = new VaultWireError('1Password broker worker exited before answering.');
      for (const [, call] of this.pending) {
        if (call.timer) clearTimeout(call.timer);
        call.reject(err);
      }
      this.pending.clear();
    });
    proc.on('error', (err) => {
      this.spawnError = new Error(`Cannot start 1Password broker worker: ${err.message}`);
      this.proc = null;
    });
    return proc;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: string; result?: unknown; error?: { message?: string; code?: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // A malformed line is never a result; ignore it.
      }
      if (typeof msg.id !== 'string') continue;
      const call = this.pending.get(msg.id);
      if (!call) continue;
      this.pending.delete(msg.id);
      if (call.timer) clearTimeout(call.timer);
      if (msg.error) {
        call.reject(new Error(msg.error.message ?? '1Password broker error.'));
      } else {
        call.resolve(msg.result);
      }
    }
  }

  /** One NDJSON-RPC round-trip to the worker. Timeout -> VaultWireError (fail-closed). */
  private call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const proc = this.ensureWorker();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new VaultWireError(
            `1Password broker call "${method}" timed out after ${this.timeoutMs}ms.`,
            this.timeoutMs,
          ),
        );
      }, this.timeoutMs);
      // The timer must not keep the process alive on its own.
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      proc.stdin.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Cannot write to 1Password broker worker: ${err.message}`));
        }
      });
    });
  }

  /** CLI presence + sign-in state. Never throws for "not installed" — see the status. */
  async getStatus(): Promise<OnePasswordBrokerStatus> {
    return this.call<OnePasswordBrokerStatus>('status');
  }

  /** Item metadata only (id/title/category) — no secret values. */
  async listItems(vaultId?: string): Promise<OnePasswordItemSummary[]> {
    const result = await this.call<{ items: OnePasswordItemSummary[] }>('list-items', {
      ...(vaultId ? { vaultId } : {}),
    });
    return result.items;
  }

  /**
   * The value of ONE field of one item (e.g. `password`). The value
   * travels main-process-only: callers must store it straight into
   * the Vault (or use it for one login) and never forward it to the
   * renderer or log it.
   */
  async getField(itemId: string, field: string): Promise<string> {
    const result = await this.call<{ value: string }>('get-field', { itemId, field });
    return result.value;
  }

  /** Stop the worker. Pending calls reject with a VaultWireError. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
    }
    for (const [, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(new VaultWireError('1Password broker disposed before answering.'));
    }
    this.pending.clear();
  }
}
