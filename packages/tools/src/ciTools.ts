/**
 * CI / bug / AI-attribution tools for @open-bot/tools (v0.7, ROADMAP §2b):
 *  - `ci_investigate` — read a CI log (workspace file or URL), work out
 *    the likely cause of the failure, and record the investigation in
 *    `.open-bot/ci-investigations/<id>.json`.
 *  - `bug_report` — write a structured bug report to
 *    `.open-bot/bug-reports/<id>.json`.
 *  - `bug_fix_report` — record the result of fixing a bug (changes +
 *    tests run) and mark the matching bug report fixed when it exists.
 *  - `ai_attribution` — record which AI model produced a change
 *    (model + prompt summary + time) in `.open-bot/attribution.json`.
 *    The model/prompt MUST be supplied by the caller — this tool never
 *    invents an attribution source.
 *
 * Records live under `.open-bot/` (bot state, never committed). The
 * `fetch` implementation is injectable (`fetchFn`) so tests can use a
 * mock instead of a live URL.
 *
 * Factory (same pattern as createGitTools):
 *   createCiTools(opts?) -> Tool[]   (bound, usable)
 *   CI_TOOLS                         (unbound placeholders)
 *
 * Approval: ci_investigate only reads a log and writes an internal
 * record under .open-bot -> false. bug_report / bug_fix_report /
 * ai_attribution create durable records the user will rely on -> true.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '@open-bot/core';
import { resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };
const MAX_LOG_CHARS = 100_000;
const FETCH_TIMEOUT_MS = 30_000;

export type CiFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CiToolOptions {
  /** Injectable fetch for CI logs from a URL (tests use a mock). Default: global fetch. */
  fetchFn?: CiFetchFn;
  /** Fixed workspace directory. */
  workspaceDir?: string;
}

export interface CiInvestigation {
  id: string;
  source: string;
  sourceKind: 'file' | 'url';
  createdAt: string;
  botId: string;
  summary: string;
  suspectedCause: string;
  findings: string[];
  suggestedNextSteps: string[];
  logExcerpt: string;
}

export interface BugReport {
  id: string;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'fixed';
  steps: string[];
  labels: string[];
  logExcerpt: string;
  createdAt: string;
  botId: string;
  fixReportId?: string;
}

export interface BugFixReport {
  id: string;
  bugId: string;
  summary: string;
  changes: string[];
  testsRun: string[];
  result: 'fixed' | 'partial' | 'not-fixed';
  createdAt: string;
  botId: string;
}

export interface AiAttributionEntry {
  id: string;
  file: string;
  model: string;
  promptSummary: string;
  changeSummary: string;
  recordedAt: string;
  botId: string;
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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be a string or an array of strings.`);
  }
  return value as string[];
}

function writeJsonFile(fullPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** Pure heuristic: pick the most informative error lines out of a log. */
export function pickErrorLines(log: string, maxLines = 20): string[] {
  const lines = log.split('\n');
  const scored: Array<{ line: string; score: number; index: number }> = [];
  const patterns: Array<[RegExp, number]> = [
    [/^.*\b(error|failed|failure|fatal)\b.*$/i, 3],
    [/exit code/i, 3],
    [/test[s]? (failed|failing)/i, 3],
    [/Error:/, 2],
    [/Traceback|Exception|panic:/i, 3],
    [/out of memory|OOM|heap out of memory/i, 3],
    [/timed? ?out|timeout/i, 2],
    [/ENOTFOUND|ECONNREFUSED|network/i, 2],
    [/permission denied|EACCES/i, 2],
    [/not found|No such file/i, 2],
    [/FAIL\b/, 2],
  ];
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    let score = 0;
    for (const [re, points] of patterns) {
      if (re.test(line)) score += points;
    }
    if (score > 0) scored.push({ line: line.slice(0, 500), score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, maxLines).map((s) => s.line);
}

/** Pure heuristic: guess the failure family from error lines. Pure function (unit-tested). */
export function guessFailureCause(errorLines: string[]): {
  cause: string;
  nextSteps: string[];
} {
  const joined = errorLines.join('\n').toLowerCase();
  if (/out of memory|heap out of memory|\booom\b/.test(joined)) {
    return {
      cause: 'Likely out-of-memory: the job ran out of heap/container memory.',
      nextSteps: [
        'Raise the memory limit for the CI job (or NODE_OPTIONS=--max-old-space-size).',
        'Check for a memory leak or an unexpectedly large input in the failing step.',
      ],
    };
  }
  if (/timed? ?out|timeout/.test(joined)) {
    return {
      cause: 'Likely a timeout: a step or test ran longer than its limit.',
      nextSteps: [
        'Re-run the job to rule out a flaky slow run.',
        'Find the slowest test/step in the log and split it or raise its timeout.',
      ],
    };
  }
  if (/test[s]? (failed|failing)|fail\b/.test(joined) && /assert|expected|received/.test(joined)) {
    return {
      cause: 'Likely a failing test: an assertion did not hold (expected vs received).',
      nextSteps: [
        'Run the failing test locally and read its assertion diff.',
        'Check whether a recent change broke the expectation, or the test itself is stale.',
      ],
    };
  }
  if (/permission denied|eacces/.test(joined)) {
    return {
      cause: 'Likely a permissions problem: the CI runner could not read/write a path.',
      nextSteps: [
        'Check the file/directory permissions and the user the CI step runs as.',
        'Make sure secrets are passed as environment variables, not files with wrong modes.',
      ],
    };
  }
  if (/enotfound|econnrefused|network|fetch failed|getaddrinfo/.test(joined)) {
    return {
      cause: 'Likely a network problem: a dependency or service could not be reached.',
      nextSteps: [
        'Re-run the job (transient network/DNS failures are common in CI).',
        'Check the service URL and whether the CI runner allows outbound network access.',
      ],
    };
  }
  if (/not found|no such file|module not found|cannot find module/.test(joined)) {
    return {
      cause: 'Likely a missing file or dependency: something the job needs is not installed or not checked out.',
      nextSteps: [
        'Check the checkout step and the install step (npm ci / lockfile) in the CI config.',
        'Verify the missing path/module exists on the branch that ran.',
      ],
    };
  }
  if (/error:|failed|failure|fatal/.test(joined)) {
    return {
      cause: 'A step reported an error (see the findings); the log does not match a known failure family.',
      nextSteps: [
        'Read the first error line in the findings and reproduce that step locally.',
        'Search the error message in the project issue tracker — it may be a known failure.',
      ],
    };
  }
  return {
    cause: 'No clear error line found in the log — the job may have failed silently or the log is truncated.',
    nextSteps: [
      'Re-run the job with fuller logging (or check the CI run page for the step that went red).',
      'Pass a longer log (the tool reads up to 100,000 chars).',
    ],
  };
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

export function createCiTools(opts: CiToolOptions = {}): Tool[] {
  const resolveWorkspace = (ctx: ToolContext): string => opts.workspaceDir || ctx.workspaceDir;
  const fetchFn: CiFetchFn = opts.fetchFn ?? fetch;

  const ciInvestigate: Tool = {
    definition: toolDef(
      'ci_investigate',
      'Investigate a CI failure: read the CI log from a workspace file or a URL, pick out the error lines, ' +
        'guess the likely cause (heuristic — it says so when the cause is uncertain), and record the investigation ' +
        'in .open-bot/ci-investigations/<id>.json. Does not claim certainty it does not have.',
      {
        source: { type: 'string', description: 'Workspace-relative log file path, or an http(s) URL to fetch the log from.' },
        id: { type: 'string', description: 'Investigation id (optional; generated when omitted).' },
      },
      ['source'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const source = getStringArg(args, 'source');
        const workspaceDir = resolveWorkspace(ctx);
        const id = getOptionalStringArg(args, 'id') ?? newId('ci');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
          return errorResult('Invalid "id": use only letters, digits, ".", "-" and "_".');
        }
        let log: string;
        let sourceKind: 'file' | 'url';
        if (/^https?:\/\//i.test(source)) {
          sourceKind = 'url';
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          timer.unref?.();
          try {
            const res = await fetchFn(source, { signal: controller.signal });
            if (!res.ok) {
              return errorResult(`Fetching the CI log failed with HTTP ${res.status} from ${source}.`);
            }
            log = await res.text();
          } catch (err) {
            if ((err as Error).name === 'AbortError') {
              return errorResult(`Fetching the CI log timed out after ${FETCH_TIMEOUT_MS}ms: ${source}.`);
            }
            return errorResult(`Fetching the CI log failed (network error: ${(err as Error).message}).`);
          } finally {
            clearTimeout(timer);
          }
        } else {
          sourceKind = 'file';
          const fullPath = resolveWithin(workspaceDir, source);
          try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) return errorResult(`Not a file: "${source}"`);
            log = fs.readFileSync(fullPath, 'utf8');
          } catch {
            return errorResult(`Cannot read CI log file: "${source}" (missing or unreadable).`);
          }
        }
        if (log.length > MAX_LOG_CHARS) log = log.slice(0, MAX_LOG_CHARS);
        const findings = pickErrorLines(log);
        const { cause, nextSteps } = guessFailureCause(findings);
        const record: CiInvestigation = {
          id,
          source,
          sourceKind,
          createdAt: new Date().toISOString(),
          botId: ctx.botId,
          summary: findings.length > 0 ? `${findings.length} error line(s) found.` : 'No error lines found in the log.',
          suspectedCause: cause,
          findings,
          suggestedNextSteps: nextSteps,
          logExcerpt: log.slice(0, 5000),
        };
        const outPath = path.join(workspaceDir, '.open-bot', 'ci-investigations', `${id}.json`);
        writeJsonFile(outPath, record);
        const lines = [
          `CI investigation ${id} recorded to .open-bot/ci-investigations/${id}.json.`,
          `Source (${sourceKind}): ${source}`,
          `Suspected cause: ${cause}`,
          findings.length > 0
            ? `Error lines (${findings.length}):\n${findings.map((f) => `- ${f}`).join('\n')}`
            : 'No error lines found in the log.',
          `Suggested next steps:\n${nextSteps.map((s) => `- ${s}`).join('\n')}`,
        ];
        return truncate(lines.join('\n\n'));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bugReport: Tool = {
    definition: toolDef(
      'bug_report',
      'Create a structured bug report from a description (+ optional log excerpt) and save it to ' +
        '.open-bot/bug-reports/<id>.json. The report records what was reported, not a diagnosis — ' +
        'the cause stays "unknown" until an investigation says otherwise.',
      {
        title: { type: 'string', description: 'Short bug title.' },
        description: { type: 'string', description: 'What goes wrong, and how to reproduce it.' },
        severity: {
          type: 'string',
          description: 'Severity: "low", "medium", "high" or "critical". Default: "medium".',
          enum: ['low', 'medium', 'high', 'critical'],
        },
        steps: {
          type: 'array',
          description: 'Steps to reproduce (array of strings).',
          items: { type: 'string' },
        },
        labels: {
          type: 'array',
          description: 'Labels (array of strings).',
          items: { type: 'string' },
        },
        log: { type: 'string', description: 'Relevant log excerpt (optional, stored truncated).' },
        id: { type: 'string', description: 'Bug id (optional; generated when omitted).' },
      },
      ['title', 'description'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const workspaceDir = resolveWorkspace(ctx);
        const severityRaw = getOptionalStringArg(args, 'severity') ?? 'medium';
        if (!['low', 'medium', 'high', 'critical'].includes(severityRaw)) {
          return errorResult(`Invalid "severity" "${severityRaw}".`);
        }
        const id = getOptionalStringArg(args, 'id') ?? newId('bug');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
          return errorResult('Invalid "id": use only letters, digits, ".", "-" and "_".');
        }
        const log = getOptionalStringArg(args, 'log') ?? '';
        const report: BugReport = {
          id,
          title: getStringArg(args, 'title'),
          description: getStringArg(args, 'description'),
          severity: severityRaw as BugReport['severity'],
          status: 'open',
          steps: getStringArrayArg(args, 'steps'),
          labels: getStringArrayArg(args, 'labels'),
          logExcerpt: log.slice(0, 5000),
          createdAt: new Date().toISOString(),
          botId: ctx.botId,
        };
        writeJsonFile(
          path.join(workspaceDir, '.open-bot', 'bug-reports', `${id}.json`),
          report,
        );
        return truncate(
          `Bug report ${id} saved to .open-bot/bug-reports/${id}.json.\n` +
            `Title: ${report.title}\nSeverity: ${report.severity} | Status: open` +
            (report.labels.length > 0 ? `\nLabels: ${report.labels.join(', ')}` : ''),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bugFixReport: Tool = {
    definition: toolDef(
      'bug_fix_report',
      'Record the result of fixing a bug: the bug id, what changed, and which tests were run. ' +
        'Saves .open-bot/bug-reports/<bugId>.fix.json and, when the matching bug report exists, marks it fixed.',
      {
        bugId: { type: 'string', description: 'Id of the bug report (from bug_report).' },
        summary: { type: 'string', description: 'What the bug was and what fixed it.' },
        changes: {
          type: 'array',
          description: 'Files/changes made (array of strings).',
          items: { type: 'string' },
        },
        testsRun: {
          type: 'array',
          description: 'Tests run to verify the fix (array of strings, e.g. "npm test").',
          items: { type: 'string' },
        },
        result: {
          type: 'string',
          description: 'Outcome: "fixed", "partial" or "not-fixed". Default: "fixed".',
          enum: ['fixed', 'partial', 'not-fixed'],
        },
      },
      ['bugId', 'summary'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const workspaceDir = resolveWorkspace(ctx);
        const bugId = getStringArg(args, 'bugId');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bugId)) {
          return errorResult('Invalid "bugId": use only letters, digits, ".", "-" and "_".');
        }
        const resultRaw = getOptionalStringArg(args, 'result') ?? 'fixed';
        if (!['fixed', 'partial', 'not-fixed'].includes(resultRaw)) {
          return errorResult(`Invalid "result" "${resultRaw}".`);
        }
        const fixId = newId('fix');
        const fix: BugFixReport = {
          id: fixId,
          bugId,
          summary: getStringArg(args, 'summary'),
          changes: getStringArrayArg(args, 'changes'),
          testsRun: getStringArrayArg(args, 'testsRun'),
          result: resultRaw as BugFixReport['result'],
          createdAt: new Date().toISOString(),
          botId: ctx.botId,
        };
        const bugDir = path.join(workspaceDir, '.open-bot', 'bug-reports');
        writeJsonFile(path.join(bugDir, `${bugId}.fix.json`), fix);
        let marked = '';
        const bugPath = path.join(bugDir, `${bugId}.json`);
        try {
          if (fs.existsSync(bugPath)) {
            const existing = JSON.parse(fs.readFileSync(bugPath, 'utf8')) as BugReport;
            if (fix.result === 'fixed') {
              existing.status = 'fixed';
              existing.fixReportId = fixId;
              writeJsonFile(bugPath, existing);
              marked = ` Bug report ${bugId} marked fixed.`;
            }
          }
        } catch {
          // A corrupt bug report must not fail the fix report itself.
          marked = ` (Note: could not update the matching bug report file — it may be corrupt.)`;
        }
        return truncate(
          `Bug fix report ${fixId} saved to .open-bot/bug-reports/${bugId}.fix.json.\n` +
            `Bug: ${bugId} | Result: ${fix.result}\nSummary: ${fix.summary}` +
            (fix.testsRun.length > 0 ? `\nTests run: ${fix.testsRun.join(', ')}` : '') +
            marked,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const aiAttribution: Tool = {
    definition: toolDef(
      'ai_attribution',
      'Record AI attribution for a file/change: which model produced it and a summary of the prompt. ' +
        'Appends to .open-bot/attribution.json. The model and prompt summary MUST be supplied by the caller — ' +
        'this tool never invents an attribution source: without a model it refuses.',
      {
        file: { type: 'string', description: 'Workspace-relative file (or change) the attribution is for.' },
        model: { type: 'string', description: 'Model that produced the change, e.g. "grok-4.7" (required — never guessed).' },
        promptSummary: { type: 'string', description: 'Short summary of the prompt/instruction used.' },
        changeSummary: { type: 'string', description: 'Short summary of what changed.' },
      },
      ['file', 'model'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const workspaceDir = resolveWorkspace(ctx);
        const file = getStringArg(args, 'file');
        const model = getStringArg(args, 'model');
        if (!model.trim()) {
          return errorResult('Attribution needs a "model": it is never guessed or invented.');
        }
        const entry: AiAttributionEntry = {
          id: newId('attr'),
          file,
          model,
          promptSummary: getOptionalStringArg(args, 'promptSummary') ?? '',
          changeSummary: getOptionalStringArg(args, 'changeSummary') ?? '',
          recordedAt: new Date().toISOString(),
          botId: ctx.botId,
        };
        const attrPath = path.join(workspaceDir, '.open-bot', 'attribution.json');
        let entries: AiAttributionEntry[] = [];
        try {
          if (fs.existsSync(attrPath)) {
            const parsed: unknown = JSON.parse(fs.readFileSync(attrPath, 'utf8'));
            if (Array.isArray(parsed)) entries = parsed as AiAttributionEntry[];
          }
        } catch {
          return errorResult(
            'Cannot record attribution: .open-bot/attribution.json exists but is not valid JSON — fix or remove it first.',
          );
        }
        entries.push(entry);
        writeJsonFile(attrPath, entries);
        return truncate(
          `AI attribution recorded in .open-bot/attribution.json (entry ${entry.id}).\n` +
            `File: ${file}\nModel: ${model}` +
            (entry.promptSummary ? `\nPrompt: ${entry.promptSummary}` : '') +
            (entry.changeSummary ? `\nChange: ${entry.changeSummary}` : ''),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [ciInvestigate, bugReport, bugFixReport, aiAttribution];
}

/** Unbound placeholders (same pattern as CODE_TOOLS / GIT_TOOLS). */
export const CI_TOOLS: Tool[] = createCiTools();
