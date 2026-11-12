/**
 * Tests cho v0.59 — 1Password Settings UI + call view / dictation UI +
 * peek_changes dữ liệu thật.
 *
 *  1. Core `peek_changes` (packages/core/src/voice/fileChanges.ts):
 *     trích xuất đổi file thật từ lịch sử tool-call của bot — không
 *     còn trả `changes: []`.
 *  2. Tích hợp với store thật: ghi tool call qua ToolCallHistoryStore
 *     (file `<workspace>/.open-bot/tool-calls.jsonl` do agent loop ghi)
 *     rồi đọc lại bằng chính đường mà main dùng cho peek_changes.
 *  3. Helper thuần của call view / dictation
 *     (apps/desktop/src/renderer/voice/voiceUi.ts).
 *  4. Mức source (không cần chạy app): section 1Password trong tab
 *     Bảo mật & Vault, IPC set-enabled, CallView, nút mic dictation
 *     trong ChatView, handler peek_changes trong main.
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-v059.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractFileChanges,
  buildPeekChangesResult,
  PEEK_CHANGES_LIMIT,
} from '../packages/core/dist/voice/fileChanges.js';
import { ToolCallHistoryStore } from '../packages/tools/dist/index.js';
import {
  appendCallTranscript,
  concatPcm16Base64,
  insertDictationText,
} from '../apps/desktop/src/renderer/voice/voiceUi.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = 1793000000000;
const rec = (tool_name, args, extra = {}) => ({
  tool_call_id: `call-${Math.random().toString(36).slice(2)}`,
  tool_name,
  args_json: JSON.stringify(args),
  started_at_ms: NOW,
  completed_at_ms: NOW + 100,
  status: 'ok',
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. extractFileChanges — dữ liệu thật từ lịch sử tool-call
// ---------------------------------------------------------------------------

test('v059 peek_changes: trích đổi file thật từ tool ghi file (write/edit/delete)', () => {
  const records = [
    rec('read_file', { path: 'notes/a.md' }, { started_at_ms: NOW, completed_at_ms: NOW + 10 }),
    rec('write_file', { path: 'notes/todo.md', content: 'x' }, { started_at_ms: NOW + 20, completed_at_ms: NOW + 30 }),
    rec('apply_diff', { path: 'src/app.ts' }, { started_at_ms: NOW + 40, completed_at_ms: NOW + 50 }),
    rec('delete_file', { path: 'old.txt' }, { started_at_ms: NOW + 60, completed_at_ms: NOW + 70 }),
    rec('shell_exec', { command: 'ls' }, { started_at_ms: NOW + 80, completed_at_ms: NOW + 90 }),
  ];
  const changes = extractFileChanges(records, { botId: 'bot-1' });
  // Mới nhất trước: delete, edit, write.
  assert.deepEqual(
    changes.map((c) => [c.file, c.kind]),
    [
      ['old.txt', 'delete'],
      ['src/app.ts', 'edit'],
      ['notes/todo.md', 'write'],
    ],
  );
  for (const c of changes) {
    assert.equal(c.botId, 'bot-1');
    assert.equal(typeof c.at, 'number');
    assert.ok(c.at >= NOW);
    assert.equal(c.status, 'ok');
  }
  assert.equal(changes[2].tool, 'write_file');
});

test('v059 peek_changes: lọc theo file, giới hạn số lượng, bỏ record hỏng', () => {
  const records = [
    rec('write_file', { path: 'a.md', content: '1' }),
    { tool_call_id: 'bad-json', tool_name: 'write_file', args_json: '{not json', started_at_ms: NOW },
    rec('write_file', { path: 'b.md', content: '2' }),
    rec('write_file', { content: 'không có path' }),
    rec('write_file', { path: 'a.md', content: '3' }),
  ];
  const filtered = extractFileChanges(records, { botId: 'bot-1', file: 'a.md' });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((c) => c.file === 'a.md'));
  const limited = extractFileChanges(records, { botId: 'bot-1', limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].file, 'a.md');
  assert.equal(PEEK_CHANGES_LIMIT, 20);
});

test('v059 peek_changes: không có đổi file nào thì trả rỗng + ghi chú thật (không bịa)', () => {
  const result = buildPeekChangesResult({
    botId: 'bot-1',
    workspaceDir: '/tmp/ws',
    records: [rec('read_file', { path: 'a.md' })],
  });
  assert.equal(result.workspaceDir, '/tmp/ws');
  assert.equal(result.botId, 'bot-1');
  assert.deepEqual(result.changes, []);
  assert.match(result.note, /chưa đổi file nào/);
});

test('v059 peek_changes: payload có đủ file + loại đổi + thời gian + bot', () => {
  const result = buildPeekChangesResult({
    botId: 'bot-9',
    workspaceDir: '/tmp/ws',
    records: [rec('write_file', { path: 'x.md', content: 'hi' })],
  });
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0], {
    file: 'x.md',
    kind: 'write',
    at: NOW + 100,
    botId: 'bot-9',
    tool: 'write_file',
    status: 'ok',
  });
  assert.equal(result.note, undefined);
});

// ---------------------------------------------------------------------------
// 2. Tích hợp store thật: tool ghi file -> history -> peek_changes
// ---------------------------------------------------------------------------

test('v059 peek_changes: sau khi tool ghi file, history thật trả đổi file thật (không rỗng)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v059-peek-'));
  try {
    const store = new ToolCallHistoryStore(dir);
    // Mô phỏng agent loop ghi lại các tool call đã chạy (P1-7).
    store.record({
      tool_call_id: 'c1',
      tool_name: 'write_file',
      args_json: JSON.stringify({ path: 'notes/todo.md', content: 'mua sữa' }),
      started_at_ms: NOW,
      completed_at_ms: NOW + 50,
      status: 'ok',
    });
    store.record({
      tool_call_id: 'c2',
      tool_name: 'apply_diff',
      args_json: JSON.stringify({ path: 'src/app.ts' }),
      started_at_ms: NOW + 60,
      completed_at_ms: NOW + 120,
      status: 'ok',
    });
    store.record({
      tool_call_id: 'c3',
      tool_name: 'read_file',
      args_json: JSON.stringify({ path: 'notes/todo.md' }),
      started_at_ms: NOW + 130,
      completed_at_ms: NOW + 140,
      status: 'ok',
    });
    // Đường main dùng cho peek_changes: đọc lại file history.
    const records = new ToolCallHistoryStore(dir).listRecent(100);
    assert.equal(records.length, 3);
    const result = buildPeekChangesResult({ botId: 'bot-1', workspaceDir: dir, records });
    assert.equal(result.changes.length, 2);
    assert.deepEqual(
      result.changes.map((c) => [c.file, c.kind]),
      [
        ['src/app.ts', 'edit'],
        ['notes/todo.md', 'write'],
      ],
    );
    // File history thật nằm trong workspace (không phải kho song song).
    assert.ok(fs.existsSync(path.join(dir, '.open-bot', 'tool-calls.jsonl')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Helper thuần của call view / dictation UI
// ---------------------------------------------------------------------------

test('v059 call view: transcript interim cập nhật tại chỗ, final đóng dòng rồi mở dòng mới', () => {
  let lines = [];
  lines = appendCallTranscript(lines, { text: 'xin', isFinal: false, at: 1 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].isFinal, false);
  lines = appendCallTranscript(lines, { text: 'xin chào', isFinal: false, at: 2 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'xin chào');
  lines = appendCallTranscript(lines, { text: 'xin chào bạn', isFinal: true, at: 3 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].isFinal, true);
  lines = appendCallTranscript(lines, { text: 'tôi giúp gì?', isFinal: true, at: 4 });
  assert.equal(lines.length, 2);
  assert.equal(lines[1].text, 'tôi giúp gì?');
  lines = appendCallTranscript(lines, { text: '   ', isFinal: true, at: 5 });
  assert.equal(lines.length, 2);
});

test('v059 dictation: transcript chèn vào ô nhập, cách bằng khoảng trắng', () => {
  assert.equal(insertDictationText('', 'xin chào'), 'xin chào');
  assert.equal(insertDictationText('mua', 'sữa nhé'), 'mua sữa nhé');
  assert.equal(insertDictationText('mua', '   '), 'mua');
  assert.equal(insertDictationText('mua ', '  sữa  '), 'mua  sữa');
});

test('v059 dictation: gộp frame PCM16 base64 không mất/không đảo mẫu', () => {
  const frame = (bytes) => Buffer.from(bytes).toString('base64');
  const merged = concatPcm16Base64([frame([1, 2, 3, 4]), frame([5, 6]), '']);
  assert.equal(Buffer.from(merged, 'base64').toString('hex'), '010203040506');
  assert.equal(concatPcm16Base64([]), '');
  assert.equal(concatPcm16Base64(['']), '');
});

// ---------------------------------------------------------------------------
// 4. Mức source: 1Password UI, CallView, dictation, IPC, main handler
// ---------------------------------------------------------------------------

test('v059 1Password UI: section nằm trong tab Bảo mật & Vault, có toggle + kiểm tra kết nối', () => {
  const tab = read('apps/desktop/src/renderer/components/SettingsSecurityTab.tsx');
  assert.match(tab, /data-testid="onepassword-section"/);
  assert.match(tab, /settings\.onePasswordTitle/);
  assert.match(tab, /toggleOnePassword\(e\.target\.checked\)/);
  assert.match(tab, /checkOnePassword\(\)/);
  assert.match(tab, /settings\.onePasswordSignedIn/);
  assert.match(tab, /settings\.onePasswordUnavailable/);
  assert.match(tab, /settings\.onePasswordDisabled/);
  assert.match(tab, /settings\.onePasswordCliVersion/);
  // Status không bao giờ render secret/token.
  assert.ok(!/onePasswordStatus\.(token|secret|password|value)/.test(tab));
  const settings = read('apps/desktop/src/renderer/components/SettingsView.tsx');
  assert.match(settings, /loadOnePasswordStatus\(\)/);
  assert.match(settings, /onepassword:status/);
  assert.match(settings, /onepassword:set-enabled/);
  assert.match(settings, /SettingsSecurityTab/);
});

test('v059 1Password IPC: preload + global.d.ts expose set-enabled, types có cờ enabled', () => {
  const preload = read('apps/desktop/src/main/preload.ts');
  assert.match(preload, /'onepassword:set-enabled'/);
  assert.match(preload, /setOnePasswordEnabled/);
  const globalDts = read('apps/desktop/src/renderer/global.d.ts');
  assert.match(globalDts, /'onepassword:set-enabled'/);
  assert.match(globalDts, /setOnePasswordEnabled\(enabled: boolean\)/);
  const types = read('apps/desktop/src/renderer/types.ts');
  assert.match(types, /enabled: boolean;\n  cliVersion\?: string;/);
});

test('v059 1Password main: set-enabled lưu settings + tắt thì không spawn worker, import-field từ chối', () => {
  const main = read('apps/desktop/src/main/main.ts');
  assert.match(main, /ipcMain\.handle\(\n\s+'onepassword:set-enabled'/);
  assert.match(main, /settings\.onePasswordEnabled = enabled;/);
  assert.match(main, /onePasswordBroker\.dispose\(\);/);
  assert.match(main, /onePasswordEnabled === false/);
  assert.match(main, /1Password broker đã tắt trong Cài đặt/);
});

test('v059 call view: CallView có trạng thái + transcript trực tiếp + nút kết thúc, đăng ký surface call', () => {
  const callView = read('apps/desktop/src/renderer/components/CallView.tsx');
  assert.match(callView, /data-testid="call-view"/);
  assert.match(callView, /data-testid="call-status"/);
  assert.match(callView, /data-testid="call-transcript"/);
  assert.match(callView, /data-testid="call-end"/);
  assert.match(callView, /voice\.callEnd/);
  assert.match(callView, /voiceSurfaceRegister\(botId, surface, 'call'\)/);
  assert.match(callView, /voiceSurfaceUnregister/);
  const chat = read('apps/desktop/src/renderer/components/ChatView.tsx');
  assert.match(chat, /<CallView/);
  assert.match(chat, /setVoiceTranscripts/);
  assert.match(chat, /appendCallTranscript/);
});

test('v059 dictation UI: nút mic trong ô nhập ChatView gọi voice:dictation, chèn transcript, hiện "đang nghe"', () => {
  const chat = read('apps/desktop/src/renderer/components/ChatView.tsx');
  assert.match(chat, /data-testid="dictation-button"/);
  assert.match(chat, /voiceDictation\(bot\.id, audioBase64\)/);
  assert.match(chat, /concatPcm16Base64\(frames\)/);
  assert.match(chat, /insertDictationText\(inputRef\.current, res\.text\)/);
  assert.match(chat, /data-testid="dictation-listening"/);
  assert.match(chat, /voice\.dictationListening/);
  assert.match(chat, /voice\.dictationHint/);
});

test('v059 peek_changes main: đọc history thật qua ToolCallHistoryStore, không còn trả rỗng', () => {
  const main = read('apps/desktop/src/main/main.ts');
  assert.match(main, /ToolCallHistoryStore/);
  assert.match(main, /buildPeekChangesResult\(\{/);
  assert.match(main, /readBotFileChangeRecords/);
  assert.ok(!main.includes('changes: [] as string[]'), 'main không còn trả changes rỗng');
  assert.ok(!main.includes('chưa theo dõi lịch sử đổi file theo bot'), 'ghi chú cũ đã bỏ');
});

test('v059 i18n: mọi key mới có ở cả en và vi', () => {
  const en = JSON.parse(read('apps/desktop/src/renderer/i18n/locales/en.json'));
  const vi = JSON.parse(read('apps/desktop/src/renderer/i18n/locales/vi.json'));
  const keys = [
    'settings.onePasswordTitle',
    'settings.onePasswordIntro',
    'settings.onePasswordEnableLabel',
    'settings.onePasswordCheck',
    'settings.onePasswordChecking',
    'settings.onePasswordSignedIn',
    'settings.onePasswordSignedOut',
    'settings.onePasswordUnavailable',
    'settings.onePasswordDisabled',
    'settings.onePasswordCliVersion',
    'settings.onePasswordLoadError',
    'settings.onePasswordSaveError',
    'settings.onePasswordGuide',
    'voice.callTitle',
    'voice.callConnecting',
    'voice.callActive',
    'voice.callEnded',
    'voice.callEnd',
    'voice.callTranscriptEmpty',
    'voice.dictationRecord',
    'voice.dictationStop',
    'voice.dictationHint',
    'voice.dictationListening',
    'voice.dictationTranscribing',
    'voice.dictationError',
  ];
  for (const key of keys) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en thiếu ${key}`);
    assert.ok(typeof vi[key] === 'string' && vi[key].length > 0, `vi thiếu ${key}`);
  }
});
