/**
 * Git host tools for @open-bot/tools (v0.7, ROADMAP §2b):
 * kết nối git host, quản lý pull request, xem/cập nhật code tour,
 * sửa label PR, đặt branch đang làm việc.
 *
 * How the token reaches these tools (never hard-coded, never read here):
 *  - The host passes `getGitHubToken`, which reads the user's GitHub
 *    personal access token from the Vault. The tool never touches the
 *    Vault or settings.json itself, and never logs the token.
 *  - `fetchFn` is injectable (tests use a mock GitHub API; production
 *    uses global fetch against https://api.github.com, or `baseUrl`
 *    for GitHub Enterprise).
 *
 * `set_active_branch` runs `git checkout` inside the workspace via the
 * sandboxed `runShell` (denylist + workspace confinement); the branch
 * name is validated and must already exist (`git rev-parse --verify`).
 *
 * Factory (same pattern as createWebMediaTools / createAgentTools):
 *   createGitTools(opts?) -> Tool[]   (bound, usable)
 *   GIT_TOOLS                         (unbound placeholders)
 *
 * Approval: every write (pr_create, pr_update, pr_label_set,
 * pr_code_tour_update, set_active_branch) needs approval; the reads
 * (git_host_connect, pr_list, pr_code_tour_view) do not.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { createGitHubClient } from '@open-bot/core/dist/git/host';
import type {
  GitFetchFn,
  GitHubClient,
  GitPullRequest,
} from '@open-bot/core/dist/git/host';
import { resolveWithin, runShell } from './sandbox';
import { shellQuote } from './shellQuote';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };

export type GetGitHubToken = () => string | null | Promise<string | null>;

export interface GitToolOptions {
  /** GitHub token callback (host reads it from the Vault). Required for any API call. */
  getGitHubToken?: GetGitHubToken;
  /** GitHub API base URL (default https://api.github.com; tests point at a mock server). */
  baseUrl?: string;
  /** Injectable fetch (tests use a mock). Default: global fetch. */
  fetchFn?: GitFetchFn;
  /** Fixed workspace directory (its git repo is used by set_active_branch). */
  workspaceDir?: string;
}


function errorResult(message: string): string {
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

function getNumberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Argument "${name}" must be a positive integer (PR number).`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

/** Git branch names: no leading `-`, no `..`, no spaces or shell metacharacters. */
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function validateBranchName(branch: string): void {
  if (!BRANCH_NAME_RE.test(branch) || branch.includes('..') || branch.endsWith('.lock')) {
    throw new Error(
      `Invalid branch name "${branch}": use letters, digits, ".", "-" , "_" and "/" only, ` +
        'not starting with "-", and no "..".',
    );
  }
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

function formatPullRequest(pr: GitPullRequest): string {
  const labels = pr.labels.length > 0 ? ` [${pr.labels.join(', ')}]` : '';
  return (
    `#${pr.number} ${pr.title}${labels}\n` +
    `  state: ${pr.state} | author: ${pr.author || '?'} | ${pr.headBranch} → ${pr.baseBranch}\n` +
    `  url: ${pr.htmlUrl}\n` +
    `  updated: ${pr.updatedAt}`
  );
}

function makeGitClient(opts: GitToolOptions): GitHubClient {
  if (!opts.getGitHubToken) {
    throw new Error(
      'No GitHub token is wired up (createGitTools needs getGitHubToken). ' +
        'The host must supply it — it reads the token from the Vault. ' +
        'The tool never reads settings.json or the Vault itself.',
    );
  }
  return createGitHubClient({
    getToken: opts.getGitHubToken,
    baseUrl: opts.baseUrl,
    fetchFn: opts.fetchFn,
  });
}

export function createGitTools(opts: GitToolOptions = {}): Tool[] {
  const resolveWorkspace = (ctx: ToolContext): string => opts.workspaceDir || ctx.workspaceDir;

  const gitHostConnect: Tool = {
    definition: toolDef(
      'git_host_connect',
      'Check the GitHub token (read from the Vault by the host) and list the user\'s repositories ' +
        'via the public GitHub API. Returns the GitHub login + repos. Read-only.',
      {
        per_page: { type: 'number', description: 'Max repos to list (1–100). Default: 30.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const client = makeGitClient(opts);
        const login = await client.checkToken();
        const perPage =
          args['per_page'] === undefined
            ? 30
            : Math.max(1, Math.min(100, Math.floor(args['per_page'] as number)));
        const repos = await client.listRepos(perPage);
        if (repos.length === 0) {
          return `GitHub connected as "${login}" (token works). No repositories visible to this token.`;
        }
        const lines = repos.map(
          (r) =>
            `- ${r.fullName}${r.private ? ' (private)' : ''} — default branch: ${r.defaultBranch}` +
            (r.description ? ` — ${r.description}` : ''),
        );
        return truncate(
          `GitHub connected as "${login}" (token works). Repositories (${repos.length}):\n${lines.join('\n')}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const prList: Tool = {
    definition: toolDef(
      'pr_list',
      'List pull requests of a GitHub repo (open by default). Read-only.',
      {
        owner: { type: 'string', description: 'Repo owner (user or org), e.g. "octocat".' },
        repo: { type: 'string', description: 'Repo name, e.g. "hello-world".' },
        state: {
          type: 'string',
          description: 'PR state filter: "open", "closed" or "all". Default: "open".',
          enum: ['open', 'closed', 'all'],
        },
      },
      ['owner', 'repo'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const owner = getStringArg(args, 'owner');
        const repo = getStringArg(args, 'repo');
        const stateRaw = getOptionalStringArg(args, 'state') ?? 'open';
        if (stateRaw !== 'open' && stateRaw !== 'closed' && stateRaw !== 'all') {
          return errorResult(`Invalid "state" "${stateRaw}": expected "open", "closed" or "all".`);
        }
        const prs = await makeGitClient(opts).listPullRequests(owner, repo, stateRaw);
        if (prs.length === 0) return `No ${stateRaw} pull requests in ${owner}/${repo}.`;
        return truncate(
          `Pull requests in ${owner}/${repo} (${prs.length}, ${stateRaw}):\n\n${prs.map(formatPullRequest).join('\n\n')}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const prCreate: Tool = {
    definition: toolDef(
      'pr_create',
      'Create a pull request on GitHub (head branch → base branch). Needs approval: it creates a public-facing PR.',
      {
        owner: { type: 'string', description: 'Repo owner.' },
        repo: { type: 'string', description: 'Repo name.' },
        title: { type: 'string', description: 'PR title.' },
        head: { type: 'string', description: 'Head branch (with the changes), e.g. "feature/x".' },
        base: { type: 'string', description: 'Base branch to merge into, e.g. "main".' },
        body: { type: 'string', description: 'PR description (optional).' },
        draft: { type: 'boolean', description: 'Create as a draft PR (default false).' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const pr = await makeGitClient(opts).createPullRequest(
          getStringArg(args, 'owner'),
          getStringArg(args, 'repo'),
          {
            title: getStringArg(args, 'title'),
            head: getStringArg(args, 'head'),
            base: getStringArg(args, 'base'),
            body: getOptionalStringArg(args, 'body'),
            draft: getBoolArg(args, 'draft', false),
          },
        );
        return truncate(`Pull request created:\n\n${formatPullRequest(pr)}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const prUpdate: Tool = {
    definition: toolDef(
      'pr_update',
      'Update a pull request: title, body and/or state ("open" to reopen, "closed" to close). Needs approval.',
      {
        owner: { type: 'string', description: 'Repo owner.' },
        repo: { type: 'string', description: 'Repo name.' },
        number: { type: 'number', description: 'PR number.' },
        title: { type: 'string', description: 'New title (optional).' },
        body: { type: 'string', description: 'New body (optional).' },
        state: {
          type: 'string',
          description: 'New state: "open" or "closed" (optional).',
          enum: ['open', 'closed'],
        },
      },
      ['owner', 'repo', 'number'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const stateRaw = getOptionalStringArg(args, 'state');
        if (stateRaw !== undefined && stateRaw !== 'open' && stateRaw !== 'closed') {
          return errorResult(`Invalid "state" "${stateRaw}": expected "open" or "closed".`);
        }
        const pr = await makeGitClient(opts).updatePullRequest(
          getStringArg(args, 'owner'),
          getStringArg(args, 'repo'),
          getNumberArg(args, 'number'),
          {
            title: getOptionalStringArg(args, 'title'),
            body: getOptionalStringArg(args, 'body'),
            state: stateRaw as 'open' | 'closed' | undefined,
          },
        );
        return truncate(`Pull request updated:\n\n${formatPullRequest(pr)}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const prLabelSet: Tool = {
    definition: toolDef(
      'pr_label_set',
      'Replace the labels of a pull request with the given list (empty list clears all labels). Needs approval.',
      {
        owner: { type: 'string', description: 'Repo owner.' },
        repo: { type: 'string', description: 'Repo name.' },
        number: { type: 'number', description: 'PR number.' },
        labels: {
          type: 'array',
          description: 'Labels to set (replaces all current labels).',
          items: { type: 'string' },
        },
      },
      ['owner', 'repo', 'number', 'labels'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const owner = getStringArg(args, 'owner');
        const repo = getStringArg(args, 'repo');
        const number = getNumberArg(args, 'number');
        const labels = getStringArrayArg(args, 'labels');
        const result = await makeGitClient(opts).setPullRequestLabels(owner, repo, number, labels);
        return result.length === 0
          ? `Labels cleared on ${owner}/${repo}#${number}.`
          : `Labels on ${owner}/${repo}#${number} set to: ${result.join(', ')}.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const prCodeTourView: Tool = {
    definition: toolDef(
      'pr_code_tour_view',
      'View a pull request\'s code tour: the files it changes (with diff patches, truncated) plus its review comments. Read-only.',
      {
        owner: { type: 'string', description: 'Repo owner.' },
        repo: { type: 'string', description: 'Repo name.' },
        number: { type: 'number', description: 'PR number.' },
      },
      ['owner', 'repo', 'number'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const owner = getStringArg(args, 'owner');
        const repo = getStringArg(args, 'repo');
        const number = getNumberArg(args, 'number');
        const client = makeGitClient(opts);
        const [pr, files, comments] = await Promise.all([
          client.getPullRequest(owner, repo, number),
          client.listPullRequestFiles(owner, repo, number),
          client.listPullRequestComments(owner, repo, number),
        ]);
        const parts: string[] = [`Code tour for ${owner}/${repo}#${number}: ${pr.title}`, '', formatPullRequest(pr)];
        parts.push('', `Files changed (${files.length}):`);
        if (files.length === 0) {
          parts.push('(no files)');
        } else {
          for (const file of files) {
            parts.push(`- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`);
            if (file.patch) {
              const patch = file.patch.length > 3000 ? file.patch.slice(0, 3000) + '\n[... patch truncated ...]' : file.patch;
              parts.push(`  ${patch.split('\n').join('\n  ')}`);
            }
          }
        }
        parts.push('', `Review comments (${comments.length}):`);
        if (comments.length === 0) {
          parts.push('(no comments)');
        } else {
          for (const comment of comments) {
            const where = comment.path ? ` at ${comment.path}:${comment.line ?? '?'}` : '';
            parts.push(`- #${comment.id} ${comment.author}${where} (${comment.createdAt}): ${comment.body}`);
          }
        }
        return truncate(parts.join('\n'));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const prCodeTourUpdate: Tool = {
    definition: toolDef(
      'pr_code_tour_update',
      'Update a pull request\'s code tour: add a comment (general, or inline at a file+line with the PR head commit SHA) ' +
        'or submit a review (APPROVE / REQUEST_CHANGES / COMMENT). Needs approval.',
      {
        owner: { type: 'string', description: 'Repo owner.' },
        repo: { type: 'string', description: 'Repo name.' },
        number: { type: 'number', description: 'PR number.' },
        body: { type: 'string', description: 'Comment / review text.' },
        path: { type: 'string', description: 'File path for an inline comment (optional; needs line + commitId).' },
        line: { type: 'number', description: 'Line number for an inline comment (optional).' },
        commitId: { type: 'string', description: 'Head commit SHA for an inline comment (optional).' },
        reviewEvent: {
          type: 'string',
          description: 'Submit as a review instead of a plain comment: "APPROVE", "REQUEST_CHANGES" or "COMMENT" (optional).',
          enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
        },
      },
      ['owner', 'repo', 'number', 'body'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const owner = getStringArg(args, 'owner');
        const repo = getStringArg(args, 'repo');
        const number = getNumberArg(args, 'number');
        const body = getStringArg(args, 'body');
        const reviewEvent = getOptionalStringArg(args, 'reviewEvent');
        const client = makeGitClient(opts);
        if (reviewEvent !== undefined) {
          if (reviewEvent !== 'APPROVE' && reviewEvent !== 'REQUEST_CHANGES' && reviewEvent !== 'COMMENT') {
            return errorResult(`Invalid "reviewEvent" "${reviewEvent}".`);
          }
          const review = await client.submitPullRequestReview(owner, repo, number, {
            body,
            event: reviewEvent,
          });
          return `Review submitted on ${owner}/${repo}#${number}: ${reviewEvent} (review id ${review.id}, state ${review.state || 'submitted'}).`;
        }
        const pathArg = getOptionalStringArg(args, 'path');
        const lineArg = args['line'] === undefined ? undefined : getNumberArg(args, 'line');
        const commitId = getOptionalStringArg(args, 'commitId');
        const comment = await client.addPullRequestComment(owner, repo, number, {
          body,
          path: pathArg,
          line: lineArg,
          commitId,
        });
        const where = comment.path ? ` inline at ${comment.path}:${comment.line ?? '?'}` : '';
        return `Comment added to ${owner}/${repo}#${number}${where} (comment id ${comment.id}).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const setActiveBranch: Tool = {
    definition: toolDef(
      'set_active_branch',
      'Switch the workspace git repo to another branch (the branch the agent is working on). ' +
        'The branch must already exist in the repo; this tool never creates branches. ' +
        'Runs `git checkout` inside the workspace via the sandbox. Needs approval.',
      {
        branch: { type: 'string', description: 'Branch name to check out, e.g. "feature/x". Must already exist.' },
      },
      ['branch'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const branch = getStringArg(args, 'branch');
        validateBranchName(branch);
        const workspaceDir = resolveWorkspace(ctx);
        // The workspace must be a git repo; refuse otherwise with a clear message.
        if (!fs.existsSync(path.join(workspaceDir, '.git'))) {
          return errorResult(
            `Workspace "${workspaceDir}" is not a git repository (no .git directory). ` +
              'set_active_branch only works inside a git repo.',
          );
        }
        const exists = await runShell(`git rev-parse --verify --quiet ${shellQuote(branch)}`, workspaceDir, {
          workspaceDir,
          signal: ctx.signal,
        });
        if (exists.code !== 0) {
          return errorResult(
            `Branch "${branch}" does not exist in this repo. ` +
              'Create it first (e.g. `git checkout -b <branch>`) or pick an existing branch.',
          );
        }
        const result = await runShell(`git checkout ${shellQuote(branch)}`, workspaceDir, {
          workspaceDir,
          signal: ctx.signal,
        });
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim();
          return errorResult(
            `git checkout ${branch} failed (exit ${result.code}): ${detail || 'no output'}. ` +
              'The working tree may have uncommitted changes conflicting with the switch.',
          );
        }
        const current = await runShell('git branch --show-current', workspaceDir, {
          workspaceDir,
          signal: ctx.signal,
        });
        return truncate(
          `Active branch is now "${branch}" in the workspace repo.` +
            (current.code === 0 && current.stdout.trim()
              ? ` (git reports current branch: ${current.stdout.trim()})`
              : '') +
            (result.stdout.trim() ? `\n${result.stdout.trim()}` : ''),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    gitHostConnect,
    prList,
    prCreate,
    prUpdate,
    prLabelSet,
    prCodeTourView,
    prCodeTourUpdate,
    setActiveBranch,
  ];
}

/** Unbound placeholders (same pattern as CODE_TOOLS / MCP_TOOLS). */
export const GIT_TOOLS: Tool[] = createGitTools();
