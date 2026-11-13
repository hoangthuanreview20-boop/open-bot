/**
 * Local git workflow tools for @open-bot/tools (v0.97, Team T6):
 * history and branch work on the workspace repo through the git CLI,
 * sandboxed to the workspace (runShell + resolveWithin).
 *
 * This module covers the workflow verbs the older tools do not:
 *  - `git_log` — commit history with filters (path / author / since /
 *    until / grep) + `stat` diffstat + `full` body (v0.98 merge: the
 *    `until` / `grep` / `stat` filters were ported in from T6's
 *    standalone gitLog.ts, which built the same tool a second time —
 *    see the merge note in ./gitLog.ts)
 *  - `git_branch` — list local branches (read-only)
 *  - `git_branch_create` / `git_branch_delete` — create / delete a branch
 *  - `git_show` — show one commit, or the staged diff (`--cached`)
 *  (`git_blame` already exists in codeTools.ts — extended there in v0.97
 *  with an optional line range instead of being duplicated here.)
 *
 * Already covered elsewhere (not duplicated here): `git_status`,
 * `git_diff` and `git_commit` in ./tools.ts, `set_active_branch`
 * (checkout) and the GitHub PR tools in ./gitTools.ts.
 *
 * Safety: every ref (branch / revision / start point) is validated
 * against a strict pattern before it is quoted into a command —
 * no `..`, no leading `-`, no shell metacharacters, no `@{`.
 * File paths are confined to the workspace with resolveWithin.
 * Writes (create / delete) need approval; reads do not.
 *
 * Factory (same pattern as createGitTools / createBrowserTools):
 *   createGitWorkflowTools() -> Tool[]   (bound, usable)
 *   GIT_WORKFLOW_TOOLS                  (unbound placeholders)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { truncateWithBlob } from './blobStore';
import { resolveWithin, runShell } from './sandbox';
import { shellQuote } from './shellQuote';
import { MAX_TOOL_RESULT_CHARS } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS lives in ./truncate —
// re-export so code importing from this module does not have to change.
export { MAX_TOOL_RESULT_CHARS };

/**
 * Truncate a tool result, spilling the overflow into the workspace blob
 * store when a workspaceDir is given (same wrapper as tools.ts).
 */
function truncate(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS, workspaceDir?: string): string {
  if (workspaceDir) return truncateWithBlob(text, workspaceDir, maxChars);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated to ${maxChars} chars ...]`;
}

/** Longest git output kept in a single tool result (diffs can be huge). */
export const GIT_WORKFLOW_MAX_CHARS = 10_000;

/** Max commits `git_log` returns in one call. */
export const GIT_LOG_MAX_LIMIT = 100;

export function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getIntArg(
  args: Record<string, unknown>,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Argument "${name}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/**
 * Branch names: no leading `-`, no `..`, no spaces or shell
 * metacharacters (same rule as gitTools.ts `validateBranchName`).
 */
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateBranchName(branch: string): void {
  if (!BRANCH_NAME_RE.test(branch) || branch.includes('..') || branch.endsWith('.lock')) {
    throw new Error(
      `Invalid branch name "${branch}": use letters, digits, ".", "-" , "_" and "/" only, ` +
        'not starting with "-", and no "..".',
    );
  }
}

/**
 * A git revision the tools accept: `HEAD` (with optional `~N` / `^N`
 * suffixes), a short or full SHA, or a branch/tag name. Rejects range
 * syntax, reflog syntax (`@{...}`) and anything with shell
 * metacharacters — callers validate both sides of a range separately.
 */
const REVISION_RE = /^(HEAD(~[0-9]+)?(\^[0-9]*)?|[0-9a-f]{4,40}|[A-Za-z0-9][A-Za-z0-9._/-]*)$/;

export function validateGitRef(ref: string, argName = 'revision'): void {
  if (!REVISION_RE.test(ref) || ref.includes('..') || ref.includes('@{') || ref.endsWith('.lock')) {
    throw new Error(
      `Invalid git ${argName} "${ref}": expected HEAD, a commit SHA, or a branch/tag name ` +
        '(letters, digits, ".", "-", "_" and "/" only, no ".." or "@{").',
    );
  }
}

/** `YYYY-MM-DD` or an ISO datetime — the only `since` shapes accepted. */
const SINCE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/;

function validateDate(value: string, name: string): void {
  if (!SINCE_RE.test(value)) {
    throw new Error(
      `Invalid "${name}" "${value}": expected a date (YYYY-MM-DD) or an ISO datetime.`,
    );
  }
}

function validateSince(since: string): void {
  validateDate(since, 'since');
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

/** True when the workspace directory holds a git repo (worktree `.git` files count). */
export function isGitRepo(workspaceDir: string): boolean {
  try {
    return fs.existsSync(path.join(workspaceDir, '.git'));
  } catch {
    return false;
  }
}

function requireGitRepo(ctx: ToolContext): string | null {
  if (!isGitRepo(ctx.workspaceDir)) {
    return errorResult(
      `Workspace "${ctx.workspaceDir}" is not a git repository (no .git entry). ` +
        'Git workflow tools only work inside a git repo.',
    );
  }
  return null;
}

async function runGit(gitArgs: string, ctx: ToolContext): Promise<string> {
  const result = await runShell(`git ${gitArgs}`, ctx.workspaceDir, {
    workspaceDir: ctx.workspaceDir,
    signal: ctx.signal,
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return errorResult(`git ${gitArgs.split(' ')[0]} failed (exit ${result.code}): ${detail}`);
  }
  return result.stdout;
}

export function createGitWorkflowTools(): Tool[] {
  const gitLog: Tool = {
    definition: toolDef(
      'git_log',
      'Show the commit history of the workspace repo (newest first). ' +
        'Filter by file/directory, author, or date. Read-only.',
      {
        limit: { type: 'number', description: `Max commits to show (1–${GIT_LOG_MAX_LIMIT}). Default: 20.` },
        path: { type: 'string', description: 'Only commits touching this file or directory inside the workspace (optional).' },
        author: { type: 'string', description: 'Only commits by this author (substring match, optional).' },
        since: { type: 'string', description: 'Only commits after this date, YYYY-MM-DD or ISO datetime (optional).' },
        until: { type: 'string', description: 'Only commits before this date, YYYY-MM-DD or ISO datetime (optional).' },
        grep: { type: 'string', description: 'Only commits whose message contains this text (optional).' },
        stat: { type: 'boolean', description: 'Include a diffstat (files changed per commit). Default false.' },
        full: { type: 'boolean', description: 'Include the full commit message body, not just the subject line (default false).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const notRepo = requireGitRepo(ctx);
        if (notRepo) return notRepo;
        const limit = getIntArg(args, 'limit', 20, 1, GIT_LOG_MAX_LIMIT);
        const author = getOptionalStringArg(args, 'author');
        const since = getOptionalStringArg(args, 'since');
        if (since !== undefined) validateSince(since);
        const until = getOptionalStringArg(args, 'until');
        if (until !== undefined) validateDate(until, 'until');
        const grep = getOptionalStringArg(args, 'grep');
        const stat = getBoolArg(args, 'stat', false);
        const full = getBoolArg(args, 'full', false);
        const relPath = getOptionalStringArg(args, 'path');
        // One log line per commit: short hash, ISO date, author, subject
        // (+ body when `full`); the `%x09` tabs keep the columns aligned
        // even when a subject contains spaces.
        const format = full ? '%h%x09%ad%x09%an%x09%s%n%b' : '%h%x09%ad%x09%an%x09%s';
        let gitArgs = `log --format=${shellQuote(format)} --date=short -n ${limit}`;
        if (author) gitArgs += ` --author=${shellQuote(author)}`;
        if (since) gitArgs += ` --since=${shellQuote(since)}`;
        if (until) gitArgs += ` --until=${shellQuote(until)}`;
        if (grep) gitArgs += ` --grep=${shellQuote(grep)}`;
        if (stat) gitArgs += ' --stat';
        if (relPath) {
          resolveWithin(ctx.workspaceDir, relPath);
          gitArgs += ` -- ${shellQuote(relPath)}`;
        }
        const out = await runGit(gitArgs, ctx);
        if (out.startsWith('Error:')) return out;
        if (out.trim() === '') return '(no commits match)';
        return truncate(out, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const gitBranch: Tool = {
    definition: toolDef(
      'git_branch',
      'List branches of the workspace repo (current branch marked with `*`, upstream + ahead/behind shown). Read-only.',
      {
        all: { type: 'boolean', description: 'Include remote-tracking branches (default false).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const notRepo = requireGitRepo(ctx);
        if (notRepo) return notRepo;
        const all = getBoolArg(args, 'all', false);
        const out = await runGit(all ? 'branch -vv -a' : 'branch -vv', ctx);
        if (out.startsWith('Error:')) return out;
        if (out.trim() === '') return '(no branches — empty repo?)';
        return truncate(out, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const gitBranchCreate: Tool = {
    definition: toolDef(
      'git_branch_create',
      'Create a local branch in the workspace repo (at HEAD by default, or at the given start point). ' +
        'Does not switch to it — use set_active_branch to check it out. Needs approval.',
      {
        name: { type: 'string', description: 'New branch name, e.g. "feature/x".' },
        startPoint: { type: 'string', description: 'Commit/branch to start from (default: HEAD).' },
      },
      ['name'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const notRepo = requireGitRepo(ctx);
        if (notRepo) return notRepo;
        const name = getStringArg(args, 'name');
        validateBranchName(name);
        const startPoint = getOptionalStringArg(args, 'startPoint');
        if (startPoint !== undefined) validateGitRef(startPoint, 'startPoint');
        const gitArgs = startPoint
          ? `branch ${shellQuote(name)} ${shellQuote(startPoint)}`
          : `branch ${shellQuote(name)}`;
        const out = await runGit(gitArgs, ctx);
        if (out.startsWith('Error:')) return out;
        return `Branch "${name}" created${startPoint ? ` at ${startPoint}` : ''}.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const gitBranchDelete: Tool = {
    definition: toolDef(
      'git_branch_delete',
      'Delete a local branch in the workspace repo. Refuses to delete the checked-out branch or an ' +
        'unmerged branch unless force is true. Needs approval.',
      {
        name: { type: 'string', description: 'Branch name to delete.' },
        force: { type: 'boolean', description: 'Delete even when the branch is not fully merged (git branch -D). Default false.' },
      },
      ['name'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const notRepo = requireGitRepo(ctx);
        if (notRepo) return notRepo;
        const name = getStringArg(args, 'name');
        validateBranchName(name);
        const force = getBoolArg(args, 'force', false);
        const out = await runGit(`branch ${force ? '-D' : '-d'} ${shellQuote(name)}`, ctx);
        if (out.startsWith('Error:')) return out;
        return truncate(`Branch "${name}" deleted.\n${out}`, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const gitShow: Tool = {
    definition: toolDef(
      'git_show',
      'Show one commit of the workspace repo (diff by default, `--stat` when stat is true), ' +
        'or the staged diff when staged is true. Read-only.',
      {
        revision: { type: 'string', description: 'Commit to show (SHA, branch, or HEAD — default HEAD). Ignored when staged is true.' },
        path: { type: 'string', description: 'Only show changes to this file or directory inside the workspace (optional).' },
        stat: { type: 'boolean', description: 'Show only the file statistics, not the full diff (default false).' },
        staged: { type: 'boolean', description: 'Show the staged diff (git diff --cached) instead of a commit (default false).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const notRepo = requireGitRepo(ctx);
        if (notRepo) return notRepo;
        const staged = getBoolArg(args, 'staged', false);
        const stat = getBoolArg(args, 'stat', false);
        const relPath = getOptionalStringArg(args, 'path');
        if (relPath) resolveWithin(ctx.workspaceDir, relPath);
        let gitArgs: string;
        if (staged) {
          gitArgs = stat ? 'diff --cached --stat' : 'diff --cached';
        } else {
          const revision = getOptionalStringArg(args, 'revision') ?? 'HEAD';
          validateGitRef(revision);
          gitArgs = stat ? `show --stat ${shellQuote(revision)}` : `show ${shellQuote(revision)}`;
        }
        if (relPath) gitArgs += ` -- ${shellQuote(relPath)}`;
        const out = await runGit(gitArgs, ctx);
        if (out.startsWith('Error:')) return out;
        if (out.trim() === '') return staged ? '(nothing staged)' : '(empty commit)';
        return truncate(out, GIT_WORKFLOW_MAX_CHARS, ctx.workspaceDir);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [gitLog, gitBranch, gitBranchCreate, gitBranchDelete, gitShow];
}

/** Tool names, in registration order (for tests / docs). */
export const GIT_WORKFLOW_TOOL_NAMES = [
  'git_log',
  'git_branch',
  'git_branch_create',
  'git_branch_delete',
  'git_show',
] as const;

/** Unbound placeholders (same pattern as CODE_TOOLS / GIT_TOOLS). */
export const GIT_WORKFLOW_TOOLS: Tool[] = createGitWorkflowTools();
