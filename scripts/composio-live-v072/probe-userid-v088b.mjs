/**
 * Probe v0.88b — CHỈ ĐỌC: chứng minh session với user id đã cấu hình
 * thấy 3 connection Active trong dashboard, session 'local-user' thì không.
 *
 * Chạy qua driver (surrogate key chỉ đi qua env, không in ra, không ghi file):
 *   COMPOSIO_PROBE_USER_ID=<user id trên dashboard> python3 scripts/composio-live-v072/run-live.py probe-userid-v088b.mjs configured
 *   python3 scripts/composio-live-v072/run-live.py probe-userid-v088b.mjs local-user
 *
 * Chỉ gọi COMPOSIO_MANAGE_CONNECTIONS (đọc trạng thái kết nối) — không
 * tạo/sửa/xoá gì, không tạo issue/mail/tin nhắn, không sửa dashboard.
 * Không ghi file snapshot: kết quả chỉ in ra stdout, và chỉ in trạng
 * thái active/inactive từng toolkit (không in chi tiết tài khoản,
 * không in user id, không in key/surrogate).
 */
import { ComposioToolRouter } from '../../packages/core/dist/composio/router.js';
import { connectMcp } from '../../packages/core/dist/mcp/client.js';

const SURROGATE = process.env.COMPOSIO_KEY_SURROGATE ?? '';
if (!SURROGATE.startsWith('hsurr:')) {
  console.error('probe: no surrogate in env');
  process.exit(2);
}
const label = process.argv[2] ?? '';
if (label !== 'configured' && label !== 'local-user') {
  console.error('probe: usage: probe-userid-v088b.mjs <configured|local-user>');
  process.exit(2);
}
let userId;
if (label === 'configured') {
  userId = (process.env.COMPOSIO_PROBE_USER_ID ?? '').trim();
  if (!userId) {
    console.error('probe: COMPOSIO_PROBE_USER_ID env is empty (user id trên dashboard Composio)');
    process.exit(2);
  }
} else {
  userId = 'local-user';
}
function scrub(s) {
  return String(s).split(SURROGATE).join('[redacted]').split(userId).join('[user-id]');
}

const router = new ComposioToolRouter({ apiKey: SURROGATE });
const session = await router.createSession({ userId, toolkits: ['github', 'gmail', 'slack'] });
console.log(`probe: label=${label} session ok, mcp host=${new URL(session.mcpUrl).hostname}`);
const client = await connectMcp(router.buildMcpConfig(session));
try {
  const raw = await client.callTool('COMPOSIO_MANAGE_CONNECTIONS', {
    toolkits: ['github', 'gmail', 'slack'],
  });
  const text = scrub(typeof raw === 'string' ? raw : JSON.stringify(raw));
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(JSON.parse(text));
    } catch {
      parsed = null;
    }
  }
  const results = parsed?.data?.results ?? parsed?.results ?? null;
  const toolkits = ['github', 'gmail', 'slack'];
  const states = {};
  let activeCount = 0;
  for (const tk of toolkits) {
    const entry = results?.[tk] ?? null;
    const active = entry?.status === 'active' || entry?.has_active_connection === true;
    states[tk] = active ? 'active' : entry ? `not-active (status=${entry.status ?? '?'})` : 'missing';
    if (active) activeCount += 1;
  }
  console.log(`probe: label=${label} successful=${parsed?.successful ?? '?'} message=${parsed?.data?.message ?? '?'}`);
  for (const tk of toolkits) console.log(`probe: label=${label} ${tk}: ${states[tk]}`);
  console.log(`probe: label=${label} ACTIVE_COUNT=${activeCount}/3`);
  // Đối chứng: session không thấy connection thì output chứa link OAuth mới.
  if (activeCount === 0) {
    console.log(`probe: label=${label} has_oauth_link=${/oauth|connect/i.test(text)} (no active connection)`);
  }
} finally {
  await client.close().catch(() => undefined);
}
