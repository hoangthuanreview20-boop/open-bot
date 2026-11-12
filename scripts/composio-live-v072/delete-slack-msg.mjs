/**
 * Dọn tay tin Slack test mồ côi (chạy 1 lần, 2026-11-11).
 *
 * Lần chạy live test ghi thứ hai gửi được tin vào kênh `social`
 * (ts 1794375188.715749) nhưng bước 7 xoá thất bại: Slack
 * chat.delete cần channel ID, không chấp nhận tên kênh như
 * chat.postMessage ("Slack API error: channel_not_found"). Tin
 * vẫn nằm trong kênh — script này xoá nó bằng channel ID
 * C0CGHN8L5R9 (lấy từ probe SLACK_LIST_ALL_CHANNELS).
 *   python3 scripts/composio-live-v072/run-live.py delete-slack-msg.mjs
 */
import { ComposioToolRouter } from '../../packages/core/dist/composio/router.js';
import { connectMcp } from '../../packages/core/dist/mcp/client.js';

const SURROGATE = process.env.COMPOSIO_KEY_SURROGATE ?? '';
if (!SURROGATE.startsWith('hsurr:')) {
  console.error('cleanup: no surrogate in env');
  process.exit(2);
}
function scrub(s) {
  return String(s).split(SURROGATE).join('[redacted]');
}

// User id của connected account Slack trên dashboard (như live.mjs).
const DASHBOARD_USER_ID = 'pg-test-0d236b17-eece-4031-aae3-e8dbc3d70910';

const router = new ComposioToolRouter({ apiKey: SURROGATE });
const session = await router.createSession({ userId: DASHBOARD_USER_ID, toolkits: ['slack'] });
const client = await connectMcp(router.buildMcpConfig(session));
try {
  const raw = await client.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [
      {
        tool_slug: 'SLACK_DELETES_A_MESSAGE_FROM_A_CHAT',
        // BẮT BUỘC channel ID (C0CGHN8L5R9 = kênh `social`); tên kênh
        // bị Slack API từ chối ở chat.delete.
        arguments: { channel: 'C0CGHN8L5R9', ts: '1794375188.715749' },
      },
    ],
  });
  const text = scrub(typeof raw === 'string' ? raw : JSON.stringify(raw));
  console.log(`cleanup: SLACK_DELETE ts=1794375188.715749 → ${text.slice(0, 800)}`);
} finally {
  await client.close().catch(() => undefined);
}
