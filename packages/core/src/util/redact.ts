/**
 * Secret redaction for logs and error messages (v0.5, ROADMAP §2d:
 * "Không bao giờ log token").
 *
 * Pure functions: no file/env access, no logging. Apply them to ANY
 * string before it reaches a log line, an error surfaced to the UI,
 * or an IPC payload that might be logged downstream:
 *
 *   console.error('[open-bot] ...', redactBearer(redactSecrets(msg, knownSecrets)));
 *
 * Known secrets (API keys, tokens just created, …) go through
 * `redactSecrets`; `redactBearer` catches `Authorization: Bearer …`
 * shapes even when the exact token value is not known.
 */

/** What a redacted secret looks like in output. */
export const REDACTED = '<redacted>';

/**
 * Replace every occurrence of every secret in `secrets` inside `text`
 * with `'<redacted>'`. Matching is literal (no regex), so secrets
 * containing regex characters are handled correctly.
 *
 * Secrets shorter than 4 characters (or empty / non-string) are
 * SKIPPED: redacting a 1–3 char string would mangle ordinary words
 * ("a", "key", "sk") and a short match is not a secret anyway.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!Array.isArray(secrets) || secrets.length === 0) return text;
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Replace `Bearer <token>` occurrences with `Bearer <redacted>`.
 * Matches the header shape `Authorization: Bearer <token>` as well as
 * a bare `Bearer <token>` inside a message. The token is any run of
 * non-whitespace characters (covers base64, JWT `a.b.c`, `sk-…`,
 * `xai-…`); the word `Bearer` itself is kept so the reader still sees
 * that an auth header was present. Case-insensitive (`bearer` too).
 */
export function redactBearer(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`);
}
