/**
 * Tests for the Composio main-process IPC wiring (v0.57 follow-up):
 * persisted-state helpers in packages/core/src/composio/state.ts —
 * the pure logic main.ts uses to restore the saved Composio state at
 * startup, apply it to the ComposioAppSource (so `apps:list` shows the
 * apps), and build the state view the IPC `composio:get-state` returns.
 *
 * No Electron, no live network, no real key: the source runs against a
 * fresh AppRegistry (never the global defaultAppRegistry), and the
 * "key" is only ever a boolean (keyConfigured), never a value.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-ipc-v057.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_TOOLKIT_SLUGS,
  ComposioAppSource,
  applyComposioPersistedState,
  buildComposioStateView,
  composioStateToPersist,
  defaultComposioPersistedState,
  resolveComposioPersistedState,
} from '../packages/core/dist/composio/index.js';
import { AppRegistry, createDefaultAppRegistry } from '../packages/core/dist/apps/index.js';

function freshSource() {
  // AppRegistry() defaults to BUILTIN_APPS — start empty, then seed once.
  const registry = new AppRegistry([]);
  for (const app of createDefaultAppRegistry().list()) registry.register(app);
  return { registry, source: new ComposioAppSource({ registry, hasApiKey: () => false }) };
}

test('composio state: resolve defaults to OFF with all 40 toolkits', () => {
  assert.deepEqual(resolveComposioPersistedState(undefined), {
    enabled: false,
    toolkits: [...COMPOSIO_TOOLKIT_SLUGS],
  });
  assert.deepEqual(resolveComposioPersistedState(null), {
    enabled: false,
    toolkits: [...COMPOSIO_TOOLKIT_SLUGS],
  });
  assert.deepEqual(resolveComposioPersistedState({}), {
    enabled: false,
    toolkits: [...COMPOSIO_TOOLKIT_SLUGS],
  });
});

test('composio state: resolve keeps valid toolkits, drops junk, dedupes', () => {
  const out = resolveComposioPersistedState({
    enabled: true,
    toolkits: ['gmail', 'slack', 'gmail', 'nope', 42, null],
  });
  assert.equal(out.enabled, true);
  assert.deepEqual(out.toolkits, ['gmail', 'slack']);
});

test('composio state: enabled must be exactly true (fail-closed)', () => {
  assert.equal(resolveComposioPersistedState({ enabled: 1 }).enabled, false);
  assert.equal(resolveComposioPersistedState({ enabled: 'true' }).enabled, false);
  assert.equal(resolveComposioPersistedState({ enabled: true }).enabled, true);
});

test('composio state: default is OFF and round-trips through the source', () => {
  const { registry, source } = freshSource();
  const def = defaultComposioPersistedState();
  assert.equal(def.enabled, false);
  applyComposioPersistedState(source, def);
  assert.equal(source.isEnabled(), false);
  assert.equal(registry.get('composio'), undefined);
  assert.deepEqual(composioStateToPersist(source), def);
});

test('composio state: enabled + subset of toolkits registers only those apps', () => {
  const { registry, source } = freshSource();
  applyComposioPersistedState(source, { enabled: true, toolkits: ['gmail', 'github'] });
  assert.equal(source.isEnabled(), true);
  assert.ok(registry.get('composio'));
  assert.ok(registry.get('composio-gmail'));
  assert.ok(registry.get('composio-github'));
  assert.equal(registry.get('composio-slack'), undefined);
  assert.equal(registry.get('composio-notion'), undefined);
  // Local M7 apps are untouched by the Composio toggle.
  assert.ok(registry.get('slack'));
  assert.deepEqual(composioStateToPersist(source), { enabled: true, toolkits: ['gmail', 'github'] });
});

test('composio state: disabling removes every Composio app, locals stay', () => {
  const { registry, source } = freshSource();
  applyComposioPersistedState(source, { enabled: true, toolkits: ['gmail'] });
  assert.ok(registry.get('composio-gmail'));
  applyComposioPersistedState(source, { enabled: false, toolkits: ['gmail'] });
  assert.equal(source.isEnabled(), false);
  assert.equal(registry.get('composio'), undefined);
  assert.equal(registry.get('composio-gmail'), undefined);
  assert.ok(registry.get('slack'));
});

test('composio state: view carries labels/icons, no key material', () => {
  const { source } = freshSource();
  applyComposioPersistedState(source, { enabled: true, toolkits: ['notion'] });
  const view = buildComposioStateView(source, true);
  assert.equal(view.enabled, true);
  assert.equal(view.keyConfigured, true);
  assert.equal(view.apps.length, 40);
  const notion = view.apps.find((a) => a.toolkit === 'notion');
  assert.equal(notion?.label, 'Notion (via Composio)');
  assert.equal(notion?.enabled, true);
  assert.equal(view.apps.find((a) => a.toolkit === 'gmail')?.enabled, false);
  // v0.88b: mặc định chưa cấu hình user id (tham số thứ 3 vắng).
  assert.equal(view.userIdConfigured, false);
  // The view carries exactly these fields — no key/token/user-id value ever.
  assert.deepEqual(Object.keys(view).sort(), ['apps', 'enabled', 'keyConfigured', 'userIdConfigured']);
});

test('composio state v088b: view carries userIdConfigured when passed', () => {
  const { source } = freshSource();
  const view = buildComposioStateView(source, true, true);
  assert.equal(view.userIdConfigured, true);
  // Không có field nào chứa giá trị user id.
  assert.ok(!JSON.stringify(view).includes('pg-test'));
});

test('composio state: view with no key says not configured', () => {
  const { source } = freshSource();
  const view = buildComposioStateView(source, false);
  assert.equal(view.enabled, false);
  assert.equal(view.keyConfigured, false);
  assert.equal(view.apps.length, 40);
});
