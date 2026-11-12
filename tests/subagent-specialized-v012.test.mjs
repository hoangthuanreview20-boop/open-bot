/**
 * subagent-specialized-v012.test.mjs — Subagent chuyên biệt hoá v0.12 mục 3.
 * Module thuần (packages/core/src/agent/subagent.ts): spec riêng, tool
 * subset, model/timeout riêng, chạy song song + gộp kết quả. Runner thật
 * (AgentRunner) được tiêm vào qua hàm giả — không gọi mạng, không cần API key.
 * Run: build core rồi `node --test tests/subagent-specialized-v012.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  buildSubagentSystemPrompt,
  detectConflicts,
  filterToolsForSubagent,
  mergeParallelResults,
  runSpecializedSubagent,
  runSpecializedSubagentsParallel,
  validateSpecializedSpec,
} from '../packages/core/dist/agent/subagent.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeTool(name) {
  return { definition: { name, description: `tool ${name}`, parameters: {} }, needsApproval: false, execute: async () => name };
}

test('validateSpecializedSpec: chuẩn hoá tên/instructions/tool, lỗi rõ khi thiếu', () => {
  const spec = validateSpecializedSpec({
    name: '  researcher ',
    instructions: '  tìm kiếm và tóm tắt  ',
    tools: ['web_search', 'web_search', '  ', 'read_file'],
    model: '  mock-small ',
  });
  assert.equal(spec.name, 'researcher');
  assert.equal(spec.instructions, 'tìm kiếm và tóm tắt');
  assert.deepEqual(spec.tools, ['web_search', 'read_file']);
  assert.equal(spec.model, 'mock-small');
  assert.equal(spec.timeoutMs, DEFAULT_SUBAGENT_TIMEOUT_MS);
  assert.throws(() => validateSpecializedSpec({ name: '', instructions: 'x' }), /tên/);
  assert.throws(
    () => validateSpecializedSpec({ name: 'a', instructions: '   ' }),
    /instructions riêng/,
  );
  assert.throws(
    () => validateSpecializedSpec({ name: 'a', instructions: 'x', timeoutMs: 0 }),
    /timeoutMs > 0/,
  );
  assert.throws(
    () => validateSpecializedSpec({ name: 'a', instructions: 'x', maxSteps: -1 }),
    /maxSteps > 0/,
  );
});

test('filterToolsForSubagent: subset giữ thứ tự gốc, báo tên tool thiếu', () => {
  const all = [fakeTool('read_file'), fakeTool('web_search'), fakeTool('shell_exec')];
  const { tools, missing } = filterToolsForSubagent(all, {
    name: 'r',
    instructions: 'tìm kiếm',
    tools: ['web_search', 'khong_co_tool_nay'],
  });
  assert.deepEqual(tools.map((t) => t.definition.name), ['web_search']);
  assert.deepEqual(missing, ['khong_co_tool_nay']);
  // Không giới hạn tool → toàn bộ.
  const full = filterToolsForSubagent(all, { name: 'r', instructions: 'x' });
  assert.equal(full.tools.length, 3);
  assert.deepEqual(full.missing, []);
});

test('buildSubagentSystemPrompt gộp base + instructions + tool + model + timeout', () => {
  const prompt = buildSubagentSystemPrompt(
    {
      name: 'coder',
      instructions: 'Chỉ viết code TypeScript, không giải thích dài.',
      tools: ['read_file', 'write_file'],
      model: 'mock-code',
      timeoutMs: 60_000,
    },
    'Bạn là trợ lý chung.',
  );
  assert.match(prompt, /Bạn là trợ lý chung/);
  assert.match(prompt, /\[subagent chuyên biệt: coder\]/);
  assert.match(prompt, /Chỉ viết code TypeScript/);
  assert.match(prompt, /read_file, write_file/);
  assert.match(prompt, /mock-code/);
  assert.match(prompt, /60000ms/);
});

test('runSpecializedSubagent: runner trả string và object đều chuẩn hoá được', async () => {
  const fromString = await runSpecializedSubagent(
    async () => 'kết quả text',
    { spec: { name: 'a', instructions: 'làm việc A' }, task: 'việc A' },
  );
  assert.equal(fromString.status, 'done');
  assert.equal(fromString.output, 'kết quả text');
  assert.ok(fromString.durationMs >= 0);

  const fromObject = await runSpecializedSubagent(
    async () => ({ name: 'b', status: 'done', output: 'xong', durationMs: 5, verdict: 'đồng ý' }),
    { spec: { name: 'b', instructions: 'làm việc B' }, task: 'việc B' },
  );
  assert.equal(fromObject.verdict, 'đồng ý');
  assert.equal(fromObject.output, 'xong');
});

test('runSpecializedSubagent: runner throw → status error, không throw ra ngoài', async () => {
  const result = await runSpecializedSubagent(
    async () => {
      throw new Error('provider sập');
    },
    { spec: { name: 'loi', instructions: 'x' }, task: 'việc lỗi' },
  );
  assert.equal(result.status, 'error');
  assert.match(result.error, /provider sập/);
  assert.equal(result.output, '');
});

test('runSpecializedSubagent: timeout riêng chặn runner chạy quá lâu', async () => {
  const result = await runSpecializedSubagent(
    async () => {
      await sleep(500);
      return 'về muộn';
    },
    { spec: { name: 'cham', instructions: 'x', timeoutMs: 30 }, task: 'việc chậm' },
  );
  assert.equal(result.status, 'timeout');
  assert.match(result.error, /timeout sau 30ms/);
});

test('runSpecializedSubagentsParallel: chạy song song, giữ đúng thứ tự, lỗi một bên không sập nhóm', async () => {
  const started = [];
  const runner = async ({ spec }) => {
    started.push(spec.name);
    if (spec.name === 'slow') await sleep(60);
    if (spec.name === 'bad') throw new Error('hỏng');
    return `kết quả ${spec.name}`;
  };
  const results = await runSpecializedSubagentsParallel(runner, [
    { spec: { name: 'fast', instructions: 'x' }, task: '1' },
    { spec: { name: 'slow', instructions: 'x' }, task: '2' },
    { spec: { name: 'bad', instructions: 'x' }, task: '3' },
  ]);
  assert.deepEqual(results.map((r) => r.name), ['fast', 'slow', 'bad']);
  assert.deepEqual(results.map((r) => r.status), ['done', 'done', 'error']);
  assert.equal(results[0].output, 'kết quả fast');
  // Song song thật: tổng thời gian ~ thời gian của subagent chậm nhất, không phải cộng dồn.
  assert.ok(Math.max(...results.map((r) => r.durationMs)) < 500);
});

test('runSpecializedSubagentsParallel: tên trùng nhau thì ném lỗi', async () => {
  await assert.rejects(
    () =>
      runSpecializedSubagentsParallel(async () => 'ok', [
        { spec: { name: 'dup', instructions: 'x' }, task: '1' },
        { spec: { name: 'dup', instructions: 'x' }, task: '2' },
      ]),
    /Tên subagent phải duy nhất/,
  );
  assert.deepEqual(await runSpecializedSubagentsParallel(async () => 'ok', []), []);
});

test('detectConflicts: verdict khác nhau → xung đột; giống nhau → không', () => {
  const mk = (name, verdict, output = '') => ({
    name,
    status: 'done',
    output,
    durationMs: 1,
    verdict,
  });
  const conflicts = detectConflicts([mk('a', 'đồng ý'), mk('b', 'từ chối')]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].description, /Kết luận khác nhau/);
  assert.deepEqual(conflicts[0].subagents.sort(), ['a', 'b']);
  assert.deepEqual(detectConflicts([mk('a', 'đồng ý'), mk('b', 'Đồng ý')]), []);
  assert.deepEqual(detectConflicts([mk('a', undefined, 'không có verdict')]), []);
});

test('detectConflicts: marker đối lập trong text → xung đột (heuristic)', () => {
  const mk = (name, output) => ({ name, status: 'done', output, durationMs: 1 });
  const conflicts = detectConflicts([
    mk('a', 'Tôi đồng ý với phương án này.'),
    mk('b', 'Tôi không đồng ý, phương án này rủi ro.'),
  ]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].description, /Mâu thuẫn dạng text/);
  // Cùng một bên marker thì không xung đột; tắt heuristic thì không báo.
  assert.deepEqual(
    detectConflicts([mk('a', 'đồng ý'), mk('b', 'cũng đồng ý')]),
    [],
  );
  assert.deepEqual(
    detectConflicts([mk('a', 'đồng ý'), mk('b', 'không đồng ý')], {
      conflictMarkerPairs: [],
    }),
    [],
  );
  // Subagent lỗi/timeout không tham gia phát hiện xung đột.
  assert.deepEqual(
    detectConflicts([
      mk('a', 'đồng ý'),
      { name: 'b', status: 'error', output: '', durationMs: 1, error: 'hỏng' },
    ]),
    [],
  );
});

test('mergeParallelResults: nối theo thứ tự + counts + mục xung đột để bot cha phân xử', () => {
  const merged = mergeParallelResults([
    { name: 'researcher', status: 'done', output: 'Tìm thấy 3 nguồn, tôi đồng ý.', durationMs: 10, verdict: 'đồng ý' },
    { name: 'reviewer', status: 'done', output: 'Tôi không đồng ý với nguồn 2.', durationMs: 12, verdict: 'từ chối' },
    { name: 'coder', status: 'timeout', output: '', durationMs: 30, error: 'timeout sau 30ms' },
  ]);
  assert.deepEqual(merged.counts, { done: 2, error: 0, timeout: 1, total: 3 });
  assert.ok(merged.conflicts.length >= 1);
  assert.match(merged.text, /## researcher \(done/);
  assert.match(merged.text, /## reviewer \(done/);
  assert.match(merged.text, /## coder \(timeout/);
  assert.ok(merged.text.indexOf('researcher') < merged.text.indexOf('reviewer'));
  assert.match(merged.text, /## Xung đột cần phân xử/);
  assert.match(merged.text, /Bot cha cần xem xét/);
  // Không xung đột: ghi rõ không phát hiện xung đột.
  const clean = mergeParallelResults([
    { name: 'a', status: 'done', output: 'xong việc A', durationMs: 1 },
    { name: 'b', status: 'done', output: 'xong việc B', durationMs: 1 },
  ]);
  assert.deepEqual(clean.conflicts, []);
  assert.match(clean.text, /Không phát hiện xung đột/);
});
