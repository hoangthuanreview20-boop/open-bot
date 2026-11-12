/**
 * Tests for v0.67a — MCP marketplace view: search / tag filter helpers
 * (apps/desktop/src/renderer/components/mcpMarketplace.ts, imported
 * via Node's type stripping, like the vision renderer tests) plus
 * static wiring checks over the view / IPC chain:
 *   McpMarketplaceView.tsx -> preload listMcpServerTools ->
 *   main `mcp-marketplace:tools` (session cache) -> core probe.
 *
 * No Electron, no network, no keys. The "probe on demand only" rule
 * is checked statically: the view calls listMcpServerTools exactly
 * once, from the "View tools" toggle — never while loading the list.
 *
 * Run: node --test tests/mcp-marketplace-view-v067a.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MARKETPLACE_ALL_TAGS,
  filterMarketplaceServers,
  marketplaceTags,
  toolParamSummary,
} from '../apps/desktop/src/renderer/components/mcpMarketplace.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const read = (p) => fs.readFileSync(p, 'utf-8');
const renderer = path.join(repo, 'apps/desktop/src/renderer');

const SERVERS = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files inside allowed folders.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    tags: ['files', 'official'],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A persistent knowledge graph the agent can remember facts in.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    tags: ['memory', 'official'],
  },
  {
    id: 'may-chu',
    name: 'Máy chủ dữ liệu',
    description: 'Truy vấn cơ sở dữ liệu nội bộ.',
    transport: 'http',
    url: 'http://127.0.0.1:8080/mcp',
    tags: ['database'],
  },
];

// ---------------------------------------------------------------------------
// marketplaceTags
// ---------------------------------------------------------------------------

test('marketplaceTags collects every distinct tag, sorted', () => {
  assert.deepEqual(marketplaceTags(SERVERS), ['database', 'files', 'memory', 'official']);
  assert.deepEqual(marketplaceTags([]), []);
});

// ---------------------------------------------------------------------------
// filterMarketplaceServers
// ---------------------------------------------------------------------------

test('filter: empty query + all tags returns everything', () => {
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, '', MARKETPLACE_ALL_TAGS).map((s) => s.id),
    ['filesystem', 'memory', 'may-chu'],
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, '   ', '').map((s) => s.id),
    ['filesystem', 'memory', 'may-chu'],
  );
});

test('filter: search matches name or description, case-insensitive', () => {
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'MEMORY', MARKETPLACE_ALL_TAGS).map((s) => s.id),
    ['memory'],
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'knowledge graph', MARKETPLACE_ALL_TAGS).map((s) => s.id),
    ['memory'],
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'files', MARKETPLACE_ALL_TAGS).map((s) => s.id),
    ['filesystem'],
  );
});

test('filter: search is diacritic-insensitive (Vietnamese query, no accents needed)', () => {
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'may chu du lieu', MARKETPLACE_ALL_TAGS).map((s) => s.id),
    ['may-chu'],
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'co so du lieu', MARKETPLACE_ALL_TAGS).map((s) => s.id),
    ['may-chu'],
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'Máy chủ', MARKETPLACE_ALL_TAGS).map((s) => s.id),
    ['may-chu'],
  );
});

test('filter: every query token must match (multi-word AND)', () => {
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'memory files', MARKETPLACE_ALL_TAGS),
    [],
    'no single server matches both tokens',
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'persistent remember', MARKETPLACE_ALL_TAGS).map((s) => s.id),
    ['memory'],
  );
});

test('filter: tag chip narrows the list, and combines with search', () => {
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, '', 'official').map((s) => s.id),
    ['filesystem', 'memory'],
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, '', 'database').map((s) => s.id),
    ['may-chu'],
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'files', 'official').map((s) => s.id),
    ['filesystem'],
  );
  assert.deepEqual(
    filterMarketplaceServers(SERVERS, 'files', 'database'),
    [],
    'tag + search are ANDed',
  );
  assert.deepEqual(filterMarketplaceServers(SERVERS, '', 'no-such-tag'), []);
});

test('filter: no match returns an empty list (view shows the no-results line)', () => {
  assert.deepEqual(filterMarketplaceServers(SERVERS, 'zzzz', MARKETPLACE_ALL_TAGS), []);
});

// ---------------------------------------------------------------------------
// toolParamSummary
// ---------------------------------------------------------------------------

test('toolParamSummary returns property + required names from inputSchema', () => {
  assert.deepEqual(
    toolParamSummary({
      name: 'echo',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, loud: { type: 'boolean' } },
        required: ['text'],
      },
    }),
    { paramNames: ['text', 'loud'], required: ['text'] },
  );
});

test('toolParamSummary: missing schema / empty properties means no params', () => {
  assert.deepEqual(toolParamSummary({ name: 'a' }), { paramNames: [], required: [] });
  assert.deepEqual(
    toolParamSummary({ name: 'b', inputSchema: { type: 'object', properties: {} } }),
    { paramNames: [], required: [] },
  );
  assert.deepEqual(
    toolParamSummary({ name: 'c', inputSchema: { type: 'object' } }),
    { paramNames: [], required: [] },
  );
});

test('toolParamSummary: required names that are not properties are dropped', () => {
  assert.deepEqual(
    toolParamSummary({
      name: 'd',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text', 'ghost'],
      },
    }),
    { paramNames: ['text'], required: ['text'] },
  );
});

// ---------------------------------------------------------------------------
// Static wiring: view -> preload -> main -> core
// ---------------------------------------------------------------------------

test('wiring: view has search input + tag chips + per-server View tools button', () => {
  const view = read(path.join(renderer, 'components/McpMarketplaceView.tsx'));
  assert.match(view, /type="search"/, 'search input');
  assert.match(view, /data-testid="mcp-marketplace-search"/, 'search input test id (page has other search boxes)');
  assert.match(view, /mcp\.searchPlaceholder/, 'search placeholder i18n key');
  assert.match(view, /mcp\.allTags/, 'All-tags chip');
  assert.match(view, /mcp\.filterByTag/, 'tag filter group label');
  assert.match(view, /mcp\.viewTools/, 'View tools button');
  assert.match(view, /mcp\.hideTools/, 'Hide tools toggle');
  assert.match(view, /mcp\.toolsTitle/, 'tools count title');
  assert.match(view, /mcp\.toolsLoading/, 'tools loading state');
  assert.match(view, /mcp\.toolsLoadError/, 'tools error state');
  assert.match(view, /mcp\.toolsNeedsKey/, 'needs-key state');
  assert.match(view, /mcp\.toolsEmpty/, 'empty tools state');
  assert.match(view, /mcp\.toolsSource/, 'tool source line');
  assert.match(view, /mcp\.noResults/, 'no-results line');
  // Install / uninstall / next-steps / confirm modal are untouched.
  assert.match(view, /mcp\.install/, 'install still present');
  assert.match(view, /mcp\.uninstallConfirm/, 'uninstall confirm still present');
  assert.match(view, /mcp\.nextStepsTitle/, 'next steps still present');
  assert.match(view, /ConfirmModal/, 'confirm modal still present');
});

test('wiring: tools are probed on demand only — exactly one listMcpServerTools call, in the toggle', () => {
  const view = read(path.join(renderer, 'components/McpMarketplaceView.tsx'));
  const calls = view.match(/listMcpServerTools/g) ?? [];
  assert.equal(calls.length, 1, 'one call site: the View-tools toggle, never the list loader');
  assert.match(view, /window\.openBot\.listMcpServerTools\(server\.id\)/);
  assert.doesNotMatch(view, /useEffect\(\(\) => \{\s*[^}]*listMcpServerTools/s);
});

test('wiring: preload + global.d.ts expose listMcpServerTools mirroring the other MCP calls', () => {
  const preload = read(path.join(repo, 'apps/desktop/src/main/preload.ts'));
  assert.match(preload, /listMcpServerTools: \(id\) => ipcRenderer\.invoke\('mcp-marketplace:tools', \{ id \}\)/);
  const dts = read(path.join(renderer, 'global.d.ts'));
  assert.match(dts, /listMcpServerTools\(id: string\): Promise<McpMarketplaceProbeResultLike>;/);
  assert.match(dts, /McpMarketplaceProbeResultLike,/);
  const types = read(path.join(renderer, 'types.ts'));
  assert.match(types, /export interface McpMarketplaceProbeResultLike/);
  assert.match(types, /export interface McpMarketplaceToolLike/);
});

test('wiring: main registers mcp-marketplace:tools with a session cache (ok/needs-key only)', () => {
  const main = read(path.join(repo, 'apps/desktop/src/main/main.ts'));
  assert.match(main, /ipcMain\.handle\('mcp-marketplace:tools'/);
  assert.match(main, /probeMarketplaceServerTools\(id, app\.getPath\('userData'\)\)/);
  assert.match(main, /mcpMarketplaceToolsCache/);
  // v0.68a: the cache is keyed by server id + registry fingerprint, so
  // a catalogue edit invalidates stale entries (the ok/needs-key-only
  // rule lives in MarketplaceProbeCache.set, covered by the v0.68a tests).
  assert.match(main, /new MarketplaceProbeCache\(\)/);
  assert.match(main, /getMarketplaceRegistryFingerprint\(app\.getPath\('userData'\)\)/);
  assert.match(main, /mcpMarketplaceToolsCache\.get\(id, fingerprint\)/);
  assert.match(main, /mcpMarketplaceToolsCache\.set\(id, fingerprint, result\)/);
  assert.match(main, /probeMarketplaceServerTools,/);
  assert.match(main, /getMarketplaceRegistryFingerprint,/);
  assert.match(main, /MarketplaceProbeCache,/);
});

test('wiring: every new mcp.* key exists in both locales with matching placeholders', () => {
  const vi = JSON.parse(read(path.join(renderer, 'i18n/locales/vi.json')));
  const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const keys = [
    'mcp.allTags',
    'mcp.filterByTag',
    'mcp.hideTools',
    'mcp.noResults',
    'mcp.searchPlaceholder',
    'mcp.toolsEmpty',
    'mcp.toolsLoadError',
    'mcp.toolsLoading',
    'mcp.toolsNeedsKey',
    'mcp.toolsNoParams',
    'mcp.toolsParams',
    'mcp.toolsRequired',
    'mcp.toolsSource',
    'mcp.toolsTitle',
    'mcp.toolsTruncated',
    'mcp.viewTools',
  ];
  for (const key of keys) {
    assert.ok(key in vi, `${key} missing in vi.json`);
    assert.ok(key in en, `${key} missing in en.json`);
    assert.ok(vi[key].trim().length > 0 && en[key].trim().length > 0, `${key} must be non-empty`);
    assert.deepEqual(placeholders(vi[key]), placeholders(en[key]), `${key} placeholders differ`);
  }
});

test('wiring: no hard-coded Vietnamese in the new/changed renderer files (i18n rule)', () => {
  const vietnamese = /[À-ỹđĐ]/;
  for (const file of ['components/McpMarketplaceView.tsx', 'components/mcpMarketplace.ts']) {
    const src = read(path.join(renderer, file));
    for (const [i, line] of src.split('\n').entries()) {
      assert.ok(!vietnamese.test(line), `${file}:${i + 1} still has hard-coded Vietnamese: ${line.trim()}`);
    }
  }
});
