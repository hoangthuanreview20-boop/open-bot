/**
 * Live probes (v0.98, Đội T5 — voice live).
 *
 * The key gate (`keyGate.ts`) answers "is a key configured?" from
 * local state. These probes answer the next question — "is the
 * live path actually reachable from this machine?" — without ever
 * sending a key anywhere:
 *
 *   1. `probeHttpsEndpoint()` — an unauthenticated GET at the
 *      provider's REST base (Gemini `/v1beta/models`, OpenAI
 *      `/v1/realtime`). No key is attached, so the server answers
 *      400/401/405 — any HTTP response proves DNS + TLS + the
 *      endpoint is up, and the round-trip is the latency. A
 *      network error / timeout proves the opposite. The probe
 *      sends nothing secret and reads only the status code.
 *   2. `probeGeminiConnectorModels()` — runs the already-connected
 *      Gemini connector helper (`gemini.py list-models`, which
 *      carries the registered credential through the connector's
 *      own surrogate flow — the key never touches a file, an
 *      argument or a log) and reports which models this key can
 *      actually call, in particular the Live API models
 *      (`bidiGenerateContent` in `supportedGenerationMethods` or
 *      a `*-live-*` / `*-native-audio*` id). This is the only
 *      probe that uses the real key, and it does so through the
 *      connector the user already connected — the same path the
 *      2026-11-09 live test used.
 *   3. `probeGeminiLiveReadiness()` — both together: key valid
 *      for Live models + endpoint reachable = the Gemini Live
 *      adapter has a real live path. Anything less is reported
 *      honestly (which half failed, and why).
 *   4. `probeLocalProxy()` — the local Gemini REST proxy
 *      (`gemini_proxy.py`, 127.0.0.1:8765) answers GET `/` with
 *      `{"ok": true}`; the probe reports whether it is up and how
 *      fast, so the app can say whether the "via-proxy" provider
 *      path is alive. Loopback only — never a remote host.
 *
 * Every probe is injectable (`fetchImpl`, `runner`) so tests run
 * them deterministically with fakes; the live runs in
 * `tests/voice-live-v098.test.mjs` use the real network/helper
 * and assert only the shape, logging the measured numbers.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { isGeminiLiveModel } from './keyGate';

/** Default probe timeout (ms). */
export const LIVE_PROBE_TIMEOUT_MS = 10_000;
/** Default Gemini connector helper (the registered custom.gemini helper). */
export const GEMINI_CONNECTOR_HELPER_RELATIVE = path.join(
  'workspace',
  'custom-connectors',
  'custom.gemini',
  'bin',
  'gemini.py',
);
/** Default local Gemini REST proxy port (gemini_proxy.py). */
export const GEMINI_LOCAL_PROXY_PORT = 8765;

// ---------------------------------------------------------------------------
// 1. Unauthenticated endpoint probe (no key sent, ever)
// ---------------------------------------------------------------------------

/** Gemini REST base, probed without a key (GET → 400 without ?key=). */
export const GEMINI_ENDPOINT_PROBE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
/** OpenAI Realtime base, probed without a key (GET → 401/405). */
export const OPENAI_ENDPOINT_PROBE_URL = 'https://api.openai.com/v1/realtime';

/** One endpoint probe result. */
export interface EndpointProbeResult {
  /** URL probed (no key in it — ever). */
  url: string;
  /** True when the server answered with any HTTP status. */
  reachable: boolean;
  /** HTTP status when the server answered, else null. */
  statusCode: number | null;
  /** Round-trip time (ms), -1 when nothing answered. */
  latencyMs: number;
  /** Plain-language failure when not reachable ('' when reachable). */
  error: string;
  /** When the probe ran (wall clock). */
  at: number;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ status: number }>;

/** Default fetch: the global fetch, when the runtime has one. */
function defaultFetch(url: string, init?: { signal?: AbortSignal }): Promise<{ status: number }> {
  const fetchFn = (globalThis as { fetch?: FetchLike }).fetch;
  if (!fetchFn) {
    return Promise.reject(new Error('probeHttpsEndpoint: no fetch available in this runtime.'));
  }
  return fetchFn(url, init);
}

/**
 * GET `url` with no credentials and a timeout. Any HTTP response
 * (even 400/401/405 — the server *refusing* an unauthenticated
 * request) counts as reachable: it proves DNS + TLS + the
 * endpoint. A thrown error / abort counts as unreachable, with
 * the reason kept (never a key — none was sent).
 */
export async function probeHttpsEndpoint(
  url: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<EndpointProbeResult> {
  const at = Date.now();
  const timeoutMs = Math.max(100, options.timeoutMs ?? LIVE_PROBE_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    return {
      url,
      reachable: true,
      statusCode: res.status,
      latencyMs: Date.now() - started,
      error: '',
      at,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut =
      message.toLowerCase().includes('abort') || message.toLowerCase().includes('timeout');
    return {
      url,
      reachable: false,
      statusCode: null,
      latencyMs: -1,
      error: timedOut
        ? `No answer from ${url} within ${timeoutMs}ms (network or endpoint down).`
        : `Could not reach ${url}: ${message.slice(0, 200)}`,
      at,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe both realtime endpoints (Gemini + OpenAI) in parallel. */
export async function probeRealtimeEndpoints(
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{ gemini: EndpointProbeResult; openai: EndpointProbeResult }> {
  const [gemini, openai] = await Promise.all([
    probeHttpsEndpoint(GEMINI_ENDPOINT_PROBE_URL, options),
    probeHttpsEndpoint(OPENAI_ENDPOINT_PROBE_URL, options),
  ]);
  return { gemini, openai };
}

// ---------------------------------------------------------------------------
// 2. Gemini connector probe (key via the connector, never via a file)
// ---------------------------------------------------------------------------

/** One model as the connector's `list-models` reports it. */
export interface GeminiConnectorModel {
  name: string;
  /** Model id without the `models/` prefix. */
  id: string;
  /** Generation methods the key may call on this model. */
  supportedGenerationMethods: string[];
  /** True when this model can serve the Live API. */
  liveCapable: boolean;
}

/** Result of probing the Gemini connector for Live-capable models. */
export interface GeminiConnectorProbeResult {
  /** True when the helper ran and returned a model list. */
  available: boolean;
  /** Live-capable models this key can call (may be empty). */
  liveModels: GeminiConnectorModel[];
  /** All models returned (ids only — the report stays small). */
  modelIds: string[];
  /** How long the helper took (ms). */
  latencyMs: number;
  /** Plain-language failure when unavailable ('' when available). */
  error: string;
  /** When the probe ran (wall clock). */
  at: number;
}

/** Runner type for the connector helper (injectable in tests). */
export type ConnectorRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

function defaultConnectorRunner(
  argv: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let child;
    try {
      child = execFile(argv[0] as string, argv.slice(1), { timeout: timeoutMs });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Parse the `gemini.py list-models` stdout. The helper prints one
 * model per line in plain text —
 *   `models/gemini-2.5-flash | generateContent, countTokens, …`
 * — plus a `(<n> models, HTTP <status>)` footer; older / other
 * helpers may print one JSON object per model (or a JSON array).
 * Both shapes parse; lines that are neither are ignored. A model
 * is live-capable when its id matches the Live pattern or its
 * methods include `bidiGenerateContent`.
 */
export function parseGeminiListModels(stdout: string): GeminiConnectorModel[] {
  const models: GeminiConnectorModel[] = [];
  const seen = new Set<string>();
  const chunks: unknown[] = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Plain-text shape: `models/<id> | method, method, …`.
    const textMatch = trimmed.match(/^(models\/[A-Za-z0-9._-]+)\s*\|\s*(.*)$/);
    if (textMatch) {
      const name = textMatch[1] as string;
      const methods = (textMatch[2] as string)
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
      pushModel(models, seen, name, methods);
      continue;
    }
    try {
      chunks.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Not JSON on this line — the helper also prints progress text.
    }
  }
  const flat: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    if (Array.isArray(chunk)) {
      for (const item of chunk) {
        if (item && typeof item === 'object') flat.push(item as Record<string, unknown>);
      }
    } else if (chunk && typeof chunk === 'object') {
      flat.push(chunk as Record<string, unknown>);
    }
  }
  for (const item of flat) {
    const name = typeof item.name === 'string' ? item.name : '';
    if (!name) continue;
    const methods = Array.isArray(item.supportedGenerationMethods)
      ? (item.supportedGenerationMethods as unknown[]).filter(
          (m): m is string => typeof m === 'string',
        )
      : [];
    pushModel(models, seen, name, methods);
  }
  return models;
}

/** Add one model to the list (dedupe by id). */
function pushModel(
  models: GeminiConnectorModel[],
  seen: Set<string>,
  name: string,
  methods: string[],
): void {
  const id = name.replace(/^models\//, '');
  if (!id || seen.has(id)) return;
  seen.add(id);
  models.push({
    name,
    id,
    supportedGenerationMethods: methods,
    liveCapable: isGeminiLiveModel(id) || methods.includes('bidiGenerateContent'),
  });
}

/**
 * Run `gemini.py list-models` through the connector and report
 * the Live-capable models. The helper path defaults to the
 * registered connector helper under $HOME; main passes its own
 * path explicitly. The key is carried by the connector's own
 * surrogate flow — this function never sees, passes or logs it.
 */
export async function probeGeminiConnectorModels(
  options: {
    helperPath?: string;
    runner?: ConnectorRunner;
    timeoutMs?: number;
  } = {},
): Promise<GeminiConnectorProbeResult> {
  const at = Date.now();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000);
  const helperPath =
    options.helperPath ??
    path.join(process.env.HOME ?? '', GEMINI_CONNECTOR_HELPER_RELATIVE);
  const runner = options.runner ?? defaultConnectorRunner;
  const started = Date.now();
  let out: { stdout: string; stderr: string; code: number | null };
  try {
    out = await runner(['python3', helperPath, 'list-models'], timeoutMs);
  } catch (err) {
    return {
      available: false,
      liveModels: [],
      modelIds: [],
      latencyMs: Date.now() - started,
      error: `Gemini connector helper could not run: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      at,
    };
  }
  const latencyMs = Date.now() - started;
  if (out.code !== 0) {
    return {
      available: false,
      liveModels: [],
      modelIds: [],
      latencyMs,
      error:
        `Gemini connector helper exited with code ${out.code ?? 'unknown'}` +
        (out.stderr ? `: ${out.stderr.slice(0, 200)}` : ' — the Gemini connection may need reconnecting.'),
      at,
    };
  }
  const models = parseGeminiListModels(out.stdout);
  if (models.length === 0) {
    return {
      available: false,
      liveModels: [],
      modelIds: [],
      latencyMs,
      error: 'Gemini connector helper returned no models — the key may have no model access.',
      at,
    };
  }
  return {
    available: true,
    liveModels: models.filter((m) => m.liveCapable),
    modelIds: models.map((m) => m.id),
    latencyMs,
    error: '',
    at,
  };
}

// ---------------------------------------------------------------------------
// 3. Combined Gemini Live readiness
// ---------------------------------------------------------------------------

/** Combined readiness for the Gemini Live adapter. */
export interface GeminiLiveReadiness {
  /** True when a Live model is callable AND the endpoint answers. */
  liveReady: boolean;
  /** Live-capable models the connector key can call. */
  liveModels: GeminiConnectorModel[];
  /** The endpoint probe (reachable = DNS/TLS/endpoint up). */
  endpoint: EndpointProbeResult;
  /** The connector probe (key valid + models listed). */
  connector: GeminiConnectorProbeResult;
  /** One-line verdict for the UI / diagnostics. */
  detail: string;
  /** When the check ran (wall clock). */
  at: number;
}

/**
 * Check Gemini Live readiness end to end: connector models +
 * endpoint reachability. Both halves are reported even when one
 * fails, so the UI can say exactly which half is missing.
 */
export async function probeGeminiLiveReadiness(
  options: {
    helperPath?: string;
    runner?: ConnectorRunner;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<GeminiLiveReadiness> {
  const at = Date.now();
  const [connector, endpoint] = await Promise.all([
    probeGeminiConnectorModels(options),
    probeHttpsEndpoint(GEMINI_ENDPOINT_PROBE_URL, options),
  ]);
  const liveReady =
    connector.available && connector.liveModels.length > 0 && endpoint.reachable;
  let detail: string;
  if (liveReady) {
    detail =
      `Gemini Live is ready: ${connector.liveModels.length} live model(s) callable ` +
      `(${connector.liveModels.map((m) => m.id).join(', ')}) and the endpoint answers in ${endpoint.latencyMs}ms.`;
  } else if (!connector.available) {
    detail = `Gemini Live is NOT ready — connector check failed: ${connector.error}`;
  } else if (connector.liveModels.length === 0) {
    detail =
      'Gemini Live is NOT ready — the key lists models, but none is Live-capable ' +
      '(no *-live-* / *-native-audio* model, no bidiGenerateContent method).';
  } else {
    detail = `Gemini Live is NOT ready — endpoint unreachable: ${endpoint.error}`;
  }
  return { liveReady, liveModels: connector.liveModels, endpoint, connector, detail, at };
}

// ---------------------------------------------------------------------------
// 4. Local Gemini REST proxy probe (loopback only)
// ---------------------------------------------------------------------------

/** Result of probing the local Gemini REST proxy. */
export interface LocalProxyProbeResult {
  /** True when the proxy answered GET / with HTTP 200. */
  up: boolean;
  /** Port probed. */
  port: number;
  /** Round-trip time (ms), -1 when down. */
  latencyMs: number;
  /** Plain-language failure when down ('' when up). */
  error: string;
  /** When the probe ran (wall clock). */
  at: number;
}

/**
 * Probe the local Gemini REST proxy (`gemini_proxy.py`) on
 * 127.0.0.1. GET `/` answers `{"ok": true}` when it is up. The
 * probe never leaves loopback and never sends a key.
 */
export async function probeLocalProxy(
  options: { port?: number; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<LocalProxyProbeResult> {
  const at = Date.now();
  const port = options.port ?? GEMINI_LOCAL_PROXY_PORT;
  const url = `http://127.0.0.1:${port}/`;
  const started = Date.now();
  const probe = await probeHttpsEndpoint(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 3000,
  });
  if (probe.reachable && probe.statusCode === 200) {
    return { up: true, port, latencyMs: Date.now() - started, error: '', at };
  }
  return {
    up: false,
    port,
    latencyMs: -1,
    error: probe.reachable
      ? `Local Gemini proxy answered HTTP ${probe.statusCode ?? '?'} (expected 200).`
      : `Local Gemini proxy is not running on 127.0.0.1:${port} — start gemini_proxy.py first.`,
    at,
  };
}
