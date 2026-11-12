/**
 * Tests for the v0.90d local harness hardening (packages/core/src/api/):
 *
 * - Rate limiting: token bucket 120 req/phút/client mặc định (cấu
 *   hình qua `rateLimitPerMinute`), vượt → 429 + header Retry-After
 *   + body lỗi rõ; miễn /v1/health; bucket riêng theo token.
 * - Giới hạn kết nối: `maxConnections` + tối đa N kết nối/IP (vượt
 *   → socket bị destroy ngay, không treo) + headersTimeout /
 *   requestTimeout (requestTimeout chỉ tính lúc NHẬN request).
 * - Restart: `onUnexpectedClose` KHÔNG bắn khi stop() có chủ đích;
 *   helper `retryWithBackoff` (backoff 1s/2s/4s/8s/16s, tối đa 5
 *   lần, huỷ được qua shouldRetry).
 *
 * Giới hạn của test (nói thẳng): đường `onUnexpectedClose` DƯƠNG
 * (server chết thật → callback bắn) không trigger được từ test —
 * Node chỉ emit 'close' sau khi `close()` được gọi, mà `close()`
 * đó chính là `stop()` (đã có cờ `stopping` chặn). Test chỉ chứng
 * minh chiều âm (stop() không gọi callback) + helper retry (đơn vị
 * của vòng khởi động lại ở main). Việc nối callback → retry ở main
 * được kiểm chứng bằng code review + build/typecheck.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/api-harness-hardening-v090d.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';

import {
  createApiServer,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  MAX_API_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  API_HEADERS_TIMEOUT_MS,
  API_REQUEST_TIMEOUT_MS,
  API_CONNECTIONS_CHECKING_INTERVAL_MS,
} from '../packages/core/dist/api/server.js';
import {
  API_RESTART_MAX_ATTEMPTS,
  API_RESTART_BASE_DELAY_MS,
  API_RESTART_MAX_DELAY_MS,
  apiRestartDelayMs,
  retryWithBackoff,
} from '../packages/core/dist/api/restart.js';

const TOKEN = 'test-token-v090d';
const TOKEN_B = 'test-token-v090d-other';
const TEAM = 'team-1';
const BOTS = [
  { id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseHandlers() {
  return {
    listBots: async () => BOTS,
    runBot: async (_botId, text) => ({ text: `echo: ${text}` }),
    getHistory: async () => [],
    listTasks: async () => [],
  };
}

const servers = [];
async function startServer(opts = {}) {
  const server = createApiServer({
    port: 0,
    token: TOKEN,
    teamId: TEAM,
    handlers: baseHandlers(),
    ...opts,
  });
  await server.start();
  servers.push(server);
  return server;
}
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().stop();
  }
});

/** One real HTTP request against a test server. */
function request(server, { method = 'GET', path = '/v1/bots', token = TOKEN, team = TEAM } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (team !== null) headers['X-Open-Bot-Team'] = team;
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('constants: rate limit 120/phut, cap 100 conn / 20 conn-IP, timeout 30s/300s, check 30s', () => {
  assert.equal(DEFAULT_RATE_LIMIT_PER_MINUTE, 120);
  assert.equal(RATE_LIMIT_WINDOW_MS, 60_000);
  assert.equal(MAX_API_CONNECTIONS, 100);
  assert.equal(MAX_CONNECTIONS_PER_IP, 20);
  assert.equal(API_HEADERS_TIMEOUT_MS, 30_000);
  assert.equal(API_REQUEST_TIMEOUT_MS, 300_000);
  assert.equal(API_CONNECTIONS_CHECKING_INTERVAL_MS, 30_000);
});

test('options khong hop le: rateLimitPerMinute am / maxConnections 0 / timeout am -> throw luc tao server', () => {
  assert.throws(
    () => createApiServer({ port: 0, token: TOKEN, handlers: baseHandlers(), rateLimitPerMinute: -1 }),
    /rateLimitPerMinute/,
  );
  assert.throws(
    () => createApiServer({ port: 0, token: TOKEN, handlers: baseHandlers(), maxConnections: 0 }),
    /maxConnections/,
  );
  assert.throws(
    () => createApiServer({ port: 0, token: TOKEN, handlers: baseHandlers(), maxConnectionsPerIp: 0 }),
    /maxConnectionsPerIp/,
  );
  assert.throws(
    () => createApiServer({ port: 0, token: TOKEN, handlers: baseHandlers(), requestTimeoutMs: -1 }),
    /requestTimeoutMs/,
  );
  // Luật của Node: headersTimeout phải <= requestTimeout — sai thì
  // throw rõ thay vì để Node swap ngầm hai giá trị (test này từng
  // đỏ vì chỉ truyền requestTimeoutMs 300, headers mặc định 30s bị
  // swap thành 30s nên body dở không bị cắt sau 3s).
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: TOKEN,
        handlers: baseHandlers(),
        headersTimeoutMs: 30_000,
        requestTimeoutMs: 300,
      }),
    /headersTimeoutMs.*<= requestTimeoutMs/,
  );
});

// ---------------------------------------------------------------------------
// Rate limiting (server thật trên 127.0.0.1)
// ---------------------------------------------------------------------------

test('rate limit: 5 req/phut -> 5 lan 200, lan 6 -> 429 + Retry-After + body loi ro', async () => {
  const server = await startServer({ rateLimitPerMinute: 5 });
  for (let i = 0; i < 5; i++) {
    const res = await request(server);
    assert.equal(res.status, 200, `request ${i + 1} phải 200`);
  }
  const limited = await request(server);
  assert.equal(limited.status, 429, 'request thứ 6 phải 429');
  assert.ok(limited.headers['retry-after'], 'phải có header Retry-After');
  const retryAfter = Number(limited.headers['retry-after']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After phải là số nguyên >= 1 (nhận ${limited.headers['retry-after']})`);
  assert.equal(limited.headers['x-ratelimit-limit'], '5');
  const body = JSON.parse(limited.body);
  assert.equal(typeof body.error, 'string');
  assert.match(body.error, /rate limit/i);
});

test('rate limit: /v1/health van 200 sau khi da het quota (health mien)', async () => {
  const server = await startServer({ rateLimitPerMinute: 2 });
  await request(server);
  await request(server);
  assert.equal((await request(server)).status, 429, 'quota đã hết');
  const health = await request(server, { path: '/v1/health', token: null, team: null });
  assert.equal(health.status, 200, 'health không bị chặn');
  assert.deepEqual(JSON.parse(health.body), { ok: true });
});

test('rate limit: bucket rieng theo token — token A het, token B van 200', async () => {
  // Token B phải là token hợp lệ (extraTokens) thì mới tới được
  // rate limit — nếu không nó đã bị 401 trước khi đếm bucket.
  const server = await startServer({ rateLimitPerMinute: 2, extraTokens: [TOKEN_B] });
  await request(server, { token: TOKEN });
  await request(server, { token: TOKEN });
  assert.equal((await request(server, { token: TOKEN })).status, 429, 'token A đã hết quota');
  const other = await request(server, { token: TOKEN_B });
  assert.equal(other.status, 200, 'token B có bucket riêng nên vẫn 200');
});

test('rate limit: rateLimitPerMinute 0 = tat — 10 request lien tuc deu 200', async () => {
  const server = await startServer({ rateLimitPerMinute: 0 });
  for (let i = 0; i < 10; i++) {
    assert.equal((await request(server)).status, 200, `request ${i + 1} phải 200 khi đã tắt limit`);
  }
});

// ---------------------------------------------------------------------------
// Giới hạn kết nối + timeout (socket thật)
// ---------------------------------------------------------------------------

/** Mở một socket TCP giữ kết nối keep-alive (gửi GET /v1/health rồi giữ). */
function holdConnection(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let settled = false;
    sock.on('connect', () => {
      sock.write('GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    });
    sock.on('data', () => {
      if (!settled) {
        settled = true;
        resolve(sock);
      }
    });
    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('held socket không nhận được response trong 5s'));
      }
    }, 5000);
  });
}

test('cap moi IP: giu 2 ket noi (cap 2), ket noi thu 3 bi dong ngay + callback + count dung', async () => {
  const rejected = [];
  const server = await startServer({
    maxConnectionsPerIp: 2,
    onConnectionRejected: (info) => rejected.push(info),
  });
  const held = [await holdConnection(server.port), await holdConnection(server.port)];
  try {
    assert.equal(server.getConnectionCount(), 2, 'đang giữ đúng 2 kết nối');
    // Socket thứ 3: phải đóng nhanh (không treo), không nhận dữ liệu.
    const third = net.connect(server.port, '127.0.0.1');
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      third.on('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
      third.on('error', () => {
        // ECONNRESET cũng là một dạng từ chối sạch — 'close' sẽ theo sau.
      });
    });
    assert.equal(closed, true, 'kết nối thứ 3 phải bị đóng trong 2s (không treo)');
    assert.equal(rejected.length, 1, 'callback onConnectionRejected phải chạy đúng 1 lần');
    assert.equal(rejected[0].reason, 'per-ip-cap');
    assert.match(rejected[0].remoteAddress, /127\.0\.0\.1/);
    assert.equal(server.getConnectionCount(), 2, 'kết nối bị từ chối không được tính');
  } finally {
    for (const s of held) s.destroy();
  }
});

test('requestTimeout: POST gui thieu body thi bi dong/408 trong 3s (timeout 300ms)', async () => {
  // headersTimeoutMs PHẢI <= requestTimeoutMs (luật Node) và chu kỳ
  // kiểm tra phải ngắn — nếu không Node swap ngầm (headers 30s thành
  // request) và timeout chỉ được thực thi mỗi 30s.
  const server = await startServer({
    headersTimeoutMs: 300,
    requestTimeoutMs: 300,
    connectionsCheckingIntervalMs: 50,
  });
  const sock = net.connect(server.port, '127.0.0.1');
  const outcome = await new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve({ timedOut: true, data }), 3000);
    sock.on('connect', () => {
      // Header đủ (kèm auth hợp lệ để qua gate auth rồi mới chờ
      // body), body thiếu (khai 10 byte nhưng chỉ gửi 2) → server
      // chờ body rồi requestTimeout phải cắt.
      sock.write(
        `POST /v1/bots/bot-1/run HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nX-Open-Bot-Team: ${TEAM}\r\nContent-Type: application/json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{"`,
      );
    });
    sock.on('data', (chunk) => {
      data += chunk.toString('utf-8');
      if (data.includes('408')) {
        clearTimeout(timer);
        resolve({ timedOut: false, data });
      }
    });
    sock.on('close', () => {
      clearTimeout(timer);
      resolve({ timedOut: false, data });
    });
    sock.on('error', () => {
      // ECONNRESET khi server đóng cũng là kết thúc — 'close' theo sau.
    });
  });
  assert.equal(outcome.timedOut, false, 'socket phải bị đóng/408 trong 3s, không treo');
  assert.ok(outcome.data.includes('408') || outcome.data === '', `phải nhận 408 hoặc bị đóng không dữ liệu (nhận ${JSON.stringify(outcome.data)})`);
  sock.destroy();
});

test('headersTimeout: mo ket noi roi khong gui gi thi bi dong/408 trong 3s (timeout 300ms)', async () => {
  const server = await startServer({
    headersTimeoutMs: 300,
    requestTimeoutMs: 300,
    connectionsCheckingIntervalMs: 50,
  });
  const sock = net.connect(server.port, '127.0.0.1');
  const outcome = await new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve({ timedOut: true, data }), 3000);
    sock.on('data', (chunk) => {
      data += chunk.toString('utf-8');
      if (data.includes('408')) {
        clearTimeout(timer);
        resolve({ timedOut: false, data });
      }
    });
    sock.on('close', () => {
      clearTimeout(timer);
      resolve({ timedOut: false, data });
    });
    sock.on('error', () => {
      // ECONNRESET khi server đóng cũng là kết thúc — 'close' theo sau.
    });
  });
  assert.equal(outcome.timedOut, false, 'socket không gửi header phải bị đóng/408 trong 3s, không treo');
  assert.ok(outcome.data.includes('408') || outcome.data === '', `phải nhận 408 hoặc bị đóng không dữ liệu (nhận ${JSON.stringify(outcome.data)})`);
  sock.destroy();
});

// ---------------------------------------------------------------------------
// Restart: onUnexpectedClose + retryWithBackoff
// ---------------------------------------------------------------------------

test('restart: stop() co chu dich KHONG goi onUnexpectedClose', async () => {
  let called = 0;
  const server = await startServer({ onUnexpectedClose: () => { called += 1; } });
  assert.equal(server.isRunning, true);
  await server.stop();
  await sleep(150);
  assert.equal(called, 0, 'stop() có chủ đích không được báo là chết đột ngột');
});

test('restart: apiRestartDelayMs tang dan 1s/2s/4s/8s roi tran 16s', () => {
  assert.equal(API_RESTART_MAX_ATTEMPTS, 5);
  assert.equal(API_RESTART_BASE_DELAY_MS, 1000);
  assert.equal(API_RESTART_MAX_DELAY_MS, 16_000);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 10].map((n) => apiRestartDelayMs(n)),
    [1000, 2000, 4000, 8000, 16000, 16000, 16000],
  );
  assert.throws(() => apiRestartDelayMs(0), /attempt/);
});

test('restart: retryWithBackoff thanh cong o lan 3, bao dung so lan', async () => {
  let calls = 0;
  const failed = [];
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error(`fail ${calls}`);
    },
    { delayFor: () => 1, onAttemptFailed: (err, attempt) => failed.push(attempt) },
  );
  assert.deepEqual(result, { ok: true, attempts: 3 });
  assert.equal(calls, 3);
  assert.deepEqual(failed, [1, 2]);
});

test('restart: retryWithBackoff bo cuoc sau 5 lan, giu loi cuoi', async () => {
  let calls = 0;
  const failed = [];
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      throw new Error('port ban');
    },
    { delayFor: () => 1, onAttemptFailed: (err, attempt) => failed.push(attempt) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 5);
  assert.equal(calls, 5);
  assert.equal(result.error.message, 'port ban');
  assert.deepEqual(failed, [1, 2, 3, 4, 5]);
});

test('restart: shouldRetry false thi dung ngay, khong cho het 5 lan', async () => {
  let calls = 0;
  let allow = true;
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      throw new Error('fail');
    },
    {
      delayFor: () => 1,
      shouldRetry: () => allow,
      onAttemptFailed: () => {
        allow = false;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});

test('restart: maxAttempts 1 chi thu dung 1 lan', async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      throw new Error('fail');
    },
    { maxAttempts: 1, delayFor: () => 1 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});
