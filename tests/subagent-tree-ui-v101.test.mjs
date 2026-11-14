/**
 * subagent-tree-ui-v101.test.mjs — SubagentTreeView UI v1.01 (Team T6).
 *
 * - Mọi key `subagentTree.*` / `grader.*` mà component dùng đều có đủ
 *   6 locale, giá trị không rỗng, {placeholder} khớp với en.
 * - Không có tiếng Việt hard-code trong SubagentTreeView.tsx và
 *   subagentTreeUtils.ts (chuỗi hiển thị chỉ qua t()).
 * - Helper thuần (flatten/count/gradePercent) chạy đúng trên snapshot mẫu.
 *
 * Run: `node --test tests/subagent-tree-ui-v101.test.mjs` (không cần build;
 * utils import từ source TS qua Node type stripping, như agui test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countTreeByStatus,
  flattenSubagentTree,
  gradePercent,
  statusLabelKey,
} from '../apps/desktop/src/renderer/components/subagentTreeUtils.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const localesDir = join(repo, 'apps/desktop/src/renderer/i18n/locales');
const componentPath = join(
  repo,
  'apps/desktop/src/renderer/components/SubagentTreeView.tsx',
);
const utilsPath = join(repo, 'apps/desktop/src/renderer/components/subagentTreeUtils.ts');

const LOCALES = ['en', 'vi', 'zh', 'ja', 'fr', 'es'];
const dicts = {};
for (const code of LOCALES) {
  dicts[code] = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
}

const EXPECTED_KEYS = [
  'subagentTree.title',
  'subagentTree.empty',
  'subagentTree.nodes',
  'subagentTree.tokens',
  'subagentTree.maxDepth',
  'subagentTree.totalOverBudget',
  'subagentTree.overBudget',
  'subagentTree.depth',
  'subagentTree.spawns',
  'subagentTree.expand',
  'subagentTree.collapse',
  'subagentTree.task',
  'subagentTree.model',
  'subagentTree.status.running',
  'subagentTree.status.done',
  'subagentTree.status.error',
  'subagentTree.status.timeout',
  'subagentTree.status.stopped',
  'grader.passed',
  'grader.failed',
  'grader.rounds',
];

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Ký tự tiếng Việt đặc trưng (đ + nguyên âm có dấu) — component không được chứa. */
const VIETNAMESE_RE = /[đĐăắằẳẵặâấầẩẫậêếềểễệôốồổỗộơớờởỡợưúủũụưứừửữựàáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]/;

function sampleSnapshot() {
  return {
    root: {
      id: 'root',
      parentId: null,
      name: 'root',
      depth: 0,
      status: 'running',
      task: '',
      tokensUsed: 120,
      budgetTokens: 32000,
      spawnsUsed: 2,
      startedAt: 1000,
      overBudget: false,
      children: [
        {
          id: 'a',
          parentId: 'root',
          name: 'researcher',
          depth: 1,
          status: 'done',
          task: 'tìm tài liệu',
          model: 'mock',
          tokensUsed: 80,
          budgetTokens: 32000,
          spawnsUsed: 1,
          startedAt: 1001,
          endedAt: 1002,
          overBudget: false,
          children: [
            {
              id: 'a1',
              parentId: 'a',
              name: 'crawler',
              depth: 2,
              status: 'error',
              task: 'crawl trang',
              tokensUsed: 10,
              budgetTokens: 5,
              spawnsUsed: 0,
              startedAt: 1002,
              endedAt: 1003,
              error: 'timeout',
              overBudget: true,
              children: [],
            },
          ],
        },
        {
          id: 'b',
          parentId: 'root',
          name: 'coder',
          depth: 1,
          status: 'timeout',
          task: 'viết code',
          tokensUsed: 30,
          budgetTokens: 32000,
          spawnsUsed: 0,
          startedAt: 1001,
          overBudget: false,
          children: [],
        },
      ],
    },
    totalNodes: 4,
    totalTokensUsed: 240,
    totalBudgetTokens: 1000,
    totalOverBudget: false,
    policy: { maxDepth: 5, maxSpawnsPerRoot: 50, maxSpawnsPerBranch: 10 },
  };
}

test('i18n: key subagentTree.* + grader.* có đủ 6 locale, placeholder khớp en', () => {
  for (const key of EXPECTED_KEYS) {
    const enValue = dicts.en[key];
    assert.ok(typeof enValue === 'string' && enValue.length > 0, `en thiếu key ${key}`);
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `${code} thiếu key ${key}`,
      );
      assert.deepEqual(
        placeholders(value),
        placeholders(enValue),
        `${code}.${key} placeholder khác en (en: ${placeholders(enValue)}, ${code}: ${placeholders(value)})`,
      );
    }
  }
});

test('i18n: mọi key t() trong component đều tồn tại trong locale', () => {
  const source = readFileSync(componentPath, 'utf-8');
  const used = new Set([...source.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
  // statusLabelKey() trả key động — kiểm tra riêng qua helper.
  used.add('subagentTree.status.running');
  used.add('subagentTree.status.done');
  used.add('subagentTree.status.error');
  used.add('subagentTree.status.timeout');
  used.add('subagentTree.status.stopped');
  assert.ok(used.size > 0, 'component phải dùng ít nhất 1 key t()');
  for (const key of used) {
    for (const code of LOCALES) {
      assert.ok(dicts[code][key] !== undefined, `${code} thiếu key component dùng: ${key}`);
    }
  }
});

test('component + utils: không có tiếng Việt hard-code', () => {
  for (const file of [componentPath, utilsPath]) {
    const source = readFileSync(file, 'utf-8');
    assert.ok(!VIETNAMESE_RE.test(source), `${file} chứa tiếng Việt hard-code`);
  }
});

test('subagentTreeUtils: flatten giữ thứ tự depth-first, collapse ẩn con cháu', () => {
  const snap = sampleSnapshot();
  const rows = flattenSubagentTree(snap);
  assert.deepEqual(
    rows.map((r) => r.node.id),
    ['root', 'a', 'a1', 'b'],
  );
  assert.deepEqual(
    rows.map((r) => r.depth),
    [0, 1, 2, 1],
  );
  assert.ok(rows.every((r) => r.hidden === false));
  const collapsed = flattenSubagentTree(snap, new Set(['a']));
  const hidden = collapsed.filter((r) => r.hidden).map((r) => r.node.id);
  assert.deepEqual(hidden, ['a1'], 'collapse node a thì chỉ ẩn cháu a1');
  assert.ok(collapsed.find((r) => r.node.id === 'a' && r.hidden === false));
});

test('subagentTreeUtils: countTreeByStatus đếm đủ mọi trạng thái', () => {
  const counts = countTreeByStatus(sampleSnapshot());
  assert.deepEqual(counts, { running: 1, done: 1, error: 1, timeout: 1, stopped: 0 });
});

test('subagentTreeUtils: statusLabelKey + gradePercent', () => {
  assert.equal(statusLabelKey('done'), 'subagentTree.status.done');
  assert.equal(statusLabelKey('timeout'), 'subagentTree.status.timeout');
  assert.equal(gradePercent({ ratio: 0.857, passed: true, roundsUsed: 2 }), 86);
  assert.equal(gradePercent({ ratio: 1.5, passed: true, roundsUsed: 1 }), 100);
  assert.equal(gradePercent({ ratio: -0.2, passed: false, roundsUsed: 1 }), 0);
  assert.equal(gradePercent({ ratio: Number.NaN, passed: false, roundsUsed: 1 }), 0);
});

test('locale files: không có file locale nào ngoài LOCALES bị quên key mới', () => {
  const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files.sort(), [...LOCALES].map((c) => `${c}.json`).sort());
  for (const code of LOCALES) {
    for (const key of EXPECTED_KEYS) {
      assert.ok(dicts[code][key] !== undefined, `${code} thiếu ${key}`);
    }
  }
});
