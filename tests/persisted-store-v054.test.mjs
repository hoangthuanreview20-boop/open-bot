/**
 * Tests for v0.54 (P1-10): renderer persisted store có version (§9).
 *
 * Covered here (pure core logic, no DOM — storage inject qua StorageLike):
 *  - save/load roundtrip: envelope lưu đủ schemaVersion + scope +
 *    accountSensitive; đọc lại đúng giá trị.
 *  - load: chưa có gì → default; JSON hỏng → default + report
 *    `client_persistence`; sai version không migrate → default + report;
 *    có migrate → giá trị đã migrate; dữ liệu legacy (không envelope) +
 *    migrate từ version 0.
 *  - save lỗi (storage throw) → false + report; clear lỗi → report, không throw.
 *  - PersistedStoreRegistry: clearAccountSensitive chỉ xoá store gắn tài
 *    khoản; clearForNoStorage xoá mọi store client-persisted.
 *  - DraftStore: create trả id UUID; get/update/remove/list.
 *  - createDraftId trả UUID hợp lệ; schemaVersion < 1 / key rỗng → throw.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/persisted-store-v054.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DraftStore,
  PersistedStore,
  PersistedStoreRegistry,
  createDraftId,
  createMemoryStorage,
} from '../packages/core/dist/client/persistedStore.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reportsCollector() {
  const reports = [];
  return { reports, report: (r) => reports.push(r) };
}

test('P1-10: save/load roundtrip — envelope có đủ schemaVersion + scope + accountSensitive', () => {
  const storage = createMemoryStorage();
  const { reports, report } = reportsCollector();
  const store = new PersistedStore(
    {
      key: 'open-bot:test',
      schemaVersion: 2,
      scope: 'client-persisted',
      accountSensitive: true,
      defaultValue: { a: 1 },
    },
    storage,
    report,
  );
  assert.equal(store.load().a, 1, 'chưa có gì thì trả default');
  assert.equal(store.save({ a: 5 }), true);
  assert.deepEqual(store.load(), { a: 5 });
  const raw = JSON.parse(storage.getItem('open-bot:test'));
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.scope, 'client-persisted');
  assert.equal(raw.accountSensitive, true);
  assert.deepEqual(raw.value, { a: 5 });
  assert.deepEqual(reports, [], 'không lỗi thì không report');
  store.clear();
  assert.equal(storage.getItem('open-bot:test'), null);
  assert.equal(store.load().a, 1);
});

test('P1-10: load hỏng — JSON hỏng / sai version → default + report client_persistence', () => {
  const storage = createMemoryStorage();
  const { reports, report } = reportsCollector();
  const store = new PersistedStore(
    {
      key: 'open-bot:broken',
      schemaVersion: 1,
      scope: 'client-persisted',
      accountSensitive: false,
      defaultValue: 'mặc định',
    },
    storage,
    report,
  );
  storage.setItem('open-bot:broken', '{json hỏng');
  assert.equal(store.load(), 'mặc định');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'client_persistence');
  assert.equal(reports[0].storeKey, 'open-bot:broken');
  assert.equal(reports[0].operation, 'load');

  // Sai version, không có migrate → default + report.
  storage.setItem(
    'open-bot:broken',
    JSON.stringify({ schemaVersion: 99, scope: 'client-persisted', accountSensitive: false, value: 'cũ' }),
  );
  assert.equal(store.load(), 'mặc định');
  assert.equal(reports.length, 2);
  assert.match(reports[1].error, /schemaVersion lưu \(99\)/);
});

test('P1-10: migrate — sai version có migrate thì dùng giá trị đã migrate; legacy không envelope migrate từ 0', () => {
  const storage = createMemoryStorage();
  const { reports, report } = reportsCollector();
  const store = new PersistedStore(
    {
      key: 'open-bot:mig',
      schemaVersion: 2,
      scope: 'client-persisted',
      accountSensitive: false,
      defaultValue: { count: 0 },
      migrate: (value, fromVersion) => {
        if (fromVersion === 1 && typeof value === 'object' && value !== null) {
          return { count: Number(value.count ?? 0) + 100 };
        }
        if (fromVersion === 0 && typeof value === 'number') return { count: value };
        throw new Error(`không migrate được từ ${fromVersion}`);
      },
    },
    storage,
    report,
  );
  storage.setItem(
    'open-bot:mig',
    JSON.stringify({ schemaVersion: 1, scope: 'client-persisted', accountSensitive: false, value: { count: 3 } }),
  );
  assert.deepEqual(store.load(), { count: 103 });
  // Legacy: giá trị thô, không có envelope.
  storage.setItem('open-bot:mig', '7');
  assert.deepEqual(store.load(), { count: 7 });
  // Migrate lỗi → default + report migrate.
  storage.setItem(
    'open-bot:mig',
    JSON.stringify({ schemaVersion: 5, scope: 'client-persisted', accountSensitive: false, value: {} }),
  );
  assert.deepEqual(store.load(), { count: 0 });
  assert.equal(reports[reports.length - 1].operation, 'migrate');
});

test('P1-10: save/clear lỗi storage → false/report, không throw', () => {
  const throwing = {
    getItem: () => {
      throw new Error('đọc lỗi');
    },
    setItem: () => {
      throw new Error('ghi lỗi: hết quota');
    },
    removeItem: () => {
      throw new Error('xoá lỗi');
    },
  };
  const { reports, report } = reportsCollector();
  const store = new PersistedStore(
    {
      key: 'open-bot:throw',
      schemaVersion: 1,
      scope: 'session-only',
      accountSensitive: false,
      defaultValue: 0,
    },
    throwing,
    report,
  );
  assert.equal(store.load(), 0);
  assert.equal(store.save(1), false);
  assert.doesNotThrow(() => store.clear());
  assert.equal(reports.length, 3);
  assert.deepEqual(
    reports.map((r) => r.operation),
    ['load', 'save', 'clear'],
  );
  assert.ok(reports.every((r) => r.kind === 'client_persistence'));
});

test('P1-10: registry — clearAccountSensitive chỉ xoá store gắn tài khoản; clearForNoStorage xoá hết client-persisted', () => {
  const storage = createMemoryStorage();
  const registry = new PersistedStoreRegistry();
  const drafts = registry.register(
    new PersistedStore(
      { key: 'open-bot:drafts', schemaVersion: 1, scope: 'client-persisted', accountSensitive: true, defaultValue: {} },
      storage,
    ),
  );
  const layout = registry.register(
    new PersistedStore(
      { key: 'open-bot:layout', schemaVersion: 1, scope: 'client-persisted', accountSensitive: false, defaultValue: {} },
      storage,
    ),
  );
  const session = registry.register(
    new PersistedStore(
      { key: 'open-bot:session', schemaVersion: 1, scope: 'session-only', accountSensitive: true, defaultValue: {} },
      storage,
    ),
  );
  drafts.save({ d1: 'nháp' });
  layout.save({ collapsed: true });
  session.save({ tmp: 1 });
  const clearedAccount = registry.clearAccountSensitive();
  assert.deepEqual(clearedAccount.sort(), ['open-bot:drafts', 'open-bot:session'].sort());
  assert.equal(storage.getItem('open-bot:drafts'), null);
  assert.notEqual(storage.getItem('open-bot:layout'), null, 'layout không gắn tài khoản thì giữ lại');
  assert.equal(storage.getItem('open-bot:session'), null);
  layout.save({ collapsed: false });
  drafts.save({ d1: 'nháp mới' });
  const clearedNoStorage = registry.clearForNoStorage();
  // clearForNoStorage xoá MỌI store client-persisted đã đăng ký (drafts +
  // layout) — kể cả store đã rỗng sau lần xoá trước; store session-only
  // (open-bot:session) không bị động tới.
  assert.deepEqual(clearedNoStorage.sort(), ['open-bot:drafts', 'open-bot:layout'].sort());
  assert.equal(storage.getItem('open-bot:drafts'), null);
  assert.equal(storage.getItem('open-bot:layout'), null);
  assert.deepEqual(registry.keys().sort(), ['open-bot:drafts', 'open-bot:layout', 'open-bot:session'].sort());
});

test('P1-10: DraftStore — create trả UUID, get/update/remove/list', () => {
  const storage = createMemoryStorage();
  const raw = new PersistedStore(
    { key: 'open-bot:drafts', schemaVersion: 1, scope: 'client-persisted', accountSensitive: true, defaultValue: {} },
    storage,
  );
  const drafts = new DraftStore(raw);
  const id = drafts.create({ botId: 'bot-1', text: 'nháp 1' });
  assert.match(id, UUID_RE, 'draft key phải là UUID');
  const id2 = drafts.create({ botId: 'bot-1', text: 'nháp 2' });
  assert.notEqual(id, id2);
  assert.equal(drafts.get(id).value.text, 'nháp 1');
  assert.equal(drafts.get('không-có'), null);
  assert.equal(drafts.update(id, { botId: 'bot-1', text: 'nháp 1 sửa' }), true);
  assert.equal(drafts.get(id).value.text, 'nháp 1 sửa');
  assert.equal(drafts.update('không-có', { botId: 'x', text: '' }), false);
  assert.equal(drafts.list().length, 2);
  assert.equal(drafts.remove(id2), true);
  assert.equal(drafts.remove(id2), false);
  assert.equal(drafts.list().length, 1);
  // Draft vẫn nằm trong 1 store duy nhất (không phải 1 key storage/draft).
  assert.deepEqual(storage.keys(), ['open-bot:drafts']);
});

test('P1-10: createDraftId trả UUID; def sai thì throw ngay lúc tạo store', () => {
  assert.match(createDraftId(), UUID_RE);
  assert.notEqual(createDraftId(), createDraftId());
  const storage = createMemoryStorage();
  assert.throws(
    () =>
      new PersistedStore(
        { key: '', schemaVersion: 1, scope: 'client-persisted', accountSensitive: false, defaultValue: null },
        storage,
      ),
    /key không rỗng/,
  );
  assert.throws(
    () =>
      new PersistedStore(
        { key: 'x', schemaVersion: 0, scope: 'client-persisted', accountSensitive: false, defaultValue: null },
        storage,
      ),
    /schemaVersion phải là số nguyên >= 1/,
  );
});
