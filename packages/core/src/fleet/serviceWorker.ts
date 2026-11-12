/**
 * Fleet service worker (đội D) — entry chạy trong mỗi workspace.
 *
 * Được FleetServiceManager spawn bằng `spawn(process.execPath, [file,
 * workspaceId, port])` (mẫu như plugin sandbox worker: file biên dịch
 * trong cùng package, env đã lọc). Worker KHÔNG phải server dữ liệu:
 * nó chỉ trả lời health check trên loopback — cố tình tối thiểu.
 *
 * - Bind DUY NHẤT 127.0.0.1 (không bao giờ 0.0.0.0) — nguyên tắc
 *   loopback-trust: ai chạm được port này coi như toàn quyền nên
 *   không expose ra ngoài.
 * - Chỉ có 1 route: GET /health, cần header
 *   `Authorization: Bearer <token>` (token do manager tạo lúc start,
 *   qua env FLEET_SERVICE_TOKEN, chỉ giữ trong bộ nhớ). Sai token →
 *   401, route khác → 404. Không đọc/ghi dữ liệu workspace, không
 *   expose duyệt/xoá/credential/vòng đời computer (nguyên tắc MCP
 *   của OpenMausBot: không expose những thao tác đó).
 * - SIGTERM/SIGINT → đóng server rồi exit 0. Lỗi listen → stderr +
 *   exit 1 (manager coi như start thất bại).
 *
 * Chạy bằng: node dist/fleet/serviceWorker.js <workspaceId> <port>
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';

const workspaceId = process.argv[2] ?? '';
const portRaw = process.argv[3] ?? '';
const port = Number.parseInt(portRaw, 10);
const token = process.env.FLEET_SERVICE_TOKEN ?? '';

if (workspaceId.trim() === '') {
  process.stderr.write('fleet service worker cần workspaceId (argv[2]).\n');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write('fleet service worker cần port hợp lệ (argv[3]).\n');
  process.exit(1);
}
if (token.length < 16) {
  process.stderr.write('fleet service worker cần FLEET_SERVICE_TOKEN (tối thiểu 16 ký tự).\n');
  process.exit(1);
}

const startedAt = Date.now();

function tokenMatches(header: string | string[] | undefined): boolean {
  if (typeof header !== 'string') return false;
  if (!header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url !== '/health' || req.method !== 'GET') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not-found' }));
    return;
  }
  if (!tokenMatches(req.headers.authorization)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      workspaceId,
      uptimeMs: Date.now() - startedAt,
      pid: process.pid,
    }),
  );
});

server.on('error', (err) => {
  process.stderr.write(`fleet service worker (${workspaceId}) lỗi listen: ${(err as Error).message}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  // Sẵn sàng — manager phát hiện qua /health, không cần IPC ready.
});

function shutdown(signal: string): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
  void signal;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
