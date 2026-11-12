/**
 * Tests cho v0.12 mục 8 — Structured output (JSON Schema) (W4d):
 *   packages/core/src/agent/structured.ts
 *
 * Chạy sau khi build riêng core:
 *   npx tsc -p packages/core/tsconfig.json
 *   node --test tests/structured-v012.test.mjs
 * Không cần API key thật, không gọi mạng (producer đều giả).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStructuredPromptHint,
  buildStructuredRetryHint,
  extractJsonText,
  formatStructuredError,
  parseStructuredOutput,
  parseStructuredWithRetry,
  validateAgainstSchema,
} from '../packages/core/dist/agent/structured.js';

// Schema mẫu: kết quả code-review.
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'message'],
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          message: { type: 'string', minLength: 1 },
          line: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// validateAgainstSchema
// ---------------------------------------------------------------------------

test('validateAgainstSchema: giá trị hợp lệ → không lỗi', () => {
  const errors = validateAgainstSchema(
    { verdict: 'pass', findings: [] },
    REVIEW_SCHEMA,
  );
  assert.deepEqual(errors, []);
});

test('validateAgainstSchema: giá trị hợp lệ đầy đủ (nested) → không lỗi', () => {
  const errors = validateAgainstSchema(
    {
      verdict: 'fail',
      summary: 'Có 1 lỗi nghiêm trọng.',
      findings: [{ severity: 'high', message: 'SQL injection', line: 42 }],
    },
    REVIEW_SCHEMA,
  );
  assert.deepEqual(errors, []);
});

test('validateAgainstSchema: thiếu trường bắt buộc → lỗi từng field', () => {
  const errors = validateAgainstSchema({ findings: [] }, REVIEW_SCHEMA);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, '$.verdict');
  assert.match(errors[0].message, /thiếu trường bắt buộc/);
});

test('validateAgainstSchema: sai kiểu → lỗi ghi rõ kiểu mong đợi', () => {
  const errors = validateAgainstSchema({ verdict: 123, findings: [] }, REVIEW_SCHEMA);
  // 123 vi phạm cả enum lẫn type → phải có lỗi type ghi rõ kiểu mong đợi.
  assert.ok(
    errors.some((e) => e.path === '$.verdict' && /kiểu phải là string/.test(e.message)),
    JSON.stringify(errors),
  );
  assert.ok(errors.some((e) => e.path === '$.verdict' && /nhận được number/.test(e.message)));
});

test('validateAgainstSchema: enum sai → lỗi', () => {
  const errors = validateAgainstSchema(
    { verdict: 'maybe', findings: [] },
    REVIEW_SCHEMA,
  );
  assert.ok(errors.some((e) => e.path === '$.verdict' && /enum/.test(e.message)));
});

test('validateAgainstSchema: lỗi lồng nhau ghi đúng path $.findings[0].severity', () => {
  const errors = validateAgainstSchema(
    { verdict: 'fail', findings: [{ severity: 'critical', message: 'x' }] },
    REVIEW_SCHEMA,
  );
  assert.ok(
    errors.some((e) => e.path === '$.findings[0].severity'),
    JSON.stringify(errors),
  );
});

test('validateAgainstSchema: additionalProperties false → lỗi trường thừa', () => {
  const errors = validateAgainstSchema(
    { verdict: 'pass', findings: [], extra: 1 },
    REVIEW_SCHEMA,
  );
  assert.ok(errors.some((e) => e.path === '$.extra' && /không được phép/.test(e.message)));
  // Trường thừa trong item cũng bị bắt.
  const nested = validateAgainstSchema(
    { verdict: 'pass', findings: [{ severity: 'low', message: 'm', zzz: 1 }] },
    REVIEW_SCHEMA,
  );
  assert.ok(nested.some((e) => e.path === '$.findings[0].zzz'));
});

test('validateAgainstSchema: additionalProperties là schema → validate trường thừa theo schema', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: { type: 'number' },
  };
  assert.deepEqual(validateAgainstSchema({ name: 'a', n: 3 }, schema), []);
  const errors = validateAgainstSchema({ name: 'a', n: 'x' }, schema);
  assert.ok(errors.some((e) => e.path === '$.n'));
});

test('validateAgainstSchema: array/string/number — minItems, minLength, minimum', () => {
  assert.equal(
    validateAgainstSchema(['a'], { type: 'array', minItems: 2 }).length,
    1,
  );
  assert.equal(
    validateAgainstSchema('ab', { type: 'string', minLength: 3 }).length,
    1,
  );
  assert.equal(
    validateAgainstSchema(0, { type: 'number', minimum: 1 }).length,
    1,
  );
  assert.equal(
    validateAgainstSchema(11, { type: 'number', maximum: 10 }).length,
    1,
  );
  assert.deepEqual(validateAgainstSchema(5, { type: 'number', minimum: 1, maximum: 10 }), []);
});

test('validateAgainstSchema: integer phân biệt với number có phần thập phân', () => {
  assert.deepEqual(validateAgainstSchema(42, { type: 'integer' }), []);
  assert.equal(validateAgainstSchema(4.5, { type: 'integer' }).length, 1);
  assert.deepEqual(validateAgainstSchema(4.5, { type: 'number' }), []);
});

test('validateAgainstSchema: items validate từng phần tử, type array sai → dừng sớm', () => {
  const errors = validateAgainstSchema(
    { verdict: 'pass', findings: 'không phải mảng' },
    REVIEW_SCHEMA,
  );
  assert.ok(errors.some((e) => e.path === '$.findings'));
  // Không crash khi value là string nhưng schema yêu cầu object.
  assert.equal(validateAgainstSchema('x', { type: 'object', required: ['a'] }).length, 1);
});

test('validateAgainstSchema: kiểu boolean/null và type dạng mảng', () => {
  assert.deepEqual(validateAgainstSchema(true, { type: 'boolean' }), []);
  assert.deepEqual(validateAgainstSchema(null, { type: 'null' }), []);
  assert.equal(validateAgainstSchema('x', { type: 'boolean' }).length, 1);
  assert.deepEqual(validateAgainstSchema('x', { type: ['string', 'null'] }), []);
  assert.deepEqual(validateAgainstSchema(null, { type: ['string', 'null'] }), []);
});

// ---------------------------------------------------------------------------
// extractJsonText / parseStructuredOutput
// ---------------------------------------------------------------------------

test('parseStructuredOutput: JSON thuần → ok', () => {
  const r = parseStructuredOutput('{"verdict":"pass","findings":[]}', REVIEW_SCHEMA);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { verdict: 'pass', findings: [] });
  assert.deepEqual(r.errors, []);
});

test('parseStructuredOutput: block ```json → ok', () => {
  const r = parseStructuredOutput(
    'Đây là kết quả:\n```json\n{"verdict":"fail","findings":[{"severity":"high","message":"lỗi","line":3}]}\n```',
    REVIEW_SCHEMA,
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.verdict, 'fail');
});

test('parseStructuredOutput: JSON lẫn trong lời giải thích → ok', () => {
  const r = parseStructuredOutput(
    'Tôi đã xem xong. {"verdict":"pass","findings":[]} Hết.',
    REVIEW_SCHEMA,
  );
  assert.equal(r.ok, true);
});

test('parseStructuredOutput: JSON array ở cấp cao nhất → ok', () => {
  const r = parseStructuredOutput('[1, 2, 3]', { type: 'array', items: { type: 'integer' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [1, 2, 3]);
});

test('parseStructuredOutput: không có JSON → lỗi rõ ràng + giữ text gốc', () => {
  const r = parseStructuredOutput('Xin chào, tôi không trả JSON.', REVIEW_SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].path, '$');
  assert.match(r.errors[0].message, /Không tìm thấy JSON/);
  assert.equal(r.rawText, 'Xin chào, tôi không trả JSON.');
});

test('parseStructuredOutput: JSON hợp lệ nhưng sai schema → lỗi từng field + giữ value', () => {
  const r = parseStructuredOutput('{"verdict":"maybe","findings":[]}', REVIEW_SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.value.verdict, 'maybe');
  assert.ok(r.errors.some((e) => e.path === '$.verdict'));
  assert.equal(r.rawText, '{"verdict":"maybe","findings":[]}');
});

test('parseStructuredOutput: JSON dở (thiếu ngoặc) → lỗi, không throw', () => {
  const r = parseStructuredOutput('{"verdict":"pass",', REVIEW_SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
});

test('extractJsonText: rỗng → null; fence không phải JSON → null', () => {
  assert.equal(extractJsonText(''), null);
  assert.equal(extractJsonText('   '), null);
  assert.equal(extractJsonText('```\nkhông phải json\n```'), null);
});

// ---------------------------------------------------------------------------
// buildStructuredPromptHint / buildStructuredRetryHint / formatStructuredError
// ---------------------------------------------------------------------------

test('buildStructuredPromptHint: chứa schema + trường bắt buộc, ép JSON thuần', () => {
  const hint = buildStructuredPromptHint(REVIEW_SCHEMA, 'vi');
  assert.match(hint, /JSON thuần/);
  assert.match(hint, /"verdict"/);
  assert.match(hint, /Các trường bắt buộc: verdict, findings/);
  const en = buildStructuredPromptHint(REVIEW_SCHEMA, 'en');
  assert.match(en, /valid JSON/);
  assert.match(en, /Required fields: verdict, findings/);
});

test('buildStructuredRetryHint: liệt kê lỗi từng field', () => {
  const hint = buildStructuredRetryHint(
    [
      { path: '$.verdict', message: 'giá trị không nằm trong enum cho phép' },
      { path: '$.findings[0].severity', message: 'thiếu trường bắt buộc "severity"' },
    ],
    'vi',
  );
  assert.match(hint, /\$\.verdict/);
  assert.match(hint, /\$\.findings\[0\]\.severity/);
  assert.match(hint, /CHỈ JSON/);
});

test('formatStructuredError: kèm lỗi + văn bản gốc của model', () => {
  const result = parseStructuredOutput('{"verdict":"maybe"}', REVIEW_SCHEMA);
  const text = formatStructuredError(result, 'vi');
  assert.match(text, /verdict/);
  assert.match(text, /\{"verdict":"maybe"\}/);
});

// ---------------------------------------------------------------------------
// parseStructuredWithRetry
// ---------------------------------------------------------------------------

test('parseStructuredWithRetry: thành công ngay lần đầu → attempts = 1', async () => {
  let calls = 0;
  const r = await parseStructuredWithRetry(
    async () => {
      calls += 1;
      return '{"verdict":"pass","findings":[]}';
    },
    REVIEW_SCHEMA,
    { maxRetries: 2 },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
});

test('parseStructuredWithRetry: lần đầu sai, lần 2 đúng → attempts = 2, hint nhắc lỗi', async () => {
  const hints = [];
  const r = await parseStructuredWithRetry(
    async (attempt, retryHint) => {
      hints.push(retryHint);
      if (attempt === 0) return '{"verdict":"maybe","findings":[]}';
      return '{"verdict":"pass","findings":[]}';
    },
    REVIEW_SCHEMA,
    { maxRetries: 2 },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(hints[0], '');
  assert.match(hints[1], /\$\.verdict/);
  assert.match(hints[1], /CHỈ JSON/);
});

test('parseStructuredWithRetry: hết lượt vẫn sai → attempts = maxRetries + 1, giữ text gốc cuối', async () => {
  const r = await parseStructuredWithRetry(
    async () => 'không phải json',
    REVIEW_SCHEMA,
    { maxRetries: 2 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.equal(r.rawText, 'không phải json');
  assert.equal(r.errors.length, 1);
});

test('parseStructuredWithRetry: maxRetries = 0 → chỉ thử 1 lần', async () => {
  let calls = 0;
  const r = await parseStructuredWithRetry(
    async () => {
      calls += 1;
      return 'sai';
    },
    REVIEW_SCHEMA,
    { maxRetries: 0 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
});
