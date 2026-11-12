/**
 * Computer-local tools for @open-bot/tools (v0.6) — the "Tool local trên
 * máy người dùng" item of the ROADMAP (section 2b, Shell / thực thi).
 *
 * Tools:
 *   system_info    — OS / CPU / RAM / disk, read-only.
 *   list_processes — list processes, read-only (ps on Unix, tasklist on
 *                    Windows; capped at 100 rows).
 *   kill_process   — kill ONE process, but ONLY when the pid belongs to
 *                    a process the daemon started (verified against
 *                    daemon list()/listSessions() ExecInfo/SessionInfo
 *                    pids). Anything else is refused. needsApproval.
 *   open_path      — open a file/folder inside the workspace with the
 *                    OS default app (xdg-open / open / start).
 *                    needsApproval, path confined by resolveWithin().
 *
 * Kill/open are deliberately narrow: this is NOT computer-use (no
 * mouse/keyboard/screen control) and NOT a general process manager.
 * Without a daemon connected, kill_process cannot verify ownership and
 * refuses every pid — that is the safe default, stated in its result.
 *
 * Factory:
 *   createLocalTools(getDaemon?) -> Tool[]   (bound, usable)
 *   createLocalTools({ getDaemon }) -> Tool[] (options form)
 *   LOCAL_TOOLS                              (daemon-less placeholder:
 *                                             info/list work, kill always
 *                                             refuses, open still works)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import { resolveWithin, runShell } from './sandbox';
import type { ShellDaemon } from './daemon/types';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };
const MAX_PROCESSES = 100;

export interface LocalToolsOptions {
  /** Lazily resolved per call, so a dead daemon is re-created by the caller. */
  getDaemon?: () => ShellDaemon | null;
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

function getNumberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (value === undefined || value === null) {
    throw new Error(`Missing required argument: "${name}"`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Argument "${name}" must be a positive pid number.`);
  }
  return Math.floor(value);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    value /= 1024;
    unit = u;
    if (value < 1024) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

export function createLocalTools(
  getDaemonOrOptions?: (() => ShellDaemon | null) | LocalToolsOptions,
): Tool[] {
  const options: LocalToolsOptions =
    typeof getDaemonOrOptions === 'function'
      ? { getDaemon: getDaemonOrOptions }
      : (getDaemonOrOptions ?? {});
  const getDaemon = options.getDaemon;

  const systemInfoTool: Tool = {
    definition: toolDef(
      'system_info',
      'Read-only system information: OS, CPU (model + cores), memory (total/free), disk free/total for the workspace drive, uptime. No process control, no file writes.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        const cpus = os.cpus();
        const disk = diskUsage(ctx.workspaceDir);
        return truncate(
          JSON.stringify(
            {
              platform: os.platform(),
              arch: os.arch(),
              release: os.release(),
              hostname: os.hostname(),
              cpuModel: cpus.length > 0 ? cpus[0]?.model ?? 'unknown' : 'unknown',
              cpuCores: cpus.length,
              memoryTotal: formatBytes(os.totalmem()),
              memoryFree: formatBytes(os.freemem()),
              memoryTotalBytes: os.totalmem(),
              memoryFreeBytes: os.freemem(),
              disk,
              uptimeSeconds: Math.floor(os.uptime()),
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listProcessesTool: Tool = {
    definition: toolDef(
      'list_processes',
      'Read-only list of running processes (pid, parent pid, CPU %, memory %, command). Max 100 rows, sorted by CPU. Listing only — use kill_process to stop a daemon-started process.',
      {
        filter: {
          type: 'string',
          description: 'Optional substring to filter the command column (case-insensitive).',
        },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const filter = getStringArg(args, 'filter', false).toLowerCase();
        const rows = await readProcessList();
        const filtered = filter
          ? rows.filter((r) => r.command.toLowerCase().includes(filter))
          : rows;
        const shown = filtered.slice(0, MAX_PROCESSES);
        const lines = shown.map(
          (r) => `${String(r.pid).padStart(7)} ${String(r.ppid).padStart(7)} ${r.cpu}% ${r.mem}% ${r.command}`,
        );
        const note =
          filtered.length > MAX_PROCESSES
            ? `\n[... showing ${MAX_PROCESSES} of ${filtered.length} ...]`
            : '';
        return truncate(
          `Processes (${filtered.length} matching, sorted by CPU):\n` +
            `    PID    PPID CPU% MEM% COMMAND\n${lines.join('\n')}${note}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const killProcessTool: Tool = {
    definition: toolDef(
      'kill_process',
      'Kill ONE process by pid — ONLY if that pid belongs to a process started by the local-exec-daemon ' +
        '(an exec_task/shell_exec exec or an interactive shell session, verified against the daemon\'s live list). ' +
        'Any other pid (system processes, the user\'s apps, the agent itself) is REFUSED. Without a daemon connected, every pid is refused.',
      {
        pid: { type: 'number', description: 'OS pid to kill.' },
      },
      ['pid'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const pid = getNumberArg(args, 'pid');
        const daemon = getDaemon?.() ?? null;
        if (!daemon) {
          return errorResult(
            `Refusing to kill pid ${pid}: no exec daemon connected, so ownership cannot be verified. ` +
              `kill_process only kills processes started by the daemon.`,
          );
        }
        // Verify ownership against the daemon's own live records.
        const [execs, sessions] = await Promise.all([
          daemon.list().catch(() => []),
          daemon.listSessions().catch(() => []),
        ]);
        const ownedExec = execs.find((e) => e.pid === pid);
        const ownedSession = sessions.find((s) => s.pid === pid);
        if (!ownedExec && !ownedSession) {
          return errorResult(
            `Refusing to kill pid ${pid}: it is not a daemon-started exec or shell session. ` +
              `kill_process only kills processes the daemon/agent started.`,
          );
        }
        if (ownedExec) {
          const { killed } = await daemon.kill(ownedExec.execId);
          return killed
            ? `Killed daemon exec "${ownedExec.execId}" (pid ${pid}, ${ownedExec.command} ${ownedExec.args.join(' ')}).`
            : `Pid ${pid} was already finished by the time the kill was sent.`;
        }
        // ownedSession is defined here (the early return above proves it).
        const { closed } = await daemon.closeSession(
          (ownedSession as { sessionId: string }).sessionId,
        );
        return closed
          ? `Closed daemon shell session (pid ${pid}).`
          : `Pid ${pid} session was already closed by the time the kill was sent.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const openPathTool: Tool = {
    definition: toolDef(
      'open_path',
      'Open a file or folder inside the workspace with the OS default application ' +
        '(xdg-open on Linux, open on macOS, start on Windows). The path must stay inside the workspace. Needs approval.',
      {
        path: { type: 'string', description: 'File or folder path, relative to the workspace root.' },
      },
      ['path'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const relPath = getStringArg(args, 'path');
        const fullPath = resolveWithin(ctx.workspaceDir, relPath);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          return errorResult(`Path does not exist: "${relPath}"`);
        }
        if (!stat.isFile() && !stat.isDirectory()) {
          return errorResult(`Not a file or directory: "${relPath}"`);
        }
        const opener =
          process.platform === 'win32'
            ? { command: 'cmd', args: ['/c', 'start', '', fullPath] }
            : process.platform === 'darwin'
              ? { command: 'open', args: [fullPath] }
              : { command: 'xdg-open', args: [fullPath] };
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const child = spawn(opener.command, opener.args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.on('error', (err: Error) => rejectPromise(err));
          child.on('spawn', () => resolvePromise());
          // Detach: the opener outlives this tool call.
          child.unref();
        });
        return `Opened "${relPath}" with the system default application.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [systemInfoTool, listProcessesTool, killProcessTool, openPathTool];
}

/** Disk usage for the drive holding `dir` (best effort; nulls when unavailable). */
function diskUsage(dir: string): {
  path: string;
  total: string | null;
  free: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
} {
  const fallback = {
    path: dir,
    total: null,
    free: null,
    totalBytes: null,
    freeBytes: null,
  };
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; blocks: number; bfree: number } }).statfsSync;
    if (typeof statfs !== 'function') return fallback;
    const s = statfs(dir);
    return {
      path: dir,
      total: formatBytes(s.bsize * s.blocks),
      free: formatBytes(s.bsize * s.bfree),
      totalBytes: s.bsize * s.blocks,
      freeBytes: s.bsize * s.bfree,
    };
  } catch {
    return fallback;
  }
}

interface ProcessRow {
  pid: number;
  ppid: number;
  cpu: string;
  mem: string;
  command: string;
}

/** Read the process table. Unix: `ps`; Windows: `tasklist` (no ppid/cpu).
 *  Unix dùng `ps -eo pid,ppid,%cpu,%mem,args` KHÔNG có `--sort`: flag
 *  `--sort` chỉ có trên GNU ps (Linux) — ps BSD trên macOS từ chối nó
 *  ("illegal option") nên toàn bộ tool lỗi trên macOS. Sắp xếp theo CPU
 *  được làm bằng JS ở dưới, giống hệt kết quả `--sort=-pcpu` trên Linux.
 *  `%cpu`/`%mem` là keyword hợp lệ trên cả GNU ps lẫn BSD ps (macOS). */
async function readProcessList(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    const result = await runShell('tasklist /FO CSV /NH', process.cwd());
    if (result.code !== 0) throw new Error(`tasklist failed: ${result.stderr.trim()}`);
    const rows: ProcessRow[] = [];
    for (const line of result.stdout.split('\n')) {
      const m = /"([^"]*)","(\d+)"/.exec(line.trim());
      if (!m) continue;
      rows.push({
        pid: Number(m[2]),
        ppid: 0,
        cpu: '?',
        mem: '?',
        command: m[1] as string,
      });
    }
    return rows;
  }
  const result = await runShell(
    'ps -eo pid,ppid,%cpu,%mem,args',
    process.cwd(),
  );
  if (result.code !== 0) throw new Error(`ps failed: ${result.stderr.trim()}`);
  const rows: ProcessRow[] = [];
  const lines = result.stdout.split('\n').slice(1); // skip header
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    // Full command line (args, not comm: comm truncates node to its
    // thread name "MainThread"). Cap the display length per row.
    const command = (m[5] as string).trim();
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: m[3] as string,
      mem: m[4] as string,
      command: command.length > 120 ? command.slice(0, 120) + '…' : command,
    });
  }
  // Sắp xếp theo CPU giảm dần (thay cho `--sort=-pcpu` của GNU ps,
  // không có trên macOS). CPU parse lỗi thì coi là 0, xếp cuối.
  rows.sort((a, b) => (Number.parseFloat(b.cpu) || 0) - (Number.parseFloat(a.cpu) || 0));
  return rows;
}

/**
 * Unbound placeholder: same tool shapes, daemon-less (system_info and
 * list_processes work; kill_process refuses every pid without a daemon
 * to verify ownership). Real usage with a daemon:
 *   const tools = createLocalTools(() => daemonClient);
 */
export const LOCAL_TOOLS: Tool[] = createLocalTools();
