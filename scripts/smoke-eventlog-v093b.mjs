/**
 * v0.93b — EventLogView smoke trong app Electron THẬT (xvfb + CDP):
 * phân trang >100 entries + đổi bot trong select + live tail bền.
 *
 * Khác v0.92b (1 bot Ollama, chạy thật 1 lượt, tối đa 8 entries):
 * seed SẴN NDJSON trên đĩa trước khi mở app — 150 entries cho bot A
 * (`smoke-ollama`, text `seeded A entry #i`, timestamp cách nhau 1s)
 * và 3 entries cho bot B (`smoke-second`, `second-bot entry #i`) —
 * rồi qua DevTools Protocol:
 *
 *   1. Mở EventLogView → trang đầu CHỈ 100 entries, count "100 / 150",
 *      nút "Tải thêm" còn đó, status live "đã kết nối" (không load
 *      hết một lần).
 *   2. Click "Tải thêm" → 150 entries, count "150 / 150", hết nút
 *      "Tải thêm", 150 summary KHÔNG trùng nhau.
 *   3. Đổi bot trong select sang bot B → đúng 3 entries của bot B,
 *      không lẫn 1 dòng nào của bot A, count "3 / 3".
 *   4. Đổi lại bot A → lại trang đầu 100 entries, entry đầu là
 *      `seeded A entry #0` (không kẹt log bot cũ, không stale).
 *   5. Live tail: chạy 1 lượt qua `window.openBot.sendChat` khi đang
 *      ở EventLogView → entry mới tự append, không cần refresh.
 *   6. Resync: chờ 32s (hơn 1 nhịp resync 30s của view) → số entry
 *      và tập summary KHÔNG đổi (resync không nhân đôi entry đã có).
 *   7. Refresh + tải thêm tới hết → tổng hiển thị == số dòng NDJSON
 *      trên đĩa, summary vẫn không trùng (không mất, không trùng).
 *   8. Thu console error / exception của renderer + stderr của main;
 *      chụp 5 screenshot làm bằng chứng.
 *
 * KHÔNG gọi API ngoài, KHÔNG dùng key: provider duy nhất là Ollama
 * local (http://127.0.0.1:11434, model qwen2.5:0.5b text-only), chỉ 1
 * lượt chạy thật. App chạy với --user-data-dir tạm nên không đụng dữ
 * liệu thật. Seed NDJSON chỉ chứa text vô hại, không secret.
 *
 * Evidence dir (v0.93b): mặc định `.smoke-scratch/eventlog-v093b/`
 * (gitignored — chạy suite không làm bẩn cây); đặt
 * SMOKE_EVENTLOG_REFRESH=1 để refresh snapshot đã commit ở
 * `docs/smoke-eventlog-v093b/`.
 *
 * Usage:
 *   node scripts/smoke-eventlog-v093b.mjs [--keep] [--timeout-ms 420000]
 *
 * Exit 0 = mọi assertion pass; exit 1 = có bước fail (in rõ bước nào).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'apps', 'desktop');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron');
const TMP = '/tmp/open-bot-eventlog93-smoke';
const USER_DATA = path.join(TMP, 'userdata');
const WORKSPACE = path.join(TMP, 'workspace');
const REFRESH_EVIDENCE = process.env.SMOKE_EVENTLOG_REFRESH === '1';
const SHOTS_DIR = REFRESH_EVIDENCE
  ? path.join(ROOT, 'docs', 'smoke-eventlog-v093b')
  : path.join(ROOT, '.smoke-scratch', 'eventlog-v093b');
const BOT_A = 'smoke-ollama';
const BOT_B = 'smoke-second';
const MODEL = 'qwen2.5:0.5b';
const SEED_A = 150;
const SEED_B = 3;
const DEBUG_PORT = 9300 + (process.pid % 300); // động như các smoke khác — tránh đụng port khi chạy song song

const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');
const TIMEOUT_MS = Number(
  (process.argv.find((a) => a.startsWith('--timeout-ms=')) ?? '').split('=')[1] ?? 420000,
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}
function fail(name, detail) {
  step(name, false, detail);
}

async function getJson(url, tries = 120) {
  // 60s — theo CDP_DEADLINE_MS (tests/cdp-deadline.mjs): Electron lạnh
  // dưới tải có thể mất >30s mới serve /json/list.
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`DevTools endpoint not up: ${url}`);
}

function seedNdjson(botId, count, prefix, baseMs) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      at: new Date(baseMs + i * 1000).toISOString(),
      botId,
      threadId: botId,
      kind: 'text',
      payload: { text: `${prefix} #${i}` },
    }));
  }
  return lines.join('\n') + '\n';
}

async function main() {
  // ---- Chuẩn bị thư mục tạm + seed settings.json (2 bot Ollama) ----
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  // Xoá bằng chứng fail của lần chạy trước (nếu lần này pass thì
  // không để file 99-failure.png cũ gây hiểu lầm).
  fs.rmSync(path.join(SHOTS_DIR, '99-failure.png'), { force: true });
  fs.rmSync(path.join(SHOTS_DIR, 'failure-diag.json'), { force: true });
  const bot = (id, name) => ({
    id,
    name,
    providerId: 'ollama',
    model: MODEL,
    systemPrompt: 'You are a test bot. Reply briefly.',
    workspaceDir: WORKSPACE,
    autoApprove: true,
    approvalLevel: 'auto-approve-safe',
    smallModelGuard: false,
  });
  const settings = {
    providers: {},
    bots: [bot(BOT_A, 'Smoke Ollama A'), bot(BOT_B, 'Smoke Ollama B')],
    locale: 'vi',
    api: { enabled: false, port: 3456 },
  };
  fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify(settings, null, 2));
  // Seed NDJSON: bot A 150 entries, bot B 3 entries. Timestamp lùi
  // về quá khứ (cách nhau 1s) để event live của lượt chạy thật (ở
  // "hiện tại") luôn mới hơn mọi entry seed.
  const logDir = path.join(USER_DATA, 'harness-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const baseMs = Date.now() - 300_000;
  fs.writeFileSync(path.join(logDir, `${BOT_A}.ndjson`), seedNdjson(BOT_A, SEED_A, 'seeded A entry', baseMs));
  fs.writeFileSync(path.join(logDir, `${BOT_B}.ndjson`), seedNdjson(BOT_B, SEED_B, 'second-bot entry', baseMs));

  // ---- Khởi động app thật dưới xvfb ----
  const app = spawn(
    'xvfb-run',
    ['-a', ELECTRON, '.', '--no-sandbox', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${USER_DATA}`],
    { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let mainOut = '';
  app.stdout.on('data', (d) => { mainOut += d; });
  app.stderr.on('data', (d) => { mainOut += d; });
  const killApp = () => {
    // Giết cả process group: SIGTERM gửi cho xvfb-run (shell script)
    // không tới được electron con, lần chạy trước đã để orphan.
    try { process.kill(-app.pid, 'SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* noop */ } }, 5000);
  };

  const startedAt = Date.now();
  const deadline = startedAt + TIMEOUT_MS;
  const timeLeft = () => deadline - Date.now();
  const assertTime = (label) => {
    if (timeLeft() <= 0) throw new Error(`timeout toàn cục ở bước: ${label}`);
  };

  // Hoist để catch cũng dùng được cho chẩn đoán khi fail.
  let ws = null;
  let send = null;
  let evalJs = null;

  try {
    const targets = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error(`không có page target (targets: ${targets.map((t) => t.type).join(',')})`);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(`exception: ${JSON.stringify(msg.params?.exceptionDetails).slice(0, 500)}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        consoleErrors.push(`console.error: ${JSON.stringify(msg.params?.args).slice(0, 500)}`);
      } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        consoleErrors.push(`log.error: ${msg.params.entry.text?.slice(0, 500)} ${msg.params.entry.url ?? ''}`);
      }
    };
    send = (method, params = {}) =>
      new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    evalJs = async (expression, awaitPromise = false) => {
      const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (res.result?.exceptionDetails) {
        throw new Error(`evaluate lỗi: ${JSON.stringify(res.result.exceptionDetails).slice(0, 500)} — expr: ${expression.slice(0, 200)}`);
      }
      return res.result?.result?.value;
    };
    const waitFor = async (label, fn, timeoutMs = 30000, stepMs = 500) => {
      const end = Date.now() + timeoutMs;
      let last = '';
      for (;;) {
        try {
          const v = await fn();
          if (v) return v;
          last = typeof v === 'string' ? v : JSON.stringify(v);
        } catch (e) { last = e.message; }
        if (Date.now() > end) throw new Error(`hết ${timeoutMs}ms chờ: ${label} (cuối: ${last})`);
        await sleep(stepMs);
      }
    };
    const clickButton = async (text) => evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === ${JSON.stringify(text)} && b.offsetParent !== null && !b.disabled);
      if (btns.length === 0) return 'missing';
      btns[0].click();
      return 'ok:' + btns.length;
    })()`);
    // v0.62 (UI-13): nav dưới sidebar gộp thành 1 menu "⋯ Menu" —
    // EventLogView nằm trong dropdown, không phải nút trực tiếp.
    const openEventLog = async () => {
      const menu = await clickButton('⋯ Menu');
      if (!menu.startsWith('ok')) return menu;
      await waitFor('nav dropdown mở', async () =>
        (await evalJs(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`)) ? 'ok' : '', 15000);
      return evalJs(`(() => {
        const el = document.querySelector('[data-nav-key="eventlog"]');
        if (!el) return 'missing';
        el.click();
        return 'ok';
      })()`);
    };
    const shot = async (name) => {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS_DIR, name);
      fs.writeFileSync(file, Buffer.from(res.result?.data ?? '', 'base64'));
      return file;
    };
    // Count line "100 / 150 event" + danh sách summary (<strong> mỗi li).
    const readList = async () => {
      const s = await evalJs(`JSON.stringify({
        n: document.querySelectorAll('.task-list li').length,
        countLine: [...document.querySelectorAll('span')].map((e) => e.textContent).find((t) => /\\d+ \\/ \\d+ event/.test(t)) ?? '',
        summaries: [...document.querySelectorAll('.task-list li strong')].map((e) => e.textContent),
        hasLoadMore: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Tải thêm' && b.offsetParent !== null && !b.disabled),
        liveStatus: document.querySelector('[data-testid="eventlog-live-status"]')?.textContent ?? '',
        firstSummary: document.querySelector('.task-list li strong')?.textContent ?? '',
      })`);
      const o = JSON.parse(s);
      const m = o.countLine.match(/(\d+) \/ (\d+) event/);
      return { ...o, shown: m ? Number(m[1]) : -1, total: m ? Number(m[2]) : -1 };
    };
    const selectBot = async (botId) => evalJs(`(() => {
      const sel = document.querySelector('#eventlog-bot');
      if (!sel) return 'no-select';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, ${JSON.stringify(botId)});
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    // ---- 1. App mount + mở EventLogView: trang đầu 100 / 150 ----
    await waitFor('app mount (#root có con)', async () =>
      (await evalJs(`document.getElementById('root')?.children?.length ?? 0`)) > 0, 60000);
    step('app mount dưới xvfb', true);
    assertTime('mở EventLogView');
    const click1 = await openEventLog();
    step('menu → EventLogView', click1.startsWith('ok'), click1);
    await waitFor('h2 "Nhật ký event" trong pane chính', async () =>
      (await evalJs(`document.querySelector('.main h2')?.textContent ?? ''`)) === 'Nhật ký event', 30000);
    const first = await waitFor('trang đầu load xong: 100 / 150', async () => {
      const l = await readList();
      return l.shown === 100 && l.total === SEED_A ? l : '';
    }, 60000);
    step('phân trang: trang đầu chỉ 100 entries (không load hết 150)', first.shown === 100 && first.total === 150, `count="${first.countLine}"`);
    step('nút "Tải thêm" còn đó khi chưa hết trang', first.hasLoadMore, `hasLoadMore=${first.hasLoadMore}`);
    step('status live "đã kết nối"', first.liveStatus.includes('đã kết nối'), first.liveStatus);
    step('entry đầu là seed #0 (oldest-first)', first.firstSummary === 'seeded A entry #0', first.firstSummary);
    const shot1 = await shot('01-paging-first-page.png');

    // ---- 2. Tải thêm → 150 / 150, không trùng ----
    assertTime('tải thêm');
    const more = await clickButton('Tải thêm');
    step('click "Tải thêm"', more.startsWith('ok'), more);
    const all = await waitFor('load-more xong: 150 / 150', async () => {
      const l = await readList();
      return l.shown === 150 && l.total === SEED_A ? l : '';
    }, 60000);
    step('tải thêm: đủ 150 / 150 entries', all.shown === 150 && all.total === 150, `count="${all.countLine}"`);
    step('hết trang thì mất nút "Tải thêm"', !all.hasLoadMore, `hasLoadMore=${all.hasLoadMore}`);
    step('150 summary không trùng nhau', new Set(all.summaries).size === 150, `unique=${new Set(all.summaries).size}/150`);
    const shot2 = await shot('02-paging-all-loaded.png');

    // ---- 3. Đổi bot trong select → đúng log bot B, không lẫn bot A ----
    assertTime('đổi bot sang B');
    const selB = await selectBot(BOT_B);
    step('select bot → smoke-second', selB === BOT_B, selB);
    const botB = await waitFor('bot B load xong: 3 / 3', async () => {
      const l = await readList();
      return l.shown === 3 && l.total === SEED_B ? l : '';
    }, 60000);
    step('đổi bot: đúng 3 entries của bot B', botB.shown === 3 && botB.total === 3, `count="${botB.countLine}"`);
    step(
      'đổi bot: không lẫn entry bot A',
      botB.summaries.every((s) => s.includes('second-bot entry')) && !botB.summaries.some((s) => s.includes('seeded A entry')),
      `summaries=[${botB.summaries.join(' | ')}]`,
    );
    const shot3 = await shot('03-bot-switched.png');

    // ---- 4. Đổi lại bot A → lại trang đầu 100, không kẹt log bot B ----
    assertTime('đổi bot về A');
    const selA = await selectBot(BOT_A);
    step('select bot → smoke-ollama', selA === BOT_A, selA);
    const backA = await waitFor('bot A load lại: 100 / 150', async () => {
      const l = await readList();
      return l.shown === 100 && l.total === SEED_A ? l : '';
    }, 60000);
    step('đổi lại bot A: lại trang đầu 100 / 150', backA.shown === 100 && backA.total === 150, `count="${backA.countLine}"`);
    step(
      'đổi lại bot A: không còn entry bot B',
      !backA.summaries.some((s) => s.includes('second-bot entry')) && backA.firstSummary === 'seeded A entry #0',
      `first="${backA.firstSummary}"`,
    );

    // ---- 5. Live tail: 1 lượt chạy thật, entry mới tự append ----
    assertTime('live tail');
    const before = await readList();
    const liveRes = await evalJs(
      `window.openBot.sendChat(${JSON.stringify(BOT_A)}, 'Say hello in Vietnamese, one short sentence. Do not call any tools.')`,
      true,
    );
    step('live-tail run qua sendChat hoàn tất', liveRes?.ok === true, JSON.stringify(liveRes)?.slice(0, 200));
    const afterLive = await waitFor('live tail append entry mới (không refresh)', async () => {
      const l = await readList();
      const hasNew = l.summaries.some((s) => !before.summaries.includes(s));
      return l.n > before.n && hasNew ? l : '';
    }, 120000);
    step('live tail append entry mới vào list', afterLive.n > before.n, `trước=${before.n} sau=${afterLive.n} total=${afterLive.total}`);
    const shot4 = await shot('04-live-tail.png');

    // ---- 6. Resync: chờ hơn 1 nhịp 30s → không nhân đôi entry ----
    assertTime('resync 30s');
    const beforeResync = await readList();
    await sleep(32000);
    const afterResync = await readList();
    step(
      'resync 30s không nhân đôi entry đã có',
      afterResync.n === beforeResync.n && afterResync.total === beforeResync.total,
      `trước=${beforeResync.n}/${beforeResync.total} sau=${afterResync.n}/${afterResync.total}`,
    );
    const sortedBefore = [...beforeResync.summaries].sort();
    const sortedAfter = [...afterResync.summaries].sort();
    step(
      'resync 30s không đổi tập summary',
      JSON.stringify(sortedBefore) === JSON.stringify(sortedAfter),
      `unique trước=${new Set(beforeResync.summaries).size} sau=${new Set(afterResync.summaries).size}`,
    );
    const shot5 = await shot('05-after-resync.png');

    // ---- 7. Refresh + tải thêm tới hết: tổng == dòng NDJSON trên đĩa ----
    assertTime('refresh + tải thêm');
    const refresh = await clickButton('Làm mới');
    step('click "Làm mới"', refresh.startsWith('ok'), refresh);
    const refreshed = await waitFor('refresh xong: lại 100 / total', async () => {
      const l = await readList();
      return l.shown === 100 && l.total >= SEED_A ? l : '';
    }, 60000);
    step('refresh: lại trang đầu 100', refreshed.shown === 100, `count="${refreshed.countLine}"`);
    const diskLinesA = fs
      .readFileSync(path.join(logDir, `${BOT_A}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean).length;
    let guard = 0;
    let finalList = refreshed;
    while (finalList.hasLoadMore && guard < 5) {
      guard += 1;
      const c = await clickButton('Tải thêm');
      if (!c.startsWith('ok')) break;
      finalList = await waitFor(`tải thêm lần ${guard}: đủ total`, async () => {
        const l = await readList();
        return l.shown === l.total && l.total >= SEED_A ? l : '';
      }, 60000);
    }
    step('tải thêm tới hết sau refresh', finalList.shown === finalList.total, `count="${finalList.countLine}"`);
    step(
      'tổng hiển thị == số dòng NDJSON trên đĩa (không mất, không trùng)',
      finalList.total === diskLinesA && new Set(finalList.summaries).size === finalList.total,
      `total=${finalList.total} diskLines=${diskLinesA} unique=${new Set(finalList.summaries).size}`,
    );

    // ---- 8. Console errors / main stderr ----
    const jsErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
    step('không lỗi JS trong renderer console', jsErrors.length === 0, jsErrors.slice(0, 5).join(' | ') || '0 lỗi');
    const errLines = mainOut.split('\n').filter(
      (l) => /error|unhandled|fatal/i.test(l) && !/gpu|dbus|bluez|bluetooth|vaapi|ozone/i.test(l),
    );
    step('không lỗi nghiêm trọng trong main log', errLines.length === 0, errLines.slice(0, 3).join(' | ') || 'sạch');

    ws.close();
    const summary = {
      ok: process.exitCode !== 1,
      steps,
      shots: [shot1, shot2, shot3, shot4, shot5],
      seededA: SEED_A,
      seededB: SEED_B,
      diskLinesA,
      finalTotal: finalList.total,
      consoleErrors: jsErrors,
      mainLogTail: mainOut.split('\n').slice(-30).join('\n'),
      durationMs: Date.now() - startedAt,
    };
    fs.writeFileSync(path.join(SHOTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(SHOTS_DIR, 'main.log'), mainOut.slice(-200000));
    console.log(`\nSMOKE ${summary.ok ? 'PASS' : 'FAIL'} in ${summary.durationMs}ms — shots: ${SHOTS_DIR}`);
  } catch (e) {
    fail('smoke chạy trọn vẹn', e.message);
    console.error(e);
    // Chẩn đoán khi fail: screenshot + DOM hiện tại (đừng để lần sau mù).
    try {
      if (ws && ws.readyState === 1) {
        const shotRes = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOTS_DIR, '99-failure.png'), Buffer.from(shotRes.result?.data ?? '', 'base64'));
        const diag = await evalJs(`JSON.stringify({
          url: location.href,
          h2: [...document.querySelectorAll('h2')].map((h) => h.textContent),
          bodyStart: document.body.innerText.slice(0, 1200),
        })`);
        console.log('DIAG', diag);
        fs.writeFileSync(path.join(SHOTS_DIR, 'failure-diag.json'), diag);
      }
    } catch { /* chẩn đoán là best-effort */ }
    try {
      fs.writeFileSync(path.join(SHOTS_DIR, 'main.log'), mainOut.slice(-200000));
      fs.writeFileSync(path.join(SHOTS_DIR, 'summary.json'), JSON.stringify({ ok: false, steps, error: e.message }, null, 2));
    } catch { /* noop */ }
  } finally {
    killApp();
    if (!KEEP) {
      await sleep(3000);
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  }
  process.exit(process.exitCode ?? 0);
}

main();
