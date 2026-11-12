/**
 * Probe v0.84 (read-only): does Huy's Composio project have anything a
 * real trigger event could fire from?
 *
 * GET /api/v3.1/connected_accounts — connected accounts (OAuth/API-key
 * connections to toolkits; a trigger instance needs one).
 * GET /api/v3/trigger_instances/active — active trigger instances.
 *
 * Prints only counts, toolkit slugs, trigger slugs and statuses — no
 * secrets, no ids beyond the trigger/account nanoids needed to identify
 * them (nanoids are not credentials). Auth via COMPOSIO_KEY_SURROGATE
 * env (hsurr:), swapped by Sentinel on egress to backend.composio.dev.
 */
const surrogate = process.env.COMPOSIO_KEY_SURROGATE ?? '';
if (!surrogate.startsWith('hsurr:')) {
  console.error('probe: no surrogate in env');
  process.exit(2);
}
const BASE = 'https://backend.composio.dev/api/v3.1';

async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'x-api-key': surrogate } });
  const text = await res.text();
  return { status: res.status, text };
}

const accounts = await get('/connected_accounts?limit=100');
console.log(`connected_accounts: HTTP ${accounts.status}`);
if (accounts.status === 200) {
  const data = JSON.parse(accounts.text);
  const items = data.items ?? [];
  console.log(`connected_accounts: total=${data.total ?? items.length}`);
  for (const a of items) {
    console.log(`  - toolkit=${a.toolkit?.slug ?? a.toolkitSlug ?? '?'} status=${a.status ?? '?'} id=${a.id ?? a.nanoid ?? '?'}`);
  }
} else {
  console.log(`connected_accounts: body(head)=${accounts.text.slice(0, 300)}`);
}

const triggers = await get('/trigger_instances/active');
console.log(`trigger_instances/active: HTTP ${triggers.status}`);
if (triggers.status === 200) {
  const data = JSON.parse(triggers.text);
  const items = data.items ?? (Array.isArray(data) ? data : []);
  console.log(`trigger_instances/active: total=${data.total ?? items.length}`);
  for (const t of items) {
    console.log(`  - slug=${t.triggerSlug ?? t.trigger_slug ?? t.slug ?? '?'} id=${t.id ?? t.triggerId ?? '?'} status=${t.status ?? '?'} connectedAccountId=${t.connectedAccountId ?? '?'}`);
  }
} else {
  console.log(`trigger_instances/active: body(head)=${triggers.text.slice(0, 300)}`);
}
