/**
 * HTTP tool for @open-bot/tools (v0.89, worker F4 — builtin tools giá trị cao).
 *
 *   http_request — GET / POST / PUT / DELETE to a public HTTP(S) URL
 *     with an optional body and headers. Read-only GETs are covered by
 *     the older `http_get` (no approval); this tool also does writes,
 *     so it is approval-gated as a whole — the `needsApproval` flag is
 *     per-tool, not per-method, so a single tool cannot gate only its
 *     non-GET calls. The agent loop asks the user before any call, and
 *     the description states that POST / PUT / DELETE mutate remote
 *     state and must be approved.
 *
 * Egress — uses the repo's own egress mechanism, never a home-grown
 * allowlist (see `packages/core/src/egress/policy.ts` and
 * `packages/tools/src/ssrf.ts`):
 *  - when the host passes `getEgressPolicy` (team policy, resolved
 *    lazily per call — same pattern as `createShellExecTool` in
 *    tools.ts), the URL is checked with `assertEgressUrl` (allowlist
 *    mode, fail-closed, no policy = blocked);
 *  - otherwise it falls back to the SSRF guard `assertPublicUrl`
 *    (allow-public: every destination must resolve to a public IP —
 *    localhost / private LAN / cloud metadata are blocked, exactly
 *    like `web_fetch` / `http_get`).
 * Every redirect hop (max 5) is re-checked the same way, so a
 * redirect cannot smuggle the request to an internal host.
 *
 * Credentials: NO credential is sent by default. `Authorization` /
 * `Cookie` / `Proxy-Authorization` request headers are dropped, and
 * `set-cookie` response headers are never returned. An `Authorization`
 * header is sent ONLY when the host explicitly configured one via
 * `opts.getAuthorization` (e.g. a Vault-backed resolver the user set
 * up) — the tool never reads the Vault or env itself and never logs
 * the value.
 *
 * Limits: 30s timeout, request body max 1 MB, response body read max
 * 1 MB (cut with a note), result truncated to MAX_TOOL_RESULT_CHARS.
 *
 * Factory (same pattern as the other tool groups):
 *   createHttpTools(opts?) -> Tool[]   (bound, usable)
 *   HTTP_TOOLS                         (unbound placeholders)
 *
 * The fetch implementation is injectable (`opts.fetchFn`, default
 * global fetch) so tests need no live network.
 */
import type { Tool } from '@open-bot/core';
import type { EgressPolicy } from '@open-bot/core/dist/egress/policy';
import { assertEgressUrl, assertPublicUrl } from './ssrf';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

/** Hard timeout for one http_request call (all hops share it): 30s. */
export const HTTP_REQUEST_TIMEOUT_MS = 30_000;
/** Max request body and max response body read: 1 MB. */
export const MAX_HTTP_BODY_BYTES = 1_000_000;
/** Max redirects followed (each hop re-checked against egress): 5. */
export const MAX_HTTP_REDIRECTS = 5;

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
export type HttpRequestMethod = (typeof ALLOWED_METHODS)[number];

/** Request headers that are never sent (they carry credentials or routing). */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'set-cookie',
  'upgrade',
]);

/** Response headers never shown to the agent (they carry credentials). */
const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie']);

export interface HttpToolOptions {
  /** Fetch implementation (tests inject a mock; default global fetch). */
  fetchFn?: typeof fetch;
  /**
   * Lazily resolve the egress policy in force (team policy). When
   * absent, the SSRF guard (`assertPublicUrl`) is used instead.
   * Returning `undefined` = no policy resolver; `null` = policy
   * explicitly off -> fail-closed (blocked).
   */
  getEgressPolicy?: () => EgressPolicy | null | undefined;
  /** DNS lookup (tests inject a fake; default real DNS via ssrf). */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /**
   * Explicitly user-configured Authorization value (e.g. resolved by
   * the host from the Vault). Absent = no Authorization header is
   * ever sent. The value is never logged.
   */
  getAuthorization?: () => string | undefined;
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

/** Check one URL against egress (policy when configured, SSRF guard otherwise). */
async function assertUrlAllowed(
  url: URL,
  opts: HttpToolOptions,
): Promise<void> {
  const policy = opts.getEgressPolicy?.();
  if (opts.getEgressPolicy !== undefined) {
    // Resolver present (even when it returns undefined/null): the
    // egress policy path decides — null/undefined policy = fail-closed.
    await assertEgressUrl(url, policy ?? null, { lookupFn: opts.lookupFn });
    return;
  }
  await assertPublicUrl(url, { lookupFn: opts.lookupFn });
}

/**
 * One http_request call. Exported for tests: `fetchFn` and egress are
 * injected through `opts`, so no live network is needed.
 */
export async function doHttpRequest(
  args: Record<string, unknown>,
  opts: HttpToolOptions = {},
): Promise<string> {
  const methodRaw = args['method'] === undefined ? 'GET' : getStringArg(args, 'method', false);
  const method = methodRaw.toUpperCase();
  if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
    return errorResult(
      `Method "${methodRaw}" is not allowed. Allowed methods: ${ALLOWED_METHODS.join(', ')}.`,
    );
  }
  const rawUrl = getStringArg(args, 'url');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return errorResult(`Invalid URL: "${rawUrl}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return errorResult(`Only http:// and https:// URLs are allowed, got "${url.protocol}"`);
  }

  const body = args['body'] === undefined ? undefined : getStringArg(args, 'body', false);
  if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_HTTP_BODY_BYTES) {
    return errorResult(
      `Request body is ${Buffer.byteLength(body, 'utf8')} bytes, over the ${MAX_HTTP_BODY_BYTES} byte limit.`,
    );
  }
  if (body !== undefined && method === 'GET') {
    return errorResult('GET requests do not take a body; use POST, PUT or DELETE.');
  }

  // Headers: user-supplied, minus forbidden ones; Authorization only
  // from an explicitly configured resolver, never from args.
  const headers: Record<string, string> = {};
  const rawHeaders = args['headers'];
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      return errorResult('Argument "headers" must be an object of string values.');
    }
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        return errorResult(`Header "${name}" must be a string, got ${typeof value}`);
      }
      if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
  }
  const configuredAuth = opts.getAuthorization?.();
  if (configuredAuth !== undefined && configuredAuth !== '') {
    headers['Authorization'] = configuredAuth;
  }
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const deadline = Date.now() + HTTP_REQUEST_TIMEOUT_MS;
  let currentUrl = url;
  try {
    for (let hop = 0; hop <= MAX_HTTP_REDIRECTS; hop += 1) {
      await assertUrlAllowed(currentUrl, opts);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms: ${currentUrl}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let res: Response;
      try {
        res = await fetchFn(currentUrl.toString(), {
          method,
          headers,
          body: hop === 0 ? body : undefined,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw new Error(`Request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms: ${currentUrl}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      const location = res.headers?.get?.('location') ?? null;
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === MAX_HTTP_REDIRECTS) {
          return errorResult(`Too many redirects (>${MAX_HTTP_REDIRECTS}) when requesting ${currentUrl}`);
        }
        // Redirects drop the body (same as browsers for 301/302/303;
        // 307/308 keep it, but re-sending a mutating body to a new
        // host is riskier than losing it — the agent can re-issue).
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      const headerLines: string[] = [];
      try {
        res.headers?.forEach?.((value: string, name: string) => {
          if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            headerLines.push(`${name}: ${value}`);
          }
        });
      } catch {
        // Mocked / non-standard headers object — skip the listing.
      }
      const rawBody = await res.text();
      let bodyText = rawBody;
      let bodyNote = '';
      if (Buffer.byteLength(rawBody, 'utf8') > MAX_HTTP_BODY_BYTES) {
        bodyText = Buffer.from(rawBody, 'utf8').subarray(0, MAX_HTTP_BODY_BYTES).toString('utf8');
        bodyNote = `\n[... response body cut at ${MAX_HTTP_BODY_BYTES} bytes ...]`;
      }
      const out = [
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} ${method} ${currentUrl}`,
        '--- headers ---',
        headerLines.length > 0 ? headerLines.join('\n') : '(no headers)',
        '--- body ---',
        bodyText + bodyNote,
      ].join('\n');
      return truncate(out, MAX_TOOL_RESULT_CHARS);
    }
    return errorResult(`Too many redirects (>${MAX_HTTP_REDIRECTS}) when requesting ${url}`);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

export function createHttpTools(opts: HttpToolOptions = {}): Tool[] {
  const httpRequestTool: Tool = {
    definition: {
      name: 'http_request',
      description:
        'Make an HTTP request (GET/POST/PUT/DELETE) to a public http(s) URL and return status + headers + body. POST/PUT/DELETE mutate remote state and require approval (this tool is approval-gated; read-only GETs can use http_get instead). Egress allowlist/SSRF rules apply (internal hosts blocked, redirects re-checked). No credentials are sent unless the user explicitly configured an Authorization value. Timeout 30s, body max 1 MB.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL to request.' },
          method: {
            type: 'string',
            description: 'HTTP method: GET (default), POST, PUT or DELETE.',
          },
          body: { type: 'string', description: 'Request body (POST/PUT/DELETE only, max 1 MB).' },
          headers: {
            type: 'object',
            description: 'Extra request headers. Authorization/Cookie are never sent from here.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    // Static per-tool flag (see header): the whole tool is gated so
    // non-GET calls can never slip through without approval.
    needsApproval: true,
    async execute(args) {
      try {
        return await doHttpRequest(args, opts);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
  return [httpRequestTool];
}

export const HTTP_TOOLS: Tool[] = createHttpTools();
