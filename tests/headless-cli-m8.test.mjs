/**
 * Tests cho M8 — Headless CLI (`apps/cli/`).
 *
 * Covers (spawn CLI thật, provider mock, thư mục tạm):
 *  - `--help` in ra hướng dẫn (kèm --auto-approve + fail-closed)
 *  - `run --provider mock --json` trả JSON máy đọc được, exit 0
 *  - `run --bot <name>` đọc bots.json trong dataDir
 *  - `run --export FILE` ghi file JSON kết quả
 *  - `team apply <file> --json` validate + ghi team.json, exit 0;
 *    file team hỏng → exit 1
 *  - approval headless mặc định TỪ CHỐI: mock gọi tool cần duyệt
 *    (write_file) → text `đã hủy`, exit 3, file không được tạo;
 *    `--auto-approve` → tool chạy, exit 0, file được tạo
 *
 * KHÔNG dùng key thật, KHÔNG gọi API ngoài: provider mock + thư mục tạm.
 *
 * Run sau khi build core + tools + cli:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools && npm run build --workspace=@open-bot/cli
 *   xvfb-run -a node --test tests/headless-cli-m8.test.mjs
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

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-m8-cli-') {
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

test('cli --help: hướng dẫn đầy đủ, nêu rõ approval headless mặc định từ chối', () => {
  const res = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /open-bot run/);
  assert.match(res.stdout, /team apply/);
  assert.match(res.stdout, /--auto-approve/);
  assert.match(res.stdout, /TỪ CHỐI/);
  assert.match(res.stdout, /--json/);
  assert.match(res.stdout, /--export/);
});

test('cli run --provider mock --json: JSON máy đọc được, exit 0', () => {
  const dataDir = makeTempDir();
  const res = runCli(['run', '--provider', 'mock', '--model', 'mock', '--prompt', 'xin chào', '--json'], dataDir);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.text, 'mock reply');
  assert.equal(out.approvalDenied, false);
  assert.equal(typeof out.runId, 'string');
  assert.equal(typeof out.botId, 'string');
});

test('cli run --bot: đọc bots.json; --export ghi file JSON', () => {
  const dataDir = makeTempDir();
  const ws = path.join(dataDir, 'ws', 'bot-1');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'bots.json'),
    JSON.stringify([
      {
        bot: {
          id: 'bot-1',
          name: 'Bot CLI',
          providerId: 'mock',
          model: 'mock',
          systemPrompt: 'test',
          workspaceDir: ws,
          autoApprove: false,
        },
        provider: {
          id: 'mock',
          label: 'Mock',
          defaultModel: 'mock',
          mockResponses: [{ text: 'trả lời từ bots.json' }],
        },
      },
    ]),
    'utf8',
  );
  const exportFile = path.join(dataDir, 'out.json');
  const res = runCli(
    ['run', '--bot', 'Bot CLI', '--prompt', 'hello', '--json', '--export', exportFile],
    dataDir,
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.text, 'trả lời từ bots.json');
  assert.equal(out.botId, 'bot-1');
  const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  assert.equal(exported.text, 'trả lời từ bots.json');
  assert.equal(exported.botId, 'bot-1');
});

test('cli run --bot không có trong bots.json: lỗi rõ, exit 1', () => {
  const dataDir = makeTempDir();
  const res = runCli(['run', '--bot', 'Bot Ma', '--prompt', 'hi'], dataDir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Không thấy bot/);
});

test('cli team apply: validate + ghi team.json; file hỏng → exit 1', () => {
  const dataDir = makeTempDir();
  const teamFile = path.join(dataDir, 'team.json');
  fs.writeFileSync(
    teamFile,
    JSON.stringify({
      id: 'team-1',
      name: 'Đội M8',
      members: [{ userId: 'u1', name: 'Huy', role: 'admin' }],
      sharedBots: [{ botId: 'bot-1', sharedBy: 'u1' }],
    }),
    'utf8',
  );
  const res = runCli(['team', 'apply', teamFile, '--json'], dataDir);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.id, 'team-1');
  assert.equal(out.name, 'Đội M8');
  assert.equal(out.members, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'team.json'), 'utf8'));
  assert.equal(saved.name, 'Đội M8');
  assert.equal(saved.members[0].userId, 'u1');

  const badFile = path.join(dataDir, 'bad-team.json');
  fs.writeFileSync(badFile, JSON.stringify({ id: 'x' }), 'utf8');
  const bad = runCli(['team', 'apply', badFile], dataDir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /không hợp lệ/);
});

test('cli run approval headless: mặc định từ chối (exit 3, file không tạo); --auto-approve thì chạy (exit 0)', () => {
  const dataDir = makeTempDir();
  const ws = path.join(dataDir, 'ws', 'writer');
  fs.mkdirSync(ws, { recursive: true });
  const target = path.join(ws, 'hello.txt');
  const bots = [
    {
      bot: {
        id: 'writer',
        name: 'Writer',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'test',
        workspaceDir: ws,
        autoApprove: false,
      },
      provider: {
        id: 'mock',
        label: 'Mock',
        defaultModel: 'mock',
        mockResponses: [
          {
            text: '',
            toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'hello.txt', content: 'xin chào' } }],
          },
          { text: 'đã ghi' },
        ],
      },
    },
  ];
  fs.writeFileSync(path.join(dataDir, 'bots.json'), JSON.stringify(bots), 'utf8');

  // Mặc định: từ chối fail-closed — run dừng, file không được tạo.
  const denied = runCli(['run', '--bot', 'writer', '--prompt', 'ghi file', '--json'], dataDir);
  assert.equal(denied.status, 3, `expected exit 3, got ${denied.status}: ${denied.stdout} ${denied.stderr}`);
  const deniedOut = JSON.parse(denied.stdout);
  assert.equal(deniedOut.text, 'đã hủy');
  assert.equal(deniedOut.approvalDenied, true);
  assert.equal(fs.existsSync(target), false, 'deny thì tool không chạy, file không được tạo');
  assert.match(denied.stderr, /từ chối approval headless/);

  // --auto-approve (cờ tường minh): tool chạy, file được tạo.
  const allowed = runCli(
    ['run', '--bot', 'writer', '--prompt', 'ghi file', '--json', '--auto-approve'],
    dataDir,
  );
  assert.equal(allowed.status, 0, `stderr: ${allowed.stderr}`);
  const allowedOut = JSON.parse(allowed.stdout);
  assert.equal(allowedOut.text, 'đã ghi');
  assert.equal(allowedOut.approvalDenied, false);
  assert.equal(fs.existsSync(target), true, 'auto-approve thì tool chạy');
  assert.equal(fs.readFileSync(target, 'utf8'), 'xin chào');
});
