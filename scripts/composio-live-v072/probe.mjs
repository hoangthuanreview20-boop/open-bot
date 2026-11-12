/**
 * Probe 0 — does Sentinel swap the surrogate for Node fetch?
 *
 * GET https://backend.composio.dev/api/v3.1/tools?limit=1 with
 * x-api-key = surrogate from env. Prints only status + first slug.
 * Never prints the surrogate.
 */
const surrogate = process.env.COMPOSIO_KEY_SURROGATE ?? '';
if (!surrogate.startsWith('hsurr:')) {
  console.error('probe: no surrogate in env');
  process.exit(2);
}
const t0 = Date.now();
const res = await fetch('https://backend.composio.dev/api/v3.1/tools?limit=1', {
  headers: { 'x-api-key': surrogate },
});
const ms = Date.now() - t0;
const text = await res.text();
console.log(`probe: HTTP ${res.status} in ${ms}ms`);
if (res.status === 200) {
  try {
    const data = JSON.parse(text);
    const items = data.items ?? [];
    console.log(`probe: total=${data.total ?? '?'} first=${items[0]?.slug ?? '?'} toolkit=${items[0]?.toolkit?.slug ?? '?'}`);
  } catch {
    console.log('probe: 200 but body is not JSON');
  }
} else {
  console.log(`probe: body(head)=${text.slice(0, 200)}`);
}
