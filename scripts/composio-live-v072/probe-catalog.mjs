/**
 * Probe 1 — catalog endpoint behaviour (read-only).
 * Summarises GET /api/v3.1/tools with and without ?toolkit=:
 * response keys, item count, distinct toolkit slugs, whether any
 * GMAIL_/SLACK_/GITHUB_/NOTION_ slug appears, and whether the
 * filtered list differs from the unfiltered one.
 * Never prints the surrogate.
 */
const surrogate = process.env.COMPOSIO_KEY_SURROGATE ?? '';
if (!surrogate.startsWith('hsurr:')) {
  console.error('probe: no surrogate in env');
  process.exit(2);
}
const BASE = 'https://backend.composio.dev/api/v3.1';

async function getTools(params) {
  const qs = new URLSearchParams(params).toString();
  const t0 = Date.now();
  const res = await fetch(`${BASE}/tools?${qs}`, { headers: { 'x-api-key': surrogate } });
  const ms = Date.now() - t0;
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: res.status, ms, error: text.slice(0, 200) };
  }
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
  const toolkits = [...new Set(items.map((i) => i.toolkit?.slug ?? '?'))];
  const interesting = items
    .map((i) => i.slug ?? '')
    .filter((s) => /^(GMAIL|SLACK|GITHUB|NOTION)_/.test(s));
  return {
    status: res.status,
    ms,
    keys: Object.keys(data),
    totalField: data.total ?? null,
    nextCursor: data.next_cursor ?? null,
    count: items.length,
    toolkits: toolkits.slice(0, 10),
    firstSlugs: items.slice(0, 3).map((i) => i.slug),
    interesting: interesting.slice(0, 10),
  };
}

for (const label of ['none', 'slack', 'SLACK', 'gmail']) {
  const params = { limit: '100' };
  if (label !== 'none') params.toolkit = label;
  const r = await getTools(params);
  console.log(`toolkit=${label}: ${JSON.stringify(r)}`);
}
