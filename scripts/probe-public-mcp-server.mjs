/**
 * Manual probe of PUBLIC, no-auth MCP servers over streamable HTTP
 * with the repo's real client (`StreamableHttpMcpClient`).
 *
 * v0.71 milestone 2 — MCP marketplace: first probe of real public
 * servers (before this, the HTTP probe was only tested against the
 * local fake server in tests/mcp-marketplace-probe-fake-http-server.mjs).
 *
 * This is a MANUAL script, NOT a test in the suite: it hits the live
 * internet, so it must never run in CI / `npm test` (flaky + slow).
 *
 * What it does per server (read-only):
 *   1. `new StreamableHttpMcpClient({ name, url })` — no headers,
 *      no authProvider, no credential of any kind.
 *   2. `initialize()` (timed) — records serverInfo name/version and
 *      the negotiated protocol version.
 *   3. `listTools()` (timed) — records tool names (+ first line of
 *      each description). NEVER calls a tool.
 *   4. `close()` in a finally block.
 *
 * On failure it also does ONE diagnostic raw GET of the endpoint URL
 * (no auth, no body) and records only the HTTP status + content-type
 * — just enough to tell "endpoint moved / dead" apart from "server
 * rejected the MCP handshake". No response body is logged (it could
 * contain anything).
 *
 * Usage:
 *   npm run build --workspace=@open-bot/core   # dist must be fresh
 *   node scripts/probe-public-mcp-server.mjs [name ...]
 *   # with no args: probe every candidate below, sequentially.
 *   # with args: probe only the named candidates, e.g.
 *   node scripts/probe-public-mcp-server.mjs deepwiki context7
 *
 * Output: one JSON object per server on stdout (machine-readable) +
 * a human summary on stderr. Exit code 0 even when some servers fail
 * (a failing public server is a finding, not a script error); exit 1
 * only when the script itself cannot run (e.g. dist missing).
 *
 * SAFETY: no key/token/secret is ever sent or logged. The candidates
 * below are public endpoints documented as no-auth in November 2026
 * (see docs/mcp-marketplace-real-probe.md for sources). If a server
 * starts demanding auth (HTTP 401) the client reports it and the
 * script moves on — it never retries with a credential.
 */
import { StreamableHttpMcpClient } from '../packages/core/dist/mcp/client.js';

/**
 * Candidates: public MCP servers documented as no-auth / no-signup.
 * Sources (checked 2026-11-10): freeapi.watch/free-mcp-servers
 * (hourly-monitored, "last verified November 2026"), the vendors'
 * own docs (docs.devin.ai DeepWiki MCP), and independent write-ups
 * (octomind.run, continuumcode.ai, chatforest.com for GitMCP).
 *
 * Notes per candidate:
 *  - deepwiki-sse is the LEGACY SSE transport. The repo client does
 *    NOT support legacy SSE (see client.ts header: "The legacy SSE
 *    transport ... is NOT supported"), so it is expected to fail —
 *    it is probed once only to document that gap with evidence.
 *  - edgeone is the only write-capable server on the list (deploys
 *    HTML to a public URL). We only ever call tools/list, never a
 *    tool, so nothing is deployed.
 *  - gitmcp is per-repo: one well-known public repo is used
 *    (modelcontextprotocol/typescript-sdk). The dynamic endpoint
 *    https://gitmcp.io/docs is NOT probed (same service, same code).
 */
const CANDIDATES = [
  {
    id: 'ms-learn',
    name: 'Microsoft Learn MCP',
    url: 'https://learn.microsoft.com/api/mcp',
    vendor: 'Microsoft',
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs MCP',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    vendor: 'Cloudflare',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki MCP (streamable HTTP)',
    url: 'https://mcp.deepwiki.com/mcp',
    vendor: 'Cognition (Devin)',
  },
  {
    id: 'deepwiki-sse',
    name: 'DeepWiki MCP (legacy SSE)',
    url: 'https://mcp.deepwiki.com/sse',
    vendor: 'Cognition (Devin)',
    expectFail: 'legacy SSE transport is not supported by StreamableHttpMcpClient',
  },
  {
    id: 'context7',
    name: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    vendor: 'Upstash',
    note: 'works without a key at low volume per Oct 2026 write-ups; one report says HTTP may require a credential since 4.2.0 — probe decides',
  },
  {
    id: 'gitmcp',
    name: 'GitMCP (modelcontextprotocol/typescript-sdk)',
    url: 'https://gitmcp.io/modelcontextprotocol/typescript-sdk',
    vendor: 'idosal/git-mcp (community)',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face MCP',
    url: 'https://hf.co/mcp',
    vendor: 'Hugging Face',
  },
  {
    id: 'astro-docs',
    name: 'Astro Docs MCP',
    url: 'https://mcp.docs.astro.build/mcp',
    vendor: 'Astro',
  },
  {
    id: 'edgeone',
    name: 'EdgeOne Pages MCP',
    url: 'https://mcp-on-edge.edgeone.site/mcp-server',
    vendor: 'Tencent EdgeOne',
    note: 'write-capable (deploys HTML); probe only ever calls tools/list, never a tool',
  },
];

const PER_STEP_TIMEOUT_MS = 30_000;
const PER_SERVER_TIMEOUT_MS = 75_000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms waiting for ${what}`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function diagnosticGet(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/event-stream' },
      signal: AbortSignal.timeout(15_000),
    });
    // Drain + discard the body so the connection closes; never log it.
    await res.text().catch(() => undefined);
    return { status: res.status, contentType: res.headers.get('content-type') ?? '' };
  } catch (err) {
    return { status: null, error: err.message };
  }
}

async function probeOne(candidate) {
  const startedAt = Date.now();
  const result = {
    id: candidate.id,
    name: candidate.name,
    vendor: candidate.vendor,
    url: candidate.url,
    transport: 'streamable-http',
    ok: false,
    initializeMs: null,
    toolsListMs: null,
    totalMs: null,
    serverInfo: null,
    negotiatedProtocolVersion: null,
    tools: [],
    error: null,
    diagnosticGet: null,
  };
  const client = new StreamableHttpMcpClient({ name: candidate.id, url: candidate.url });
  try {
    await withTimeout(
      (async () => {
        const t0 = Date.now();
        const info = await client.initialize();
        result.initializeMs = Date.now() - t0;
        result.serverInfo = info;
        result.negotiatedProtocolVersion = client.negotiatedProtocolVersion ?? null;
        const t1 = Date.now();
        const tools = await client.listTools();
        result.toolsListMs = Date.now() - t1;
        result.tools = tools.map((t) => ({
          name: t.name,
          description:
            typeof t.description === 'string'
              ? t.description.slice(0, 160)
              : undefined,
        }));
        result.ok = true;
      })(),
      PER_SERVER_TIMEOUT_MS,
      `probe of ${candidate.id}`,
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.diagnosticGet = await diagnosticGet(candidate.url);
  } finally {
    await client.close().catch(() => undefined);
  }
  result.totalMs = Date.now() - startedAt;
  return result;
}

async function main() {
  const wanted = process.argv.slice(2);
  const selected = wanted.length
    ? CANDIDATES.filter((c) => wanted.includes(c.id))
    : CANDIDATES;
  const unknown = wanted.filter((w) => !CANDIDATES.some((c) => c.id === w));
  if (unknown.length) {
    console.error(`Unknown candidate id(s): ${unknown.join(', ')}`);
    console.error(`Known ids: ${CANDIDATES.map((c) => c.id).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const t0 = Date.now();
  const results = [];
  for (const candidate of selected) {
    console.error(`Probing ${candidate.id} — ${candidate.url} ...`);
    // Sequential on purpose: one public server at a time, no hammering.
    // eslint-disable-next-line no-await-in-loop
    const result = await probeOne(candidate);
    results.push(result);
    console.log(JSON.stringify(result));
    console.error(
      `  -> ${result.ok ? `OK ${result.tools.length} tool(s)` : `FAIL: ${result.error}`} ` +
        `(${result.totalMs}ms)`,
    );
  }
  const okCount = results.filter((r) => r.ok).length;
  console.error(
    `\nSummary: ${okCount}/${results.length} servers answered initialize + tools/list ` +
      `in ${Date.now() - t0}ms total. No credential was sent to any server.`,
  );
}

await main();
