/**
 * git_log — lịch sử commit của workspace repo (v0.98, sóng T6).
 *
 * Tool git còn thiếu trong bộ git local: đã có git_status / git_diff /
 * git_commit / git_blame, nhưng chưa có cách nào xem LỊCH SỬ commit
 * (ai sửa gì, khi nào, vì sao) mà không chạy shell_exec tay. git_log
 * lấp đúng lỗ đó — read-only, không cần approval.
 *
 * An toàn: mọi giá trị user đưa vào đều đi qua `shellQuote` (không
 * nối chuỗi thô vào lệnh); `path` phải nằm trong workspace
 * (`resolveWithin`); `since`/`until` chỉ nhận ngày `YYYY-MM-DD`
 * (kèm giờ `HH:MM` tùy chọn); `limit` bị chặn 1..100; output cắt ở
 * MAX_TOOL_RESULT_CHARS.
 *
 * Đăng ký: KHÔNG gộp vào ALL_TOOLS — v0.97's gitWorkflowTools đã
 * đăng ký `git_log` (cùng tên, thêm `full` + format tab-separated
 * mà test git-workflow-v097 khóa lại); đăng ký cả hai sẽ trùng tên
 * trong registry (merge v0.98). Module này giữ lại làm thư viện
 * độc lập: `parseGitLogOutput` / `formatGitLogCommits` + test trực
 * tiếp ở tests/git-log-v098.test.mjs; các filter `until` / `grep` /
 * `stat` đã được port sang gitWorkflowTools.git_log.
 */
import type { Tool, ToolContext } from '@open-bot/core';
import { resolveWithin, runShell } from './sandbox';
import { shellQuote } from './shellQuote';
import { truncateWithBlob } from './blobStore';
import { MAX_TOOL_RESULT_CHARS, truncateText } from './truncate';

/** Cắt output dài (như helper `truncate` cục bộ trong tools.ts): có workspaceDir thì lưu blob. */
function truncate(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS, workspaceDir?: string): string {
  if (workspaceDir) return truncateWithBlob(text, workspaceDir, maxChars);
  return truncateText(text, maxChars);
}

/** Số commit tối đa cho một lần gọi. */
export const GIT_LOG_MAX_LIMIT = 100;
/** Số commit mặc định. */
export const GIT_LOG_DEFAULT_LIMIT = 20;

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getLimitArg(args: Record<string, unknown>): number {
  const value = args['limit'];
  if (value === undefined || value === null) return GIT_LOG_DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Argument "limit" must be an integer, got ${typeof value}`);
  }
  if (value < 1 || value > GIT_LOG_MAX_LIMIT) {
    throw new Error(`Argument "limit" must be between 1 and ${GIT_LOG_MAX_LIMIT}, got ${value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

/** Ngày git chấp nhận ở đây: YYYY-MM-DD, kèm giờ HH:MM[:SS] tùy chọn. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

function validateDateArg(value: string, name: string): void {
  if (value === '') return;
  if (!DATE_RE.test(value)) {
    throw new Error(
      `Argument "${name}" must be a date like "2026-11-01" (optional time "2026-11-01 09:30"), got "${value}"`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Argument "${name}" is not a valid date: "${value}"`);
  }
}

async function runGit(gitArgs: string, ctx: ToolContext): Promise<string> {
  const result = await runShell(`git ${gitArgs}`, ctx.workspaceDir, {
    workspaceDir: ctx.workspaceDir,
    signal: ctx.signal,
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return errorResult(`git log failed (exit ${result.code}): ${detail}`);
  }
  return result.stdout;
}

interface ParsedCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
}

/**
 * Parse output của `git log` với format dùng ký tự phân cách điều
 * khiển: %x1f giữa các field, %x1e giữa các commit. Không bao giờ
 * throw với output lạ — commit parse hỏng thì bỏ qua.
 */
export function parseGitLogOutput(output: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const record of output.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '').replace(/\n+$/, '');
    if (trimmed === '') continue;
    const fields = trimmed.split('\x1f');
    if (fields.length < 4) continue;
    const [hash = '', author = '', date = '', subject = ''] = fields;
    const body = fields.slice(4).join('\x1f').trim();
    if (hash === '') continue;
    commits.push({ hash, author, date, subject, body });
  }
  return commits;
}

export function formatGitLogCommits(commits: ParsedCommit[]): string {
  return commits
    .map((c) => {
      const firstBody = c.body === '' ? '' : `\n    ${c.body.split('\n')[0]}`;
      return `${c.hash} ${c.date} ${c.author} | ${c.subject}${firstBody}`;
    })
    .join('\n');
}

export const gitLogTool: Tool = {
  definition: {
    name: 'git_log',
    description:
      'Show recent commit history for the workspace repository (hash, date, author, subject). ' +
      'Filter by author, file path, date range, or message text; add --stat with stat=true.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `How many commits to show (1-${GIT_LOG_MAX_LIMIT}, default ${GIT_LOG_DEFAULT_LIMIT}).`,
        },
        author: { type: 'string', description: 'Only commits whose author name/email contains this text.' },
        path: {
          type: 'string',
          description: 'Only commits touching this file or directory inside the workspace.',
        },
        since: { type: 'string', description: 'Only commits after this date, e.g. "2026-11-01".' },
        until: { type: 'string', description: 'Only commits before this date, e.g. "2026-11-13".' },
        grep: { type: 'string', description: 'Only commits whose message contains this text.' },
        stat: { type: 'boolean', description: 'Include a diffstat (files changed per commit). Default false.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const limit = getLimitArg(args);
      const author = getStringArg(args, 'author');
      const pathArg = getStringArg(args, 'path');
      const since = getStringArg(args, 'since');
      const until = getStringArg(args, 'until');
      const grep = getStringArg(args, 'grep');
      const stat = getBoolArg(args, 'stat');
      validateDateArg(since, 'since');
      validateDateArg(until, 'until');
      if (pathArg !== '') resolveWithin(ctx.workspaceDir, pathArg);

      const parts: string[] = ['log', `--max-count=${limit}`, '--date=short'];
      if (author !== '') parts.push(`--author=${shellQuote(author)}`);
      if (since !== '') parts.push(`--since=${shellQuote(since)}`);
      if (until !== '') parts.push(`--until=${shellQuote(until)}`);
      if (grep !== '') parts.push(`--grep=${shellQuote(grep)}`);
      if (stat) {
        parts.push('--stat');
        if (pathArg !== '') parts.push('--', shellQuote(pathArg));
        const out = await runGit(parts.join(' '), ctx);
        if (out.startsWith('Error:')) return out;
        return truncate(out.trim() === '' ? '(no commits match)' : out, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
      }
      parts.push(`--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1f%b%x1e`);
      if (pathArg !== '') parts.push('--', shellQuote(pathArg));
      const out = await runGit(parts.join(' '), ctx);
      if (out.startsWith('Error:')) return out;
      const commits = parseGitLogOutput(out);
      if (commits.length === 0) return '(no commits match)';
      return truncate(formatGitLogCommits(commits), MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

export const GIT_LOG_TOOLS: Tool[] = [gitLogTool];
