// Đối chiếu slug curated (verifiedToolSlugs) của 18 toolkit mới v0.96
// với danh sách live đã discovery (toolkits-live-2026-11-13.txt).
// Chạy offline trên file đã discovery — không gọi mạng, không key.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPOSIO_TOOLKITS } from '../../packages/core/dist/composio/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEW = ['stripe','shopify','box','confluence','gitlab','calendly','mailchimp','twilio','googledocs','youtube','linkedin','reddit','whatsapp','pagerduty','typeform','sendgrid','bitbucket','freshdesk'];

const raw = fs.readFileSync(path.join(HERE, 'toolkits-live-2026-11-13.txt'), 'utf8');
const live = new Map(); // toolkit -> Set(slug)
let cur = null;
for (const line of raw.split('\n')) {
  const h = line.match(/^=== (\S+) ===$/);
  if (h) { cur = h[1]; live.set(cur, new Set()); continue; }
  const m = line.match(/^([A-Z][A-Z0-9_]+) \| toolkit: (\S+)$/);
  if (m && cur) live.get(cur).add(m[1]);
}
const out = { ranAt: new Date().toISOString(), toolkits: {}, missing: [], totalLiveTools: 0, totalCurated: 0, totalCuratedFound: 0 };
for (const slug of NEW) {
  const def = COMPOSIO_TOOLKITS.find((d) => d.slug === slug);
  const set = live.get(slug) ?? new Set();
  const missing = (def?.verifiedToolSlugs ?? []).filter((s) => !set.has(s));
  out.toolkits[slug] = { liveTotal: set.size, curated: def?.verifiedToolSlugs.length ?? 0, missing };
  out.totalLiveTools += set.size;
  out.totalCurated += def?.verifiedToolSlugs.length ?? 0;
  out.totalCuratedFound += (def?.verifiedToolSlugs.length ?? 0) - missing.length;
  out.missing.push(...missing.map((s) => `${slug}:${s}`));
}
fs.writeFileSync(path.join(HERE, 'toolkits-verify-2026-11-13.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify({ totalLiveTools: out.totalLiveTools, totalCurated: out.totalCurated, totalCuratedFound: out.totalCuratedFound, missing: out.missing }, null, 2));
process.exit(out.missing.length ? 1 : 0);
