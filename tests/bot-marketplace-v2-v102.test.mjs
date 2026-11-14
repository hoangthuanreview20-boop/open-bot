/**
 * Tests for the bot marketplace v2 (packages/core/src/agent/marketplaceV2.ts).
 *
 * Covers the merged catalog (built-in templates + locally published
 * agents), search / filter / sort, per-user ratings, and one-click
 * install for both entry kinds.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/bot-marketplace-v2-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildMarketplaceV2Catalog,
  getMarketplaceV2Rating,
  installMarketplaceV2Entry,
  listMarketplaceV2Categories,
  listMarketplaceV2Tags,
  rateMarketplaceV2Entry,
  searchMarketplaceV2Catalog,
} from '../packages/core/dist/agent/marketplaceV2.js';
import { publishAgent } from '../packages/core/dist/agent/marketplace.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-marketplace-v2-'));
}

const BASE_BOT = {
  id: 'bot-1',
  name: 'Helper',
  providerId: 'xai',
  model: 'grok-4.7',
  systemPrompt: 'You are a helper.',
  workspaceDir: '/some/workspace',
  autoApprove: false,
};

// --- catalog ---------------------------------------------------------------

test('marketplace v2: catalog holds the 20 built-in templates in a fresh dir', () => {
  const dir = tmpDir();
  const catalog = buildMarketplaceV2Catalog(dir);
  assert.equal(catalog.length, 20);
  assert.ok(catalog.every((e) => e.kind === 'template' && e.id.startsWith('tpl:')));
  assert.ok(catalog.every((e) => e.installs === 0 && e.ratingAverage === 0 && e.ratingCount === 0));
  assert.ok(catalog.every((e) => e.tags.includes(e.category)));
  const categories = listMarketplaceV2Categories(catalog);
  assert.deepEqual(categories, ['automation', 'code', 'data', 'general', 'research', 'writing']);
  assert.ok(listMarketplaceV2Tags(catalog).includes('code'));
});

test('marketplace v2: published agents join the catalog as pub: entries', () => {
  const dir = tmpDir();
  publishAgent(dir, BASE_BOT, { author: 'alice', description: 'My helper bot.' });
  const catalog = buildMarketplaceV2Catalog(dir);
  assert.equal(catalog.length, 21);
  const published = catalog.find((e) => e.kind === 'published');
  assert.equal(published.id, 'pub:bot-1');
  assert.equal(published.name, 'Helper');
  assert.equal(published.author, 'alice');
  assert.equal(published.category, 'custom');
  assert.equal(published.createdAt !== null, true);
});

// --- search / filter / sort -------------------------------------------------

test('marketplace v2: search matches name, description and tags', () => {
  const dir = tmpDir();
  const catalog = buildMarketplaceV2Catalog(dir);
  const byName = searchMarketplaceV2Catalog(catalog, { query: 'code reviewer' });
  assert.ok(byName.length >= 1);
  assert.ok(byName.every((e) => `${e.name} ${e.description} ${e.tags.join(' ')}`.toLowerCase().includes('code')));
  const codeOnly = searchMarketplaceV2Catalog(catalog, { category: 'code' });
  assert.ok(codeOnly.length > 0);
  assert.ok(codeOnly.every((e) => e.category === 'code'));
  const tagged = searchMarketplaceV2Catalog(catalog, { tag: 'research' });
  assert.ok(tagged.length > 0);
  assert.ok(tagged.every((e) => e.tags.includes('research')));
  assert.deepEqual(searchMarketplaceV2Catalog(catalog, { query: 'zzzz-no-such-bot' }), []);
  assert.deepEqual(searchMarketplaceV2Catalog(catalog, { category: 'nope' }), []);
});

test('marketplace v2: sort by name / installs / rating / newest', () => {
  const dir = tmpDir();
  const catalog = buildMarketplaceV2Catalog(dir);
  const byName = searchMarketplaceV2Catalog(catalog, { sort: 'name' });
  const names = byName.map((e) => e.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  // Install one template twice: it must top the installs sort.
  const code = catalog.find((e) => e.category === 'code');
  installMarketplaceV2Entry(dir, code.id);
  installMarketplaceV2Entry(dir, code.id);
  const byInstalls = searchMarketplaceV2Catalog(buildMarketplaceV2Catalog(dir), { sort: 'installs' });
  assert.equal(byInstalls[0].id, code.id);
  assert.equal(byInstalls[0].installs, 2);
  // Rate another entry 5 stars: it must top the rating sort.
  const other = catalog.find((e) => e.id !== code.id && e.category === 'research');
  rateMarketplaceV2Entry(dir, other.id, 'alice', 5);
  const byRating = searchMarketplaceV2Catalog(buildMarketplaceV2Catalog(dir), { sort: 'rating' });
  assert.equal(byRating[0].id, other.id);
  // Newest: published agents (with a date) sort before dateless templates.
  publishAgent(dir, { ...BASE_BOT, id: 'bot-9', name: 'Fresh' }, {});
  const byNewest = searchMarketplaceV2Catalog(buildMarketplaceV2Catalog(dir), { sort: 'newest' });
  assert.equal(byNewest[0].kind, 'published');
});

// --- ratings ---------------------------------------------------------------

test('marketplace v2: ratings average across users, one rating per user', () => {
  const dir = tmpDir();
  const catalog = buildMarketplaceV2Catalog(dir);
  const entry = catalog[0];
  assert.deepEqual(getMarketplaceV2Rating(dir, entry.id), { average: 0, count: 0 });
  assert.deepEqual(rateMarketplaceV2Entry(dir, entry.id, 'alice', 5), { average: 5, count: 1 });
  assert.deepEqual(rateMarketplaceV2Entry(dir, entry.id, 'bob', 3), { average: 4, count: 2 });
  // Alice re-rates: her 5 becomes a 1, count stays 2.
  assert.deepEqual(rateMarketplaceV2Entry(dir, entry.id, 'alice', 1), { average: 2, count: 2 });
  assert.deepEqual(getMarketplaceV2Rating(dir, entry.id), { average: 2, count: 2 });
  assert.throws(() => rateMarketplaceV2Entry(dir, entry.id, 'alice', 0), /1 to 5/);
  assert.throws(() => rateMarketplaceV2Entry(dir, entry.id, 'alice', 6), /1 to 5/);
  assert.throws(() => rateMarketplaceV2Entry(dir, entry.id, 'alice', 4.5), /1 to 5/);
  assert.throws(() => rateMarketplaceV2Entry(dir, 'tpl:nope', 'alice', 5), /not found/);
  assert.throws(() => rateMarketplaceV2Entry(dir, entry.id, '  ', 5), /userId/);
});

// --- one-click install -------------------------------------------------------

test('marketplace v2: installing a template returns a fresh bot config', () => {
  const dir = tmpDir();
  const catalog = buildMarketplaceV2Catalog(dir);
  const template = catalog.find((e) => e.id === 'tpl:code');
  assert.ok(template, 'code template must exist');
  const first = installMarketplaceV2Entry(dir, template.id);
  assert.equal(first.config.name, template.name);
  assert.equal(first.config.workspaceDir, '');
  assert.notEqual(first.config.id, template.sourceId);
  assert.equal(first.entry.installs, 1);
  const second = installMarketplaceV2Entry(dir, template.id);
  assert.notEqual(second.config.id, first.config.id);
  assert.equal(second.entry.installs, 2);
});

test('marketplace v2: installing a published agent clones it and bumps installs', () => {
  const dir = tmpDir();
  publishAgent(dir, BASE_BOT, { author: 'alice' });
  const first = installMarketplaceV2Entry(dir, 'pub:bot-1');
  assert.equal(first.config.name, 'Helper');
  assert.equal(first.config.workspaceDir, '');
  assert.notEqual(first.config.id, 'bot-1');
  assert.equal(first.entry.installs, 1);
  assert.equal(first.config.systemPrompt, 'You are a helper.');
  const again = installMarketplaceV2Entry(dir, 'pub:bot-1');
  assert.equal(again.entry.installs, 2);
  assert.notEqual(again.config.id, first.config.id);
});

test('marketplace v2: unknown ids and bad prefixes throw', () => {
  const dir = tmpDir();
  assert.throws(() => installMarketplaceV2Entry(dir, 'tpl:nope'), /not found/);
  assert.throws(() => installMarketplaceV2Entry(dir, 'pub:nope'), /nope/);
  assert.throws(() => installMarketplaceV2Entry(dir, 'weird-id'), /must start with/);
  assert.throws(() => installMarketplaceV2Entry(dir, '  '), /non-empty entryId/);
});
