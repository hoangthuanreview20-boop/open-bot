/**
 * cli-query-v101.test.mjs — CLI `open-bot query` v1.01 (Team T6).
 * Chạy CLI thật đã build (apps/cli/dist/cli.js) với provider mock:
 * text stream ra stdout, --json in JSON cuối, exit code đúng.
 * Run: build cli rồi `node --test tests/cli-query-v101.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'apps/cli/dist/cli.js');

async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd: repo,
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

test('cli query: mock provider stream text ra stdout, exit 0', async () => {
  const res = await runCli([
    'query',
    '--prompt',
    'hello',
    '--mock-response',
    'xin chào từ mock',
  ]);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /xin chào từ mock/);
});

test('cli query: --json in đúng JSON cuối (text/turns/toolCalls/aborted)', async () => {
  const res = await runCli(['query', '--prompt', 'hello', '--json']);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.text, 'mock reply');
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.toolCalls, 0);
  assert.equal(parsed.aborted, false);
});

test('cli query: thiếu --prompt thì exit 1 + lỗi rõ', async () => {
  const res = await runCli(['query']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /cần --prompt/);
});

test('cli query: provider thật không có key thì exit 1 + hướng dẫn env', async () => {
  const res = await runCli([
    'query',
    '--prompt',
    'hi',
    '--provider',
    'openai',
    '--model',
    'gpt-4o',
  ]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /OPENBOT_OPENAI_API_KEY/);
});

test('cli query: --help liệt kê lệnh query', async () => {
  const res = await runCli(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /open-bot query --prompt/);
});
