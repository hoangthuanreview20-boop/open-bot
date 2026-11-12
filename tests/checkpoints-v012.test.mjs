/**
 * Checkpoint/resume sau mỗi step — v0.12 mục 4 (W4b).
 *
 * SQLite thật (BotMemory) trên thư mục tạm, mock provider không cần
 * thiết ở đây vì checkpoints.ts không gọi provider — test mô phỏng
 * vòng lặp 3 step bằng cách lưu checkpoint sau mỗi step rồi "crash"
 * (mở lại BotMemory) và resume từ checkpoint mới nhất.
 * Không gọi mạng live, không cần API key, không chạm x.ai.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import {
  saveCheckpoint,
  saveStepCheckpoint,
  listCheckpoints,
  getCheckpoint,
  resumeFromCheckpoint,
  buildResumeState,
  pruneCheckpoints,
  DEFAULT_CHECKPOINTS_KEPT,
} from '../packages/core/dist/agent/checkpoints.js';

function tmpMem() {
  const dir = mkdtempSync(join(tmpdir(), 'open-bot-ckpt-'));
  const mem = new BotMemory(dir);
  return { dir, mem };
}

function cleanup(dir, mem) {
  mem.close();
  rmSync(dir, { recursive: true, force: true });
}

/** History mẫu sau step 0: system + user + assistant kèm tool call + tool result. */
function messagesAfterStep0() {
  return [
    { role: 'system', content: 'Bạn là trợ lý.' },
    { role: 'user', content: 'Đọc file a.txt' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }],
    },
    { role: 'tool', content: 'nội dung a.txt', toolCallId: 'call-1' },
  ];
}

test('save + get: round-trip đủ messages, toolCalls và tokens', () => {
  const { dir, mem } = tmpMem();
  try {
    const saved = saveCheckpoint(mem, {
      runId: 'run-1',
      botId: 'bot-1',
      stepIndex: 0,
      messages: messagesAfterStep0(),
      toolCalls: [{ call: { id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }, result: { callId: 'call-1', ok: true, output: 'nội dung a.txt' } }],
      tokensUsed: 120,
    });
    assert.equal(saved.runId, 'run-1');
    assert.equal(saved.stepIndex, 0);
    assert.equal(saved.tokensUsed, 120);
    assert.ok(saved.id);
    assert.ok(saved.createdAt);

    const got = getCheckpoint(mem, 'run-1', 0);
    assert.deepEqual(got.messages, messagesAfterStep0());
    assert.equal(got.toolCalls.length, 1);
    assert.equal(got.toolCalls[0].call.name, 'read_file');
    assert.equal(got.toolCalls[0].result.output, 'nội dung a.txt');
    assert.equal(got.tokensUsed, 120);
  } finally {
    cleanup(dir, mem);
  }
});

test('list + latest: nhiều step theo thứ tự, latest lấy step cao nhất', () => {
  const { dir, mem } = tmpMem();
  try {
    for (let step = 0; step < 3; step++) {
      saveCheckpoint(mem, {
        runId: 'run-1',
        botId: 'bot-1',
        stepIndex: step,
        messages: [{ role: 'user', content: `step ${step}` }],
        tokensUsed: (step + 1) * 100,
      });
    }
    const list = listCheckpoints(mem, 'run-1');
    assert.deepEqual(list.map((c) => c.stepIndex), [0, 1, 2]);
    assert.deepEqual(list.map((c) => c.tokensUsed), [100, 200, 300]);
    const latest = getCheckpoint(mem, 'run-1', 'latest');
    assert.equal(latest.stepIndex, 2);
    assert.equal(latest.messages[0].content, 'step 2');
  } finally {
    cleanup(dir, mem);
  }
});

test('getCheckpoint run/step chưa có trả null, không ném lỗi', () => {
  const { dir, mem } = tmpMem();
  try {
    assert.equal(getCheckpoint(mem, 'run-chua-co', 'latest'), null);
    assert.equal(getCheckpoint(mem, 'run-chua-co', 0), null);
    saveCheckpoint(mem, { runId: 'run-1', botId: 'bot-1', stepIndex: 0, messages: [] });
    assert.equal(getCheckpoint(mem, 'run-1', 5), null);
    assert.equal(resumeFromCheckpoint(mem, 'run-chua-co'), null);
  } finally {
    cleanup(dir, mem);
  }
});

test('lưu đè cùng step (upsert): nội dung mới thắng, không tạo 2 bản ghi', () => {
  const { dir, mem } = tmpMem();
  try {
    const first = saveCheckpoint(mem, {
      runId: 'run-1', botId: 'bot-1', stepIndex: 0,
      messages: [{ role: 'user', content: 'cũ' }], tokensUsed: 10,
    });
    const second = saveCheckpoint(mem, {
      runId: 'run-1', botId: 'bot-1', stepIndex: 0,
      messages: [{ role: 'user', content: 'mới' }], tokensUsed: 20,
    });
    assert.equal(first.id, second.id);
    assert.equal(listCheckpoints(mem, 'run-1').length, 1);
    assert.equal(getCheckpoint(mem, 'run-1', 0).messages[0].content, 'mới');
    assert.equal(getCheckpoint(mem, 'run-1', 0).tokensUsed, 20);
  } finally {
    cleanup(dir, mem);
  }
});

test('resumeFromCheckpoint: nextStepIndex = step+1, đủ history + tool đã xong', () => {
  const { dir, mem } = tmpMem();
  try {
    saveCheckpoint(mem, {
      runId: 'run-1',
      botId: 'bot-1',
      stepIndex: 1,
      messages: messagesAfterStep0(),
      toolCalls: [{ call: { id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }, result: { callId: 'call-1', ok: true, output: 'nội dung a.txt' } }],
      tokensUsed: 250,
    });
    const state = resumeFromCheckpoint(mem, 'run-1');
    assert.equal(state.nextStepIndex, 2);
    assert.equal(state.runId, 'run-1');
    assert.equal(state.tokensUsed, 250);
    assert.deepEqual(state.messages, messagesAfterStep0());
    // Message assistant vẫn mang toolCalls, message tool vẫn đi sau nó —
    // provider nhận lại đúng cặp này nên không gọi lại tool đã xong.
    const assistant = state.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.toolCalls[0].id, 'call-1');
    assert.equal(state.completedToolCalls[0].call.id, 'call-1');
    assert.equal(state.completedToolCalls[0].result.ok, true);
    // Resume từ step cụ thể (không phải latest).
    const state0 = resumeFromCheckpoint(mem, 'run-1', 1);
    assert.equal(state0.nextStepIndex, 2);
  } finally {
    cleanup(dir, mem);
  }
});

test('buildResumeState thuần túy: sửa state resume không bẩn checkpoint gốc', () => {
  const { dir, mem } = tmpMem();
  try {
    const cp = saveCheckpoint(mem, {
      runId: 'run-1', botId: 'bot-1', stepIndex: 0,
      messages: messagesAfterStep0(), tokensUsed: 5,
    });
    const state = buildResumeState(cp);
    state.messages.push({ role: 'user', content: 'thêm sau' });
    state.messages[1].content = 'ĐÃ SỬA';
    assert.equal(cp.messages.length, 4);
    assert.equal(cp.messages[1].content, 'Đọc file a.txt');
    // Và sửa input sau khi save cũng không làm bẩn checkpoint đã lưu.
    const inputMessages = [{ role: 'user', content: 'gốc' }];
    saveCheckpoint(mem, { runId: 'run-2', botId: 'bot-1', stepIndex: 0, messages: inputMessages });
    inputMessages[0].content = 'ĐÃ ĐỔI SAU KHI SAVE';
    assert.equal(getCheckpoint(mem, 'run-2', 0).messages[0].content, 'gốc');
  } finally {
    cleanup(dir, mem);
  }
});

test('pruneCheckpoints: chỉ giữ N mới nhất; keep 0 xoá hết', () => {
  const { dir, mem } = tmpMem();
  try {
    for (let step = 0; step < 5; step++) {
      saveCheckpoint(mem, {
        runId: 'run-1', botId: 'bot-1', stepIndex: step,
        messages: [{ role: 'user', content: `step ${step}` }],
      });
    }
    assert.equal(DEFAULT_CHECKPOINTS_KEPT, 10);
    const deleted = pruneCheckpoints(mem, 'run-1', 2);
    assert.equal(deleted, 3);
    assert.deepEqual(listCheckpoints(mem, 'run-1').map((c) => c.stepIndex), [3, 4]);
    // Prune run khác không ảnh hưởng run này.
    saveCheckpoint(mem, { runId: 'run-2', botId: 'bot-1', stepIndex: 0, messages: [] });
    pruneCheckpoints(mem, 'run-2', 0);
    assert.equal(listCheckpoints(mem, 'run-2').length, 0);
    assert.equal(listCheckpoints(mem, 'run-1').length, 2);
    assert.equal(pruneCheckpoints(mem, 'run-1', 0), 2);
    assert.equal(listCheckpoints(mem, 'run-1').length, 0);
  } finally {
    cleanup(dir, mem);
  }
});

test('saveCheckpoint validate đầu vào: runId/botId rỗng, stepIndex âm', () => {
  const { dir, mem } = tmpMem();
  try {
    assert.throws(() => saveCheckpoint(mem, { runId: '', botId: 'b', stepIndex: 0, messages: [] }), /runId/);
    assert.throws(() => saveCheckpoint(mem, { runId: 'r', botId: '', stepIndex: 0, messages: [] }), /botId/);
    assert.throws(() => saveCheckpoint(mem, { runId: 'r', botId: 'b', stepIndex: -1, messages: [] }), /stepIndex/);
    assert.throws(() => pruneCheckpoints(mem, 'r', -1), /keepLastN/);
  } finally {
    cleanup(dir, mem);
  }
});

test('mô phỏng loop 3 step + crash + resume: không chạy lại step đã xong', () => {
  const { dir, mem } = tmpMem();
  try {
    // Giả lập loop: mỗi step provider trả 1 tool call, tool chạy xong,
    // loop push assistant + tool result rồi lưu checkpoint (saveStepCheckpoint).
    const messages = [
      { role: 'system', content: 'Bạn là trợ lý.' },
      { role: 'user', content: 'Làm 3 việc' },
    ];
    const done = [];
    const toolNames = ['tool_a', 'tool_b', 'tool_c'];
    let tokens = 0;
    for (let step = 0; step < 3; step++) {
      const call = { id: `call-${step}`, name: toolNames[step], args: {} };
      const result = { callId: call.id, ok: true, output: `xong ${toolNames[step]}` };
      messages.push({ role: 'assistant', content: '', toolCalls: [call] });
      messages.push({ role: 'tool', content: result.output, toolCallId: call.id });
      done.push({ call, result });
      tokens += 100;
      saveStepCheckpoint(mem, {
        runId: 'run-loop', botId: 'bot-1', stepIndex: step,
        messages, toolCalls: done, tokensUsed: tokens,
      });
    }
    // "Crash": đóng + mở lại BotMemory trên cùng thư mục (bảng + dữ liệu còn).
    mem.close();
    const mem2 = new BotMemory(dir);
    try {
      const state = resumeFromCheckpoint(mem2, 'run-loop');
      assert.equal(state.nextStepIndex, 3);
      assert.equal(state.tokensUsed, 300);
      assert.equal(state.messages.length, 2 + 3 * 2);
      assert.deepEqual(state.completedToolCalls.map((t) => t.call.name), toolNames);
      // Resume chỉ tiếp tục từ step 3 — 3 tool đã xong có trong history
      // nên model không gọi lại chúng.
      assert.equal(state.messages.filter((m) => m.role === 'tool').length, 3);
    } finally {
      mem2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint hỏng JSON trong DB: get/resume ném lỗi rõ ràng thay vì resume sai', () => {
  const { dir, mem } = tmpMem();
  try {
    // Chèn trực tiếp dòng hỏng qua API thô của BotMemory.
    mem.insertCheckpointRow({
      runId: 'run-hong', botId: 'bot-1', stepIndex: 0,
      messagesJson: '{không phải json', toolCallsJson: '[]', tokensUsed: 0,
    });
    assert.throws(() => getCheckpoint(mem, 'run-hong', 0), /không phải JSON/);
    assert.throws(() => resumeFromCheckpoint(mem, 'run-hong'), /không phải JSON/);
  } finally {
    cleanup(dir, mem);
  }
});
