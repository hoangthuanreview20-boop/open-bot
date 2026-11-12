/**
 * PII/secret redaction for crash reports (v0.86, P2-7).
 *
 * A crash report must NEVER carry personal data: no user name, no home
 * directory path, no chat content, no API key / token. Everything the
 * collector records goes through `redactCrashText` first — message,
 * stack, and any file path inside them.
 *
 * Pure functions: no I/O, no logging. The home directory defaults to
 * `os.homedir()` when the caller does not pass one (tests pass a fake
 * home so the test never depends on the real machine).
 */

import * as os from 'node:os';
import { redactBearer, redactSecrets, REDACTED } from '../util/redact';

/** What a redacted home directory looks like inside a report. */
export const REDACTED_HOME = '<home>';
/** What a redacted user name looks like inside a report. */
export const REDACTED_USER = '<user>';

export interface RedactCrashOptions {
  /** Home directory to hide (default: `os.homedir()`). */
  homeDir?: string;
  /** User name to hide (default: `os.userInfo().username`, best-effort). */
  username?: string;
  /** Extra known secrets to blank out (exact match, via `redactSecrets`). */
  extraSecrets?: string[];
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact PII/secrets from free text before it is stored in a crash
 * report. Order matters: home dir first (it also hides the user name
 * inside the path), then the bare user name, then token shapes, then
 * known secrets.
 *
 * Patterns blanked out:
 *  - the home directory, in both `/home/<user>` and `C:\Users\<user>`
 *    spellings (and any path under it — the whole prefix is replaced,
 *    the tail stays, so `/home/x/project/a.ts` becomes
 *    `<home>/project/a.ts`: still useful for debugging, no PII);
 *  - the bare user name anywhere else (best-effort);
 *  - `Authorization: Bearer <token>` and bare `Bearer <token>`;
 *  - `sk-…` / `xai-…` / `sk-ant-…`-style keys (any run of 20+ token
 *    chars after a known key prefix);
 *  - `api_key` / `apikey` / `token` / `password` / `passwd` assignments
 *    (`key=value`, `key: value`, JSON `"key": "value"`);
 *  - long hex/base64-looking runs (32+ chars) that appear right after
 *    the word `key` or `secret`.
 *
 * Never throws: bad input returns the input (or '' for non-strings).
 */
export function redactCrashText(text: string, opts: RedactCrashOptions = {}): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;

  // 1. Home directory — every spelling of it.
  const home = opts.homeDir ?? safeHomedir();
  if (home) {
    // Windows home may be given with backslashes; the same path may
    // also appear with forward slashes in a stack trace.
    const variants = new Set<string>([home, home.replace(/\\/g, '/')]);
    // `C:\Users\name` → also hide the bare `C:/Users/name` form.
    for (const v of [...variants]) {
      if (v) out = out.split(v).join(REDACTED_HOME);
    }
    // Case-insensitive pass for the Windows form (drive letters and
    // user names are case-insensitive on Windows; a stack trace may
    // spell the path differently from os.homedir()).
    const lower = home.toLowerCase();
    if (lower !== home) {
      out = out.replace(new RegExp(escapeRegExp(lower), 'gi'), REDACTED_HOME);
    }
  }

  // 2. Bare user name (outside the home path, e.g. `user "huy"` in a
  // message, or a `~huy` expansion). Only when it is 2+ chars, and
  // only as a whole word, so common words are not mangled.
  const username = opts.username ?? safeUsername();
  if (username && username.length >= 2) {
    // `C:\Users\<name>` / `/Users/<name>` (macOS) is a home dir even
    // when os.homedir() reports a different (POSIX) spelling — hide
    // the whole prefix, not just the bare name.
    out = out.replace(
      new RegExp(`(?:[A-Za-z]:)?[\\\\/]Users[\\\\/]${escapeRegExp(username)}`, 'g'),
      REDACTED_HOME,
    );
    out = out.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, 'g'), REDACTED_USER);
  }

  // 3. Bearer tokens (header shape + bare shape).
  out = redactBearer(out);

  // 4. Key-like assignments: api_key=…, "apiKey": "…", token: …, password=…
  // The value is any run of non-space / non-quote / non-comma chars.
  out = out.replace(
    /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd)\b(\s*["']?\s*[:=]\s*["']?)([^\s"',}\]]+)/gi,
    (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  );

  // 5. Bare provider key shapes: sk-…, xai-…, sk-ant-… (20+ chars).
  out = out.replace(/\b(?:sk|sk-ant|xai)-[A-Za-z0-9_-]{16,}\b/g, REDACTED);

  // 6. Long standalone hex/base64 runs that look like a token (32+
  // chars, mixed case/digits) — only when they appear as a whole
  // token, so hashes in stack traces of *code* (short ids) survive.
  // This is deliberately narrow: a 64-hex git sha in a message is
  // not PII, but a 40-char bearer-style token is.
  out = out.replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, (m) => {
    // Keep it when it looks like a file hash the user pasted
    // deliberately (all hex, exactly 40/64 chars = sha1/sha256).
    if (/^[0-9a-f]{40}$/.test(m) || /^[0-9a-f]{64}$/.test(m)) return m;
    return REDACTED;
  });

  // 7. Caller-supplied known secrets (exact match).
  if (opts.extraSecrets && opts.extraSecrets.length > 0) {
    out = redactSecrets(out, opts.extraSecrets);
  }

  return out;
}

function safeHomedir(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

function safeUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}
