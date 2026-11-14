/**
 * fanout-grader-v101.test.mjs — Fan-out + rubric grader v1.01 (Team T6).
 * Module thuần (packages/core/src/subagents/grader.ts + fanout.ts):
 * validate rubric, chấm keyword / LLM JSON, fan-out song song có giới
 * hạn đồng thời + vòng sửa lại tối đa N. Runner thật được tiêm bằng
 * hàm giả — không gọi mạng, không cần API key.
 * Run: build core rồi `node --test tests/fanout-grader-v101.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeywordGrader,
  createLlmGrader,
  extractJsonObject,
  gradeOutput,
  runFanOutWithGrading,
  validateRubric,
  DEFAULT_FANOUT_CONCURRENCY,
  DEFAULT_FANOUT_MAX_ROUNDS,
} from '../packages/core/dist/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUBRIC = {
  id: 'report',
  name: 'Báo cáo ngắn',
  passThreshold: 0.7,
  criteria: [
    { id: 'correct', label: 'Đúng', description: 'Số liệu đúng.', weight: 2, maxScore: 10 },
    { id: 'concise', label: 'Ngắn gọn', description: 'Dưới 200 từ.', weight: 1, maxScore: 10 },
  ],
};

test('validateRubric: chuẩn hoá weight/maxScore/threshold, lỗi rõ khi sai', () => {
  const r = validateRubric({
    id: '  r1 ',
    name: ' R ',
    criteria: [{ id: 'a', label: 'A', description: 'd' }],
  });
  assert.equal(r.id, 'r1');
  assert.equal(r.passThreshold, 0.7);
  assert.equal(r.criteria[0].weight, 1);
  assert.equal(r.criteria[0].maxScore, 10);
  assert.throws(() => validateRubric({ id: '', name: 'x', criteria: [{ id: 'a' }] }), /id không rỗng/);
  assert.throws(() => validateRubric({ id: 'r', name: 'x', criteria: [] }), /ít nhất 1 tiêu chí/);
  assert.throws(
    () => validateRubric({ id: 'r', name: 'x', criteria: [{ id: 'a' }, { id: 'a' }] }),
    /trùng id tiêu chí/,
  );
  assert.throws(
    () => validateRubric({ id: 'r', name: 'x', passThreshold: 1.5, criteria: [{ id: 'a' }] }),
    /passThreshold phải trong 0..1/,
  );
});

test('gradeOutput + keyword grader: điểm có trọng số, feedback liệt kê tiêu chí rớt', async () => {
  const grader = createKeywordGrader({
    correct: [{ keyword: '42' }],
    concise: [{ keyword: 'ngắn' }],
  });
  const grade = await gradeOutput('Đáp án 42, trình bày ngắn.', RUBRIC, grader);
  assert.equal(grade.ratio, 1);
  assert.equal(grade.passed, true);
  assert.equal(grade.totalScore, 30); // (10*2 + 10*1)
  assert.equal(grade.maxScore, 30);
  assert.match(grade.feedback, /Đạt rubric/);

  const bad = await gradeOutput('Đáp án sai.', RUBRIC, grader);
  assert.equal(bad.ratio, 0);
  assert.equal(bad.passed, false);
  assert.match(bad.feedback, /Đúng: 0\/10/);
  assert.match(bad.feedback, /Ngắn gọn: 0\/10/);

  // Chỉ đúng 1 tiêu chí nặng (weight 2): ratio = 2/3 ≈ 0.667 < 0.7 → rớt.
  const partial = await gradeOutput('Đáp án 42 nhưng dài dòng.', RUBRIC, grader);
  assert.ok(Math.abs(partial.ratio - 2 / 3) < 0.001);
  assert.equal(partial.passed, false);
});

test('gradeOutput: tiêu chí grader không chấm thì 0 điểm + ghi chú, không đoán', async () => {
  const grader = async () => [{ criterionId: 'correct', score: 8 }];
  const grade = await gradeOutput('text', RUBRIC, grader);
  const concise = grade.perCriterion.find((c) => c.criterionId === 'concise');
  assert.equal(concise.score, 0);
  assert.match(concise.comment ?? '', /không chấm tiêu chí này/);
});

test('gradeOutput: điểm lạ từ grader được kẹp về 0..maxScore', async () => {
  const grader = async () => [
    { criterionId: 'correct', score: 999 },
    { criterionId: 'concise', score: -5 },
  ];
  const grade = await gradeOutput('text', RUBRIC, grader);
  assert.equal(grade.perCriterion.find((c) => c.criterionId === 'correct').score, 10);
  assert.equal(grade.perCriterion.find((c) => c.criterionId === 'concise').score, 0);
});

test('extractJsonObject: tách JSON trong ```json fence và text xung quanh', () => {
  assert.deepEqual(extractJsonObject('{"a": 1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('Đây là kết quả:\n```json\n{"scores": {"a": 5}}\n```'), {
    scores: { a: 5 },
  });
  assert.equal(extractJsonObject('không có json'), null);
  assert.equal(extractJsonObject('{không hợp lệ'), null);
});

test('createLlmGrader: parse JSON scores/comments; lỗi JSON thì throw (fail-closed)', async () => {
  const grader = createLlmGrader(async () =>
    '{"scores": {"correct": 9, "concise": 7}, "comments": {"correct": "Số liệu đúng."}}',
  );
  const grade = await gradeOutput('output', RUBRIC, grader);
  assert.equal(grade.perCriterion.find((c) => c.criterionId === 'correct').score, 9);
  assert.equal(grade.perCriterion.find((c) => c.criterionId === 'correct').comment, 'Số liệu đúng.');
  assert.equal(grade.perCriterion.find((c) => c.criterionId === 'concise').score, 7);

  const broken = createLlmGrader(async () => 'Tôi chấm 8 điểm, không có JSON.');
  await assert.rejects(() => gradeOutput('output', RUBRIC, broken), /không trả JSON hợp lệ/);

  const noScores = createLlmGrader(async () => '{"comments": {}}');
  await assert.rejects(() => gradeOutput('output', RUBRIC, noScores), /thiếu trường "scores"/);
});

function keywordGraderFor(retryBehavior) {
  // Runner giả: lần đầu trả output thiếu từ khoá, lần sau trả output tốt.
  const calls = new Map();
  const runner = async ({ spec, task }) => {
    const n = (calls.get(spec.name) ?? 0) + 1;
    calls.set(spec.name, n);
    await sleep(5);
    if (retryBehavior === 'always-bad') return 'output thiếu từ khoá';
    if (n === 1) return 'output thiếu từ khoá';
    return `output tốt có 42 và ngắn (vòng ${n})`;
  };
  return { runner, calls };
}

test('runFanOutWithGrading: đạt ngay vòng 1 thì không sửa lại', async () => {
  const grader = createKeywordGrader({
    correct: [{ keyword: '42' }],
    concise: [{ keyword: 'ngắn' }],
  });
  // Runner trả output tốt ngay từ đầu.
  const goodRunner = async () => 'đáp án 42, trình bày ngắn.';
  const result = await runFanOutWithGrading(
    goodRunner,
    [{ name: 'a', task: 'viết báo cáo' }],
    RUBRIC,
    { grader, maxRounds: 3 },
  );
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.totalRounds, 1);
  assert.equal(result.tasks[0].roundsUsed, 1);
  assert.equal(result.tasks[0].passed, true);
  assert.match(result.summary, /1 đạt, 0 chưa đạt/);
});

test('runFanOutWithGrading: chưa đạt → gửi sửa lại kèm feedback, đạt ở vòng 2', async () => {
  const { runner, calls } = keywordGraderFor('fix-on-retry');
  const grader = createKeywordGrader({
    correct: [{ keyword: '42' }],
    concise: [{ keyword: 'ngắn' }],
  });
  const seenTasks = [];
  const spyRunner = async (input) => {
    seenTasks.push(input.task);
    return runner(input);
  };
  const events = [];
  const result = await runFanOutWithGrading(
    spyRunner,
    [{ name: 'a', task: 'viết báo cáo' }],
    RUBRIC,
    { grader, maxRounds: 3, onEvent: (e) => events.push(e) },
  );
  assert.equal(result.passed, 1);
  assert.equal(result.tasks[0].roundsUsed, 2);
  assert.equal(calls.get('a'), 2);
  // Task vòng 2 phải chứa feedback của grader (để subagent biết sửa gì).
  assert.match(seenTasks[1], /Phản hồi từ grader/);
  assert.match(seenTasks[1], /Đúng: 0\/10/);
  assert.ok(events.some((e) => e.type === 'task-retry'));
  assert.ok(events.some((e) => e.type === 'round-start' && e.round === 2));
});

test('runFanOutWithGrading: hết maxRounds vẫn rớt thì dừng, ghi gave-up', async () => {
  const { runner } = keywordGraderFor('always-bad');
  const grader = createKeywordGrader({ correct: [{ keyword: '42' }], concise: [{ keyword: 'ngắn' }] });
  const events = [];
  const result = await runFanOutWithGrading(
    runner,
    [{ name: 'a', task: 'viết báo cáo' }],
    RUBRIC,
    { grader, maxRounds: 2, onEvent: (e) => events.push(e) },
  );
  assert.equal(result.passed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.totalRounds, 2);
  assert.equal(result.tasks[0].roundsUsed, 2);
  assert.ok(events.some((e) => e.type === 'task-gave-up'));
  assert.match(result.summary, /CHƯA ĐẠT/);
});

test('runFanOutWithGrading: giới hạn đồng thời + tên trùng bị throw trước khi chạy', async () => {
  let running = 0;
  let maxRunning = 0;
  const runner = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await sleep(20);
    running -= 1;
    return 'đáp án 42, trình bày ngắn.';
  };
  const grader = createKeywordGrader({ correct: [{ keyword: '42' }], concise: [{ keyword: 'ngắn' }] });
  const tasks = Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, task: `task ${i}` }));
  const result = await runFanOutWithGrading(runner, tasks, RUBRIC, {
    grader,
    concurrency: 2,
    maxRounds: 1,
  });
  assert.equal(result.passed, 6);
  assert.ok(maxRunning <= 2, `đồng thời tối đa 2, thấy ${maxRunning}`);
  assert.ok(maxRunning >= 2, 'phải chạy song song thật, không tuần tự');

  await assert.rejects(
    () =>
      runFanOutWithGrading(
        runner,
        [
          { name: 'dup', task: 'a' },
          { name: 'dup', task: 'b' },
        ],
        RUBRIC,
        { grader },
      ),
    /Tên subagent phải duy nhất/,
  );
  await assert.rejects(
    () => runFanOutWithGrading(runner, [{ name: 'a', task: 'x' }], RUBRIC, { grader, concurrency: 0 }),
    /concurrency > 0/,
  );
  await assert.rejects(
    () => runFanOutWithGrading(runner, [{ name: 'a', task: 'x' }], RUBRIC, { grader, maxRounds: 0 }),
    /maxRounds > 0/,
  );
});

test('runFanOutWithGrading: runner lỗi/timeout không kéo sập nhóm, vòng sau chạy lại', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    if (calls === 1) throw new Error('provider sập');
    return 'đáp án 42, trình bày ngắn.';
  };
  const grader = createKeywordGrader({ correct: [{ keyword: '42' }], concise: [{ keyword: 'ngắn' }] });
  const result = await runFanOutWithGrading(
    runner,
    [
      { name: 'bad', task: 'task lỗi' },
      { name: 'good', task: 'task tốt' },
    ],
    RUBRIC,
    { grader, maxRounds: 2 },
  );
  // bad: vòng 1 lỗi (0 điểm) → vòng 2 chạy lại, đạt. good: đạt vòng 1.
  assert.equal(result.passed, 2);
  const bad = result.tasks.find((t) => t.name === 'bad');
  assert.equal(bad.roundsUsed, 2);
  assert.equal(bad.history[0].status, 'error');
  assert.match(bad.history[0].grade.feedback, /Subagent lỗi/);
});

test('runFanOutWithGrading: không có task thì trả rỗng, không chạy grader', async () => {
  let graded = false;
  const grader = async () => {
    graded = true;
    return [];
  };
  const result = await runFanOutWithGrading(async () => 'x', [], RUBRIC, { grader });
  assert.equal(result.totalRounds, 0);
  assert.equal(result.tasks.length, 0);
  assert.equal(graded, false);
});

test('defaults: concurrency + maxRounds mặc định đúng', () => {
  assert.equal(DEFAULT_FANOUT_CONCURRENCY, 4);
  assert.equal(DEFAULT_FANOUT_MAX_ROUNDS, 3);
});

test('AgentRunner.runFanOutWithGrading: nối runner thật + mock provider, retry qua loop', async () => {
  const { AgentRunner } = await import('../packages/core/dist/index.js');
  // Provider trả theo task trong message (không phụ thuộc thứ tự gọi
  // song song): task A lần đầu xấu → retry tốt; task B tốt ngay.
  const callsByTask = new Map();
  const provider = {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      const userText = (req.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      const key = userText.includes('báo cáo A') ? 'A' : 'B';
      const n = (callsByTask.get(key) ?? 0) + 1;
      callsByTask.set(key, n);
      if (key === 'A' && n === 1) return { text: 'output thiếu từ khoá', toolCalls: [] };
      return { text: 'đáp án 42, trình bày ngắn.', toolCalls: [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
  const runner = new AgentRunner(provider, [], {
    bot: {
      id: 'bot-test',
      name: 'bot-test',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'Bạn là trợ lý test.',
      workspaceDir: process.cwd(),
      autoApprove: true,
    },
    events: {
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onApprovalNeeded: async () => true,
    },
    maxSteps: 5,
  });
  const grader = createKeywordGrader({
    correct: [{ keyword: '42' }],
    concise: [{ keyword: 'ngắn' }],
  });
  const result = await runner.runFanOutWithGrading(
    [
      { name: 'a', task: 'viết báo cáo A', spec: { instructions: 'Viết báo cáo.' } },
      { name: 'b', task: 'viết báo cáo B', spec: { instructions: 'Viết báo cáo.' } },
    ],
    RUBRIC,
    { grader, maxRounds: 3 },
  );
  assert.equal(result.passed, 2);
  assert.equal(result.tasks.find((t) => t.name === 'a').roundsUsed, 2);
  assert.equal(result.tasks.find((t) => t.name === 'b').roundsUsed, 1);
  // Cây nested của runner ghi đủ node con (mỗi lần spawn 1 node —
  // retry của A là spawn mới nên tổng là root + A(v1) + B + A(v2) = 4).
  assert.equal(runner.subagentTreeSnapshot().totalNodes, 4);
  assert.equal(runner.subagentTreeSnapshot().root.children.length, 3);
});
