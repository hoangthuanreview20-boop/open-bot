/**
 * Tests cho mô tả bot (v0.77, UI parity §3.3) — `BotConfig.description`
 * (tối đa 500 ký tự): `sanitizeConfig` giữ/cắt mô tả khi clone /
 * publish / install, giống `color` (v0.62).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/bot-description-v077.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOT_DESCRIPTION_MAX_LENGTH, sanitizeConfig } from '../packages/core/dist/index.js';

function baseConfig(overrides = {}) {
  return {
    id: 'bot-1',
    name: 'Bot',
    providerId: 'xai',
    model: 'grok-4',
    systemPrompt: '',
    workspaceDir: '',
    autoApprove: false,
    ...overrides,
  };
}

test('bot-description: cap 500 ký tự', () => {
  assert.equal(BOT_DESCRIPTION_MAX_LENGTH, 500);
});

test('bot-description: sanitizeConfig giữ mô tả (trim), clone giữ nguyên', () => {
  const clean = sanitizeConfig(baseConfig({ description: '  Trợ lý viết code  ' }));
  assert.equal(clean.description, 'Trợ lý viết code');
  // Clone = sanitizeConfig lại trên config đã sạch: mô tả còn đó.
  assert.equal(sanitizeConfig(clean).description, 'Trợ lý viết code');
});

test('bot-description: sanitizeConfig cắt mô tả dài quá 500 ký tự', () => {
  const clean = sanitizeConfig(baseConfig({ description: `x`.repeat(600) }));
  assert.equal(clean.description?.length, 500);
});

test('bot-description: sanitizeConfig bỏ mô tả rỗng / không phải chuỗi', () => {
  assert.equal(sanitizeConfig(baseConfig({ description: '' })).description, undefined);
  assert.equal(sanitizeConfig(baseConfig({ description: '   ' })).description, undefined);
  assert.equal(
    sanitizeConfig(baseConfig({ description: 42 })).description,
    undefined,
  );
});

test('bot-description: sanitizeConfig không thêm field lạ vào config', () => {
  const clean = sanitizeConfig(baseConfig({ description: 'Mô tả', apiKey: 'secret' }));
  assert.equal(clean.description, 'Mô tả');
  assert.equal('apiKey' in clean, false);
});
