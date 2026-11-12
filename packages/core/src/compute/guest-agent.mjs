#!/usr/bin/env node
/**
 * Guest agent cho máy-tính-bot mức VM (v0.78, M3).
 *
 * Chạy TRONG VM (không phải trên host): đọc yêu cầu NDJSON từ
 * virtio-serial port `org.open-bot.guest-agent`, chạy lệnh bằng
 * `execFile`, trả kết quả NDJSON về. Không dependency, chỉ dùng
 * module có sẵn của Node (>= 18).
 *
 * Cách dùng trong VM:
 *   node /opt/open-bot/guest-agent.mjs /dev/virtio-ports/org.open-bot.guest-agent
 *
 * Chế độ test trên host (đường truyền là Unix socket thay vì char
 * device — script tự nhận biết qua `stat.isSocket()`):
 *   node guest-agent.mjs /tmp/test-agent.sock
 *
 * Protocol (xem packages/core/src/compute/guestAgent.ts):
 *   Host -> guest: {"id":n,"type":"exec","command":"...","args":[...],
 *                   "timeoutMs":n,"cwd":"..."}
 *              hoặc {"id":n,"type":"ping"} / {"id":n,"type":"info"}
 *                   (v0.90c — health check)
 *   Guest -> host: {"id":n,"type":"result","code":n,
 *                   "stdout":"...","stderr":"..."}
 *              hoặc {"id":n,"type":"error","message":"..."}
 *              hoặc {"id":n,"type":"pong","version":"...","uptimeSeconds":n}
 *              hoặc {"id":n,"type":"info","version":"...","uptimeSeconds":n,
 *                      "node":"...","platform":"...","arch":"..."}
 *
 * Giới hạn: stdout/stderr tối đa 4MB — vượt thì trả lỗi (không cắt
 * lặng). Lệnh timeout theo `timeoutMs` của request (mặc định 120s).
 * Guest KHÔNG tự kiểm tra lệnh nguy hiểm — VM đã là biên cách ly;
 * host chỉ gửi lệnh khi user/bot được phép chạy trong máy đó.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import { execFile } from 'node:child_process';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
// v0.90c: version protocol — host dùng để biết guest có hỗ trợ
// ping/info không (guest cũ không có version, trả lỗi cho ping).
const GUEST_AGENT_VERSION = '0.90c';
const startedAt = Date.now();

function uptimeSeconds() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

const portPath = process.argv[2];
if (!portPath) {
  console.error('Usage: node guest-agent.mjs <virtio-port-path | unix-socket-path>');
  process.exit(2);
}

// Mở kênh tới host: Unix socket (test) hoặc char device (VM thật).
let writeLine;
let onEnd;
if (fs.statSync(portPath).isSocket()) {
  const socket = net.connect(portPath);
  socket.on('error', (err) => {
    console.error(`guest-agent: socket lỗi: ${err.message}`);
    process.exit(1);
  });
  socket.on('data', (chunk) => onData(chunk));
  socket.on('end', () => process.exit(0));
  writeLine = (line) => socket.write(`${line}\n`, 'utf8');
  onEnd = () => socket.end();
} else {
  const input = fs.createReadStream(portPath, { encoding: 'utf8' });
  const output = fs.createWriteStream(portPath, { encoding: 'utf8' });
  input.on('data', (chunk) => onData(chunk));
  input.on('error', (err) => {
    console.error(`guest-agent: không đọc được port ${portPath}: ${err.message}`);
    process.exit(1);
  });
  output.on('error', (err) => {
    console.error(`guest-agent: không ghi được port ${portPath}: ${err.message}`);
    process.exit(1);
  });
  writeLine = (line) => output.write(`${line}\n`, 'utf8');
  onEnd = () => output.end();
}

let buffer = '';

function onData(chunk) {
  buffer += chunk.toString('utf8');
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line !== '') handleLine(line);
    idx = buffer.indexOf('\n');
  }
  if (buffer.length > MAX_OUTPUT_BYTES + 1024) {
    console.error('guest-agent: dòng yêu cầu dài hơn giới hạn — bỏ qua.');
    buffer = '';
  }
}

function reply(msg) {
  try {
    writeLine(JSON.stringify(msg));
  } catch (err) {
    console.error(`guest-agent: không gửi được reply: ${err.message}`);
  }
}

function handleLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    // Không biết id — host sẽ coi đây là lỗi protocol và ngắt kết nối.
    reply({ type: 'error', message: 'Yêu cầu không phải JSON.' });
    return;
  }
  if (typeof req !== 'object' || req === null || typeof req.type !== 'string') {
    reply({ id: typeof req?.id === 'number' ? req.id : undefined, type: 'error', message: 'Yêu cầu phải có type.' });
    return;
  }
  const id = req.id;
  // v0.90c: health check — không chạy lệnh, trả ngay.
  if (req.type === 'ping') {
    reply({ id, type: 'pong', version: GUEST_AGENT_VERSION, uptimeSeconds: uptimeSeconds() });
    return;
  }
  if (req.type === 'info') {
    reply({
      id,
      type: 'info',
      version: GUEST_AGENT_VERSION,
      uptimeSeconds: uptimeSeconds(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    return;
  }
  if (req.type !== 'exec') {
    reply({ id, type: 'error', message: 'Yêu cầu phải có type "exec", "ping" hoặc "info".' });
    return;
  }
  if (typeof req.command !== 'string' || req.command.trim() === '') {
    reply({ id, type: 'error', message: 'Lệnh không được rỗng.' });
    return;
  }
  const args = Array.isArray(req.args) ? req.args.filter((a) => typeof a === 'string') : [];
  const timeoutMs = typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS;
  const options = { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES + 1024 };
  if (typeof req.cwd === 'string' && req.cwd !== '') options.cwd = req.cwd;
  execFile(req.command, args, options, (err, stdout, stderr) => {
    if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      reply({ id, type: 'error', message: 'Output vượt quá 4MB.' });
      return;
    }
    if (err && err.killed) {
      reply({ id, type: 'error', message: `Lệnh timeout sau ${timeoutMs}ms.` });
      return;
    }
    if (err && typeof err.code === 'number') {
      reply({ id, type: 'result', code: err.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      return;
    }
    if (err) {
      reply({ id, type: 'error', message: `Không chạy được lệnh: ${err.message}` });
      return;
    }
    reply({ id, type: 'result', code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
}

process.on('SIGTERM', () => {
  try {
    onEnd();
  } catch {
    // Thoát lặng.
  }
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
