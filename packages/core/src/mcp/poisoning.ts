/**
 * Tool description poisoning scanner (v0.97, Team T1).
 *
 * Background (repo survey §1): in 2026 several public MCP servers
 * were found with tool *descriptions* that carry attacks in the very
 * text the model reads — hidden instructions, override attempts,
 * exfiltration URLs. The description is trusted input to the model,
 * so a poisoned description can steer the agent even when the tool
 * code itself is harmless.
 *
 * This module scans tool descriptions (and, optionally, parameter
 * descriptions and prompt text) for suspicious patterns and scores
 * them. It never blocks by itself — the caller decides: the agent
 * registry flags the tool in the UI, the coordinator refuses to
 * auto-approve it, or the marketplace probe rejects the server.
 * Scoring is transparent: every finding names the rule, the matched
 * text, and the severity, so a false positive can be allow-listed
 * by rule instead of by silence.
 *
 * Rule families:
 *   - `instruction-override`: "ignore previous instructions",
 *     "disregard the system prompt", role-play / jailbreak openers.
 *   - `hidden-instruction`: imperatives aimed at the agent ("you
 *     must", "always send", "do not tell the user") in a description.
 *   - `exfiltration`: URLs, "send ... to ...", credential words
 *     near a network action.
 *   - `encoding`: long base64 blobs, invisible / bidi control
 *     characters, homoglyph-heavy text that hides content from
 *     human review.
 *   - `suspicious-url`: non-HTTPS URLs, URL shorteners, raw IPs,
 *     localhost / metadata endpoints in a description.
 *   - `overreach`: a read-only-looking tool whose description asks
 *     for destructive or credential-adjacent actions.
 *
 * False-positive care: ordinary documentation words ("ignore" in
 * "ignorecase", "send" in "send a message to the channel") are
 * handled by requiring the suspicious phrase to appear as a
 * standalone instruction (word boundaries + an imperative verb or
 * an agent-directed pronoun), and by scoring — a single low finding
 * is `info`, not a flag. The scanner reads text only; it never
 * executes anything and never follows URLs.
 */

export type PoisoningSeverity = 'info' | 'warning' | 'critical';

/** One scanner finding. */
export interface PoisoningFinding {
  /** Stable rule id, e.g. `instruction-override`. */
  rule: string;
  severity: PoisoningSeverity;
  /** Short explanation of what matched and why it matters. */
  message: string;
  /** The matched excerpt (truncated, for display — never the full description). */
  match: string;
}

/** Scan outcome for one description. */
export interface PoisoningScanResult {
  /** True when no warning or critical finding exists. */
  clean: boolean;
  /** 0..100; >= 70 is `critical`, >= 40 is `warning`, else `info`. */
  score: number;
  /** Overall verdict derived from the score. */
  verdict: 'clean' | 'suspicious' | 'poisoned';
  findings: PoisoningFinding[];
}

/** Scan outcome for a whole tool registry. */
export interface RegistryPoisoningReport {
  scanned: number;
  clean: number;
  suspicious: number;
  poisoned: number;
  /** Per-tool results, worst first. */
  tools: Array<{ name: string; result: PoisoningScanResult }>;
  generatedAtMs: number;
}

interface PoisoningRule {
  id: string;
  severity: PoisoningSeverity;
  /** Points added to the 0..100 score when the rule matches. */
  weight: number;
  message: string;
  pattern: RegExp;
}

const POISONING_RULES: readonly PoisoningRule[] = [
  {
    id: 'instruction-override',
    severity: 'critical',
    weight: 45,
    message: 'Description tries to override prior instructions or the system prompt.',
    pattern: /\b(ignore|disregard|override|forget|bypass)\b[^.]{0,60}\b(previous|prior|above|system|original|all)\b[^.]{0,40}\b(instructions?|prompt|rules?|guidelines?)\b/i,
  },
  {
    id: 'instruction-override-short',
    severity: 'critical',
    weight: 40,
    message: 'Description contains a direct instruction-override phrase.',
    pattern: /\b(ignore (all|the|any) instructions?|disregard (all|the) instructions?|new instructions?:|system prompt (says|is)|you are now|act as (a|an) (?!tool)\w+ (assistant|agent|admin|root)\b)/i,
  },
  {
    id: 'hidden-instruction-agent',
    severity: 'warning',
    weight: 25,
    message: 'Description gives the agent a direct imperative (do not tell the user / always do X).',
    pattern: /\b(you (must|should|have to|need to|will)|always (send|share|include|return|execute|run)|never (tell|mention|reveal|disclose|warn|ask)|do not (tell|mention|reveal|disclose|warn|ask|show) (the )?(user|anyone|operator))\b/i,
  },
  {
    id: 'hidden-instruction-secrecy',
    severity: 'warning',
    weight: 25,
    message: 'Description asks the agent to hide something from the user.',
    pattern: /\b(keep (this|it) (secret|hidden|private)|without (telling|notifying|asking) (the )?(user|anyone)|silently|in the background|do not (let|allow) (the )?user (know|see|notice))\b/i,
  },
  {
    id: 'exfiltration-send-to',
    severity: 'critical',
    weight: 40,
    message: 'Description tells the agent to send data somewhere.',
    pattern: /\b(send|upload|forward|exfiltrate|transmit|post|leak)\b[^.]{0,80}\b(to|at)\b[^.]{0,40}(https?:\/\/|www\.|\.com|\.net|\.io|webhook|endpoint|server|external)/i,
  },
  {
    id: 'credential-harvest',
    severity: 'critical',
    weight: 45,
    message: 'Description mentions credentials / secrets next to a network or send action.',
    pattern: /\b(password|api[_ -]?key|secret|token|credential|private[_ -]?key|auth)\b[^.]{0,80}\b(send|upload|post|share|include|return|expose|leak)\b/i,
  },
  {
    id: 'suspicious-url-shortener',
    severity: 'warning',
    weight: 20,
    message: 'Description contains a URL-shortener link.',
    pattern: /https?:\/\/(bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rebrand\.ly|shorturl\.at)\b/i,
  },
  {
    id: 'suspicious-url-ip',
    severity: 'warning',
    weight: 25,
    message: 'Description contains a raw IP or localhost URL.',
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/|$)/i,
  },
  {
    id: 'suspicious-url-non-https',
    severity: 'info',
    weight: 10,
    message: 'Description contains a plain-http URL.',
    pattern: /http:\/\/(?!localhost|127\.0\.0\.1)[\w.-]+\.[a-z]{2,}/i,
  },
  {
    id: 'suspicious-url-metadata',
    severity: 'critical',
    weight: 40,
    message: 'Description references a cloud metadata endpoint.',
    pattern: /169\.254\.169\.254|metadata\.google\.internal/i,
  },
  {
    id: 'encoding-base64-blob',
    severity: 'warning',
    weight: 25,
    message: 'Description contains a long base64-looking blob.',
    pattern: /[A-Za-z0-9+/]{80,}={0,2}/,
  },
  {
    id: 'encoding-invisible-chars',
    severity: 'warning',
    weight: 30,
    message: 'Description contains invisible / bidirectional control characters.',
    pattern: /[​‌‍⁠﻿‮‭‮⁦⁧⁨⁩]/,
  },
  {
    id: 'encoding-homoglyph',
    severity: 'info',
    weight: 10,
    message: 'Description contains Cyrillic / Greek look-alike letters mixed with Latin text.',
    pattern: /[а-яА-Яα-ωΑ-Ω]{3,}/,
  },
  {
    id: 'overreach-destructive',
    severity: 'warning',
    weight: 20,
    message: 'Description asks for a destructive action (delete / drop / format / shutdown).',
    pattern: /\b(delete|drop|remove|format|wipe|shutdown|destroy|kill)\b[^.]{0,40}\b(all|every|database|disk|files?|system|table)\b/i,
  },
  {
    id: 'overreach-shell',
    severity: 'warning',
    weight: 20,
    message: 'Description asks the agent to run a shell command.',
    pattern: /\b(run|execute|eval)\b[^.]{0,30}\b(shell|bash|sh|cmd|powershell|command)\b/i,
  },
  {
    id: 'prompt-injection-delimiter',
    severity: 'warning',
    weight: 25,
    message: 'Description contains prompt-injection delimiter markers.',
    pattern: /(?:\[SYSTEM\]|\[INST\]|<<SYS>>|<\|im_start\|>|<\|system\|>)/i,
  },
];

/** Rules the operator allow-listed (by id) — their findings are dropped. */
export type PoisoningAllowList = ReadonlySet<string>;

/**
 * Scan one description. Pure function: no I/O, no network, no
 * mutation of the input. The same text always yields the same
 * result, so scan outcomes are reproducible and testable.
 */
export function scanToolDescription(
  description: string,
  options: { allowList?: PoisoningAllowList } = {},
): PoisoningScanResult {
  const findings: PoisoningFinding[] = [];
  if (typeof description !== 'string' || description.length === 0) {
    return { clean: true, score: 0, verdict: 'clean', findings };
  }
  let score = 0;
  for (const rule of POISONING_RULES) {
    if (options.allowList?.has(rule.id)) continue;
    const match = rule.pattern.exec(description);
    if (!match) continue;
    score += rule.weight;
    findings.push({
      rule: rule.id,
      severity: rule.severity,
      message: rule.message,
      match: truncateMatch(match[0]),
    });
  }
  score = Math.min(100, score);
  const verdict: PoisoningScanResult['verdict'] =
    score >= 70 ? 'poisoned' : score >= 40 ? 'suspicious' : 'clean';
  return {
    clean: verdict === 'clean',
    score,
    verdict,
    findings: sortFindings(findings),
  };
}

function truncateMatch(text: string, maxChars = 80): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}

const SEVERITY_RANK: Record<PoisoningSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function sortFindings(findings: PoisoningFinding[]): PoisoningFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

/**
 * Scan a whole tool registry: every tool's description plus its
 * parameter descriptions. Returns a report sorted worst-first so
 * the operator sees the dangerous tools before the clean ones.
 * Tools without a description are reported clean (nothing to scan)
 * — absence of a description is a documentation gap, not poison.
 */
export function scanToolRegistry(
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    parameterDescriptions?: string[];
  }>,
  options: { allowList?: PoisoningAllowList } = {},
): RegistryPoisoningReport {
  const perTool: Array<{ name: string; result: PoisoningScanResult }> = [];
  for (const tool of tools) {
    const parts = [tool.description ?? '', ...(tool.parameterDescriptions ?? [])];
    const combined = parts.filter((p) => p.length > 0).join('\n');
    perTool.push({ name: tool.name, result: scanToolDescription(combined, options) });
  }
  perTool.sort((a, b) => b.result.score - a.result.score);
  let clean = 0;
  let suspicious = 0;
  let poisoned = 0;
  for (const entry of perTool) {
    if (entry.result.verdict === 'clean') clean += 1;
    else if (entry.result.verdict === 'suspicious') suspicious += 1;
    else poisoned += 1;
  }
  return {
    scanned: tools.length,
    clean,
    suspicious,
    poisoned,
    tools: perTool,
    generatedAtMs: Date.now(),
  };
}

/** One-line summary of a scan result, for logs and tool output. */
export function formatPoisoningSummary(result: PoisoningScanResult): string {
  if (result.verdict === 'clean') return 'clean (no suspicious pattern)';
  const worst = result.findings[0];
  return (
    `${result.verdict} (score ${result.score}): ` +
    result.findings.map((f) => `${f.rule} [${f.severity}]`).join('; ') +
    (worst ? ` — worst: ${worst.message}` : '')
  );
}
