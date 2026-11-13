/**
 * Tests for P2-5 (v0.86): per-window screenshot for `computer_screenshot`.
 *
 * Two layers:
 *  1. Fake binaries — a fake `xdotool` + `import` on PATH (driven by a
 *     scenario file, calls logged) exercise resolution + fail-closed
 *     behaviour without touching a real X server. Only `convert`
 *     (thumbnail) stays real.
 *  2. Live Xvfb tests — a real tkinter window is opened, captured by
 *     title, and compared against the full-screen capture; a second
 *     window with the same title must fail closed (multiple match).
 *
 * Run under xvfb:
 *   npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/computer-screenshot-window-v086.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  COMPUTER_USE_TOOLS,
  resolveWindow,
  escapeWindowSearchPattern,
  getDisplayGeometry,
  parsePngDimensions,
} from '../packages/tools/dist/computerUse.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (name) => COMPUTER_USE_TOOLS.find((t) => t.definition.name === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasDisplay = Boolean(process.env.DISPLAY);

// 1x1 transparent PNG (what the fake `import` writes).
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';

// ---------------------------------------------------------------------------
// Fake-binary harness
// ---------------------------------------------------------------------------

const FAKE_XDOTOOL = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "xdotool $*" >> "$DIR/calls.log"
SCENARIO="$(cat "$DIR/scenario" 2>/dev/null)"
if [ "$1" = "search" ]; then
  case "$SCENARIO" in
    SINGLE) echo 12345678 ;;
    MULTI) printf '11111111\\n22222222\\n' ;;
    NONE) exit 1 ;;
    SEARCH_FAIL) echo "xdotool: invalid regex" >&2; exit 2 ;;
  esac
  exit 0
fi
if [ "$1" = "getwindowname" ]; then
  if [ "$2" = "12345678" ] || [ "$2" = "0x00bc614e" ]; then echo "Single App"; exit 0; fi
  echo "xdotool: no such window $2" >&2
  exit 1
fi
echo "unexpected xdotool call: $*" >&2
exit 2
`;

const FAKE_IMPORT = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "import $*" >> "$DIR/calls.log"
MODE="$(cat "$DIR/import-mode" 2>/dev/null)"
if [ "$MODE" = "FAIL" ]; then echo "import: unable to open X window" >&2; exit 1; fi
OUT="\${@: -1}"
if [ "$MODE" = "EMPTY" ]; then : > "$OUT"; exit 0; fi
echo '${TINY_PNG_B64}' | base64 -d > "$OUT"
exit 0
`;

/**
 * Install fake xdotool/import at the front of PATH.
 * `scenario`: SINGLE | MULTI | NONE | SEARCH_FAIL (xdotool search).
 * `importMode`: '' (normal) | 'FAIL' | 'EMPTY'.
 * Returns { dir, calls(), restore() }.
 */
function installFakes(scenario, importMode = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fakebin-'));
  fs.writeFileSync(path.join(dir, 'xdotool'), FAKE_XDOTOOL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'import'), FAKE_IMPORT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'scenario'), scenario);
  if (importMode) fs.writeFileSync(path.join(dir, 'import-mode'), importMode);
  fs.writeFileSync(path.join(dir, 'calls.log'), '');
  const savedPath = process.env.PATH;
  const savedDisplay = process.env.DISPLAY;
  process.env.PATH = `${dir}:${savedPath ?? ''}`;
  if (!process.env.DISPLAY) process.env.DISPLAY = ':99';
  return {
    dir,
    calls: () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8'),
    restore: () => {
      process.env.PATH = savedPath;
      if (savedDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = savedDisplay;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-cu-win-test-'));
}

// ---------------------------------------------------------------------------
// Unit: pattern escaping + resolveWindow with fakes
// ---------------------------------------------------------------------------

test('escapeWindowSearchPattern: regex metacharacters become literal', () => {
  assert.equal(escapeWindowSearchPattern('Firefox'), 'Firefox');
  assert.equal(escapeWindowSearchPattern('My App (test)'), 'My App \\(test\\)');
  assert.equal(escapeWindowSearchPattern('a+b*c?d'), 'a\\+b\\*c\\?d');
  assert.equal(escapeWindowSearchPattern('x [1]'), 'x \\[1\\]');
});

test('resolveWindow (fake xdotool): title resolves to the single id', async () => {
  const fakes = installFakes('SINGLE');
  try {
    assert.equal(await resolveWindow('Single App'), '12345678');
    assert.match(fakes.calls(), /search --name Single App/);
  } finally {
    fakes.restore();
  }
});

test('resolveWindow (fake xdotool): decimal + hex ids are verified, not searched', async () => {
  const fakes = installFakes('SINGLE');
  try {
    assert.equal(await resolveWindow('12345678'), '12345678');
    assert.equal(await resolveWindow('0x00bc614e'), '0x00bc614e');
    assert.match(fakes.calls(), /getwindowname 12345678/);
    assert.match(fakes.calls(), /getwindowname 0x00bc614e/);
    assert.doesNotMatch(fakes.calls(), /search/);
  } finally {
    fakes.restore();
  }
});

test('resolveWindow (fake xdotool): fail-closed — no match / many matches / bad id / xdotool error', async () => {
  let fakes = installFakes('NONE');
  try {
    await assert.rejects(() => resolveWindow('Ghost App'), /No window matching "Ghost App"/);
  } finally {
    fakes.restore();
  }

  fakes = installFakes('MULTI');
  try {
    await assert.rejects(
      () => resolveWindow('Multi App'),
      /Multiple windows \(2\) match "Multi App": 11111111, 22222222/,
    );
  } finally {
    fakes.restore();
  }

  fakes = installFakes('SINGLE');
  try {
    await assert.rejects(() => resolveWindow('99999999'), /No window with id "99999999"/);
    await assert.rejects(() => resolveWindow('0xdeadbeef'), /No window with id "0xdeadbeef"/);
    await assert.rejects(() => resolveWindow('   '), /must not be empty/);
  } finally {
    fakes.restore();
  }

  fakes = installFakes('SEARCH_FAIL');
  try {
    await assert.rejects(
      () => resolveWindow('Single App'),
      /xdotool search for window "Single App" failed \(exit 2\)/,
    );
  } finally {
    fakes.restore();
  }
});

// ---------------------------------------------------------------------------
// Tool level with fakes: import -window <id>, default stays root, failures
// ---------------------------------------------------------------------------

test('computer_screenshot + window (fakes): captures the resolved window id', async () => {
  const dir = makeTempWorkspace();
  const fakes = installFakes('SINGLE');
  try {
    const out = await tool('computer_screenshot').execute(
      { window: 'Single App', filename: 'win.png' },
      CTX(dir),
    );
    assert.doesNotMatch(out, /^Error:/, out);
    const info = JSON.parse(out);
    assert.equal(info.ok, true);
    assert.equal(info.window, 'Single App');
    assert.equal(info.windowId, '12345678');
    assert.equal(info.width, 1);
    assert.equal(info.height, 1);
    assert.ok(info.sizeBytes > 0);
    assert.match(fakes.calls(), /import -window 12345678 /);
    assert.doesNotMatch(fakes.calls(), /import -window root/);
    const full = path.join(dir, info.path);
    assert.equal(fs.existsSync(full), true);
    assert.deepEqual([...fs.readFileSync(full).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    fakes.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computer_screenshot + window id (fakes): decimal id goes straight to import', async () => {
  const dir = makeTempWorkspace();
  const fakes = installFakes('SINGLE');
  try {
    const out = await tool('computer_screenshot').execute({ window: '12345678' }, CTX(dir));
    assert.doesNotMatch(out, /^Error:/, out);
    const info = JSON.parse(out);
    assert.equal(info.windowId, '12345678');
    assert.equal(info.window, '12345678');
    assert.match(fakes.calls(), /import -window 12345678 /);
  } finally {
    fakes.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computer_screenshot without window (fakes): default is still the full screen', async () => {
  const dir = makeTempWorkspace();
  const fakes = installFakes('SINGLE');
  try {
    const out = await tool('computer_screenshot').execute({}, CTX(dir));
    assert.doesNotMatch(out, /^Error:/, out);
    const info = JSON.parse(out);
    assert.equal(info.ok, true);
    assert.equal(info.window, null);
    assert.equal(info.windowId, 'root');
    assert.match(fakes.calls(), /import -window root /);
    // Empty string behaves the same as omitting the argument.
    const out2 = await tool('computer_screenshot').execute({ window: '   ' }, CTX(dir));
    assert.doesNotMatch(out2, /^Error:/, out2);
    assert.equal(JSON.parse(out2).windowId, 'root');
  } finally {
    fakes.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computer_screenshot + window (fakes): fail-closed, no file left behind', async () => {
  for (const [scenario, windowArg, pattern] of [
    ['NONE', 'Ghost App', /^Error: No window matching "Ghost App"/],
    ['MULTI', 'Multi App', /^Error: Multiple windows \(2\) match "Multi App"/],
    ['SINGLE', '99999999', /^Error: No window with id "99999999"/],
    ['SEARCH_FAIL', 'Single App', /^Error: xdotool search for window "Single App" failed/],
  ]) {
    const dir = makeTempWorkspace();
    const fakes = installFakes(scenario);
    try {
      const out = await tool('computer_screenshot').execute({ window: windowArg }, CTX(dir));
      assert.match(out, pattern, out);
      // Resolution happens before any file is created.
      assert.equal(fs.existsSync(path.join(dir, 'computer-use', 'screenshots')), false, out);
      assert.doesNotMatch(fakes.calls(), /import /);
    } finally {
      fakes.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('computer_screenshot + window (fakes): import failure / empty file are clear errors, never an empty image', async () => {
  for (const [importMode, pattern] of [
    ['FAIL', /^Error: Screenshot failed \(import exit 1\)/],
    ['EMPTY', /^Error: Screenshot failed: the PNG file is empty/],
  ]) {
    const dir = makeTempWorkspace();
    const fakes = installFakes('SINGLE', importMode);
    try {
      const out = await tool('computer_screenshot').execute({ window: 'Single App' }, CTX(dir));
      assert.match(out, pattern, out);
    } finally {
      fakes.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('computer_screenshot + window (fakes): non-string window arg is a clear error', async () => {
  const dir = makeTempWorkspace();
  const fakes = installFakes('SINGLE');
  try {
    const out = await tool('computer_screenshot').execute({ window: 123 }, CTX(dir));
    assert.match(out, /^Error: Argument "window" must be a string/);
  } finally {
    fakes.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computer_screenshot: tool definition advertises the window parameter', () => {
  const def = tool('computer_screenshot').definition;
  assert.equal(def.parameters.properties.window.type, 'string');
  assert.match(def.description, /window/);
  assert.equal(tool('computer_screenshot').needsApproval, false);
});

// ---------------------------------------------------------------------------
// Live Xvfb tests: a real tkinter window, captured by title
// ---------------------------------------------------------------------------

const TK_SCRIPT = `
import sys, tkinter as tk
title, w, h, x, y = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
root = tk.Tk()
root.title(title)
root.geometry(f"{w}x{h}+{x}+{y}")
root.configure(bg="red")
tk.Label(root, text=title, bg="red", fg="white").pack(expand=True, fill="both")
root.mainloop()
`;

function openTkWindow(title, w, h, x, y) {
  const scriptPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tk-')),
    'win.py',
  );
  fs.writeFileSync(scriptPath, TK_SCRIPT);
  const proc = spawn('python3', [scriptPath, title, String(w), String(h), String(x), String(y)], {
    stdio: 'ignore',
  });
  return { proc, scriptPath };
}

function xdotoolSearch(title) {
  try {
    const out = execFileSync('xdotool', ['search', '--name', title], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForWindow(title, timeoutMs = 10_000, minCount = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = xdotoolSearch(title);
    // v0.97 fix (merge verify): chờ đủ minCount cửa sổ, không phải
    // cửa sổ đầu tiên — trước đây hàm trả ngay khi có >= 1 cửa sổ
    // nên test "2 cửa sổ trùng tên" assert ids.length >= 2 ngay khi
    // cửa sổ thứ hai (Tk khởi động chậm dưới tải) chưa kịp hiện.
    if (ids.length >= minCount) return ids;
    await sleep(250);
  }
  return xdotoolSearch(title);
}

function windowGeometry(id) {
  const out = execFileSync('xdotool', ['getwindowgeometry', id], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const m = out.match(/Geometry:\s*(\d+)x(\d+)/);
  assert.ok(m, `could not parse getwindowgeometry output: ${out}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

test(
  'computer_screenshot + window (live xvfb): captures the named window, not the full screen',
  { skip: !hasDisplay },
  async () => {
    const dir = makeTempWorkspace();
    const title = 'OpenBot P2-5 Test Window';
    const { proc, scriptPath } = openTkWindow(title, 400, 300, 100, 80);
    try {
      const ids = await waitForWindow(title);
      assert.equal(ids.length, 1, `expected 1 window titled "${title}", got ${ids.length}`);
      const winId = ids[0];
      const geom = windowGeometry(winId);

      const out = await tool('computer_screenshot').execute(
        { window: title, filename: 'live-win.png' },
        CTX(dir),
      );
      assert.doesNotMatch(out, /^Error:/, out);
      const info = JSON.parse(out);
      assert.equal(info.ok, true);
      assert.equal(info.windowId, winId);
      // The capture matches the real window geometry (incl. any border),
      // and is strictly smaller than the full screen.
      assert.deepEqual(
        { width: info.width, height: info.height },
        geom,
        `window shot dims ${info.width}x${info.height} != window geometry ${geom.width}x${geom.height}`,
      );
      assert.ok(info.sizeBytes > 0);
      const full = path.join(dir, info.path);
      assert.equal(fs.existsSync(full), true);
      assert.deepEqual(parsePngDimensions(fs.readFileSync(full).subarray(0, 24)), geom);

      const fullOut = await tool('computer_screenshot').execute(
        { filename: 'live-full.png' },
        CTX(dir),
      );
      assert.doesNotMatch(fullOut, /^Error:/, fullOut);
      const fullInfo = JSON.parse(fullOut);
      assert.equal(fullInfo.windowId, 'root');
      const screen = await getDisplayGeometry();
      assert.deepEqual(
        { width: fullInfo.width, height: fullInfo.height },
        { width: screen.width, height: screen.height },
      );
      assert.ok(
        info.width < fullInfo.width && info.height < fullInfo.height,
        `window shot ${info.width}x${info.height} should be smaller than full screen ${fullInfo.width}x${fullInfo.height}`,
      );
      assert.notEqual(
        fs.readFileSync(full).toString('base64'),
        fs.readFileSync(path.join(dir, fullInfo.path)).toString('base64'),
        'window capture must differ from the full-screen capture',
      );
    } finally {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already dead.
      }
      fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'computer_screenshot + window (live xvfb): two windows with the same title fail closed',
  { skip: !hasDisplay },
  async () => {
    const dir = makeTempWorkspace();
    const title = 'OpenBot P2-5 Dup Window';
    const a = openTkWindow(title, 300, 200, 50, 50);
    const b = openTkWindow(title, 300, 200, 400, 50);
    try {
      const ids = await waitForWindow(title, 10_000, 2);
      assert.ok(ids.length >= 2, `expected >= 2 windows titled "${title}", got ${ids.length}`);
      const out = await tool('computer_screenshot').execute({ window: title }, CTX(dir));
      assert.match(out, new RegExp(`^Error: Multiple windows \\(${ids.length}\\) match`), out);
      assert.equal(fs.existsSync(path.join(dir, 'computer-use', 'screenshots')), false);
      // ...while the same window captured by id still works.
      const byId = await tool('computer_screenshot').execute({ window: ids[0] }, CTX(dir));
      assert.doesNotMatch(byId, /^Error:/, byId);
      assert.equal(JSON.parse(byId).windowId, ids[0]);
    } finally {
      for (const w of [a, b]) {
        try {
          w.proc.kill('SIGKILL');
        } catch {
          // Already dead.
        }
        fs.rmSync(path.dirname(w.scriptPath), { recursive: true, force: true });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'computer_screenshot + window (live xvfb): unknown title is a clear error',
  { skip: !hasDisplay },
  async () => {
    const dir = makeTempWorkspace();
    try {
      const out = await tool('computer_screenshot').execute(
        { window: 'No Such Window P2-5 XYZ' },
        CTX(dir),
      );
      assert.match(out, /^Error: No window matching "No Such Window P2-5 XYZ"/, out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
