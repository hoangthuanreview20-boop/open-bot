/**
 * Probe 3 — fetch schema live (CHỈ ĐỌC) của GMAIL_SEND_EMAIL +
 * SLACK_SEND_MESSAGE để chuẩn bị phần ghi (v0.85).
 *
 * Chỉ gọi COMPOSIO_GET_TOOL_SCHEMAS (đọc) — KHÔNG gọi MULTI_EXECUTE,
 * không tạo/sửa/xoá gì trên tài khoản thật. Chạy qua driver:
 *   python3 scripts/composio-live-v072/run-live.py probe-write-schemas.mjs
 *
 * In raw response đã scrub (surrogate/key không bao giờ lộ) và ghi
 * snapshot JSON đã scrub vào tool-schemas-write-2026-11-11.json
 * (cùng thư mục) để docs §4 / §13.4 đối chiếu.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComposioToolRouter } from '../../packages/core/dist/composio/router.js';
import { connectMcp } from '../../packages/core/dist/mcp/client.js';

const SURROGATE = process.env.COMPOSIO_KEY_SURROGATE ?? '';
if (!SURROGATE.startsWith('hsurr:')) {
  console.error('probe: no surrogate in env');
  process.exit(2);
}
function scrub(s) {
  return String(s).split(SURROGATE).join('[redacted]');
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(HERE, 'tool-schemas-write-2026-11-11.json');

const SLUGS = [
  'GMAIL_SEND_EMAIL',
  'SLACK_SEND_MESSAGE',
  'GITHUB_CREATE_AN_ISSUE',
  // Slug dọn dẹp sau test ghi (chỉ fetch schema — không thực thi):
  'GITHUB_CLOSE_ISSUE',
  'GMAIL_MOVE_TO_TRASH',
  'SLACK_DELETES_A_MESSAGE_FROM_A_CHAT',
];
const router = new ComposioToolRouter({ apiKey: SURROGATE });
const session = await router.createSession({ userId: 'local-user-1', toolkits: ['gmail', 'slack', 'github'] });
console.log(`probe: session ok, mcp host=${new URL(session.mcpUrl).hostname}`);
const client = await connectMcp(router.buildMcpConfig(session));
try {
  const raw = await client.callTool('COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: SLUGS });
  const text = scrub(raw);
  console.log(`probe: GET_TOOL_SCHEMAS raw (first 6000 chars):\n${text.slice(0, 6000)}`);
  // Parse để tóm tắt required/properties từng slug (in ngắn gọn).
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // callTool có thể trả text đã stringify 2 lần — thử parse lần nữa.
    try {
      parsed = JSON.parse(JSON.parse(text));
    } catch {
      parsed = null;
    }
  }
  const schemas = parsed?.data?.tool_schemas ?? parsed?.tool_schemas ?? null;
  const summary = {};
  if (schemas) {
    for (const slug of SLUGS) {
      const entry = schemas[slug];
      const input = entry?.input_schema ?? entry?.inputSchema ?? {};
      summary[slug] = {
        required: input.required ?? [],
        properties: Object.keys(input.properties ?? {}).sort(),
        propertyTypes: Object.fromEntries(
          Object.entries(input.properties ?? {}).map(([k, v]) => [k, v?.type ?? '?']),
        ),
      };
      console.log(`probe: ${slug} required=[${summary[slug].required.join(', ')}] properties=[${summary[slug].properties.join(', ')}]`);
    }
  } else {
    console.log('probe: WARNING — không parse được tool_schemas từ response (xem raw ở trên)');
  }
  const snapshot = {
    probe: 'composio-live-v072/probe-write-schemas.mjs (v0.85)',
    ranAt: new Date().toISOString(),
    slugs: SLUGS,
    summary,
    raw: parsed ?? text,
  };
  const scrubbed = JSON.parse(scrub(JSON.stringify(snapshot)));
  if (JSON.stringify(scrubbed).includes(SURROGATE)) throw new Error('snapshot còn chứa surrogate');
  fs.writeFileSync(OUT_PATH, JSON.stringify(scrubbed, null, 2), 'utf8');
  console.log(`probe: snapshot ghi vào ${OUT_PATH}`);
} finally {
  await client.close().catch(() => undefined);
}
