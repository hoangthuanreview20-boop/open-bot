/**
 * Live test Composio THẬT trong open-bot — v0.72 (6 bước §8, docs/composio-integration.md).
 *
 * Chạy qua driver (không chạy trực tiếp — cần surrogate từ connector):
 *   python3 scripts/composio-live-v072/run-live.py
 *
 * Key: KHÔNG BAO GIỜ xuất hiện ở đây. Driver lấy surrogate `hsurr:`
 * từ connector custom.composio, đưa vào env COMPOSIO_KEY_SURROGATE;
 * Sentinel đổi surrogate thành key thật trên egress tới
 * backend.composio.dev. Mọi chuỗi in ra / ghi file đều qua scrub()
 * để surrogate không lọt vào log hay báo cáo. Session MCP URL là
 * secret — không log.
 *
 * Chỉ các bước ĐỌC (read-only) theo mặc định: tạo session, tools/list,
 * liệt kê tool session, SEARCH_TOOLS + GET_TOOL_SCHEMAS. Bước GHI
 * (bước 4 execute + bước 5 Gmail/Slack + bước 7 dọn dẹp) chỉ chạy
 * khi env input ghi đã đủ (xem readWriteConfig + docs §8.1) VÀ
 * checklist phê duyệt WRITE-CHECKLIST.md đã được Huy ký — không
 * env = các bước ghi vẫn "skipped" có lý do, không fail cả run.
 *
 * User id cho session ghi: bắt buộc dùng đúng user id của các
 * connected account trên dashboard Composio (env
 * COMPOSIO_WRITE_USER_ID) — session với user id khác (vd
 * 'local-user-1') KHÔNG thấy connection nào (probe 2026-11-11:
 * "No active connection found", MANAGE_CONNECTIONS chỉ trả link
 * OAuth mới). Field `account` trong MULTI_EXECUTE cũng không cứu
 * được ("Multi-account selection is not enabled"). Đây cũng là gap
 * của sản phẩm: coordinator hardcode COMPOSIO_LOCAL_USER_ID
 * ('local-user') nên app chưa dùng được connection dashboard —
 * cần cho phép cấu hình Composio user id (xem báo cáo).
 * Mọi artifact ghi đều bắt buộc tiền tố '[open-bot live test]'.
 *
 * Script độc lập, KHÔNG nằm trong suite test thường (phụ thuộc mạng
 * ngoài + key thật). Báo cáo JSON: scripts/composio-live-v072/report.json
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPOSIO_GET_TOOL_SCHEMAS,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_SEARCH_TOOL,
  ComposioSessionManager,
  createComposioMetaTools,
  createComposioToolkitAppDefinitions,
  hasComposioApiKey,
} from '../../packages/core/dist/composio/index.js';
import { ComposioToolRouter } from '../../packages/core/dist/composio/router.js';
import { connectMcp } from '../../packages/core/dist/mcp/client.js';
import { AgentCoordinator } from '../../packages/core/dist/coordinator/coordinator.js';
import { Vault } from '../../packages/core/dist/vault/vault.js';

const SURROGATE = process.env.COMPOSIO_KEY_SURROGATE ?? '';
if (!SURROGATE.startsWith('hsurr:')) {
  console.error('live: thiếu COMPOSIO_KEY_SURROGATE trong env — chạy qua run-live.py');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(HERE, 'report.json');
const FAKE_USER = 'local-user-1';
/**
 * Meta-tool mà Tool Router session trả qua tools/list — ĐO THẬT v0.72:
 * server trả 6, KHÔNG có COMPOSIO_WAIT_FOR_CONNECTIONS. Docs liệt kê
 * 7 cho Composio Connect (connect.composio.dev/mcp); với Tool Router
 * session, WAIT_FOR_CONNECTIONS chỉ xuất hiện khi bật
 * `manage_connections.enable_wait_for_connections` trong config
 * session (xem type session_patch_params trong llms-full.txt).
 * Open-bot chỉ expose 3 meta-tool cho model (SEARCH / GET_SCHEMAS /
 * MULTI_EXECUTE) nên thiếu tool này không ảnh hưởng đường chạy.
 */
const EXPECTED_META_TOOLS = [
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MULTI_EXECUTE_TOOL',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_REMOTE_WORKBENCH',
  'COMPOSIO_REMOTE_BASH_TOOL',
];
const CUSTODY_WARNING =
  'Rủi ro custody: token OAuth Gmail/Slack nằm phía Composio (managed OAuth), ' +
  'không lưu trên máy này; chỉ dùng cho tài khoản không nhạy cảm trước. ' +
  'Xem docs/composio-integration.md §9 (sự cố 05/2026).';

/** Xoá surrogate khỏi mọi chuỗi trước khi in/ghi (không bao giờ lộ). */
function scrub(value) {
  if (typeof value === 'string') return value.split(SURROGATE).join('[redacted]');
  return value;
}
function log(...args) {
  console.log(...args.map((a) => (typeof a === 'string' ? scrub(a) : a)));
}
function fail(message) {
  throw new Error(scrub(String(message)));
}

const report = {
  harness: 'composio-live-v072',
  mode: 'live (API Composio thật, key qua surrogate — không key thô)',
  ranAt: new Date().toISOString(),
  steps: {},
  discoveredSlugs: { gmail: [], github: [], slack: [], notion: [] },
  multiExecuteInputSchema: null,
  // Artifact thật do bước ghi tạo (null khi bước ghi chưa chạy) —
  // dùng để dọn dẹp ở bước 7: { githubIssue: {number, url},
  // gmailMessageId, slackChannel, slackTs }.
  writeArtifacts: null,
  // User id của session ghi (đúng user id dashboard — xem đầu file).
  writeSessionUserId: null,
  latencyMs: {},
  custodyWarning: CUSTODY_WARNING,
  notes: [],
};
function markStep(n, evidence) {
  report.steps[`step${n}`] = { status: 'pass', ...evidence };
}
function markSkipped(n, reason) {
  report.steps[`step${n}`] = { status: 'skipped', reason };
}

/**
 * Input ghi qua env (v0.85, docs §8.1.3) — KHÔNG hardcode, KHÔNG
 * hỏi key. Chỉ chạy ghi khi env đủ; thiếu env nào thì bước ghi
 * tương ứng vẫn skipped có lý do. Mọi tiêu đề/nội dung artifact
 * bắt buộc có tiền tố '[open-bot live test]' — thiếu tiền tố thì
 * fail rõ TRƯỚC khi thực thi gì.
 */
const WRITE_PREFIX = '[open-bot live test]';
function readWriteConfig() {
  const missing = [];
  const env = (name) => {
    const v = (process.env[name] ?? '').trim();
    if (!v) missing.push(name);
    return v;
  };
  const repoRaw = env('COMPOSIO_WRITE_REPO');
  const [owner, repo] = repoRaw.split('/');
  if (repoRaw && (!owner || !repo || repoRaw.split('/').length !== 2)) {
    fail(`COMPOSIO_WRITE_REPO phải dạng 'owner/repo', nhận được: ${scrub(repoRaw)}`);
  }
  const issueTitle = env('COMPOSIO_WRITE_ISSUE_TITLE');
  const issueBody = env('COMPOSIO_WRITE_ISSUE_BODY');
  const mailTo = env('COMPOSIO_WRITE_MAIL_TO');
  const mailSubject = env('COMPOSIO_WRITE_MAIL_SUBJECT');
  const mailBody = env('COMPOSIO_WRITE_MAIL_BODY');
  const slackChannel = env('COMPOSIO_WRITE_SLACK_CHANNEL');
  const slackText = env('COMPOSIO_WRITE_SLACK_TEXT');
  // User id cho session ghi — bắt buộc khi có bất kỳ nhóm ghi nào sẵn.
  const writeUserId = env('COMPOSIO_WRITE_USER_ID');
  for (const [name, value] of [
    ['COMPOSIO_WRITE_ISSUE_TITLE', issueTitle],
    ['COMPOSIO_WRITE_MAIL_SUBJECT', mailSubject],
    ['COMPOSIO_WRITE_SLACK_TEXT', slackText],
  ]) {
    if (value && !value.startsWith(WRITE_PREFIX)) {
      fail(`${name} phải bắt đầu bằng '${WRITE_PREFIX}' — từ chối chạy ghi`);
    }
  }
  if (slackChannel.startsWith('#')) {
    fail(`COMPOSIO_WRITE_SLACK_CHANNEL không có tiền tố '#' (schema SLACK_SEND_MESSAGE) — nhận được: ${scrub(slackChannel)}`);
  }
  const cfg = {
    owner,
    repo,
    issueTitle,
    issueBody,
    mailTo,
    mailSubject,
    mailBody,
    slackChannel,
    slackText,
    writeUserId,
    missing,
  };
  // Nhóm env theo bước: bước 4 cần repo+title+body; bước 5 cần
  // mail đủ + slack đủ (và bước 4 ghi đã chạy).
  cfg.githubReady = Boolean(owner && repo && issueTitle && issueBody);
  cfg.mailReady = Boolean(mailTo && mailSubject && mailBody);
  cfg.slackReady = Boolean(slackChannel && slackText);
  cfg.allReady = cfg.githubReady && cfg.mailReady && cfg.slackReady;
  if ((cfg.githubReady || cfg.mailReady || cfg.slackReady) && !writeUserId) {
    fail(
      'Thiếu COMPOSIO_WRITE_USER_ID — session ghi phải dùng đúng user id của connected account trên dashboard (xem WRITE-CHECKLIST.md §8); user id khác sẽ lỗi "No active connection found".',
    );
  }
  return cfg;
}
let writeConfig = null; // Đọc ở đầu main() để lỗi env được ghi vào báo cáo.
/** MCP client của session ghi (module-level để finally đóng được). */
let writeClient = null;

/** Parse output MULTI_EXECUTE (JSON string) thành mảng results. */
function parseMultiExecuteResults(outputText) {
  let parsed;
  try {
    parsed = JSON.parse(String(outputText));
  } catch {
    fail(`không parse được output MULTI_EXECUTE: ${String(outputText).slice(0, 300)}`);
  }
  const results = parsed?.results ?? parsed?.data?.results;
  if (!Array.isArray(results)) {
    fail(`output MULTI_EXECUTE không có mảng results: ${String(outputText).slice(0, 300)}`);
  }
  // Wire shape thật (probe + live ghi 2026-11-11): mỗi result bọc
  // trong `response` — {response: {successful, data}, tool_slug,
  // index}. Mock v0.59 trả phẳng {successful, data} nên code cũ
  // đọc trực tiếp đã sai khi chạy thật (issue #1 đã tạo xong nhưng
  // check `data.number` fail vì data nằm trong `response`). Chuẩn
  // hoá về {successful, data, tool_slug} để mọi caller dùng chung.
  return results.map((r) => {
    if (r && typeof r === 'object' && r.response && typeof r.response === 'object') {
      return { ...r, successful: r.response.successful ?? r.successful, data: r.response.data ?? r.data };
    }
    return r;
  });
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout sau ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const tmpDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const coordDir = tmp('composio-live-v072-vault-');
const botWs = tmp('composio-live-v072-botws-');
// Coordinator live: KHÔNG override baseUrl/fetchFn → dùng mặc định
// (https://backend.composio.dev/api/v3.1 + global fetch).
const coordinator = new AgentCoordinator({ dataDir: coordDir });

async function main() {
  // Input ghi qua env (v0.85): đọc + validate TRƯỚC mọi bước —
  // env sai định dạng/thiếu tiền tố thì fail rõ, chưa thực thi gì.
  writeConfig = readWriteConfig();
  log(`[live] input ghi: githubReady=${writeConfig.githubReady} mailReady=${writeConfig.mailReady} slackReady=${writeConfig.slackReady} (thiếu env: ${writeConfig.missing.join(', ') || 'không'})`);
  // -- Bước 1: key (qua surrogate) + seed cho coordinator -----------------
  // App Vault trên máy này chưa có key (Huy nhập key vào connector,
  // chưa nhập vào Settings → Composio của app) — chỉ ghi boolean.
  const appVault = new Vault({ storePath: '/home/hatch/.config/@open-bot/desktop/vault.json' });
  const appVaultHasKey = hasComposioApiKey(appVault);
  const seeded = await coordinator.handle('composio.setApiKey', { apiKey: SURROGATE });
  const keyStatus = await coordinator.handle('composio.getKeyStatus', {});
  if (!seeded.hasKey || !seeded.seeded || seeded.source !== 'seeded') fail(`seed key thất bại: ${JSON.stringify(seeded)}`);
  if (!keyStatus.hasKey || keyStatus.source !== 'seeded') fail(`key status sai: ${JSON.stringify(keyStatus)}`);
  markStep(1, {
    appVaultHasKey,
    seeded: true,
    keySource: 'seeded',
    seedPath: 'RPC composio.setApiKey (đường chính v0.59, main seed trong bộ nhớ)',
  });
  log('[live] bước 1 pass — key đã seed cho coordinator (source=seeded), app Vault hasKey=%s', appVaultHasKey);

  // -- Bước 2: bật source + 4 toolkit --------------------------------------
  const applied = await coordinator.handle('composio.setState', {
    enabled: true,
    toolkits: ['github', 'gmail', 'slack', 'notion'],
  });
  const expectApps = ['composio', 'composio-github', 'composio-gmail', 'composio-slack', 'composio-notion'];
  if (JSON.stringify([...applied.registeredAppIds].sort()) !== JSON.stringify([...expectApps].sort())) {
    fail(`registeredAppIds sai: ${JSON.stringify(applied.registeredAppIds)}`);
  }
  const defs = createComposioToolkitAppDefinitions();
  for (const id of expectApps.slice(1)) {
    const def = defs.find((d) => d.id === id);
    if (!def || def.source !== 'composio') fail(`catalog def ${id} thiếu source=composio`);
  }
  const created = await coordinator.createBot({
    bot: {
      id: 'live-bot',
      name: 'Bot live',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'You are a test bot.',
      workspaceDir: botWs,
      autoApprove: true,
    },
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
  });
  if (!created.toolNames.includes(COMPOSIO_SEARCH_TOOL) || !created.toolNames.includes(COMPOSIO_MULTI_EXECUTE_TOOL)) {
    fail(`bot thiếu meta-tool: ${created.toolNames.filter((t) => t.startsWith('COMPOSIO_')).join(',')}`);
  }
  markStep(2, { registeredAppIds: applied.registeredAppIds, badgeSource: 'composio', botHasMetaTools: true });
  log('[live] bước 2 pass — 5 app Composio đã đăng ký, bot có meta-tool');

  // -- Bước 3: session thật + tools/list qua connectMcp thật ---------------
  const router = new ComposioToolRouter({ apiKey: SURROGATE });
  const tSession0 = Date.now();
  const session = await withTimeout(
    router.createSession({ userId: FAKE_USER, toolkits: ['github', 'gmail', 'slack', 'notion'] }),
    60000,
    'createSession',
  );
  const sessionCreateMs = Date.now() - tSession0;
  if (!session.sessionId || !session.mcpUrl) fail('session thiếu session_id/mcp.url');
  const mcpHost = new URL(session.mcpUrl).hostname;
  log(`[live] session tạo xong in ${sessionCreateMs}ms, mcp host=${mcpHost}, sessionId(head)=${session.sessionId.slice(0, 8)}…`);

  // tools/list qua connectMcp THẬT (Streamable HTTP tới MCP URL thật).
  const mcpClient = await withTimeout(connectMcp(router.buildMcpConfig(session)), 60000, 'connectMcp');
  let metaNames = [];
  try {
    const tools = await withTimeout(mcpClient.listTools(), 60000, 'tools/list');
    metaNames = tools.map((t) => t.name).sort();
    const multi = tools.find((t) => t.name === 'COMPOSIO_MULTI_EXECUTE_TOOL');
    if (!multi) fail('tools/list thiếu COMPOSIO_MULTI_EXECUTE_TOOL');
    const schema = multi.inputSchema ?? {};
    const toolsProp = schema.properties?.tools ?? {};
    report.multiExecuteInputSchema = {
      type: schema.type,
      toolsType: toolsProp.type,
      toolsItemProperties: Object.keys(toolsProp.items?.properties ?? {}).sort(),
      toolsItemRequired: toolsProp.items?.required ?? [],
      topRequired: schema.required ?? [],
    };
    log(`[live] tools/list: ${metaNames.length} meta-tool — ${metaNames.join(', ')}`);
  } finally {
    await mcpClient.close().catch(() => undefined);
  }
  const metaMissing = EXPECTED_META_TOOLS.filter((n) => !metaNames.includes(n));
  if (metaNames.length !== EXPECTED_META_TOOLS.length || metaMissing.length > 0) {
    fail(`meta-tool thiếu/khác docs: có ${JSON.stringify(metaNames)}, thiếu ${JSON.stringify(metaMissing)}`);
  }

  // Liệt kê tool session qua REST (phân trang) — ĐO THẬT v0.72: session
  // mặc định CHỈ trả 6 meta-tool, KHÔNG trả tool app (GMAIL_*, ...).
  // Đúng thiết kế Tool Router (docs quickstart: "It exposes only a
  // small set of meta tools, so app schemas are loaded when the agent
  // needs them") — tool app được phát hiện qua COMPOSIO_SEARCH_TOOLS
  // (bước 4), hoặc preload cụ thể khi tạo session. Mock v0.59 trả slug
  // app ở endpoint này là SAI so với server thật (ghi nhận divergences,
  // xem báo cáo + docs §8) — mock chỉ kiểm tra parsing, không phải
  // hành vi thật của endpoint.
  const allItems = [];
  let cursor;
  do {
    const page = await withTimeout(
      router.listSessionTools(session.sessionId, { limit: 500, ...(cursor ? { cursor } : {}) }),
      60000,
      'listSessionTools',
    );
    allItems.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const sessionToolSlugs = allItems.map((i) => i.slug).sort();
  log(`[live] listSessionTools: ${allItems.length} tool — ${sessionToolSlugs.join(', ')}`);
  if (JSON.stringify(sessionToolSlugs) !== JSON.stringify([...metaNames].sort())) {
    fail(`listSessionTools khác tools/list: ${JSON.stringify(sessionToolSlugs)}`);
  }

  markStep(3, {
    sessionCreateMs,
    mcpHost,
    metaTools: metaNames,
    sessionToolsTotal: allItems.length,
    sessionToolsAreMetaToolsOnly: true,
    waitForConnections: 'not returned by default (gated by manage_connections.enable_wait_for_connections)',
    multiExecuteSchema: report.multiExecuteInputSchema,
  });

  // -- Session GHI (chỉ khi env ghi đủ): dùng đúng user id của
  // dashboard (COMPOSIO_WRITE_USER_ID) + kiểm tra 3 connection
  // Active qua COMPOSIO_MANAGE_CONNECTIONS trước khi thực thi gì.
  // Session của coordinator (user 'local-user') và session đọc ở
  // bước 3 (user 'local-user-1') đều KHÔNG thấy connection
  // dashboard — chỉ session với user id đúng mới thấy (probe
  // 2026-11-11). Đây là đường ghi trực tiếp qua router + MCP
  // (không qua coordinator) để test không bị chặn bởi gap user id
  // của sản phẩm; gap đó được ghi vào báo cáo (report.notes).
  if (writeConfig.allReady) {
    const writeSession = await withTimeout(
      router.createSession({ userId: writeConfig.writeUserId, toolkits: ['github', 'gmail', 'slack'] }),
      60000,
      'createSession (ghi)',
    );
    writeClient = await withTimeout(connectMcp(router.buildMcpConfig(writeSession)), 60000, 'connectMcp (ghi)');
    const manageRaw = await withTimeout(
      writeClient.callTool('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: ['github', 'gmail', 'slack'] }),
      120000,
      'MANAGE_CONNECTIONS (ghi)',
    );
    const manageText = String(manageRaw);
    let manageParsed = null;
    try {
      manageParsed = JSON.parse(manageText);
    } catch {
      try {
        manageParsed = JSON.parse(JSON.parse(manageText));
      } catch {
        manageParsed = null;
      }
    }
    const manageResults = manageParsed?.data?.results ?? {};
    const inactive = ['github', 'gmail', 'slack'].filter((t) => manageResults[t]?.status !== 'active');
    if (inactive.length > 0) {
      fail(`connection chưa Active cho: ${inactive.join(', ')} — ${manageText.slice(0, 300)}`);
    }
    report.writeSessionUserId = writeConfig.writeUserId;
    report.notes.push(
      "GAP SẢN PHẨM (phát hiện khi chuẩn bị test ghi 2026-11-11): coordinator hardcode COMPOSIO_LOCAL_USER_ID ('local-user') nên session của app không thấy connection đã connect trong dashboard Composio — chỉ session với đúng user id của connected account (dashboard) mới thấy. Test ghi chạy qua session trực tiếp với user id đúng; app cần cho phép cấu hình Composio user id (lấy từ connected accounts hoặc Settings) thì người dùng mới dùng được Composio thật.",
    );
    log('[live] session ghi: 3 connection Active (github/gmail/slack) với user id dashboard');
  }

  /** MULTI_EXECUTE qua session ghi — wire shape {tool_slug, arguments}. */
  const multiExecuteWrite = async (items, label) => {
    if (!writeClient) fail(`không có session ghi cho ${label}`);
    const outText = await withTimeout(
      writeClient.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: items.map((it) => ({ tool_slug: it.tool, arguments: it.arguments })),
      }),
      120000,
      `MULTI_EXECUTE (ghi) ${label}`,
    );
    // Lỗi tool trả về dạng text "MCP tool error: {...}" — ném lỗi rõ
    // thay vì để JSON parser báo lỗi khó hiểu ở bước dọn dẹp.
    if (String(outText).startsWith('MCP tool error:')) {
      fail(`MULTI_EXECUTE (ghi) ${label} lỗi: ${String(outText).slice(0, 500)}`);
    }
    return parseMultiExecuteResults(String(outText));
  };

  // -- Bước 4: SEARCH + GET_SCHEMAS (chỉ đọc) — KHÔNG execute ghi ---------
  // Slug thật 4 toolkit được phát hiện qua COMPOSIO_SEARCH_TOOLS (đường
  // discovery chính của Tool Router), không phải listSessionTools.
  const discoverQueries = [
    { query: 'create a GitHub issue', prefix: 'GITHUB_' },
    { query: 'fetch emails from Gmail', prefix: 'GMAIL_' },
    { query: 'send an email with Gmail', prefix: 'GMAIL_' },
    { query: 'send a message on Slack', prefix: 'SLACK_' },
    { query: 'create a page in Notion', prefix: 'NOTION_' },
  ];
  const discovered = { gmail: [], github: [], slack: [], notion: [] };
  const searchMs = [];
  for (const { query, prefix } of discoverQueries) {
    const t0 = performance.now();
    const out = await withTimeout(
      coordinator.handle('runTool', {
        botId: 'live-bot',
        tool: COMPOSIO_SEARCH_TOOL,
        args: { query },
      }),
      120000,
      `SEARCH_TOOLS "${query}"`,
    );
    searchMs.push(Math.round((performance.now() - t0) * 10) / 10);
    const text = String(out.output ?? '');
    // Slug dạng PREFIX_REST — trích từ JSON hoặc text thô.
    const slugs = [...new Set(text.match(/[A-Z]{2,}_[A-Z0-9_]+/g) ?? [])]
      .filter((s) => s.startsWith(prefix))
      .sort();
    const key = prefix.slice(0, -1).toLowerCase();
    discovered[key] = [...new Set([...discovered[key], ...slugs])].sort();
    log(`[live] SEARCH "${query}" → ${slugs.length} slug ${prefix}* : ${slugs.slice(0, 8).join(', ')}${slugs.length > 8 ? ' …' : ''}`);
  }
  report.discoveredSlugs = discovered;
  // Slug tạo issue THẬT là GITHUB_CREATE_AN_ISSUE — slug
  // GITHUB_CREATE_ISSUE trong docs v0.57 (suy từ tài liệu) KHÔNG tồn
  // tại trên server thật. Tương tự, slug Slack/Notion thật khác slug
  // mock bịa (SLACK_POST_MESSAGE / NOTION_CREATE_PAGE không có thật).
  const githubCreate = discovered.github.find((s) => s.includes('CREATE') && s.includes('ISSUE'));
  if (!githubCreate) {
    fail(`SEARCH không trả slug tạo issue GitHub nào: ${JSON.stringify(discovered.github)}`);
  }
  if (discovered.gmail.length === 0 || discovered.slack.length === 0 || discovered.notion.length === 0) {
    fail(`thiếu slug ở 1 toolkit: ${JSON.stringify({ gmail: discovered.gmail.length, slack: discovered.slack.length, notion: discovered.notion.length })}`);
  }
  // GET_TOOL_SCHEMAS với shape {tools: [...]} — kiểm chứng shape suy
  // đoán ở v0.58; lấy schema của 1 slug mỗi toolkit (đại diện).
  const gmailSend = discovered.gmail.find((s) => s.includes('SEND') || s.includes('CREATE'));
  const slackSend = discovered.slack.find((s) => s.includes('SEND'));
  const notionCreate = discovered.notion.find((s) => s.includes('CREATE'));
  const schemaSlugs = [githubCreate, discovered.gmail[0], gmailSend, slackSend, notionCreate].filter(
    (s, i, arr) => s && arr.indexOf(s) === i,
  );
  const schemasOut = await withTimeout(
    coordinator.handle('runTool', {
      botId: 'live-bot',
      tool: COMPOSIO_GET_TOOL_SCHEMAS,
      args: { tools: schemaSlugs },
    }),
    120000,
    'GET_TOOL_SCHEMAS',
  );
  const schemasText = String(schemasOut.output ?? '');
  for (const slug of schemaSlugs) {
    if (!schemasText.includes(slug)) {
      fail(`GET_TOOL_SCHEMAS không trả schema ${slug}: ${schemasText.slice(0, 300)}`);
    }
  }
  // Ghi lại các field schema thấy được cho slug tạo issue thật.
  // Shape response THẬT (v0.72, probe-shapes):
  // {successful, data: {tool_schemas: {<slug>: {input_schema:
  // {required: [...], properties: {...}}}}}} — KHÔNG phải
  // {schemas: [{slug, input_parameters}]} như mock v0.58/v0.59 bịa.
  let schemaFields = [];
  let schemaRequired = [];
  try {
    const parsed = JSON.parse(schemasText);
    const entry = parsed?.data?.tool_schemas?.[githubCreate];
    const props = entry?.input_schema?.properties ?? {};
    schemaFields = Object.keys(props).sort();
    schemaRequired = entry?.input_schema?.required ?? [];
  } catch {
    schemaFields = ['(không parse được JSON — xem output thô)'];
  }
  log(`[live] GET_TOOL_SCHEMAS {tools:[${schemaSlugs.join(', ')}]} → ${githubCreate} field: ${schemaFields.join(', ')}`);

  // -- Bước 4 (phần GHI): execute GITHUB_CREATE_AN_ISSUE — CHỈ khi
  // env ghi GitHub đã đủ (repo + title + body) VÀ checklist §8.1 đã
  // ký. Không env = ghi lại 'NOT RUN', bước 4 vẫn pass phần đọc.
  let githubIssue = null;
  if (writeConfig.githubReady) {
    const results = await multiExecuteWrite(
      [
        {
          tool: 'GITHUB_CREATE_AN_ISSUE',
          arguments: {
            owner: writeConfig.owner,
            repo: writeConfig.repo,
            title: writeConfig.issueTitle,
            body: writeConfig.issueBody,
          },
        },
      ],
      'GITHUB_CREATE_AN_ISSUE',
    );
    const created = results.find((r) => r.tool_slug === 'GITHUB_CREATE_AN_ISSUE');
    if (!created?.successful || typeof created?.data?.number !== 'number') {
      fail(`tạo issue thật thất bại: ${JSON.stringify(results).slice(0, 500)}`);
    }
    githubIssue = { number: created.data.number, url: created.data.url ?? null };
    report.writeArtifacts = { githubIssue, gmailMessageId: null, slackChannel: null, slackTs: null };
    log(`[live] bước 4 GHI: issue thật #${githubIssue.number} — ${githubIssue.url ?? '(không có URL)'}`);
  }
  markStep(4, {
    searchReturnsGithubCreateIssue: true,
    githubCreateSlug: githubCreate,
    discoveredSlugs: discovered,
    searchMs,
    getSchemasShapeAccepted: true,
    getSchemasShapeUsed: '{ tool_slugs: [<slug>, ...] }',
    schemasChecked: schemaSlugs,
    githubCreateIssueSchemaFields: schemaFields,
    githubCreateIssueSchemaRequired: schemaRequired,
    executeWrite: githubIssue
      ? `RAN — issue #${githubIssue.number} trên ${writeConfig.owner}/${writeConfig.repo}`
      : `NOT RUN — cần Huy phê duyệt rõ + env COMPOSIO_WRITE_REPO/TITLE/BODY (thiếu: ${writeConfig.missing.filter((m) => m.startsWith('COMPOSIO_WRITE_REPO') || m.startsWith('COMPOSIO_WRITE_ISSUE')).join(', ') || 'không có env thiếu — kiểm tra checklist §8.1'})`,
    githubIssue,
  });

  // -- Bước 5 (phần GHI): Gmail + Slack — CHỈ sau khi bước 4 ghi đã
  // chạy (githubIssue có thật) VÀ env mail + slack đã đủ. Thiếu
  // điều kiện nào thì skipped có lý do, không fail cả run.
  if (githubIssue && writeConfig.mailReady && writeConfig.slackReady) {
    const results = await multiExecuteWrite(
      [
        {
          tool: 'GMAIL_SEND_EMAIL',
          arguments: {
            recipient_email: writeConfig.mailTo,
            subject: writeConfig.mailSubject,
            body: writeConfig.mailBody,
          },
        },
        {
          tool: 'SLACK_SEND_MESSAGE',
          arguments: { channel: writeConfig.slackChannel, markdown_text: writeConfig.slackText },
        },
      ],
      'GMAIL_SEND_EMAIL + SLACK_SEND_MESSAGE',
    );
    const mailResult = results.find((r) => r.tool_slug === 'GMAIL_SEND_EMAIL');
    const slackResult = results.find((r) => r.tool_slug === 'SLACK_SEND_MESSAGE');
    if (!mailResult?.successful || typeof mailResult?.data?.id !== 'string') {
      fail(`gửi mail thật thất bại: ${JSON.stringify(results).slice(0, 500)}`);
    }
    if (!slackResult?.successful || typeof slackResult?.data?.ts !== 'string') {
      fail(`gửi tin Slack thật thất bại: ${JSON.stringify(results).slice(0, 500)}`);
    }
    report.writeArtifacts.gmailMessageId = mailResult.data.id;
    report.writeArtifacts.slackChannel = writeConfig.slackChannel;
    report.writeArtifacts.slackTs = slackResult.data.ts;
    // Slack chat.delete cần channel ID, chat.postMessage chấp nhận
    // tên — lấy ID từ response gửi (data.channel) để bước 7 dùng.
    // (Live 2026-11-11: xoá bằng tên kênh lỗi "channel_not_found".)
    if (typeof slackResult.data.channel === 'string' && slackResult.data.channel) {
      report.writeArtifacts.slackChannelId = slackResult.data.channel;
    }
    markStep(5, {
      custodyWarningRecorded: true,
      gmailMessageId: mailResult.data.id,
      gmailTo: writeConfig.mailTo,
      slackChannel: writeConfig.slackChannel,
      slackChannelId: report.writeArtifacts.slackChannelId ?? null,
      slackTs: slackResult.data.ts,
    });
    log(`[live] bước 5 GHI: mail id=${mailResult.data.id}, Slack ts=${slackResult.data.ts}`);
  } else {
    const why = !githubIssue
      ? 'bước 4 ghi chưa chạy (chưa tạo issue thật)'
      : `thiếu env: ${writeConfig.missing.filter((m) => m.startsWith('COMPOSIO_WRITE_MAIL') || m.startsWith('COMPOSIO_WRITE_SLACK')).join(', ')}`;
    markSkipped(5, `Chỉ chạy sau khi bước 4 ghi xanh + Huy phê duyệt rõ (checklist §8.1) + env đủ — ${why}.`);
    report.notes.push('Bước 4 execute (tạo issue thật) + bước 5 gửi mail/Slack thật CHƯA chạy — cần Huy phê duyệt rõ repo test + hộp thư/kênh test (docs §8.1).');
  }

  // -- Bước 6: trễ 1 hop + tắt mạng tới Composio ---------------------------
  const manager = new ComposioSessionManager({
    getApiKey: () => SURROGATE,
    userId: FAKE_USER,
    getEnabledToolkits: () => ['gmail'],
  });
  const metaTools = createComposioMetaTools({ manager });
  const searchTool = metaTools.find((t) => t.definition.name === COMPOSIO_SEARCH_TOOL);
  const hopMs = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const found = await withTimeout(
      searchTool.execute({ query: 'send an email' }, { workspaceDir: botWs, botId: 'live-bot' }),
      120000,
      `1-hop search #${i + 1}`,
    );
    hopMs.push(Math.round((performance.now() - t0) * 10) / 10);
    if (!String(found).includes('GMAIL_SEND_EMAIL')) fail(`1-hop search #${i + 1} không trả GMAIL_SEND_EMAIL`);
  }
  hopMs.sort((a, b) => a - b);
  report.latencyMs.oneHopSearchMs = hopMs;
  report.latencyMs.oneHopMedianMs = hopMs[1];
  await manager.close();
  log(`[live] trễ 1 hop SEARCH_TOOLS (3 lần): ${hopMs.join(', ')} ms — median ${hopMs[1]}ms`);

  // Tắt mạng tới Composio (port không ai nghe): meta-tool lỗi sạch, không lộ key.
  const offlineManager = new ComposioSessionManager({
    getApiKey: () => SURROGATE,
    userId: FAKE_USER,
    getEnabledToolkits: () => ['gmail'],
    baseUrl: 'http://127.0.0.1:1/api/v3.1',
  });
  const offlineTools = createComposioMetaTools({ manager: offlineManager });
  const offlineSearch = offlineTools.find((t) => t.definition.name === COMPOSIO_SEARCH_TOOL);
  let offlineError = null;
  try {
    await withTimeout(
      offlineSearch.execute({ query: 'send an email' }, { workspaceDir: botWs, botId: 'live-bot' }),
      60000,
      'offline search',
    );
  } catch (err) {
    offlineError = err;
  } finally {
    await offlineManager.close();
  }
  if (!offlineError) fail('offline search phải lỗi mà lại thành công');
  if (offlineError.code !== 'composio_session_failed') fail(`offline error code sai: ${offlineError.code}`);
  if (String(offlineError.message).includes(SURROGATE)) fail('offline error lộ key/surrogate');
  log(`[live] offline: meta-tool lỗi sạch code=${offlineError.code}`);

  // App local vẫn chạy khi Composio mất mạng.
  const local = await coordinator.handle('runTool', {
    botId: 'live-bot',
    tool: 'glob_files',
    args: { pattern: '*.md' },
  });
  if (typeof local.output !== 'string' || !local.output.includes('Glob')) fail('tool local glob_files không chạy khi Composio offline');
  const state = await coordinator.handle('composio.getState', {});
  const bots = await coordinator.handle('listBots', {});
  if (!bots.botIds.includes('live-bot')) fail('listBots thiếu live-bot');
  markStep(6, {
    oneHopSearchMs: hopMs,
    oneHopMedianMs: hopMs[1],
    offlineMetaToolErrorCode: offlineError.code,
    offlineErrorLeaksKey: false,
    localToolStillWorks: true,
    coordinatorStillResponsive: state.enabled === true,
  });
  log('[live] bước 6 pass — 1 hop median %sms, offline lỗi sạch, app local vẫn chạy', hopMs[1]);

  // -- Bước 7: dọn dẹp (BẮT BUỘC sau test ghi, docs §8.1.4) ------------
  // Chỉ chạy khi bước ghi đã tạo artifact thật. Mỗi mục dọn chạy
  // riêng (1 MULTI_EXECUTE / mục) để 1 mục lỗi không giấu các mục
  // khác; kết quả từng mục ghi vào report. Issue đã đóng vẫn xem
  // được qua URL để kiểm tra sau; mail đã gửi không unsend được
  // (trash chỉ xoá bản trong Sent) — xem docs §8.1.4. Revoke
  // connection thật làm bằng tay trong dashboard Composio (không
  // tự revoke trong script).
  const artifacts = report.writeArtifacts;
  if (!artifacts) {
    markSkipped(7, 'Không có artifact thật nào để dọn (bước ghi chưa chạy).');
  } else {
    const cleanup = {};
    const runCleanup = async (label, toolSlug, args) => {
      try {
        const results = await multiExecuteWrite([{ tool: toolSlug, arguments: args }], `cleanup ${toolSlug}`);
        const done = results.find((r) => r.tool_slug === toolSlug);
        if (!done?.successful) throw new Error(`không successful: ${JSON.stringify(results).slice(0, 300)}`);
        cleanup[label] = { status: 'pass' };
        log(`[live] dọn dẹp ${label}: pass`);
      } catch (err) {
        cleanup[label] = { status: 'fail', reason: scrub(err instanceof Error ? err.message : String(err)) };
        log(`[live] dọn dẹp ${label}: FAIL — ${cleanup[label].reason}`);
      }
    };
    if (artifacts.githubIssue) {
      await runCleanup('githubClose', 'GITHUB_CLOSE_ISSUE', {
        owner: writeConfig.owner,
        repo: writeConfig.repo,
        issue_number: artifacts.githubIssue.number,
      });
    }
    if (artifacts.gmailMessageId) {
      await runCleanup('gmailTrash', 'GMAIL_MOVE_TO_TRASH', { message_id: artifacts.gmailMessageId });
    }
    if (artifacts.slackTs) {
      // Dùng channel ID (lấy ở bước 5) — chat.delete từ chối tên kênh.
      await runCleanup('slackDelete', 'SLACK_DELETES_A_MESSAGE_FROM_A_CHAT', {
        channel: artifacts.slackChannelId ?? artifacts.slackChannel,
        ts: artifacts.slackTs,
      });
    }
    const failed = Object.entries(cleanup).filter(([, v]) => v.status !== 'pass');
    if (failed.length > 0) {
      // Dọn thất bại thì bước 7 fail — không giấu; Huy dọn tay
      // phần còn lại theo report (số issue/URL, message-id, ts).
      report.steps.step7 = { status: 'fail', cleanup, note: 'Dọn dẹp chưa xong hết — dọn tay phần fail theo ID trong writeArtifacts.' };
    } else {
      markStep(7, { cleanup, revokeReminder: 'Revoke connection GitHub/Gmail/Slack trong dashboard Composio (làm bằng tay sau khi kiểm tra xong).' });
    }
  }
}

try {
  await main();
  // Kiểm tra báo cáo đủ bước: 1,2,3,4,6 pass; bước ghi (5) + dọn
  // (7) chỉ yêu cầu pass khi env input ghi đã đủ (v0.85), ngược
  // lại vẫn skipped có lý do — không fail cả run vì chưa phê duyệt.
  for (const n of [1, 2, 3, 4, 6]) {
    if (report.steps[`step${n}`]?.status !== 'pass') fail(`bước ${n} chưa pass`);
  }
  if (writeConfig.allReady) {
    if (report.steps.step5?.status !== 'pass') fail('bước 5 phải pass khi env ghi đã đủ');
    if (report.steps.step7?.status !== 'pass') fail('bước 7 (dọn dẹp) phải pass khi bước ghi đã chạy');
  } else {
    if (report.steps.step5?.status !== 'skipped') fail('bước 5 phải là skipped khi env ghi chưa đủ (chờ phê duyệt ghi)');
    if (report.steps.step7?.status !== 'skipped') fail('bước 7 phải là skipped khi không có artifact thật để dọn');
  }
  const scrubbed = JSON.parse(scrub(JSON.stringify(report)));
  if (JSON.stringify(scrubbed).includes(SURROGATE)) fail('báo cáo còn chứa surrogate');
  fs.writeFileSync(REPORT_PATH, JSON.stringify(scrubbed, null, 2), 'utf8');
  const writeSummary = writeConfig.allReady
    ? 'bước 5 GHI + bước 7 DỌN đã chạy'
    : 'bước 5 + 7 skipped (chờ Huy phê duyệt ghi, docs §8.1)';
  log(`[live] XONG — bước 1,2,3,4,6 pass; ${writeSummary}. Báo cáo: ${REPORT_PATH}`);
} catch (err) {
  try {
    report.error = scrub(err instanceof Error ? `${err.code ? `[${err.code}] ` : ''}${err.message}` : String(err));
    fs.writeFileSync(REPORT_PATH, JSON.stringify(JSON.parse(scrub(JSON.stringify(report))), null, 2), 'utf8');
  } catch {
    // Bỏ qua lỗi ghi báo cáo.
  }
  log(`[live] FAILED — ${report.error ?? 'unknown'}`);
  process.exitCode = 1;
} finally {
  try {
    if (writeClient) await writeClient.close();
  } catch {
    // Bỏ qua.
  }
  try {
    await coordinator.destroyBot({ botId: 'live-bot' });
  } catch {
    // Bỏ qua.
  }
  try {
    coordinator.shutdown();
  } catch {
    // Bỏ qua.
  }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
}
