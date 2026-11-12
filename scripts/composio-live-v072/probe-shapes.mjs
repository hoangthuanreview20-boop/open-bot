/**
 * Probe 2 — response shape thật của GET_TOOL_SCHEMAS + item shape thật
 * của MULTI_EXECUTE (read-only, KHÔNG ghi).
 *
 * GET_TOOL_SCHEMAS: in raw text để ghi đúng cấu trúc response.
 * MULTI_EXECUTE: gọi với slug KHÔNG TỒN TẠI (NO_SUCH_TOOL_XYZ_123)
 * nên server không thể thực thi gì — chỉ để xem server validate field
 * `tool` (cũ, router đang gửi) hay `tool_slug` (mới, theo inputSchema):
 *  - lỗi nhắc `tool_slug` required → field `tool` không được chấp nhận.
 *  - lỗi "unknown tool" → field được chấp nhận, chỉ slug là lạ.
 * Chạy qua driver: python3 run-live.py probe-shapes.mjs
 */
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
const router = new ComposioToolRouter({ apiKey: SURROGATE });
const session = await router.createSession({ userId: 'local-user-1', toolkits: ['github'] });
console.log(`probe: session ok, mcp host=${new URL(session.mcpUrl).hostname}`);
const client = await connectMcp(router.buildMcpConfig(session));
try {
  const schemas = await client.callTool('COMPOSIO_GET_TOOL_SCHEMAS', {
    tool_slugs: ['GITHUB_CREATE_AN_ISSUE'],
  });
  console.log(`probe: GET_TOOL_SCHEMAS raw (first 2000 chars):\n${scrub(schemas).slice(0, 2000)}`);

  const oldShape = await client.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [{ tool: 'NO_SUCH_TOOL_XYZ_123', arguments: {} }],
  });
  console.log(`probe: MULTI_EXECUTE old shape {tool} → ${scrub(oldShape).slice(0, 600)}`);

  const newShape = await client.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [{ tool_slug: 'NO_SUCH_TOOL_XYZ_123', arguments: {} }],
  });
  console.log(`probe: MULTI_EXECUTE new shape {tool_slug} → ${scrub(newShape).slice(0, 600)}`);
} finally {
  await client.close().catch(() => undefined);
}
