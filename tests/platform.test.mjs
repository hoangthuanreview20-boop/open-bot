/**
 * Tests cho v0.15 đa nền tảng, phần shell/process:
 *  - shellQuote dùng chung (packages/tools/src/shellQuote.ts): nhánh POSIX
 *    phải giống hệt 4 bản copy cũ, nhánh Windows escape đúng cho PowerShell.
 *  - killProcessGroup (packages/tools/src/killProcessGroup.ts): kill cả
 *    process group, POSIX + Windows (taskkill /T /F).
 *
 * Chạy sau khi build package tools:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/platform.test.mjs
 *
 * Chỉ dùng tiến trình local (node -e ngủ rồi bị kill), không mạng,
 * không x.ai, không API key. Trên Windows phần kiểm tra "cháu cũng chết"
 * được skip có ghi rõ (không kiểm được cây tiến trình Windows từ đây);
 * trên POSIX (Linux/macOS) phần đó chạy đầy đủ.
 *
 * Ghi chú về opener/path: không có helper opener/path nào được export
 * riêng để test — logic chọn opener (xdg-open / open / start) nằm inline
 * trong `open_path` của localTools.ts, còn `resolveWithin`/`runShell`
 * đã có test riêng. Vì vậy file này chỉ test shellQuote + kill, và kiểm
 * tra barrel export của hai helper mới.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  shellQuote,
  resolveShellPlatform,
} from '../packages/tools/dist/shellQuote.js';
import {
  killProcessGroup,
  killProcessGroupOfChild,
  isProcessAlive,
} from '../packages/tools/dist/killProcessGroup.js';
// Barrel: hai helper mới phải được export từ @open-bot/tools.
import {
  shellQuote as shellQuoteFromBarrel,
  killProcessGroup as killFromBarrel,
  killProcessGroupOfChild as killChildFromBarrel,
} from '../packages/tools/dist/index.js';

/** Poll `cond()` tới khi truthy (hoặc timeout thì throw). */
async function waitFor(cond, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

test('platform: barrel @open-bot/tools export shellQuote + killProcessGroup', () => {
  assert.equal(typeof shellQuoteFromBarrel, 'function');
  assert.equal(typeof killFromBarrel, 'function');
  assert.equal(typeof killChildFromBarrel, 'function');
  assert.equal(shellQuoteFromBarrel('a b', 'posix'), "'a b'");
});

// ---------------------------------------------------------------------------
// resolveShellPlatform
// ---------------------------------------------------------------------------

test('platform: resolveShellPlatform map win32 -> win32, còn lại -> posix', () => {
  assert.equal(resolveShellPlatform('win32'), 'win32');
  assert.equal(resolveShellPlatform('posix'), 'posix');
  assert.equal(resolveShellPlatform('darwin'), 'posix');
  assert.equal(resolveShellPlatform('linux'), 'posix');
  assert.equal(
    resolveShellPlatform(),
    process.platform === 'win32' ? 'win32' : 'posix',
  );
});

// ---------------------------------------------------------------------------
// shellQuote — POSIX (phải giống hệt hành vi cũ)
// ---------------------------------------------------------------------------

test('platform: shellQuote POSIX — chuỗi thường, khoảng trắng, chuỗi rỗng', () => {
  assert.equal(shellQuote('abc', 'posix'), "'abc'");
  assert.equal(shellQuote('a b', 'posix'), "'a b'");
  assert.equal(shellQuote('', 'posix'), "''");
  assert.equal(shellQuote('file name (1).mp4', 'posix'), "'file name (1).mp4'");
  assert.equal(shellQuote('--flag=x', 'posix'), "'--flag=x'");
});

test('platform: shellQuote POSIX — dấu nháy đơn escape thành \'\\\'\'', () => {
  assert.equal(shellQuote("it's", 'posix'), "'it'\\''s'");
  assert.equal(shellQuote("a'b'c", 'posix'), "'a'\\''b'\\''c'");
  assert.equal(shellQuote("'", 'posix'), "''\\'''");
  assert.equal(shellQuote("''", 'posix'), "''\\'''\\'''");
});

test('platform: shellQuote POSIX — ký tự đặc biệt nằm yên trong nháy đơn', () => {
  // Trong '...' của /bin/sh thì " $ ` ; | & \n đều là ký tự thường.
  assert.equal(shellQuote('a"b', 'posix'), `'a"b'`);
  assert.equal(shellQuote('a$b', 'posix'), `'a$b'`);
  assert.equal(shellQuote('a`b`', 'posix'), "'a`b`'");
  assert.equal(shellQuote('a;b|c&d', 'posix'), "'a;b|c&d'");
  assert.equal(shellQuote('a$(rm -rf /)', 'posix'), "'a$(rm -rf /)'");
  assert.equal(shellQuote('a\nb', 'posix'), "'a\nb'");
  assert.equal(shellQuote('a\\b', 'posix'), "'a\\b'");
  assert.equal(shellQuote('đường dẫn có dấu', 'posix'), "'đường dẫn có dấu'");
});

test('platform: shellQuote POSIX — round-trip qua /bin/sh thật', async () => {
  if (isWindows) return; // /bin/sh không có trên Windows.
  const inputs = [
    '',
    'abc',
    "it's a test",
    'a"b$c`d;e|f&g',
    'a\nb\tc',
    'đường dẫn có dấu',
    'x'.repeat(200),
  ];
  for (const value of inputs) {
    const out = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('/bin/sh', ['-c', `printf %s ${shellQuote(value, 'posix')}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.on('error', rejectPromise);
      child.on('close', (code) => {
        if (code !== 0) rejectPromise(new Error(`sh exit ${code}`));
        else resolvePromise(stdout);
      });
    });
    assert.equal(out, value, `round-trip sai với ${JSON.stringify(value)}`);
  }
});

test('platform: shellQuote mặc định theo máy chạy, alias darwin/linux -> posix', () => {
  const expected = isWindows ? 'win32' : 'posix';
  assert.equal(resolveShellPlatform(), expected);
  assert.equal(shellQuote('a b'), shellQuote('a b', expected));
  assert.equal(shellQuote("it's", 'darwin'), shellQuote("it's", 'posix'));
  assert.equal(shellQuote("it's", 'linux'), shellQuote("it's", 'posix'));
});

// ---------------------------------------------------------------------------
// shellQuote — Windows (PowerShell: escape bằng backtick)
// ---------------------------------------------------------------------------

test('platform: shellQuote Windows — chuỗi thường, khoảng trắng, chuỗi rỗng', () => {
  assert.equal(shellQuote('', 'win32'), '""');
  assert.equal(shellQuote('plain', 'win32'), '"plain"');
  assert.equal(shellQuote('a b', 'win32'), '"a b"');
  assert.equal(shellQuote('C:\\Users\\test\\file.txt', 'win32'), '"C:\\Users\\test\\file.txt"');
});

test('platform: shellQuote Windows — dấu nháy kép, $, backtick được escape', () => {
  // PowerShell: trong "..." thì ` là ký tự escape.
  assert.equal(shellQuote('a"b', 'win32'), '"a`"b"');
  assert.equal(shellQuote('a$b', 'win32'), '"a`$b"');
  assert.equal(shellQuote('a`b`', 'win32'), '"a``b``"');
  assert.equal(shellQuote('a"b$c`d', 'win32'), '"a`"b`$c``d"');
  // Ký tự đặc biệt của cmd/POSIX nhưng thường trong PowerShell "..." thì giữ nguyên.
  assert.equal(shellQuote('a;b|c&d', 'win32'), '"a;b|c&d"');
  assert.equal(shellQuote('a%b', 'win32'), '"a%b"');
  assert.equal(shellQuote("it's", 'win32'), `"it's"`);
});

test('platform: shellQuote Windows — giải mã một lượt khôi phục đúng input', () => {
  // Bất biến: backtick chỉ xuất hiện để escape ký tự ngay sau nó (` " $).
  const decode = (quoted) => {
    assert.ok(quoted.startsWith('"') && quoted.endsWith('"'));
    const inner = quoted.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '`') {
        const next = inner[i + 1];
        assert.ok(next === '`' || next === '"' || next === '$', `backtick lạ trước ${JSON.stringify(next)}`);
        out += next;
        i++;
      } else {
        assert.notEqual(ch, '"', 'nháy kép không escape trong output Windows');
        assert.notEqual(ch, '$', '$ không escape trong output Windows');
        out += ch;
      }
    }
    return out;
  };
  const inputs = ['', 'plain', 'a"b', 'a$b', 'a`b`', 'a"b$c`d', 'a b', "it's", '100% sure'];
  for (const value of inputs) {
    assert.equal(decode(shellQuote(value, 'win32')), value);
  }
});

// ---------------------------------------------------------------------------
// killProcessGroup
// ---------------------------------------------------------------------------

test('platform: killProcessGroup — pid không hợp lệ và tiến trình đã chết trả false', async () => {
  assert.equal(killProcessGroup(-1), false);
  assert.equal(killProcessGroup(0), false);
  assert.equal(killProcessGroup(Number.NaN), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(0), false);

  // Tiến trình đã thoát hẳn: kill phải trả false, không throw.
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = exited.pid;
  await new Promise((resolvePromise) => exited.on('exit', resolvePromise));
  assert.equal(isProcessAlive(deadPid), false);
  assert.equal(killProcessGroup(deadPid), false);
});

test('platform: killProcessGroupOfChild — kill tiến trình con đang ngủ', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    assert.ok(child.pid !== undefined && child.pid > 0);
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(killProcessGroupOfChild(child), true);
    await waitFor(() => !isProcessAlive(child.pid));
  } finally {
    // Dọn dẹp phòng khi assert giữa chừng fail.
    if (child.pid !== undefined && isProcessAlive(child.pid)) {
      killProcessGroup(child.pid);
    }
  }
});

test('platform: killProcessGroup với SIGTERM cũng diệt được tiến trình con', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(killProcessGroup(child.pid, { signal: 'SIGTERM' }), true);
    await waitFor(() => !isProcessAlive(child.pid));
  } finally {
    if (child.pid !== undefined && isProcessAlive(child.pid)) {
      killProcessGroup(child.pid);
    }
  }
});

// --- Kill cả group: cha + cháu đều chết (POSIX chạy đầy đủ) ---
const grandchildTest = test;
grandchildTest(
  'platform: killProcessGroup — kill group diệt cả cha lẫn cháu (POSIX)',
  { skip: isWindows ? 'trên Windows không kiểm được cây tiến trình cháu (taskkill /T là best-effort, xem ghi chú trong test)' : false },
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-platform-'));
    const pidFile = path.join(tmpDir, 'grandchild.pid');
    // Tiến trình cha: spawn một cháu (cùng group) rồi ngủ dài. Cháu ghi pid
    // của nó ra file để test đọc được.
    const childScript =
      `const { spawn } = require('node:child_process');` +
      `const fs = require('node:fs');` +
      `const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });` +
      `fs.writeFileSync(process.env.PIDFILE, String(g.pid));` +
      `setTimeout(()=>{},60000);`;
    const child = spawn(process.execPath, ['-e', childScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PIDFILE: pidFile },
    });
    let grandchildPid;
    try {
      assert.ok(child.pid !== undefined && child.pid > 0);
      // Chờ cháu ghi pid ra file (tối đa 5s).
      await waitFor(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : ''));
      grandchildPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
      assert.equal(isProcessAlive(child.pid), true);
      assert.equal(isProcessAlive(grandchildPid), true);

      assert.equal(killProcessGroup(child.pid), true);
      await waitFor(
        () => !isProcessAlive(child.pid) && !isProcessAlive(grandchildPid),
      );
    } finally {
      if (child.pid !== undefined && isProcessAlive(child.pid)) {
        killProcessGroup(child.pid);
      }
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        killProcessGroup(grandchildPid);
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test('platform: killProcessGroup trên Windows — chỉ kiểm tiến trình chính chết', async () => {
  // Nhánh này chỉ có ý nghĩa khi chạy test trên Windows: taskkill /T /F
  // phải diệt được tiến trình chính; cây cháu không assert được từ đây
  // (không có API nào liệt kê con của một pid đã chết trên Windows).
  if (!isWindows) return;
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
    stdio: 'ignore',
  });
  try {
    assert.equal(killProcessGroup(child.pid, { platform: 'win32' }), true);
    await waitFor(() => !isProcessAlive(child.pid));
  } finally {
    if (child.pid !== undefined && isProcessAlive(child.pid)) {
      killProcessGroup(child.pid, { platform: 'win32' });
    }
  }
});

test('platform: killProcessGroup — ép nhánh win32 trên Linux trả false cho pid đã chết, không treo', async () => {
  // Trên Linux không có taskkill thật nên chỉ kiểm được đường fallback
  // "taskkill lỗi (ENOENT) -> process.kill": pid đã chết phải trả false
  // mà không treo. (Nhánh taskkill thành công chỉ kiểm được khi chạy
  // test trên Windows. Không dùng pid 1 ở đây — kill(1) rất nguy hiểm
  // nếu test chạy dưới quyền root.)
  if (isWindows) return;
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = exited.pid;
  await new Promise((resolvePromise) => exited.on('exit', resolvePromise));
  assert.equal(
    killProcessGroup(deadPid, { platform: 'win32', taskkillTimeoutMs: 100 }),
    false,
  );
});
