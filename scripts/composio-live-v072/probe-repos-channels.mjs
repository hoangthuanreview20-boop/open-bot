/**
 * Probe 4 — CHỈ ĐỌC: tìm repo GitHub + kênh Slack để chọn đích test ghi (v0.87).
 *
 * Huy đã phê duyệt test ghi (12:13) và giao tự chọn đích test (12:26).
 * Cần 1 repo mà tài khoản GitHub đã kết nối (openbot1) có quyền tạo
 * issue, và 1 kênh trong workspace Slack "open-bot" mới tạo.
 * Chỉ gọi SEARCH + GET_SCHEMAS + MULTI_EXECUTE với tool ĐỌC —
 * không tạo/sửa/xoá gì. Chạy qua driver:
 *   python3 scripts/composio-live-v072/run-live.py probe-repos-channels.mjs
 *
 * PHÁT HIỆN (lần chạy 12:2x): session với user_id 'local-user-1'
 * (FAKE_USER trong live.mjs) KHÔNG thấy connection đã connect trong
 * dashboard — COMPOSIO_MANAGE_CONNECTIONS trả link OAuth mới
 * (pending, hết hạn sau 10 phút, bỏ qua — không dùng). Dashboard
 * hiển thị các connected account thuộc User ID
 * pg-test-0d236b17-eece-4031-aae3-e8dbc3d70910, nên session phải dùng
 * đúng user_id đó thì mới thấy connection Active. Probe này kiểm
 * chứng giả thuyết đó.
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
const OUT_PATH = path.join(HERE, 'probe-repos-channels-2026-11-11.json');

// User ID thật của các connected account trên dashboard Composio
// (hiển thị công khai trên trang Auth Configs, không phải key/token).
const DASHBOARD_USER_ID = 'pg-test-0d236b17-eece-4031-aae3-e8dbc3d70910';

const router = new ComposioToolRouter({ apiKey: SURROGATE });
const session = await router.createSession({ userId: DASHBOARD_USER_ID, toolkits: ['github', 'gmail', 'slack'] });
console.log(`probe: session ok, userId=${DASHBOARD_USER_ID}, mcp host=${new URL(session.mcpUrl).hostname}`);
const client = await connectMcp(router.buildMcpConfig(session));
const out = { probe: 'probe-repos-channels.mjs', ranAt: new Date().toISOString(), userId: DASHBOARD_USER_ID, repos: null, channels: null };
try {
  // Tìm slug liệt kê repo + kênh Slack qua SEARCH (đường discovery chính).
  const search = async (query) => {
    const raw = await client.callTool('COMPOSIO_SEARCH_TOOLS', { query });
    const text = scrub(typeof raw === 'string' ? raw : JSON.stringify(raw));
    return [...new Set(text.match(/[A-Z]{2,}_[A-Z0-9_]+/g) ?? [])].sort();
  };
  const repoSlugs = await search('list repositories owned by the user');
  console.log(`probe: SEARCH repos → ${repoSlugs.join(', ')}`);
  const chanSlugs = await search('list channels in a Slack workspace');
  console.log(`probe: SEARCH channels → ${chanSlugs.join(', ')}`);

  const listRepoSlug =
    repoSlugs.find((s) => s === 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER') ??
    repoSlugs.find((s) => s.includes('REPOSITOR')) ??
    null;
  const listChanSlug =
    chanSlugs.find((s) => s === 'SLACK_LIST_ALL_CHANNELS') ??
    chanSlugs.find((s) => s.includes('CHANNEL') || s.includes('CONVERSATION')) ??
    null;
  console.log(`probe: chosen slugs: repo=${listRepoSlug} channel=${listChanSlug}`);

  const exec = async (toolSlug, args) => {
    const raw = await client.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
      // Wire shape thật của MCP tool: {tool_slug, arguments}
      // (khác với field `tool` mà coordinator nhận qua runTool).
      tools: [{ tool_slug: toolSlug, arguments: args }],
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
    return { text, parsed };
  };

  // Lỗi "No active connection found" ở lần chạy trước → thử gắn kết
  // nối đã có trong dashboard vào session qua COMPOSIO_MANAGE_CONNECTIONS.
  // (Với user_id đúng của dashboard, kỳ vọng trả Active thay vì link mới.)
  const manageRaw = await client.callTool('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: ['github', 'gmail', 'slack'] });
  const manageText = scrub(typeof manageRaw === 'string' ? manageRaw : JSON.stringify(manageRaw));
  console.log(`probe: MANAGE_CONNECTIONS {toolkits:[github,gmail,slack]} (first 2000):\n${manageText.slice(0, 2000)}`);
  out.manageConnections = manageText.slice(0, 4000);

  if (listRepoSlug) {
    const { text, parsed } = await exec(listRepoSlug, {});
    const results = parsed?.results ?? parsed?.data?.results ?? [];
    const first = results[0] ?? {};
    const data = first.data ?? first ?? {};
    out.repos = { slug: listRepoSlug, successful: first.successful ?? null, rawFirst800: text.slice(0, 800), data };
    console.log(`probe: ${listRepoSlug} successful=${first.successful} dataKeys=${Object.keys(data).join(',')}`);
    console.log(`probe: repos raw (first 1500):\n${text.slice(0, 1500)}`);
  }
  if (listChanSlug) {
    const { text, parsed } = await exec(listChanSlug, {});
    const results = parsed?.results ?? parsed?.data?.results ?? [];
    const first = results[0] ?? {};
    const data = first.data ?? first ?? {};
    out.channels = { slug: listChanSlug, successful: first.successful ?? null, rawFirst800: text.slice(0, 800), data };
    console.log(`probe: ${listChanSlug} successful=${first.successful} dataKeys=${Object.keys(data).join(',')}`);
    console.log(`probe: channels raw (first 1500):\n${text.slice(0, 1500)}`);
  }
} finally {
  await client.close().catch(() => undefined);
}
const scrubbed = JSON.parse(scrub(JSON.stringify(out)));
if (JSON.stringify(scrubbed).includes(SURROGATE)) throw new Error('snapshot còn chứa surrogate');
fs.writeFileSync(OUT_PATH, JSON.stringify(scrubbed, null, 2), 'utf8');
console.log(`probe: snapshot ghi vào ${OUT_PATH}`);
