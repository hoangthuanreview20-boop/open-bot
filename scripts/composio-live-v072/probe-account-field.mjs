/**
 * Probe 5 — CHỈ ĐỌC: thử dùng connected account của dashboard qua
 * field `account` trong MULTI_EXECUTE, dù session user_id là
 * 'local-user-1' (không phải user_id của dashboard).
 *
 * Bối cảnh: probe 4 chứng minh session phải dùng đúng user_id của
 * dashboard (pg-test-0d236b17-...) thì mới thấy connection Active.
 * Probe này kiểm tra cơ chế thứ hai: truyền thẳng connected account
 * id (ca_...) vào item `account` của MULTI_EXECUTE — nếu server chấp
 * nhận, live test có thể chạy ghi mà không cần đổi user_id của
 * coordinator; nếu từ chối, phải đổi user_id (cơ chế chính tắc).
 * Chỉ đọc (list repo + list channel), không tạo/sửa/xoá gì.
 *   python3 scripts/composio-live-v072/run-live.py probe-account-field.mjs
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
const OUT_PATH = path.join(HERE, 'probe-account-field-2026-11-11.json');

const router = new ComposioToolRouter({ apiKey: SURROGATE });
const session = await router.createSession({ userId: 'local-user-1', toolkits: ['github', 'slack'] });
console.log('probe: session ok, userId=local-user-1');
const client = await connectMcp(router.buildMcpConfig(session));
const out = { probe: 'probe-account-field.mjs', ranAt: new Date().toISOString(), userId: 'local-user-1' };
try {
  const exec = async (toolSlug, account) => {
    const raw = await client.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: toolSlug, arguments: {}, account }],
    });
    const text = scrub(typeof raw === 'string' ? raw : JSON.stringify(raw));
    console.log(`probe: ${toolSlug} account=${account} → ${text.slice(0, 1200)}`);
    return text.slice(0, 4000);
  };
  out.github = await exec('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', 'ca_m6aK6GUdxUMf');
  out.slack = await exec('SLACK_LIST_ALL_CHANNELS', 'ca_SMVC45QXp9kH');
} finally {
  await client.close().catch(() => undefined);
}
const scrubbed = JSON.parse(scrub(JSON.stringify(out)));
if (JSON.stringify(scrubbed).includes(SURROGATE)) throw new Error('snapshot còn chứa surrogate');
fs.writeFileSync(OUT_PATH, JSON.stringify(scrubbed, null, 2), 'utf8');
console.log(`probe: snapshot ghi vào ${OUT_PATH}`);
