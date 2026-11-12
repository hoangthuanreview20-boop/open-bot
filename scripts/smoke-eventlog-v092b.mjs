/**
 * v0.92b — EventLogView smoke trong app Electron THẬT (xvfb + CDP).
 *
 * Chạy app desktop thật dưới xvfb với user-data tạm (settings.json đã
 * seed 1 bot Ollama local `qwen2.5:0.5b`), rồi qua DevTools Protocol:
 *
 *   1. Mở EventLogView từ sidebar → view render, IPC `harness:status` /
 *      `harness:thread-log` trả về (không "chưa khả dụng"), empty state
 *      đúng ("Thread này chưa có event nào").
 *   2. Quay lại chat, gửi 1 tin qua composer thật (textarea + nút Gửi),
 *      chờ run Ollama local xong; đối chiếu NDJSON trên đĩa
 *      `<userData>/harness-logs/smoke-ollama.ndjson`.
 *   3. Mở lại EventLogView → entries thật xuất hiện (kind text +
 *      lifecycle, summary chứa câu trả lời), test filter theo kind
 *      (tắt "Lỗi" → list rỗng, bật lại → entries trở lại), mở payload
 *      của 1 entry.
 *   4. Live tail: khi đang ở EventLogView, chạy thêm 1 lượt qua
 *      `window.openBot.sendChat` và kiểm tra entry mới tự append vào
 *      list mà KHÔNG cần refresh.
 *   5. Thu console error / exception của renderer + stderr của main;
 *      chụp 3 screenshot làm bằng chứng.
 *
 * KHÔNG gọi API ngoài, KHÔNG dùng key: provider duy nhất là Ollama
 * local (http://127.0.0.1:11434, model qwen2.5:0.5b text-only).
 * App chạy với --user-data-dir tạm nên không đụng dữ liệu thật.
 *
 * Usage:
 *   node scripts/smoke-eventlog-v092b.mjs [--keep] [--timeout-ms 420000]
 *
 * Evidence dir (v0.93b — fixes the recurring dirty-tree bug): by
 * default screenshots/summary.json/main.log go to the gitignored
 * scratch dir `.smoke-scratch/eventlog-v092b/` so running the test
 * suite never dirties `git status`. Set SMOKE_EVENTLOG_REFRESH=1 to
 * refresh the COMMITTED snapshot under `docs/smoke-eventlog-v092b/`
 * instead (explicit, intentional — e.g. when the view changed and
 * the checked-in evidence should match the new behaviour).
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
const TMP = '/tmp/open-bot-eventlog92-smoke';
const USER_DATA = path.join(TMP, 'userdata');
const WORKSPACE = path.join(TMP, 'workspace');
const REFRESH_EVIDENCE = process.env.SMOKE_EVENTLOG_REFRESH === '1';
const SHOTS_DIR = REFRESH_EVIDENCE
  ? path.join(ROOT, 'docs', 'smoke-eventlog-v092b')
  : path.join(ROOT, '.smoke-scratch', 'eventlog-v092b');
const BOT_ID = 'smoke-ollama';
const BOT_NAME = 'Smoke Ollama';
const MODEL = 'qwen2.5:0.5b';
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

async function main() {
  // ---- Chuẩn bị thư mục tạm + seed settings.json (1 bot Ollama) ----
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  // Xoá bằng chứng fail của lần chạy trước (nếu lần này pass thì
  // không để file 99-failure.png cũ gây hiểu lầm).
  fs.rmSync(path.join(SHOTS_DIR, '99-failure.png'), { force: true });
  fs.rmSync(path.join(SHOTS_DIR, 'failure-diag.json'), { force: true });
  const settings = {
    providers: {},
    bots: [
      {
        id: BOT_ID,
        name: BOT_NAME,
        providerId: 'ollama',
        model: MODEL,
        systemPrompt: 'You are a test bot. Reply briefly.',
        workspaceDir: WORKSPACE,
        autoApprove: true,
        approvalLevel: 'auto-approve-safe',
        smallModelGuard: false,
      },
    ],
    locale: 'vi',
    api: { enabled: false, port: 3456 },
  };
  fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify(settings, null, 2));

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

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    // ---- 1. App mount + sidebar có nút EventLog ----
    await waitFor('app mount (#root có con)', async () =>
      (await evalJs(`document.getElementById('root')?.children?.length ?? 0`)) > 0, 60000);
    step('app mount dưới xvfb', true);
    const sidebarBtn = await waitFor('nút sidebar "⋯ Menu" (chứa EventLog)', async () => {
      const r = await evalJs(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '⋯ Menu');
        return b ? 'ok' : '';
      })()`);
      return r === 'ok' ? r : '';
    }, 30000);
    step('sidebar có menu chứa EventLog', sidebarBtn === 'ok');

    // ---- 2. Mở EventLogView lần 1: render + IPC ok + empty state ----
    assertTime('mở EventLogView lần 1');
    const click1 = await openEventLog();
    step('menu → EventLogView', click1.startsWith('ok'), click1);
    await waitFor('h2 "Nhật ký event" trong pane chính', async () =>
      (await evalJs(`document.querySelector('.main h2')?.textContent ?? ''`)) === 'Nhật ký event', 30000);
    await waitFor('view load xong (hết "Đang tải")', async () =>
      !(await evalJs(`document.body.innerText.includes('Đang tải nhật ký')`)), 30000);
    const view1 = await evalJs(`JSON.stringify({
      title: document.querySelector('.main h2')?.textContent ?? '',
      allH2: [...document.querySelectorAll('h2')].map((h) => h.textContent),
      hasEmpty: document.body.innerText.includes('Thread này chưa có event nào'),
      hasUnavailable: document.body.innerText.includes('chưa khả dụng'),
      hasLoadError: document.body.innerText.includes('Không tải được nhật ký'),
      hasBotSelect: !!document.querySelector('#eventlog-bot'),
      statusLine: [...document.querySelectorAll('p')].map((p) => p.textContent).find((s) => s.includes('instance')) ?? '',
    })`);
    const v1 = JSON.parse(view1);
    step('EventLogView render (title + select bot)', v1.title === 'Nhật ký event' && v1.hasBotSelect, JSON.stringify(v1));
    step('IPC harness:thread-log trả về (không "chưa khả dụng"/lỗi tải)', !v1.hasUnavailable && !v1.hasLoadError, `unavailable=${v1.hasUnavailable} loadError=${v1.hasLoadError}`);
    step('empty state đúng khi chưa chạy bot', v1.hasEmpty, `hasEmpty=${v1.hasEmpty}`);
    step('status line harness hiển thị', v1.statusLine !== '', v1.statusLine);
    const shot1 = await shot('01-eventlog-empty.png');

    // ---- 3. Về chat, gửi 1 tin qua composer thật ----
    assertTime('về chat');
    const back = await clickButton('← Quay lại chat');
    step('back về chat', back.startsWith('ok'), back);
    await waitFor('composer textarea', async () =>
      (await evalJs(`!!document.querySelector('textarea')`)) ? 'ok' : '', 30000);
    const setText = await evalJs(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'Reply with exactly the Vietnamese greeting for hello followed by the number 42, nothing else. Do not call any tools.');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value.includes('Vietnamese greeting') ? 'ok' : 'mismatch';
    })()`);
    step('nhập tin vào composer', setText === 'ok', setText);
    const sendClick = await clickButton('Gửi');
    step('click Gửi', sendClick.startsWith('ok'), sendClick);
    // Chờ run xong: textarea mở lại + có assistant message (nút Nghe)
    // + footer usage của lượt đó. KHÔNG assert nội dung câu trả lời:
    // qwen2.5:0.5b không tuân lệnh "trả đúng câu X" theo từng chữ
    // (lần chạy trước nó diễn đạt lại thay vì lặp đúng "Xin chào 42").
    await waitFor('run Ollama xong (textarea mở + có câu trả lời)', async () => {
      const s = await evalJs(`JSON.stringify({
        taEnabled: (() => { const ta = document.querySelector('textarea'); return ta ? !ta.disabled : false; })(),
        speakBtns: document.querySelectorAll('[data-testid^="speak-"]').length,
        usage: document.querySelectorAll('[data-testid="turn-usage"]').length,
      })`);
      const o = JSON.parse(s);
      return o.taEnabled && o.speakBtns >= 1 && o.usage >= 1 ? 'ok' : '';
    }, 180000, 1000);
    step('bot Ollama trả lời qua UI thật (có usage + nút Nghe)', true);

    // ---- 4. Đối chiếu NDJSON trên đĩa ----
    const ndjsonFile = path.join(USER_DATA, 'harness-logs', `${BOT_ID}.ndjson`);
    const nd = await waitFor('NDJSON harness-logs có dòng', async () => {
      try {
        const lines = fs.readFileSync(ndjsonFile, 'utf8').trim().split('\n').filter(Boolean);
        return lines.length >= 3 ? lines : '';
      } catch { return ''; }
    }, 60000);
    const kindsOnDisk = nd.map((l) => { try { return JSON.parse(l).kind; } catch { return '?'; } });
    step('NDJSON trên đĩa có event của run', kindsOnDisk.length >= 3, `${ndjsonFile}: [${kindsOnDisk.join(', ')}]`);
    step('NDJSON có kind text + lifecycle', kindsOnDisk.includes('text') && kindsOnDisk.includes('lifecycle'), `[${kindsOnDisk.join(', ')}]`);

    // ---- 5. Mở lại EventLogView: entries thật ----
    assertTime('mở EventLogView lần 2');
    const click2 = await openEventLog();
    step('menu → EventLogView lần 2', click2.startsWith('ok'), click2);
    const entries = await waitFor('entries xuất hiện trong list', async () => {
      const s = await evalJs(`JSON.stringify({
        n: document.querySelectorAll('.task-list li').length,
        countLine: [...document.querySelectorAll('span')].map((e) => e.textContent).find((t) => t.includes('event')) ?? '',
      })`);
      const o = JSON.parse(s);
      return o.n >= 2 ? o : '';
    }, 60000);
    const entryKinds = await evalJs(`JSON.stringify([...document.querySelectorAll('.task-list .badge')].map((b) => b.textContent))`);
    const kinds = JSON.parse(entryKinds);
    step('EventLogView hiện entries thật sau run', true, `entries=${entries.n} countLine="${entries.countLine}" kinds=[${kinds.join(', ')}]`);
    step('entries gồm text + lifecycle', kinds.includes('Text') && kinds.includes('Vòng đời'), `[${kinds.join(', ')}]`);
    const shot2 = await shot('02-eventlog-filled.png');

    // ---- 6. Filter theo kind ----
    // Tắt kind CÓ entry ("Vòng đời": 2/3 entries) → list chỉ còn entry
    // Text; bật lại → đủ 3. (Tắt "Lỗi" không kiểm chứng được gì vì
    // chưa có error event nào — list vẫn 3/3 là đúng.)
    const filterOff = await clickButton('Vòng đời');
    step('click filter "Vòng đời" (tắt kind lifecycle)', filterOff.startsWith('ok'), filterOff);
    await waitFor('filter Vòng đời → chỉ còn 1 entry Text', async () => {
      const s = await evalJs(`JSON.stringify({
        n: document.querySelectorAll('.task-list li').length,
        badges: [...document.querySelectorAll('.task-list .badge')].map((b) => b.textContent),
      })`);
      const o = JSON.parse(s);
      return o.n === 1 && o.badges.length === 1 && o.badges[0] === 'Text' ? 'ok' : '';
    }, 30000);
    step('filter kind hoạt động (tắt Vòng đời → chỉ còn Text)', true);
    const filterOn = await clickButton('Vòng đời');
    step('click filter "Vòng đời" lần nữa (bật lại)', filterOn.startsWith('ok'), filterOn);
    await waitFor('entries trở lại sau khi bật filter', async () =>
      (await evalJs(`document.querySelectorAll('.task-list li').length`)) >= 2 ? 'ok' : '', 30000);
    step('bật lại filter → entries trở lại', true);

    // ---- 7. Mở payload 1 entry ----
    const payloadClick = await clickButton('Hiện payload');
    step('click "Hiện payload"', payloadClick.startsWith('ok'), payloadClick);
    await waitFor('pre payload xuất hiện', async () =>
      (await evalJs(`document.querySelectorAll('.task-list pre').length`)) >= 1 ? 'ok' : '', 15000);
    const payloadText = await evalJs(`document.querySelector('.task-list pre')?.textContent?.slice(0, 200) ?? ''`);
    step('payload JSON hiển thị', payloadText.includes('{') || payloadText.includes('"'), payloadText.slice(0, 120));

    // ---- 8. Live tail: chạy thêm 1 lượt khi đang ở EventLogView ----
    // Không assert nội dung câu trả lời theo từng chữ (0.5b diễn đạt
    // lại) — assert list có entry MỚI: số entry tăng + xuất hiện 1
    // summary chưa từng có trước lượt này, mà KHÔNG cần refresh.
    assertTime('live tail');
    const before = await evalJs(`JSON.stringify({
      n: document.querySelectorAll('.task-list li').length,
      texts: [...document.querySelectorAll('.task-list li')].map((li) => li.textContent.slice(0, 200)),
    })`);
    const beforeState = JSON.parse(before);
    const liveRes = await evalJs(
      `window.openBot.sendChat(${JSON.stringify(BOT_ID)}, 'Say hello in Vietnamese, one short sentence. Do not call any tools.')`,
      true,
    );
    step('live-tail run qua sendChat hoàn tất', liveRes?.ok === true, JSON.stringify(liveRes)?.slice(0, 200));
    await waitFor('live tail append entry mới (không refresh)', async () => {
      const s = await evalJs(`JSON.stringify({
        n: document.querySelectorAll('.task-list li').length,
        texts: [...document.querySelectorAll('.task-list li')].map((li) => li.textContent.slice(0, 200)),
      })`);
      const o = JSON.parse(s);
      const hasNew = o.texts.some((t) => !beforeState.texts.includes(t));
      return o.n > beforeState.n && hasNew ? o : '';
    }, 60000);
    const after = await evalJs(`document.querySelectorAll('.task-list li').length`);
    step('live tail append entry mới vào list', after > beforeState.n, `trước=${beforeState.n} sau=${after}`);
    const shot3 = await shot('03-eventlog-livetil.png');

    // ---- 9. Console errors / main stderr ----
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
      shots: [shot1, shot2, shot3],
      ndjsonFile,
      kindsOnDisk,
      kindsInView: kinds,
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
