/**
 * Coding-agent actions (v1.02, Team T4).
 *
 * The agent can only do six things. Every action is validated before
 * it runs (paths stay in the workspace, edit text must match exactly
 * once) and every execution returns an observation the loop feeds
 * back to the reasoner.
 */

import type { SandboxExecResult } from './sandboxExec';
import { runSandboxed } from './sandboxExec';
import type { FileChange, Workspace } from './workspace';

/** The five actions a coding agent may take. */
export type CodingAction =
  | { kind: 'create_file'; path: string; content: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'edit_file'; path: string; oldText: string; newText: string }
  | { kind: 'delete_file'; path: string }
  | { kind: 'run_command'; argv: string[]; timeoutMs?: number }
  | { kind: 'finish'; summary: string; success: boolean };

/** What the environment returned for one action. */
export interface ActionObservation {
  ok: boolean;
  summary: string;
  detail: string;
  fileChange?: FileChange;
  commandResult?: SandboxExecResult;
}

/** Human-readable one-liner for an action (used in events / traces). */
export function describeAction(action: CodingAction): string {
  switch (action.kind) {
    case 'create_file':
      return `create file ${action.path}`;
    case 'write_file':
      return `write file ${action.path}`;
    case 'edit_file':
      return `edit file ${action.path}`;
    case 'delete_file':
      return `delete file ${action.path}`;
    case 'run_command':
      return `run: ${action.argv.join(' ')}`;
    case 'finish':
      return `finish (${action.success ? 'success' : 'failure'}): ${action.summary}`;
  }
}

/**
 * Validate an action without running it. Returns an error message,
 * or null when the action is well-formed. Path confinement is checked
 * here (via `workspace.resolve`) and again at execution time.
 */
export function validateAction(action: CodingAction, workspace: Workspace): string | null {
  // Resolve first: an escaping path must be rejected before any
  // existence check (which would throw instead of returning an error).
  const resolveChecked = (p: string): string | null => {
    try {
      workspace.resolve(p);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  switch (action.kind) {
    case 'create_file': {
      if (!action.path) return 'create_file needs a path';
      const escaped = resolveChecked(action.path);
      if (escaped) return escaped;
      if (workspace.exists(action.path)) return `file already exists: ${action.path}`;
      return null;
    }
    case 'write_file': {
      if (!action.path) return 'write_file needs a path';
      return resolveChecked(action.path);
    }
    case 'edit_file': {
      if (!action.path) return 'edit_file needs a path';
      if (!action.oldText) return 'edit_file needs oldText';
      const escaped = resolveChecked(action.path);
      if (escaped) return escaped;
      if (!workspace.exists(action.path)) return `file does not exist: ${action.path}`;
      return null;
    }
    case 'delete_file': {
      if (!action.path) return 'delete_file needs a path';
      const escaped = resolveChecked(action.path);
      if (escaped) return escaped;
      if (!workspace.exists(action.path)) return `file does not exist: ${action.path}`;
      return null;
    }
    case 'run_command':
      if (action.argv.length === 0) return 'run_command needs argv';
      return null;
    case 'finish':
      if (!action.summary) return 'finish needs a summary';
      return null;
  }
}

export interface ActionExecutorOptions {
  /** Default command timeout in ms (default 120_000). */
  defaultTimeoutMs?: number;
  /** Extra env vars visible to sandboxed commands. */
  env?: Record<string, string>;
}

/**
 * Executes validated actions against a workspace. `execute` never
 * throws for a failed action — it returns a failed observation, so
 * the agent loop can reason about the failure and try a fix.
 */
export class ActionExecutor {
  private readonly workspace: Workspace;
  private readonly options: ActionExecutorOptions;

  constructor(workspace: Workspace, options: ActionExecutorOptions = {}) {
    this.workspace = workspace;
    this.options = options;
  }

  async execute(action: CodingAction): Promise<ActionObservation> {
    let invalid: string | null;
    try {
      invalid = validateAction(action, this.workspace);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, summary: `rejected: ${message}`, detail: message };
    }
    if (invalid) {
      return { ok: false, summary: `rejected: ${invalid}`, detail: invalid };
    }
    try {
      switch (action.kind) {
        case 'create_file': {
          const change = this.workspace.create(action.path, action.content);
          return {
            ok: true,
            summary: `created ${action.path} (${change.linesAdded} lines)`,
            detail: '',
            fileChange: change,
          };
        }
        case 'write_file': {
          const change = this.workspace.write(action.path, action.content);
          return {
            ok: true,
            summary: `${change.kind === 'created' ? 'created' : 'rewrote'} ${action.path} (${change.linesAdded} lines)`,
            detail: '',
            fileChange: change,
          };
        }
        case 'edit_file': {
          const change = this.workspace.edit(action.path, action.oldText, action.newText);
          return {
            ok: true,
            summary: `edited ${action.path}`,
            detail: '',
            fileChange: change,
          };
        }
        case 'delete_file': {
          const change = this.workspace.delete(action.path);
          return {
            ok: true,
            summary: `deleted ${action.path}`,
            detail: '',
            fileChange: change,
          };
        }
        case 'run_command': {
          const result = await runSandboxed(action.argv, {
            workspaceRoot: this.workspace.root,
            timeoutMs: action.timeoutMs ?? this.options.defaultTimeoutMs,
            env: this.options.env,
          });
          if (result.blocked) {
            return {
              ok: false,
              summary: `command blocked: ${result.blockReason}`,
              detail: result.blockReason ?? '',
              commandResult: result,
            };
          }
          const ok = result.exitCode === 0 && !result.timedOut;
          const tail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
          return {
            ok,
            summary: result.timedOut
              ? `command timed out after ${result.durationMs}ms: ${action.argv.join(' ')}`
              : `command exited ${result.exitCode}: ${action.argv.join(' ')}`,
            detail: tail,
            commandResult: result,
          };
        }
        case 'finish':
          return { ok: true, summary: action.summary, detail: '' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, summary: `failed: ${message}`, detail: message };
    }
  }
}
