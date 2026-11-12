/**
 * Dọn tay issue test mồ côi #1 (chạy 1 lần, 2026-11-11).
 *
 * Lần chạy live test ghi đầu tiên tạo được issue thật #1 trong
 * openbot1/open-bot nhưng script fail ở khâu kiểm tra kết quả
 * (shape response lồng nhau — xem live.mjs parseMultiExecuteResults)
 * nên bước 7 dọn dẹp không chạy. Script này chỉ đóng issue #1,
 * không tạo/sửa gì khác.
 *   python3 scripts/composio-live-v072/run-live.py close-issue-1.mjs
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

// User id của connected account GitHub trên dashboard (như live.mjs).
const DASHBOARD_USER_ID = 'pg-test-0d236b17-eece-4031-aae3-e8dbc3d70910';

const router = new ComposioToolRouter({ apiKey: SURROGATE });
const session = await router.createSession({ userId: DASHBOARD_USER_ID, toolkits: ['github'] });
const client = await connectMcp(router.buildMcpConfig(session));
try {
  const raw = await client.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [
      {
        tool_slug: 'GITHUB_CLOSE_ISSUE',
        arguments: { owner: 'openbot1', repo: 'open-bot', issue_number: 1 },
      },
    ],
  });
  const text = scrub(typeof raw === 'string' ? raw : JSON.stringify(raw));
  console.log(`cleanup: GITHUB_CLOSE_ISSUE #1 → ${text.slice(0, 1500)}`);
} finally {
  await client.close().catch(() => undefined);
}
