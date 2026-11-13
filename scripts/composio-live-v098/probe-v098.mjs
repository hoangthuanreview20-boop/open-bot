/**
 * Live probe Composio v0.98 (Team T3) — CHỈ ĐỌC + POLL, KHÔNG GHI.
 *
 * Chạy qua driver (không chạy trực tiếp — cần surrogate từ connector):
 *   python3 scripts/composio-live-v072/run-live.py /home/hatch/workspace/open-bot-v098-composio/scripts/composio-live-v098/probe-v098.mjs
 *
 * Key: KHÔNG BAO GIỜ xuất hiện ở đây (surrogate qua env, scrub mọi
 * output). Session MCP URL là secret — không log.
 *
 * Kiểm chứng:
 *  1. 3 connection Active với user id dashboard
 *     pg-test-0d236b17-eece-4031-aae3-e8dbc3d70910 (GitHub openbot1,
 *     Gmail hoangthuanreview20@gmail.com, Slack workspace "open-bot").
 *  2. GET_TOOL_SCHEMAS thật của slug toolkit mới v0.96 (stripe /
 *     gitlab / youtube) — đối chiếu discovery list-tools.
 *  3. Poll Gmail thật qua ComposioPoller + ComposioSessionManager
 *     (fetchItems = manager.executeTools GMAIL_FETCH_EMAILS):
 *     poll lần 1 (mail 15 phút gần nhất), poll lần 2 (0 mới — dedupe),
 *     enqueue vào queue qua pollBridge. Báo cáo chỉ ghi SỐ LƯỢNG +
 *     tên field (không ghi tiêu đề/nội dung mail).
 *
 * Bước GHI (issue/mail/Slack thật) KHÔNG ở đây — chạy bằng
 * scripts/composio-live-v072/live.mjs với env đã duyệt (xem docs §8.1).
 * Báo cáo JSON: scripts/composio-live-v098/report.json (scrubbed).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ComposioSessionManager,
  ComposioTriggerQueue,
  ComposioPoller,
  createGmailPollerConfig,
  enqueueComposioPollResult,
  parseComposioPollItems,
} from '../../packages/core/dist/composio/index.js';

const SURROGATE = process.env.COMPOSIO_KEY_SURROGATE ?? '';
if (!SURROGATE.startsWith('hsurr:')) {
  console.error('probe: thiếu COMPOSIO_KEY_SURROGATE trong env — chạy qua run-live.py');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(HERE, 'report.json');
const WRITE_USER_ID = 'pg-test-0d236b17-eece-4031-aae3-e8dbc3d70910';

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
  harness: 'composio-live-v098',
  mode: 'live (API Composio thật, key qua surrogate — không key thô)',
  ranAt: new Date().toISOString(),
  writeUserId: WRITE_USER_ID,
  connections: {},
  newToolkitSchemas: {},
  gmailPoll: {},
  notes: [],
};

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

/** Bóc danh sách item từ output MULTI_EXECUTE — dùng parser của core
 * (cùng hàm main process dùng cho scheduler nền); chỉ ghi TÊN field
 * của item đầu vào báo cáo, KHÔNG ghi tiêu đề/nội dung mail. */
function itemKeys(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const first = items[0];
  return first !== null && typeof first === 'object' ? Object.keys(first) : [];
}

async function main() {
  const manager = new ComposioSessionManager({
    getApiKey: () => SURROGATE,
    userId: WRITE_USER_ID,
    // 'stripe' có mặt để SEARCH_TOOLS thấy slug Stripe: search của
    // Tool Router chỉ trả tool của toolkit đang bật trong session
    // (xác nhận live: session chỉ github/gmail/slack → 0 slug STRIPE_*;
    // thêm stripe → trả STRIPE_CREATE_CUSTOMER).
    getEnabledToolkits: () => ['github', 'gmail', 'slack', 'stripe'],
  });

  // -- 1. getConnectionStatus: 3 connection Active ----------------------
  // Dùng API của chính sản phẩm (ComposioSessionManager) — nó gọi
  // COMPOSIO_MANAGE_CONNECTIONS rồi bóc accountLabel từ
  // current_user_info. Session tạo ngầm bên trong manager.
  const statusList = await withTimeout(
    manager.getConnectionStatus(['github', 'gmail', 'slack']),
    120000,
    'getConnectionStatus',
  );
  for (const entry of statusList) {
    report.connections[entry.toolkit] = {
      status: entry.status,
      accountLabel: entry.accountLabel ?? null,
    };
  }
  const inactive = ['github', 'gmail', 'slack'].filter((t) => report.connections[t]?.status !== 'active');
  if (inactive.length > 0) fail(`connection chưa Active cho: ${inactive.join(', ')}`);
  log(`[probe] 3 connection Active: github=${report.connections.github.accountLabel} gmail=${report.connections.gmail.accountLabel} slack=${report.connections.slack.accountLabel}`);

  // -- 2. GET_TOOL_SCHEMAS thật cho slug toolkit mới v0.96 --------------
  const schemaSlugs = ['STRIPE_CREATE_CUSTOMER', 'GITLAB_ADD_PROJECT_MEMBER', 'YOUTUBE_CREATE_CHANNEL_SECTION'];
  const schemasOut = await withTimeout(manager.getToolSchemas(schemaSlugs), 120000, 'GET_TOOL_SCHEMAS (toolkit moi)');
  const schemasText = String(schemasOut);
  for (const slug of schemaSlugs) {
    if (!schemasText.includes(slug)) fail(`GET_TOOL_SCHEMAS không trả schema ${slug}`);
  }
  let requiredBySlug = {};
  try {
    const parsed = JSON.parse(schemasText);
    const map = parsed?.data?.tool_schemas ?? {};
    for (const slug of schemaSlugs) {
      requiredBySlug[slug] = map[slug]?.input_schema?.required ?? null;
    }
  } catch {
    requiredBySlug = { note: '(không parse được JSON — xem output thô)' };
  }
  report.newToolkitSchemas = { slugs: schemaSlugs, requiredBySlug };
  log(`[probe] GET_TOOL_SCHEMAS toolkit mới: ${schemaSlugs.join(', ')} — required: ${JSON.stringify(requiredBySlug)}`);

  // SEARCH_TOOLS cho toolkit mới (discovery lúc chạy, như thiết kế router).
  const searchOut = await withTimeout(manager.searchTools('create a Stripe customer'), 120000, 'SEARCH_TOOLS stripe');
  const foundStripe = [...new Set(String(searchOut).match(/STRIPE_[A-Z0-9_]+/g) ?? [])].sort();
  report.newToolkitSchemas.searchStripe = foundStripe.slice(0, 10);
  if (!foundStripe.includes('STRIPE_CREATE_CUSTOMER')) fail('SEARCH_TOOLS không trả STRIPE_CREATE_CUSTOMER');
  log(`[probe] SEARCH "create a Stripe customer" → ${foundStripe.length} slug STRIPE_*`);

  // -- 3. Poll Gmail thật qua ComposioPoller + pollBridge ---------------
  const poller = new ComposioPoller(
    createGmailPollerConfig(async (args) => {
      const out = await manager.executeTools([{ tool: 'GMAIL_FETCH_EMAILS', arguments: args }]);
      return parseComposioPollItems(out);
    }),
  );
  const queue = new ComposioTriggerQueue();
  const first = await withTimeout(poller.pollOnce(), 120000, 'poll Gmail lan 1');
  if (first.error) fail(`poll Gmail lần 1 lỗi: ${first.error}`);
  // Ít nhất 1 mail trong 15 phút gần nhất mới chứng minh được parser
  // bóc đúng shape thật (mailbox có mail — xác nhận bằng shape probe
  // riêng trước đó: 15m trả 5 message).
  if (first.newItems.length === 0) fail('poll Gmail lần 1 trả 0 item mới — parser có thể bóc sai shape (mailbox có mail 15 phút gần nhất)');
  const enqueuedFirst = enqueueComposioPollResult(queue, first, {});
  const second = await withTimeout(poller.pollOnce(), 120000, 'poll Gmail lan 2');
  if (second.error) fail(`poll Gmail lần 2 lỗi: ${second.error}`);
  const enqueuedSecond = enqueueComposioPollResult(queue, second, {});
  report.gmailPoll = {
    itemKeys: itemKeys(first.newItems),
    firstPoll: { totalFetched: first.totalFetched, newItems: first.newItems.length, enqueued: enqueuedFirst },
    secondPoll: { totalFetched: second.totalFetched, newItems: second.newItems.length, enqueued: enqueuedSecond },
    queuePendingAfter: queue.size,
    dedupeWorks: second.newItems.length === 0,
  };
  log(`[probe] poll Gmail: lần 1 fetched=${first.totalFetched} mới=${first.newItems.length} enqueue=${enqueuedFirst}; lần 2 mới=${second.newItems.length} enqueue=${enqueuedSecond}; queue=${queue.size}`);
  if (second.newItems.length !== 0) fail('dedupe poll Gmail lỗi: lần 2 vẫn có item mới');

  await manager.close();
  report.notes.push(
    'Poll Gmail thật chạy qua ComposioSessionManager.executeTools (GMAIL_FETCH_EMAILS, query newer_than:15m) — cùng đường mà scheduler nền dùng trong main process.',
  );
}

try {
  await main();
  const scrubbed = JSON.parse(scrub(JSON.stringify(report)));
  if (JSON.stringify(scrubbed).includes(SURROGATE)) fail('báo cáo còn chứa surrogate');
  fs.writeFileSync(REPORT_PATH, JSON.stringify(scrubbed, null, 2), 'utf8');
  log(`[probe] XONG — 3 connection Active, schemas toolkit mới ok, poll Gmail dedupe ok. Báo cáo: ${REPORT_PATH}`);
} catch (err) {
  try {
    report.error = scrub(err instanceof Error ? `${err.code ? `[${err.code}] ` : ''}${err.message}` : String(err));
    fs.writeFileSync(REPORT_PATH, JSON.stringify(JSON.parse(scrub(JSON.stringify(report))), null, 2), 'utf8');
  } catch {
    // Bỏ qua lỗi ghi báo cáo.
  }
  log(`[probe] FAILED — ${report.error ?? 'unknown'}`);
  process.exitCode = 1;
}
