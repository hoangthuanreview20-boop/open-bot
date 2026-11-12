/**
 * Tests for the v0.6 computer-use tools: COMPUTER_USE_TOOLS
 * (computer_screenshot / computer_record_start / computer_record_stop /
 * computer_mouse_move / computer_click / computer_key / computer_type).
 *
 * These tests drive a REAL X display — run under xvfb:
 *   npm run build --workspace=@open-bot/tools
 *   xvfb-run -a npm test -- tests/computer-use-v06.test.mjs
 *
 * No window is needed: mouse/keyboard act on the root window and the
 * screenshot/recording capture the (empty) Xvfb screen.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ToolRegistry } from '../packages/tools/dist/registry.js';
import {
  COMPUTER_USE_TOOLS,
  createComputerUseTools,
  getDisplayGeometry,
  parsePngDimensions,
  validateKeySpec,
  looksLikeSecretToken,
  displayToX11GrabInput,
} from '../packages/tools/dist/computerUse.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (name) => COMPUTER_USE_TOOLS.find((t) => t.definition.name === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tempDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-cu-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Registry / metadata (no display needed)
// ---------------------------------------------------------------------------

test('computer-use: registry holds 7 tools with the right approval flags', () => {
  const reg = ToolRegistry.fromDefaults(COMPUTER_USE_TOOLS);
  assert.equal(reg.size(), 7);
  assert.equal(tool('computer_screenshot').needsApproval, false);
  for (const name of [
    'computer_record_start',
    'computer_record_stop',
    'computer_mouse_move',
    'computer_click',
    'computer_key',
    'computer_type',
  ]) {
    assert.equal(tool(name).needsApproval, true, `${name} must need approval`);
  }
  // Every tool has a full JSON-Schema parameters object.
  for (const t of COMPUTER_USE_TOOLS) {
    assert.equal(t.definition.parameters.type, 'object');
    assert.equal(typeof t.definition.parameters.properties, 'object');
    assert.ok(t.definition.description.length > 20);
  }
});

test('computer-use: createComputerUseTools returns a fresh set each call', () => {
  const a = createComputerUseTools();
  const b = createComputerUseTools();
  assert.equal(a.length, 7);
  assert.equal(b.length, 7);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(
    a.map((t) => t.definition.name),
    b.map((t) => t.definition.name),
  );
});

test('helpers: parsePngDimensions / validateKeySpec / looksLikeSecretToken / displayToX11GrabInput', () => {
  // Minimal 1x1 PNG header (signature + IHDR).
  const png = Buffer.alloc(24);
  png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(600, 20);
  assert.deepEqual(parsePngDimensions(png), { width: 800, height: 600 });
  assert.equal(parsePngDimensions(Buffer.from('not a png')), null);

  validateKeySpec('Return');
  validateKeySpec('ctrl+alt+t');
  validateKeySpec('F5');
  validateKeySpec('a');
  assert.throws(() => validateKeySpec('NotARealKey'), /Unsupported key/);
  assert.throws(() => validateKeySpec('ctrl+'), /empty part/);
  assert.throws(() => validateKeySpec('a+b+c+d+e+f'), /too many parts/);

  assert.equal(looksLikeSecretToken('sk-AbCdEfGh12345678IjKlMnOpQrStUv'), true);
  assert.equal(looksLikeSecretToken('hello world, this is a normal sentence'), false);
  assert.equal(looksLikeSecretToken('https://example.com/some/path?x=1'), false);
  assert.equal(looksLikeSecretToken('short'), false);

  assert.equal(displayToX11GrabInput(':99'), ':99.0+0,0');
  assert.equal(displayToX11GrabInput(':99.0'), ':99.0+0,0');
  assert.equal(displayToX11GrabInput('0'), ':0.0+0,0');
});

// ---------------------------------------------------------------------------
// Real display tests (need DISPLAY — skipped gracefully without one)
// ---------------------------------------------------------------------------

const hasDisplay = Boolean(process.env.DISPLAY);

test('getDisplayGeometry: returns a positive screen size', async () => {
  if (!hasDisplay) {
    await assert.rejects(() => getDisplayGeometry(), /No X display/);
    return;
  }
  const { width, height } = await getDisplayGeometry();
  assert.ok(width > 0 && height > 0, `expected positive size, got ${width}x${height}`);
});

test('computer_screenshot: captures a real PNG with dimensions + thumbnail', async () => {
  const dir = makeTempWorkspace();
  const out = await tool('computer_screenshot').execute({}, CTX(dir));
  assert.doesNotMatch(out, /^Error:/, out);
  const info = JSON.parse(out);
  assert.equal(info.ok, true);
  assert.match(info.path, /^computer-use\/screenshots\/screenshot-.*\.png$/);
  assert.ok(info.width > 0 && info.height > 0, `dims ${info.width}x${info.height}`);
  assert.ok(info.sizeBytes > 0);
  const full = path.join(dir, info.path);
  assert.equal(fs.existsSync(full), true);
  const buf = fs.readFileSync(full);
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(parsePngDimensions(buf.subarray(0, 24)), {
    width: info.width,
    height: info.height,
  });
  // Thumbnail: base64 JPEG, small.
  assert.ok(typeof info.thumbnailBase64 === 'string' && info.thumbnailBase64.length > 100);
  const thumb = Buffer.from(info.thumbnailBase64, 'base64');
  assert.ok(thumb.length <= 200_000, `thumbnail ${thumb.length} bytes`);
  assert.deepEqual([...thumb.subarray(0, 2)], [0xff, 0xd8]);
});

test('computer_mouse_move + computer_click: move lands where asked, click works', async () => {
  const dir = makeTempWorkspace();
  const { width, height } = await getDisplayGeometry();
  const x = Math.min(10, width - 1);
  const y = Math.min(10, height - 1);
  const moved = await tool('computer_mouse_move').execute({ x, y }, CTX(dir));
  assert.doesNotMatch(moved, /^Error:/, moved);
  assert.match(moved, new RegExp(`\\(${x}, ${y}\\)`));
  // NOTE: the tool verifies the position itself (chained getmouselocation
  // in the same xdotool call). A separate `xdotool getmouselocation`
  // process is NOT used here: this machine's Xvfb resets the pointer to
  // screen centre when a client disconnects, so it would report 640,512
  // even after a successful move.

  const clicked = await tool('computer_click').execute({ button: 'left' }, CTX(dir));
  assert.doesNotMatch(clicked, /^Error:/, clicked);
  const dbl = await tool('computer_click').execute({ button: 'right', doubleClick: true }, CTX(dir));
  assert.doesNotMatch(dbl, /^Error:/, dbl);
  assert.match(dbl, /double-click/);

  const badButton = await tool('computer_click').execute({ button: 'fourth' }, CTX(dir));
  assert.match(badButton, /^Error: Unknown button/);
});

test('computer_mouse_move: rejects out-of-bounds coordinates', async () => {
  const dir = makeTempWorkspace();
  const { width, height } = await getDisplayGeometry();
  for (const [x, y] of [[-1, 10], [10, -1], [width, 10], [10, height], [99999, 99999]]) {
    const out = await tool('computer_mouse_move').execute({ x, y }, CTX(dir));
    assert.match(out, /^Error: Coordinates .* outside the screen/, out);
  }
  const nonInt = await tool('computer_mouse_move').execute({ x: 10.5, y: 10 }, CTX(dir));
  assert.match(nonInt, /^Error: Coordinates must be integers/);
});

test('computer_key: presses real keys, rejects unknown ones', async () => {
  const dir = makeTempWorkspace();
  for (const key of ['Escape', 'F5', 'ctrl+l', 'Tab']) {
    const out = await tool('computer_key').execute({ key }, CTX(dir));
    assert.doesNotMatch(out, /^Error:/, out);
    assert.match(out, new RegExp(`"${key.replace('+', '\\+')}"`));
  }
  const bad = await tool('computer_key').execute({ key: 'NotARealKey' }, CTX(dir));
  assert.match(bad, /^Error: Unsupported key/);
});

test('computer_type: types text, refuses control chars and token-like secrets', async () => {
  const dir = makeTempWorkspace();
  const out = await tool('computer_type').execute({ text: 'hello open-bot' }, CTX(dir));
  assert.doesNotMatch(out, /^Error:/, out);
  assert.match(out, /Typed 14 character/);

  const ctrl = await tool('computer_type').execute({ text: 'a\x01b' }, CTX(dir));
  assert.match(ctrl, /^Error: Text contains a control character/);

  const secret = await tool('computer_type').execute(
    { text: 'sk-AbCdEfGh12345678IjKlMnOpQrStUv' },
    CTX(dir),
  );
  assert.match(secret, /^Error: Refusing to type a string that looks like/);

  const tooLong = await tool('computer_type').execute({ text: 'x'.repeat(1001) }, CTX(dir));
  assert.match(tooLong, /^Error: Text is 1001 chars, over the 1000 char limit/);

  const empty = await tool('computer_type').execute({ text: '' }, CTX(dir));
  assert.match(empty, /^Error: Nothing to type/);
});

test('computer_record_start/stop: records a real video for a few seconds', async () => {
  const dir = makeTempWorkspace();
  const started = await tool('computer_record_start').execute({}, CTX(dir));
  assert.doesNotMatch(started, /^Error:/, started);
  const info = JSON.parse(started);
  assert.equal(info.status, 'recording');
  assert.ok(info.recordingId);
  assert.match(info.path, /^computer-use\/recordings\/recording-.*\.mp4$/);

  await sleep(3000);

  const stopped = await tool('computer_record_stop').execute(
    { recordingId: info.recordingId },
    CTX(dir),
  );
  assert.doesNotMatch(stopped, /^Error:/, stopped);
  const done = JSON.parse(stopped);
  assert.equal(done.status, 'stopped');
  assert.equal(done.path, info.path);
  assert.ok(done.durationSeconds >= 2, `duration ${done.durationSeconds}s`);
  assert.ok(done.sizeBytes > 1000, `file ${done.sizeBytes} bytes`);
  const full = path.join(dir, done.path);
  assert.equal(fs.existsSync(full), true);
  // MP4 magic: 'ftyp' box at offset 4.
  const head = fs.readFileSync(full).subarray(0, 12);
  assert.equal(head.toString('ascii', 4, 8), 'ftyp');

  // Stopping the same id again is a clear error, not a crash.
  const again = await tool('computer_record_stop').execute(
    { recordingId: info.recordingId },
    CTX(dir),
  );
  assert.match(again, /^Error: Unknown recordingId/);
});

test('computer_record: unknown id + bad limits are clear errors', async () => {
  const dir = makeTempWorkspace();
  const unknown = await tool('computer_record_stop').execute(
    { recordingId: 'no-such-id' },
    CTX(dir),
  );
  assert.match(unknown, /^Error: Unknown recordingId/);

  const tooLong = await tool('computer_record_start').execute(
    { maxDurationSeconds: 9999 },
    CTX(dir),
  );
  assert.match(tooLong, /^Error: maxDurationSeconds must be between/);
  const tooBig = await tool('computer_record_start').execute({ maxFileSizeMB: 9999 }, CTX(dir));
  assert.match(tooBig, /^Error: maxFileSizeMB must be between/);
});

test('computer_record: maxDurationSeconds auto-stops the recording', async () => {
  const dir = makeTempWorkspace();
  const started = await tool('computer_record_start').execute(
    { maxDurationSeconds: 5 },
    CTX(dir),
  );
  assert.doesNotMatch(started, /^Error:/, started);
  const info = JSON.parse(started);
  // Wait past the 5s limit, then stop() should report the auto-stop.
  await sleep(7000);
  const stopped = await tool('computer_record_stop').execute(
    { recordingId: info.recordingId },
    CTX(dir),
  );
  assert.doesNotMatch(stopped, /^Error:/, stopped);
  const done = JSON.parse(stopped);
  assert.equal(done.status, 'auto-stopped');
  assert.equal(done.stopReason, 'max-duration');
  assert.ok(done.durationSeconds >= 4 && done.durationSeconds <= 9, `duration ${done.durationSeconds}s`);
  assert.ok(done.sizeBytes > 1000);
});

// ---------------------------------------------------------------------------
// No-DISPLAY behaviour (env removed, restored afterwards — runs last)
// ---------------------------------------------------------------------------

test('computer-use: clear error when DISPLAY is missing', async () => {
  const savedDisplay = process.env.DISPLAY;
  delete process.env.DISPLAY;
  try {
    const dir = makeTempWorkspace();
    const shot = await tool('computer_screenshot').execute({}, CTX(dir));
    assert.match(shot, /^Error: No X display available/);
    const rec = await tool('computer_record_start').execute({}, CTX(dir));
    assert.match(rec, /^Error: No X display available/);
    const move = await tool('computer_mouse_move').execute({ x: 10, y: 10 }, CTX(dir));
    assert.match(move, /^Error: No X display available/);
    const key = await tool('computer_key').execute({ key: 'Return' }, CTX(dir));
    assert.match(key, /^Error: No X display available/);
  } finally {
    if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay;
  }
});
