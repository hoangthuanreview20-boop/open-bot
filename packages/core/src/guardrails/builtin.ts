/**
 * Built-in rule-based guardrails (v0.10, BEYOND-ROADMAP items 5–6;
 * research P0-5: "Bắt đầu bằng guardrail không dùng model").
 *
 * Pure regex/rule checks — no model call, no I/O (except resolving a
 * path against the workspace, which is local filesystem metadata only).
 * Secret patterns extend the ones in `skills/loader.ts`
 * (`SECRET_PATTERNS` / `looksLikeSecret`); PII and injection markers
 * are new here.
 *
 * Safety rule for every `reason` string: it must NEVER contain a raw
 * secret or full PII value. Reasons name the pattern that fired and,
 * at most, a short masked preview (first 4 chars + `…`).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactBearer, redactSecrets, REDACTED } from '../util/redact';
import type {
  GuardrailContext,
  GuardrailDefinition,
  GuardrailLayer,
  GuardrailSeverity,
  GuardrailViolation,
} from './types';

/* ------------------------------------------------------------------ */
/* Pattern tables (exported so tests / later waves can reuse them)    */
/* ------------------------------------------------------------------ */

/** One named regex. `source` is compiled fresh per check (no /g state). */
export interface NamedPattern {
  code: string;
  label: string;
  /** Regex source (no flags — compiled with `gi`). */
  source: string;
}

/** Secret / credential shapes. Extends `skills/loader.ts` SECRET_PATTERNS. */
export const SECRET_PATTERNS: NamedPattern[] = [
  { code: 'secret.openai-key', label: 'OpenAI-style key (sk-…)', source: '\\bsk-[A-Za-z0-9]{16,}\\b' },
  { code: 'secret.xai-key', label: 'xAI-style key (xai-…)', source: '\\bxai-[A-Za-z0-9]{16,}\\b' },
  { code: 'secret.anthropic-key', label: 'Anthropic key (sk-ant-…)', source: '\\bsk-ant-[A-Za-z0-9\\-]{16,}\\b' },
  { code: 'secret.aws-access-key', label: 'AWS access key id (AKIA…)', source: '\\bAKIA[0-9A-Z]{16}\\b' },
  { code: 'secret.github-token', label: 'GitHub token (ghp_/gho_/github_pat_…)', source: '\\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\\b' },
  { code: 'secret.gitlab-token', label: 'GitLab token (glpat-…)', source: '\\bglpat-[A-Za-z0-9_\\-]{15,}\\b' },
  { code: 'secret.slack-token', label: 'Slack token (xox…)', source: '\\bxox[baprs]-[A-Za-z0-9\\-]{10,}\\b' },
  { code: 'secret.google-api-key', label: 'Google API key (AIza…)', source: '\\bAIza[0-9A-Za-z_\\-]{35}\\b' },
  { code: 'secret.bearer-token', label: 'Bearer token', source: '\\bBearer\\s+[A-Za-z0-9_\\-.]{16,}\\b' },
  { code: 'secret.jwt', label: 'JWT (eyJ…)', source: '\\beyJ[A-Za-z0-9_\\-]+\\.eyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\b' },
  { code: 'secret.private-key', label: 'PEM private key block', source: '-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----' },
  {
    code: 'secret.assigned-key',
    label: 'assigned key/secret value (api_key = …)',
    source: '\\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret)\\s*[:=]\\s*[\'"]?[A-Za-z0-9_\\-]{16,}[\'"]?',
  },
  {
    code: 'secret.assigned-password',
    label: 'assigned password value (password = …)',
    source: '\\b(?:password|passwd|pwd)\\s*[:=]\\s*[\'"]?\\S{8,}[\'"]?',
  },
];

/** PII shapes. Card numbers are confirmed with a Luhn check. */
export const PII_PATTERNS: NamedPattern[] = [
  {
    code: 'pii.email',
    label: 'email address',
    source: '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}',
  },
  {
    code: 'pii.phone',
    label: 'phone number',
    // VN mobile 0[35789]xxxxxxxx, +84…, or generic international +CC … (7–15 digits).
    source: '(?:\\+84|0)[35789]\\d{8}\\b|\\+\\d{1,3}[\\s\\-]?\\d{3,4}[\\s\\-]?\\d{3,4}[\\s\\-]?\\d{3,4}\\b',
  },
  {
    code: 'pii.cccd',
    label: 'CCCD (12 digits)',
    source: '(?<!\\d)\\d{12}(?!\\d)',
  },
  {
    code: 'pii.cmnd',
    label: 'CMND (9 digits)',
    source: '(?<!\\d)\\d{9}(?!\\d)',
  },
  {
    code: 'pii.card',
    label: 'card number (13–19 digits, Luhn-valid)',
    source: '(?<!\\d)(?:\\d[\\s\\-]?){13,19}(?!\\d)',
  },
];

/** Prompt-injection markers commonly found in fetched / pasted content. */
export const INJECTION_PATTERNS: NamedPattern[] = [
  { code: 'injection.ignore-instructions', label: 'ignore previous instructions', source: 'ignore\\s+(all\\s+)?(previous|prior|above|earlier)\\s+instructions' },
  { code: 'injection.disregard-instructions', label: 'disregard previous instructions', source: 'disregard\\s+(all\\s+)?(previous|prior|above|earlier)\\s+instructions' },
  { code: 'injection.forget-instructions', label: 'forget previous instructions', source: 'forget\\s+(all\\s+)?(previous|prior|your)\\s+instructions' },
  { code: 'injection.override-instructions', label: 'override instructions', source: 'override\\s+(your|the|all)\\s+instructions' },
  { code: 'injection.do-not-follow', label: 'do not follow instructions', source: 'do\\s+not\\s+follow\\s+(your|the|these)\\s+instructions' },
  { code: 'injection.you-are-now', label: '"you are now …" role override', source: 'you\\s+are\\s+now\\s+(a|an|the|in)\\b' },
  { code: 'injection.new-instructions', label: '"new instructions" block', source: 'new\\s+instructions\\s*:' },
  { code: 'injection.reveal-prompt', label: 'reveal system prompt/instructions', source: '(reveal|show|print|repeat|output|disclose)\\s+(your|the)\\s+(system\\s+prompt|instructions|prompt)' },
  { code: 'injection.system-marker', label: '[SYSTEM]/[INST] marker', source: '\\[(SYSTEM|INST)\\]' },
  { code: 'injection.jailbreak', label: 'jailbreak / DAN mode', source: '\\bjailbreak\\b|\\bDAN\\s+mode\\b|do\\s+anything\\s+now\\b' },
  { code: 'injection.disable-safety', label: 'disable safety filter', source: 'disable\\s+(your\\s+)?(safety|content)\\s+(filter|policy|guidelines)' },
  { code: 'injection.ignore-safety', label: 'ignore safety policy', source: 'ignore\\s+(your\\s+)?(safety|content)\\s+(policy|guidelines|rules)' },
  // Vietnamese variants (same tricks, local language).
  { code: 'injection.ignore-instructions-vi', label: 'bỏ qua hướng dẫn trước', source: 'bỏ\\s+qua\\s+(mọi|tất\\s+cả)\\s+(hướng\\s+dẫn|chỉ\\s+dẫn)' },
  { code: 'injection.forget-instructions-vi', label: 'quên mọi hướng dẫn', source: 'quên\\s+(mọi|tất\\s+cả)\\s+(hướng\\s+dẫn|chỉ\\s+dẫn)' },
  { code: 'injection.reveal-prompt-vi', label: 'tiết lộ system prompt', source: 'tiết\\s+lộ\\s+(system\\s+prompt|hướng\\s+dẫn\\s+hệ\\s+thống|câu\\s+lệnh\\s+hệ\\s+thống)' },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Compile a NamedPattern fresh (avoids shared /g `lastIndex` state). */
function compile(p: NamedPattern): RegExp {
  return new RegExp(p.source, 'gi');
}

/** Mask a matched value for safe inclusion in a reason string. */
function masked(matched: string): string {
  const clean = matched.replace(/\s+/g, ' ').trim();
  if (clean.length <= 8) return `${clean.slice(0, 4)}…`;
  return `${clean.slice(0, 4)}…${clean.slice(-2)}`;
}

/**
 * Luhn checksum — a 13–19 digit run is only a card number if it passes.
 * Keeps order ids / timestamps out of `pii.card`.
 */
export function luhnValid(digits: string): boolean {
  const nums = digits.replace(/\D/g, '');
  if (nums.length < 13 || nums.length > 19) return false;
  let sum = 0;
  let doubleIt = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let d = nums.charCodeAt(i)! - 48;
    if (doubleIt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}

/** Find every match of the given patterns in `text`, as violations. */
function scanPatterns(
  text: string,
  patterns: NamedPattern[],
  guardrailId: string,
  layer: GuardrailLayer,
  severity: GuardrailSeverity,
  extraCheck?: (p: NamedPattern, match: string) => boolean,
): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  for (const p of patterns) {
    const re = compile(p);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const matched = m[0];
      if (extraCheck && !extraCheck(p, matched)) continue;
      // Never put a raw secret / full PII value in the reason.
      const safePreview =
        p.code.startsWith('secret.') || p.code.startsWith('pii.')
          ? masked(matched)
          : matched.length > 60
            ? `${matched.slice(0, 60)}…`
            : matched;
      violations.push({
        guardrailId,
        layer,
        severity,
        code: p.code,
        reason: `Matched ${p.label} ("${safePreview}")`,
        span: { start: m.index, end: m.index + matched.length },
      });
      // Avoid an infinite loop on zero-length matches.
      if (matched.length === 0) re.lastIndex++;
    }
  }
  return violations;
}

/**
 * Replace every violation span in `text` with `<redacted>`, from the
 * end backwards so earlier offsets stay valid. Overlapping spans are
 * merged (the outermost span wins). Non-span violations are ignored.
 */
export function applyRedactions(text: string, violations: GuardrailViolation[]): string {
  const spans = violations
    .filter((v) => v.span && v.span.end > v.span.start)
    .map((v) => v.span!)
    .sort((a, b) => a.start - b.start);
  if (spans.length === 0) return text;
  // Merge overlaps.
  const merged: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ start: s.start, end: s.end });
    }
  }
  let out = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const s = merged[i]!;
    out = out.slice(0, s.start) + REDACTED + out.slice(s.end);
  }
  return out;
}

/**
 * Redact a final answer: known secrets first (literal match, via
 * `util/redact.ts`), then Bearer shapes, then every violation span.
 * This is what the output layer returns as `redactedText`.
 */
export function redactOutputText(
  text: string,
  violations: GuardrailViolation[],
  knownSecrets: string[] = [],
): string {
  const spanRedacted = applyRedactions(text, violations);
  return redactBearer(redactSecrets(spanRedacted, knownSecrets));
}

/* ------------------------------------------------------------------ */
/* Input / output guardrails (string values)                          */
/* ------------------------------------------------------------------ */

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export interface ScopeGuardrailOptions {
  /**
   * Out-of-scope phrases / patterns for this bot (e.g. topics the bot
   * must refuse). A string matches as a case-insensitive substring; a
   * RegExp is tested as-is.
   */
  blockedPatterns: (string | RegExp)[];
  /** Optional description override. */
  description?: string;
}

/**
 * Out-of-scope requests (input layer, opt-in — NOT in
 * `BUILTIN_GUARDRAILS`, because scope is per-bot / per-deployment
 * and there is no sensible default policy to invent).
 *
 * This is a keyword/phrase blocklist only: it can refuse requests
 * that literally mention a configured out-of-scope topic, but it
 * cannot judge semantic scope ("is this request related to the bot's
 * job?"). That judgement needs a model-based guardrail, which is not
 * implemented yet — `GuardrailDefinition.check` is async precisely so
 * a model-based guardrail can be registered later, and the registry
 * is fail-closed (a model call failure blocks) so adding one is safe.
 */
export function createScopeGuardrail(
  options: ScopeGuardrailOptions,
): GuardrailDefinition {
  const patterns = options.blockedPatterns ?? [];
  return {
    id: 'scope',
    layer: 'input',
    description:
      options.description ??
      'Blocks requests matching a configured out-of-scope phrase/pattern (opt-in keyword blocklist).',
    check(value) {
      const text = asText(value);
      if (text === null || text.length === 0 || patterns.length === 0) return [];
      const lower = text.toLowerCase();
      const violations: GuardrailViolation[] = [];
      for (let i = 0; i < patterns.length; i++) {
        const p = patterns[i]!;
        const matched =
          typeof p === 'string'
            ? lower.includes(p.toLowerCase())
            : (() => {
                const re = new RegExp(p.source, p.flags.includes('i') ? p.flags : `${p.flags}i`);
                return re.test(text);
              })();
        if (!matched) continue;
        // Reason names the configured pattern (bot-owner config, safe
        // to show) — never the matched slice of user input.
        const preview =
          typeof p === 'string' ? p : p.source;
        violations.push({
          guardrailId: 'scope',
          layer: 'input',
          severity: 'block',
          code: 'scope.blocked-topic',
          reason: `Matched out-of-scope topic (rule ${i + 1}: "${preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}")`,
        });
      }
      return violations;
    },
  };
}

/**
 * Prompt injection in input text (user message, pasted content,
 * `web_fetch` result). Blocking: fetched content must never be able
 * to steer the agent.
 */
export function createPromptInjectionGuardrail(): GuardrailDefinition {
  return {
    id: 'prompt-injection',
    layer: 'input',
    description:
      'Blocks prompt-injection markers in input text (fetched / pasted content): ignore/override instructions, role overrides, [SYSTEM] markers, jailbreak, Vietnamese variants.',
    check(value) {
      const text = asText(value);
      if (text === null || text.length === 0) return [];
      return scanPatterns(text, INJECTION_PATTERNS, 'prompt-injection', 'input', 'block');
    },
  };
}

/**
 * Secrets in text. On the `output` layer a leaked key blocks the
 * answer; on the `input` layer the user pasting their own key is only
 * warned (severity `warn` never blocks) — the key is theirs to share,
 * but the event is recorded.
 */
export function createSecretGuardrail(layer: 'input' | 'output'): GuardrailDefinition {
  const severity: GuardrailSeverity = layer === 'output' ? 'block' : 'warn';
  // Distinct ids per layer — the registry keys guardrails by id.
  const id = layer === 'output' ? 'secret-output' : 'secret-input';
  return {
    id,
    layer,
    description:
      layer === 'output'
        ? 'Blocks API keys / tokens / private keys leaking into the final answer.'
        : 'Flags API keys / tokens pasted into input (warn only — never blocks).',
    check(value, ctx) {
      const text = asText(value);
      if (text === null || text.length === 0) return [];
      const violations = scanPatterns(text, SECRET_PATTERNS, id, layer, severity);
      // Known secrets (e.g. from the Vault) are redacted on sight even
      // when they match no generic pattern.
      for (const secret of ctx.knownSecrets ?? []) {
        if (typeof secret !== 'string' || secret.length < 4) continue;
        let idx = text.indexOf(secret);
        while (idx !== -1) {
          if (!violations.some((v) => v.span && idx >= v.span.start && idx < v.span.end)) {
            violations.push({
              guardrailId: id,
              layer,
              severity,
              code: 'secret.known-secret',
              reason: 'Matched a known secret (from Vault / session)',
              span: { start: idx, end: idx + secret.length },
            });
          }
          idx = text.indexOf(secret, idx + secret.length);
        }
      }
      return violations;
    },
  };
}

/**
 * PII in the final answer (output layer only — the user's own input
 * is theirs; the model must not echo PII back out, e.g. from tool
 * results or memory). Email / phone / CCCD / CMND / Luhn-valid card.
 */
export function createPiiGuardrail(): GuardrailDefinition {
  return {
    id: 'pii',
    layer: 'output',
    description:
      'Blocks PII leaking into the final answer: email, phone, CCCD/CMND, card numbers (Luhn-checked).',
    check(value) {
      const text = asText(value);
      if (text === null || text.length === 0) return [];
      return scanPatterns(text, PII_PATTERNS, 'pii', 'output', 'block', (p, match) => {
        // A digit run is only a card when it passes Luhn.
        if (p.code === 'pii.card') return luhnValid(match);
        return true;
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tool guardrails (args record)                                      */
/* ------------------------------------------------------------------ */

/** Argument keys whose whole string value is treated as a file path. */
const PATH_ARG_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'file_path',
  'cwd',
  'dir',
  'directory',
  'src',
  'source',
  'dest',
  'destination',
  'target',
  'root',
  'folder',
]);

/** Path-like tokens inside a free-form string value. */
const PATH_TOKEN_RES: RegExp[] = [
  // Absolute POSIX path: /etc/passwd, /home/u/x.txt (not a URL — scheme excluded below).
  /(?:^|[\s"'`(=])(\/(?:[\w.\-~]+\/)+[\w.\-~]*)/g,
  // Windows absolute path: C:\Users\… or C:/Users/…
  /(?:^|[\s"'`(=])([A-Za-z]:[\\/][^\s"'`]*)/g,
  // UNC path: \\server\share\…
  /(?:^|[\s"'`(=])(\\\\[^\s"'`]+)/g,
  // Home-relative: ~/… or ~\…
  /(?:^|[\s"'`(=])(~[\\/][^\s"'`]*)/g,
  // Explicitly relative: ../… or ./…
  /(?:^|[\s"'`(=])((?:\.\.\/|\.\/)[^\s"'`]*)/g,
  // file:// URL — the path after the scheme is a real filesystem path.
  /(?:^|[\s"'`(=])(file:\/\/[^\s"'`]*)/gi,
];

/** Recursively collect every string leaf of the args value with its JSON path. */
function collectStringLeaves(
  value: unknown,
  jsonPath: string,
  out: { jsonPath: string; key: string; text: string }[],
): void {
  if (typeof value === 'string') {
    out.push({ jsonPath, key: jsonPath.split('.').pop() ?? '', text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectStringLeaves(v, `${jsonPath}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectStringLeaves(v, jsonPath ? `${jsonPath}.${k}` : k, out);
    }
  }
}

/**
 * Is `target` (absolute) inside `workspaceDir`? Same approach as the
 * sandbox helper in `packages/tools/src/sandbox.ts` (`resolveWithin`):
 * resolve symlinks for the longest existing ancestor, then re-append
 * the non-existing tail — so `link -> /etc` inside the workspace is
 * caught even when the final file does not exist yet. Core cannot
 * import from `@open-bot/tools` (dependency direction is tools → core),
 * hence this local copy.
 */
function isPathWithinWorkspace(workspaceDir: string, target: string): boolean {
  const workspaceReal = fs.realpathSync(path.resolve(workspaceDir));
  let existing = path.resolve(target);
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached filesystem root
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const realExisting = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  const resolved = tail.length > 0 ? path.join(realExisting, ...tail) : realExisting;
  return resolved === workspaceReal || resolved.startsWith(workspaceReal + path.sep);
}

/**
 * Resolve a candidate path against the workspace and report whether
 * it escapes. Returns the resolved path, or null when there is no
 * workspace to check against (then nothing can be judged an escape).
 */
function escapesWorkspace(candidate: string, workspaceDir?: string): string | null {
  if (!workspaceDir) return null;
  // A workspace that does not exist cannot be checked against — the
  // coordinator validates it at startup (ipc `validateWorkspaceDir`);
  // fail open here rather than blocking every tool call.
  if (!fs.existsSync(workspaceDir)) return null;
  let target = candidate;
  if (/^file:\/\//i.test(target)) {
    target = target.replace(/^file:\/\/(?:localhost)?/i, '');
    if (!target.startsWith('/')) target = `/${target}`;
  }
  let resolved: string;
  if (target.startsWith('~')) {
    resolved = path.resolve(os.homedir(), target.slice(1).replace(/^[/\\]/, ''));
  } else if (path.isAbsolute(target)) {
    resolved = path.resolve(target);
  } else {
    resolved = path.resolve(workspaceDir, target);
  }
  try {
    return isPathWithinWorkspace(workspaceDir, resolved) ? null : resolved;
  } catch {
    // Workspace itself unresolvable (deleted mid-run, …) — fail open
    // here; the coordinator validates the workspace at startup.
    return null;
  }
}

/**
 * Tool args must not touch paths outside the workspace. Checks both
 * dedicated path arguments (whole value) and path-like tokens inside
 * free-form strings. URLs (`https://…`) are not paths and are ignored.
 * No `workspaceDir` in context = nothing to check against (no violation).
 */
export function createToolPathGuardrail(): GuardrailDefinition {
  return {
    id: 'tool-path',
    layer: 'tool',
    description:
      'Blocks tool arguments that reference paths outside the workspace (absolute, ~, ../, Windows, UNC, file:// — symlink escapes included via longest-existing-ancestor realpath).',
    check(value, ctx) {
      const leaves: { jsonPath: string; key: string; text: string }[] = [];
      collectStringLeaves(value, '', leaves);
      const violations: GuardrailViolation[] = [];
      const seen = new Set<string>();
      const flag = (jsonPath: string, candidate: string, resolved: string) => {
        const dedup = `${jsonPath}:${resolved}`;
        if (seen.has(dedup)) return;
        seen.add(dedup);
        violations.push({
          guardrailId: 'tool-path',
          layer: 'tool',
          severity: 'block',
          code: 'tool.path-escape',
          reason:
            `Tool arg "${jsonPath}" references a path outside the workspace: ` +
            `"${candidate}" resolves to "${resolved}".`,
        });
      };
      for (const leaf of leaves) {
        const candidates: string[] = [];
        if (PATH_ARG_KEYS.has(leaf.key.toLowerCase())) {
          if (leaf.text.trim().length > 0) candidates.push(leaf.text.trim());
        }
        for (const re of PATH_TOKEN_RES) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(leaf.text)) !== null) {
            const token = m[1]!;
            // A URL scheme (https://…) also matches the POSIX pattern's
            // "/…" tail — skip tokens that are part of a URL.
            const at = m.index + m[0].indexOf(token);
            const before = leaf.text.slice(Math.max(0, at - 8), at);
            if (/[A-Za-z][A-Za-z0-9+.-]*:$/.test(before)) continue;
            candidates.push(token);
          }
        }
        for (const candidate of candidates) {
          const resolved = escapesWorkspace(candidate, ctx.workspaceDir);
          if (resolved !== null) flag(leaf.jsonPath, candidate, resolved);
        }
      }
      return violations;
    },
  };
}

/**
 * Secrets smuggled into tool arguments (e.g. a fetched page telling
 * the agent to `shell_exec` with an API key, or to write a key to a
 * file). Scanned over the JSON-serialised args.
 */
export function createToolSecretGuardrail(): GuardrailDefinition {
  return {
    id: 'tool-secret',
    layer: 'tool',
    description: 'Blocks secrets (API keys / tokens / private keys) inside tool arguments.',
    check(value, ctx) {
      if (value === null || value === undefined) return [];
      let text: string;
      try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
      } catch {
        return [];
      }
      const violations = scanPatterns(text, SECRET_PATTERNS, 'tool-secret', 'tool', 'block');
      for (const secret of ctx.knownSecrets ?? []) {
        if (typeof secret !== 'string' || secret.length < 4 || !text.includes(secret)) continue;
        violations.push({
          guardrailId: 'tool-secret',
          layer: 'tool',
          severity: 'block',
          code: 'secret.known-secret',
          reason: 'Tool args contain a known secret (from Vault / session)',
        });
      }
      return violations;
    },
  };
}

/**
 * Injection markers inside tool arguments — the classic case is a
 * `web_fetch` result pasted into a later tool call ("ignore previous
 * instructions…") or a poisoned file read into `shell_exec`.
 */
export function createToolInjectionGuardrail(): GuardrailDefinition {
  return {
    id: 'tool-injection',
    layer: 'tool',
    description: 'Blocks prompt-injection markers inside tool arguments.',
    check(value) {
      const leaves: { jsonPath: string; key: string; text: string }[] = [];
      collectStringLeaves(value, '', leaves);
      const violations: GuardrailViolation[] = [];
      for (const leaf of leaves) {
        const found = scanPatterns(
          leaf.text,
          INJECTION_PATTERNS,
          'tool-injection',
          'tool',
          'block',
        );
        for (const v of found) {
          violations.push({
            ...v,
            reason: `Tool arg "${leaf.jsonPath}": ${v.reason}`,
          });
        }
      }
      return violations;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Default set                                                        */
/* ------------------------------------------------------------------ */

/**
 * The default guardrail set, in run order per layer:
 * - input:  prompt-injection (block), secret-input (warn)
 * - output: secret-output (block), pii (block)
 * - tool:   tool-path (block), tool-secret (block), tool-injection (block)
 *
 * Not included: `createScopeGuardrail` (opt-in — scope is per-bot)
 * and any model-based guardrail (not implemented yet; see
 * `createScopeGuardrail` docs).
 *
 * The coordinator wires these at the loop boundary (start/end of turn
 * + before each tool call) — see BEYOND-ROADMAP v0.10 items 5–6.
 */
export const BUILTIN_GUARDRAILS: GuardrailDefinition[] = [
  createPromptInjectionGuardrail(),
  createSecretGuardrail('input'),
  createSecretGuardrail('output'),
  createPiiGuardrail(),
  createToolPathGuardrail(),
  createToolSecretGuardrail(),
  createToolInjectionGuardrail(),
];

/** Re-exported for callers that only need the redact helpers. */
export { REDACTED };
