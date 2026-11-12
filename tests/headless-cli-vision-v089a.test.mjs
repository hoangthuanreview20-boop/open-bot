/**
 * Tests cho v0.89a — vision qua headless CLI (`open-bot run --image`).
 *
 * Audit finding (v0.89a): desktop chat (`chat:send`) đưa được ảnh tới
 * agent từ v0.63, nhưng headless CLI — đường chạy không-UI — không có
 * cờ ảnh nào: `--prompt` bắt buộc, ảnh không có đường vào run. File
 * này spawn CLI thật với provider mock + thư mục tạm (không key thật,
 * không gọi API ngoài) và chứng minh qua code thật:
 *
 *  - `--image red.png` + prompt: ảnh đi tới loop — provider mock
 *    không có vision nên loop trả đúng câu từ chối "chưa xem được
 *    ảnh" (chính là bằng chứng ảnh đã tới được gate của loop, thay
 *    vì bị rớt ở CLI); ảnh tới được model vision thật được chứng
 *    minh riêng ở tests/gemini-live-vision-v089a.test.mjs (live).
 *  - Chỉ `--image`, không `--prompt`: run vẫn chạy (tin chỉ-ảnh).
 *  - File ảnh không tồn tại / đuôi không hỗ trợ: exit 1, lỗi rõ,
 *    chưa chạy bot.
 *  - `--help` nêu `--image`.
 *
 * Run sau khi build core + tools + cli:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools && npm run build --workspace=@open-bot/cli
 *   node --test tests/headless-cli-vision-v089a.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const cli = path.join(repo, 'apps', 'cli', 'dist', 'cli.js');

// PNG đỏ 8x8 thật (RGB 255,0,0 — build bằng node:zlib, xem
// tests/api-vision-v089a.test.mjs). Không dùng fixture ngoài.
const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-v089a-cli-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(args, dataDir) {
  return spawnSync(process.execPath, [cli, ...args, '--data-dir', dataDir], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, OPENBOT_DATA_DIR: dataDir },
  });
}

/** Thư mục tạm có sẵn 1 ảnh đỏ + 1 file text (để test đuôi sai). */
function fixtureDir() {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'red.png'), Buffer.from(RED_PNG_BASE64, 'base64'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'không phải ảnh\n');
  return dir;
}

test('cli --help: nêu --image (lặp lại được, tối đa 5 ảnh)', () => {
  const res = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--image FILE/);
  assert.match(res.stdout, /tối/);
  assert.match(res.stdout, /5 ảnh/);
});

test('cli run --image + --prompt: ảnh tới loop — mock không có vision nên từ chối rõ', () => {
  const dir = fixtureDir();
  const res = runCli(
    ['run', '--provider', 'mock', '--model', 'mock', '--prompt', 'màu gì đây?', '--image', path.join(dir, 'red.png'), '--json'],
    dir,
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  // Bằng chứng ảnh đã qua CLI → coordinator → loop gate: mock không
  // hỗ trợ vision nên loop trả câu từ chối thay vì "mock reply".
  // (Ảnh tới model vision thật: test live Gemini riêng.)
  assert.match(out.text, /chưa xem được ảnh/);
  assert.match(out.text, /mock/);
  assert.equal(out.approvalDenied, false);
});

test('cli run chỉ --image, không --prompt: tin chỉ-ảnh chạy được (không lỗi prompt rỗng)', () => {
  const dir = fixtureDir();
  const res = runCli(
    ['run', '--provider', 'mock', '--model', 'mock', '--image', path.join(dir, 'red.png'), '--json'],
    dir,
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.match(out.text, /chưa xem được ảnh/);
});

test('cli run --image lặp 2 lần: cả 2 ảnh đều được nhận (không lỗi)', () => {
  const dir = fixtureDir();
  const res = runCli(
    [
      'run', '--provider', 'mock', '--model', 'mock', '--prompt', 'hai ảnh',
      '--image', path.join(dir, 'red.png'), '--image', path.join(dir, 'red.png'), '--json',
    ],
    dir,
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(JSON.parse(res.stdout).text, /chưa xem được ảnh/);
});

test('cli run --image file không tồn tại: exit 1, lỗi rõ, chưa chạy bot', () => {
  const dir = fixtureDir();
  const res = runCli(
    ['run', '--provider', 'mock', '--model', 'mock', '--prompt', 'x', '--image', path.join(dir, 'khong-co.png')],
    dir,
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /không đọc được ảnh/);
});

test('cli run --image đuôi không hỗ trợ (.txt): exit 1, lỗi rõ', () => {
  const dir = fixtureDir();
  const res = runCli(
    ['run', '--provider', 'mock', '--model', 'mock', '--prompt', 'x', '--image', path.join(dir, 'note.txt')],
    dir,
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /không hỗ trợ/);
});

test('cli run không prompt lẫn không ảnh: vẫn lỗi như cũ', () => {
  const dir = makeTempDir();
  const res = runCli(['run', '--provider', 'mock', '--model', 'mock'], dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--prompt/);
});
