/**
 * E2E v0.71 — xác thực LẠI PAT GitHub qua handler main thật
 * (`apps:list` / `apps:set-token`) trong app Electron thật dưới xvfb.
 *
 * v0.69a xác thực PAT lúc dán, v0.70b thêm GithubPatRevalidator xác
 * thực lại mỗi khi trạng thái app được query — nhưng cả hai mới chỉ
 * được test ở tầng core + mock (tests/github-pat-revalidate-v070).
 * Test này kiểm chứng đầu-cuối qua IPC thật:
 *
 *   profile mới hoàn toàn → mở Connected apps → dán PAT giả
 *   → trạng thái connected (kèm login do mock trả về)
 *   → mock chuyển sang 401 → refresh qua `apps:list` thật
 *   → trạng thái expired + hướng dẫn dán lại hiện trong UI
 *   → mock ngắt kết nối (lỗi mạng) → refresh → vẫn connected
 *     + ghi rõ lý do chưa kiểm tra được.
 *
 * KHÔNG BAO GIỜ gọi api.github.com thật: app được trỏ tới mock
 * server HTTP local (127.0.0.1, port ephemeral) qua env
 * `OPENBOT_GITHUB_API_BASE` (xem `githubPatApiBase` trong core —
 * production không set env này thì vẫn gọi api.github.com như cũ).
 * Nếu app bỏ qua env mà gọi GitHub thật thì PAT giả nhận 401, bước
 * dán token đã đỏ ngay — test tự phát hiện.
 *
 * Cache hợp lệ 1 giờ: lần dán token seed cache hợp lệ
 * (`seedValid`), nên sau khi mock chuyển 401, lần kiểm tra sau
 * phải thực sự gọi lại mạng thay vì trả cache. Test rút TTL cache
 * còn 200ms qua env `OPENBOT_GITHUB_PAT_REVALIDATE_CACHE_MS`
 * (xem main.ts — production không set env này thì vẫn 1 giờ) rồi
 * chờ 500ms trước mỗi lần refresh; đồng thời đếm số request tới
 * mock để khẳng định lần kiểm tra sau 401 / sau lỗi mạng thực sự
 * chạm mạng (số request tăng), không phải trả cache cũ.
 *
 * Token giả chỉ dùng `ghp_test_...` (không phải token thật), không
 * bao giờ được log hay đưa vào message lỗi — các assertion chỉ kiểm
 * tra trạng thái + chuỗi hướng dẫn, không kiểm tra giá trị token.
 *
 * Skips when there is no DISPLAY — same convention as the other smokes.
 *
 * Run: xvfb-run -a node --test tests/github-pat-revalidate-e2e-v071.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP_DEADLINE_MS } from './cdp-deadline.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const CDP_PORT = 9860 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;
/** TTL cache xác thực lại rút ngắn cho test (production mặc định 1 giờ). */
const REVALIDATE_CACHE_MS = 200;
/** Chờ lâu hơn TTL cache trước mỗi lần refresh để lần kiểm tra sau chạm mạng. */
const CACHE_SETTLE_MS = 500;
/** PAT giả — không phải token thật; không log, không đưa vào message lỗi. */
const FAKE_PAT = 'ghp_test_v071_fake_token_for_e2e_only';
/** Login mà mock trả về khi PAT còn sống (hiện làm nhãn tài khoản ở UI). */
const MOCK_LOGIN = 'testuser';

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Mock GitHub API (GET /user) trên 127.0.0.1, port ephemeral.
// Mode 'ok'      → 200 + { login } (PAT còn sống).
// Mode 'revoked' → 401 (PAT đã hết hạn / bị thu hồi).
// Mode 'reset'   → ngắt socket ngay (lỗi mạng: ECONNRESET ở phía fetch).
// Chỉ đếm request + ghi nhận có header Authorization dạng Bearer hay
// không — KHÔNG lưu, KHÔNG log giá trị token.
// ---------------------------------------------------------------------------
let mockMode = 'ok';
let mockRequests = 0;
let mockSawBearerAuth = false;

const mockServer = http.createServer((req, res) => {
  if (!req.url || !req.url.startsWith('/user')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  mockRequests += 1;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) mockSawBearerAuth = true;
  if (mockMode === 'revoked') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return;
  }
  if (mockMode === 'reset') {
    // Ngắt kết nối đột ngột — fetch phía main nhận lỗi mạng, không
    // phải status HTTP (khác 401: không được kết luận token hỏng).
    req.socket.destroy();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ login: MOCK_LOGIN }));
});

async function startMock() {
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const address = mockServer.address();
  assert.ok(address && typeof address === 'object', 'mock server did not bind');
  return address.port;
}

// ---------------------------------------------------------------------------
// CDP harness — mẫu từ tests/connected-apps-v067b-smoke.test.mjs.
// ---------------------------------------------------------------------------
const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-github-pat-revalidate-v071-e2e-xdg-'));
let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();
const pageExceptions = [];

function evalJs(expression) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP evaluate timed out after ${JS_TIMEOUT_MS}ms: ${expression.slice(0, 120)}`));
    }, JS_TIMEOUT_MS);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) return reject(new Error(`CDP ${m.error.message ?? JSON.stringify(m.error)}`));
      const details = m.result?.exceptionDetails;
      if (details) return reject(new Error(`evaluate threw: ${JSON.stringify(details).slice(0, 500)}`));
      resolve(m.result?.result?.value);
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

function attachWs(pageUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(pageUrl);
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed to open'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        pageExceptions.push(JSON.stringify(m.params?.exceptionDetails ?? m).slice(0, 1000));
        return;
      }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
  });
}

async function connectCdp() {
  // v0.85: 60s, not 30s — a cold Electron under full-suite load
  // can miss 30s before it serves /json/list (see tests/cdp-deadline.mjs).
  const deadline = Date.now() + CDP_DEADLINE_MS;
  let pageUrl = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const main = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (main) { pageUrl = main.webSocketDebuggerUrl; break; }
    } catch {
      // DevTools not up yet.
    }
    await sleep(500);
  }
  assert.ok(pageUrl, `CDP page target (index.html) did not appear in ${CDP_DEADLINE_MS / 1000}s`);
  await attachWs(pageUrl);
  ws.send(JSON.stringify({ id: nextId++, method: 'Runtime.enable', params: {} }));
  const mountDeadline = Date.now() + 30_000;
  while (Date.now() < mountDeadline) {
    const n = await evalJs(`document.getElementById('root')?.children.length ?? 0`);
    if (typeof n === 'number' && n > 0) return;
    await sleep(500);
  }
  throw new Error('React did not mount in the app window within 30s');
}

async function launchApp(mockPort) {
  child = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      // Trỏ app tới mock GitHub local + rút TTL cache xác thực lại.
      OPENBOT_GITHUB_API_BASE: `http://127.0.0.1:${mockPort}`,
      OPENBOT_GITHUB_PAT_REVALIDATE_CACHE_MS: String(REVALIDATE_CACHE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await connectCdp();
}

async function quitApp() {
  if (ws) { try { ws.close(); } catch { /* already closed */ } ws = null; }
  pending.clear();
  if (!child) return;
  const proc = child;
  child = null;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([exited, sleep(5000).then(() => proc.kill('SIGKILL'))]);
}

async function waitFor(expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evalJs(expression);
      if (last) return last;
    } catch {
      // Page busy / reloading — keep polling.
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
}

async function clickTestId(testId) {
  return evalJs(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!el || el.disabled) return false;
    el.click();
    return true;
  })()`);
}

async function clickButtonByText(text) {
  return evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent.includes(${JSON.stringify(text)}));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
}

/** Mở Connected apps từ nav menu (dùng lại sau mỗi lần quay về chat). */
async function openConnectedApps() {
  assert.equal(await clickTestId('sidebar-nav-menu'), true, 'opening the nav menu');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown to open');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-nav-key="connected-apps"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking Connected apps in the menu',
  );
  await waitFor(`!!document.querySelector('[data-section="apps"]')`, 15_000, 'apps section to appear');
}

/** Quay về chat — view Connected apps unmount, mở lại sẽ load `apps:list` mới. */
async function backToChat() {
  assert.equal(await clickButtonByText('Quay lại'), true, 'clicking back to chat');
  await waitFor(
    `!document.querySelector('[data-section="apps"]') && !!document.querySelector('.chat-input textarea')`,
    15_000,
    'chat to appear after leaving Connected apps',
  );
}

/** Trạng thái app github qua IPC thật `apps:list` (không qua React state). */
async function githubStatusViaIpc() {
  const list = await evalJs(`window.openBot.listConnectedApps()`);
  assert.ok(Array.isArray(list), 'apps:list returns a list');
  const github = list.find((a) => a?.app?.id === 'github');
  assert.ok(github, 'apps:list includes the github app');
  return github;
}

/** Chi tiết trạng thái GitHub đang hiện trong UI (chuỗi từ main, không chứa token). */
async function githubDetailText() {
  return evalJs(`document.querySelector('[data-testid="app-status-detail-github"]')?.textContent ?? ''`);
}

test.before(async () => {
  if (!hasDisplay) return;
  const mockPort = await startMock();
  await launchApp(mockPort);
});

test.after(async () => {
  await quitApp();
  await new Promise((resolve) => mockServer.close(() => resolve()));
  fs.rmSync(xdgDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('e2e: PAT GitHub được xác thực lại qua IPC thật — 401 thành expired, lỗi mạng giữ connected', { skip: !hasDisplay }, async () => {
  // Fresh profile → onboarding → one-click sample bot.
  await waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding on a fresh profile');
  assert.equal(await clickButtonByText('Tạo bot mẫu'), true, 'clicking the sample-bot button');
  await waitFor(
    `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
    30_000,
    'chat to appear after sample-bot creation',
  );

  await openConnectedApps();
  await waitFor(
    `!!document.querySelector('[data-testid="app-token-input-github"]')`,
    15_000,
    'GitHub PAT input to appear (not_connected at first)',
  );

  // Chưa dán token thì chưa có request nào tới mock — `apps:list`
  // lúc chưa kết nối không được gọi API ngoài.
  assert.equal(mockRequests, 0, 'no GitHub API call before any token is pasted');

  // Dán PAT giả qua input React-controlled (native setter + input
  // event để React nhận giá trị) rồi bấm Lưu token.
  assert.equal(
    await evalJs(`(() => {
      const input = document.querySelector('[data-testid="app-token-input-github"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(FAKE_PAT)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value.length > 0;
    })()`),
    true,
    'typing the fake PAT into the GitHub token input',
  );
  assert.equal(await clickTestId('app-token-save-github'), true, 'clicking save for the GitHub PAT');

  // `apps:set-token` xác thực PAT với mock (200 + login) rồi lưu
  // Vault + seed cache; UI lật sang connected, kèm nhãn tài khoản.
  await waitFor(
    `!document.querySelector('[data-testid="app-token-input-github"]') && document.body.textContent.includes(${JSON.stringify(MOCK_LOGIN)})`,
    20_000,
    'GitHub flips to connected with the mock account label after paste',
  );
  assert.ok(mockRequests >= 1, 'paste validated the PAT against the mock GitHub API');
  assert.equal(mockSawBearerAuth, true, 'validation sent the PAT as a Bearer token');
  const afterPaste = await githubStatusViaIpc();
  assert.equal(afterPaste.authStatus, 'connected', 'apps:list says connected right after paste');
  assert.equal(afterPaste.accountLabel, MOCK_LOGIN, 'apps:list carries the mock login as account label');
  assert.equal(afterPaste.authStatusDetail, undefined, 'no status detail while the token is valid');

  // --- 401: mock thu hồi PAT → refresh qua `apps:list` thật. ---
  // Chờ quá TTL cache (200ms) để lần kiểm tra này chạm mạng thay vì
  // trả cache hợp lệ đã seed lúc dán.
  mockMode = 'revoked';
  const requestsBefore401 = mockRequests;
  await sleep(CACHE_SETTLE_MS);
  const after401 = await githubStatusViaIpc();
  assert.ok(mockRequests > requestsBefore401, 'revalidation after 401 really hit the network (not the valid cache)');
  assert.equal(after401.authStatus, 'expired', 'apps:list says expired after the mock returns 401');
  assert.ok(
    typeof after401.authStatusDetail === 'string' && after401.authStatusDetail.includes('dán lại'),
    'expired status carries the re-paste guidance',
  );

  // UI cũng phải hiện trạng thái đó: quay về chat rồi mở lại
  // Connected apps để view mount lại và load `apps:list` mới.
  await backToChat();
  await openConnectedApps();
  await waitFor(
    `document.querySelector('[data-testid="app-status-detail-github"]')?.textContent.includes('dán lại')`,
    15_000,
    'expired re-paste guidance to show in the UI',
  );
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="app-token-input-github"]')`),
    true,
    'PAT input is back once the token is expired (user can paste a new one)',
  );
  assert.equal(
    await evalJs(`document.body.textContent.includes('Token hết hạn')`),
    true,
    'expired label shows in the UI',
  );

  // --- Lỗi mạng: mock ngắt kết nối → refresh → vẫn connected. ---
  // 401 trước đó đã xóa cache hợp lệ, nên lần này cũng chạm mạng;
  // lỗi mạng không được kết luận token hỏng (khác 401).
  mockMode = 'reset';
  const requestsBeforeReset = mockRequests;
  await sleep(CACHE_SETTLE_MS);
  const afterReset = await githubStatusViaIpc();
  assert.ok(mockRequests > requestsBeforeReset, 'revalidation after the network failure really hit the network');
  assert.equal(afterReset.authStatus, 'connected', 'apps:list keeps connected when the token cannot be checked (network error)');
  assert.ok(
    typeof afterReset.authStatusDetail === 'string' && afterReset.authStatusDetail.includes('lỗi mạng'),
    'network failure is explained in the status detail instead of marking the token bad',
  );

  await backToChat();
  await openConnectedApps();
  await waitFor(
    `document.querySelector('[data-testid="app-status-detail-github"]')?.textContent.includes('lỗi mạng')`,
    15_000,
    'network-failure reason to show in the UI',
  );
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="app-token-input-github"]')`),
    false,
    'PAT input stays hidden while the token is still treated as connected',
  );
});
