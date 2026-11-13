/**
 * Tests for Media keys (v0.95, Team D2): Settings → Media keys.
 *
 * Covers:
 *  - core mediaKeys: Vault namespace 'media' CRUD for 7 providers
 *    (OpenAI, Gemini, Stability, Replicate, Runway, Luma, Pika),
 *    validation, suffix-only status (the full key never leaks),
 *    missing-key / no-client messages, config builder
 *  - coordinator: RPC `media.setKey` / `media.getKeyStatus` (seed in
 *    memory, like `composio.setApiKey`) + `getProviderConfigFor`
 *    media fallback, so image/video tools resolve the key at call time
 *  - tools: image_generate / video_generate missing-key errors point
 *    at Settings → Media keys (no crash); key-only providers fail
 *    with a clear no-client message instead of guessing the wire
 *    shape; the OpenAI video job still wires through a resolved
 *    media config (MOCK provider, no network)
 *
 * MOCK ONLY: every key below is FAKE (never a real key), no live API
 * is called, no real account is touched. The renderer (Settings UI)
 * is covered separately by tests/media-keys-v095d2-renderer.test.mjs.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/media-keys-v095d2.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MEDIA_PROVIDER_IDS,
  MEDIA_PROVIDERS,
  MEDIA_VAULT_NAMESPACE,
  buildMediaProviderConfig,
  clearMediaApiKey,
  getAllMediaApiKeys,
  getMediaApiKey,
  getMediaKeyStatus,
  getMediaProvider,
  hasMediaApiKey,
  isMediaProviderId,
  maskMediaKeySuffix,
  mediaKeyMissingMessage,
  mediaProviderNoClientMessage,
  redactMediaKey,
  setMediaApiKey,
  validateMediaApiKey,
} from '../packages/core/dist/media/index.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { Vault } from '../packages/core/dist/vault/vault.js';
import {
  createWebMediaTools,
  VideoJobStore,
} from '../packages/tools/dist/index.js';

/** Fake keys — distinctive so tests can prove they never leak. */
const FAKE_KEYS = {
  openai: 'sk-fake-openai-1111-2222-3333-4444',
  gemini: 'AIzaFakeGemini-aaaa-bbbb-cccc',
  stability: 'sk-fake-stability-zzzz-9999',
  replicate: 'r8_fake-replicate-1234-5678',
  runway: 'key_fake-runway-abcd-efgh',
  luma: 'luma-fake-key-0000-1111',
  pika: 'pika-fake-key-2222-3333',
};

const tempDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function freshVault() {
  return new Vault({ storePath: path.join(tmpDir('open-bot-media-v095d2-'), 'vault.json') });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('registry: 7 media providers, OpenAI + Gemini built-in, rest key-only', () => {
  assert.deepEqual([...MEDIA_PROVIDER_IDS], [
    'openai',
    'gemini',
    'stability',
    'replicate',
    'runway',
    'luma',
    'pika',
  ]);
  assert.equal(MEDIA_PROVIDERS.length, 7);
  assert.deepEqual(getMediaProvider('openai').kinds, ['image', 'video']);
  assert.equal(getMediaProvider('openai').clientStatus, 'builtin');
  assert.equal(getMediaProvider('openai').defaultVideoModel, 'sora-2');
  assert.equal(getMediaProvider('gemini').clientStatus, 'builtin');
  assert.deepEqual(getMediaProvider('gemini').kinds, ['image']);
  assert.equal(getMediaProvider('runway').clientStatus, 'key-only');
  assert.deepEqual(getMediaProvider('runway').kinds, ['video']);
  assert.equal(getMediaProvider('stability').defaultImageModel, 'sd3.5-large');
  assert.equal(getMediaProvider('replicate').defaultImageModel, undefined);
  assert.equal(getMediaProvider('unknown'), undefined);
  assert.equal(isMediaProviderId('luma'), true);
  assert.equal(isMediaProviderId('xai'), false);
  assert.equal(isMediaProviderId(null), false);
  for (const def of MEDIA_PROVIDERS) {
    assert.ok(def.hintKey.startsWith('settings.mediaKeys.hint.'), def.id);
    assert.ok(def.baseUrl.startsWith('https://'), def.id);
  }
});

// ---------------------------------------------------------------------------
// Vault CRUD (real Vault, fake keys)
// ---------------------------------------------------------------------------

test('vault CRUD: set/get/has/clear per provider, namespace is media', () => {
  const vault = freshVault();
  for (const id of MEDIA_PROVIDER_IDS) {
    assert.equal(hasMediaApiKey(vault, id), false);
    assert.equal(getMediaApiKey(vault, id), null);
  }
  for (const [id, key] of Object.entries(FAKE_KEYS)) {
    setMediaApiKey(vault, id, key);
    assert.equal(hasMediaApiKey(vault, id), true);
    assert.equal(getMediaApiKey(vault, id), key);
  }
  // Keys live in the 'media' namespace only — not in 'provider'.
  assert.deepEqual(vault.listSecrets(MEDIA_VAULT_NAMESPACE).sort(), [...MEDIA_PROVIDER_IDS].sort());
  assert.equal(vault.listSecrets('provider').includes('openai'), false);
  // Overwrite rotates; clear removes.
  setMediaApiKey(vault, 'openai', 'sk-fake-openai-rotated-9999');
  assert.equal(getMediaApiKey(vault, 'openai'), 'sk-fake-openai-rotated-9999');
  assert.equal(clearMediaApiKey(vault, 'openai'), true);
  assert.equal(getMediaApiKey(vault, 'openai'), null);
  assert.equal(clearMediaApiKey(vault, 'openai'), false);
  assert.equal(clearMediaApiKey(vault, 'not-a-provider'), false);
  // A fresh Vault on the same store file reads the keys back (durable).
  const reopened = new Vault({ storePath: vault.path });
  assert.equal(getMediaApiKey(reopened, 'gemini'), FAKE_KEYS.gemini);
  assert.equal(getMediaApiKey(reopened, 'openai'), null);
});

test('vault CRUD: validation rejects empty / over-long / unknown, writes nothing', () => {
  const vault = freshVault();
  for (const bad of ['', '   ', null, undefined, 123]) {
    assert.throws(() => setMediaApiKey(vault, 'openai', bad), /must not be empty/);
  }
  assert.throws(() => setMediaApiKey(vault, 'openai', 'x'.repeat(501)), /too long/);
  assert.throws(() => setMediaApiKey(vault, 'openai', 'bad\x01key'), /control characters/);
  assert.throws(() => setMediaApiKey(vault, 'not-a-provider', 'sk-fake'), /Unknown media provider/);
  assert.equal(validateMediaApiKey('  sk-fake-trimmed  '), 'sk-fake-trimmed');
  assert.equal(hasMediaApiKey(vault, 'openai'), false);
  assert.deepEqual(vault.listSecrets(MEDIA_VAULT_NAMESPACE), []);
  assert.equal(getMediaApiKey(vault, 'not-a-provider'), null);
  assert.equal(hasMediaApiKey(vault, 'not-a-provider'), false);
});

test('status: configured + last-4 suffix only — the full key never leaks', () => {
  const vault = freshVault();
  setMediaApiKey(vault, 'openai', FAKE_KEYS.openai);
  setMediaApiKey(vault, 'runway', FAKE_KEYS.runway);
  const status = getMediaKeyStatus(vault);
  assert.deepEqual(Object.keys(status).sort(), [...MEDIA_PROVIDER_IDS].sort());
  assert.deepEqual(status.openai, { configured: true, suffix: '4444' });
  assert.deepEqual(status.runway, { configured: true, suffix: 'efgh' });
  assert.deepEqual(status.gemini, { configured: false, suffix: null });
  // No full key anywhere in the status payload.
  const dumped = JSON.stringify(status);
  for (const key of Object.values(FAKE_KEYS)) {
    assert.ok(!dumped.includes(key), `status leaks key ${key.slice(0, 8)}…`);
  }
  assert.ok(!dumped.includes('sk-fake'));
  // getAllMediaApiKeys is main-only (values in memory, never logged).
  const all = getAllMediaApiKeys(vault);
  assert.deepEqual(Object.keys(all).sort(), ['openai', 'runway']);
  assert.equal(all.openai, FAKE_KEYS.openai);
});

test('mask + redact: suffix is the last 4 chars; redact strips the key', () => {
  assert.equal(maskMediaKeySuffix(FAKE_KEYS.openai), '4444');
  assert.equal(maskMediaKeySuffix('abc'), 'abc');
  assert.equal(maskMediaKeySuffix(''), null);
  assert.equal(maskMediaKeySuffix(null), null);
  assert.equal(maskMediaKeySuffix(undefined), null);
  const msg = `call failed for ${FAKE_KEYS.gemini} (bad key)`;
  assert.equal(redactMediaKey(msg, FAKE_KEYS.gemini), 'call failed for [media-key-redacted] (bad key)');
  assert.equal(redactMediaKey(msg, null), msg);
  assert.equal(redactMediaKey(msg), msg);
});

// ---------------------------------------------------------------------------
// Messages + config builder
// ---------------------------------------------------------------------------

test('messages: missing key points at Settings → Media keys; no-client names the provider', () => {
  const missing = mediaKeyMissingMessage('runway');
  assert.match(missing, /Settings → Media keys/);
  assert.match(missing, /"runway"/);
  assert.match(missing, /video/);
  assert.match(mediaKeyMissingMessage('stability'), /image/);
  assert.doesNotMatch(missing, /sk-fake/);
  const noClientImage = mediaProviderNoClientMessage('stability', 'image');
  assert.match(noClientImage, /"stability"/);
  assert.match(noClientImage, /only OpenAI and Gemini can be called directly/);
  const noClientVideo = mediaProviderNoClientMessage('runway', 'video');
  assert.match(noClientVideo, /"runway"/);
  assert.match(noClientVideo, /createVideoProvider/);
});

test('buildMediaProviderConfig: defaults per provider; null when unknown/keyless', () => {
  assert.deepEqual(buildMediaProviderConfig('openai', FAKE_KEYS.openai), {
    id: 'openai',
    apiKey: FAKE_KEYS.openai,
    baseUrl: 'https://api.openai.com/v1',
    imageModel: 'gpt-image-1',
    videoModel: 'sora-2',
  });
  assert.deepEqual(buildMediaProviderConfig('runway', FAKE_KEYS.runway), {
    id: 'runway',
    apiKey: FAKE_KEYS.runway,
    baseUrl: 'https://api.dev.runwayml.com/v1',
    videoModel: 'gen-4-turbo',
  });
  assert.deepEqual(buildMediaProviderConfig('replicate', FAKE_KEYS.replicate), {
    id: 'replicate',
    apiKey: FAKE_KEYS.replicate,
    baseUrl: 'https://api.replicate.com/v1',
  });
  assert.equal(buildMediaProviderConfig('unknown', FAKE_KEYS.openai), null);
  assert.equal(buildMediaProviderConfig('openai', ''), null);
  assert.equal(buildMediaProviderConfig('openai', null), null);
  assert.equal(buildMediaProviderConfig('openai', undefined), null);
});

// ---------------------------------------------------------------------------
// Coordinator: RPC seed + getProviderConfigFor media fallback
// ---------------------------------------------------------------------------

test('coordinator RPC media.setKey / media.getKeyStatus: seed, rotate, clear, reject unknown', async () => {
  const coordinator = new AgentCoordinator({});
  assert.deepEqual(await coordinator.handle('media.getKeyStatus', {}), { configured: [] });
  assert.deepEqual(
    await coordinator.handle('media.setKey', { providerId: 'openai', apiKey: FAKE_KEYS.openai }),
    { configured: ['openai'] },
  );
  assert.deepEqual(
    await coordinator.handle('media.setKey', { providerId: 'runway', apiKey: FAKE_KEYS.runway }),
    { configured: ['openai', 'runway'] },
  );
  // Rotate: same provider, new key — configured list unchanged.
  assert.deepEqual(
    await coordinator.handle('media.setKey', { providerId: 'openai', apiKey: 'sk-fake-rotated' }),
    { configured: ['openai', 'runway'] },
  );
  // Clear via null.
  assert.deepEqual(
    await coordinator.handle('media.setKey', { providerId: 'runway', apiKey: null }),
    { configured: ['openai'] },
  );
  assert.deepEqual(await coordinator.handle('media.getKeyStatus', {}), { configured: ['openai'] });
  // Unknown provider / bad shape: clear errors, old key untouched.
  await assert.rejects(
    coordinator.handle('media.setKey', { providerId: 'not-a-provider', apiKey: 'x' }),
    /không rõ media provider/,
  );
  await assert.rejects(
    coordinator.handle('media.setKey', { providerId: 'openai', apiKey: 123 }),
    /apiKey là string/,
  );
  await assert.rejects(coordinator.handle('media.setKey', { apiKey: 'x' }), /không rõ media provider/);
  assert.deepEqual(await coordinator.handle('media.getKeyStatus', {}), { configured: ['openai'] });
});

test('coordinator getProviderConfigFor: media fallback resolves the key at call time', async () => {
  const coordinator = new AgentCoordinator({});
  const resolve = (id) => coordinator.getProviderConfigFor(id);
  // No bot, no key → null (tools report the missing key).
  assert.equal(resolve('runway'), null);
  assert.equal(resolve('openai'), null);
  assert.equal(resolve('not-a-provider'), null);
  await coordinator.setMediaApiKey({ providerId: 'runway', apiKey: FAKE_KEYS.runway });
  assert.deepEqual(resolve('runway'), {
    id: 'runway',
    apiKey: FAKE_KEYS.runway,
    baseUrl: 'https://api.dev.runwayml.com/v1',
    videoModel: 'gen-4-turbo',
  });
  await coordinator.setMediaApiKey({ providerId: 'openai', apiKey: FAKE_KEYS.openai });
  assert.deepEqual(resolve('openai'), {
    id: 'openai',
    apiKey: FAKE_KEYS.openai,
    baseUrl: 'https://api.openai.com/v1',
    imageModel: 'gpt-image-1',
    videoModel: 'sora-2',
  });
  // Clearing the seed un-resolves it again.
  await coordinator.setMediaApiKey({ providerId: 'runway', apiKey: null });
  assert.equal(resolve('runway'), null);
  assert.notEqual(resolve('openai'), null);
});

// ---------------------------------------------------------------------------
// Tools: missing-key + no-client errors, and the wired OpenAI video job
// ---------------------------------------------------------------------------

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);

test('tools: image_generate with no key reports Settings → Media keys, never crashes', async () => {
  const dir = tmpDir('open-bot-media-tools-v095d2-');
  const tools = createWebMediaTools({
    getProviderConfig: async () => null,
    defaultProviderId: 'stability',
  });
  const out = await tool(tools, 'image_generate').execute(
    { prompt: 'a cat', providerId: 'stability' },
    CTX(dir),
  );
  assert.match(out, /^Error: /);
  assert.match(out, /Settings → Media keys/);
  assert.match(out, /"stability"/);
  assert.ok(!fs.existsSync(path.join(dir, 'generated-media')), 'no image file may be created');
});

test('tools: image_generate with a key-only provider key fails clearly, fetch never called', async () => {
  const dir = tmpDir('open-bot-media-tools-v095d2-');
  const seen = [];
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    seen.push(1);
    throw new Error('fetch must not be called for a key-only provider');
  };
  try {
    const tools = createWebMediaTools({
      getProviderConfig: async (providerId) => buildMediaProviderConfig(providerId, FAKE_KEYS.stability),
      defaultProviderId: 'stability',
    });
    const out = await tool(tools, 'image_generate').execute(
      { prompt: 'a cat', providerId: 'stability' },
      CTX(dir),
    );
    assert.match(out, /^Error: /);
    assert.match(out, /"stability"/);
    assert.match(out, /only OpenAI and Gemini can be called directly/);
    assert.equal(seen.length, 0, 'no HTTP call may go out for a key-only provider');
  } finally {
    globalThis.fetch = restoreFetch;
  }
});

test('tools: video_generate with no key reports Settings → Media keys, no job created', async () => {
  const dir = tmpDir('open-bot-media-tools-v095d2-');
  const tools = createWebMediaTools({
    getProviderConfig: async () => null,
    defaultProviderId: 'runway',
  });
  const out = await tool(tools, 'video_generate').execute(
    { prompt: 'a cat video', providerId: 'runway' },
    CTX(dir),
  );
  assert.match(out, /^Error: /);
  assert.match(out, /Settings → Media keys/);
  assert.match(out, /"runway"/);
  const store = new VideoJobStore(dir, 'test-bot');
  assert.deepEqual(await store.list(), [], 'no job may be created without a key');
});

test('tools: video_generate with a key-only provider key fails clearly, no job created', async () => {
  const dir = tmpDir('open-bot-media-tools-v095d2-');
  const tools = createWebMediaTools({
    getProviderConfig: async (providerId) => buildMediaProviderConfig(providerId, FAKE_KEYS.runway),
    defaultProviderId: 'runway',
  });
  const out = await tool(tools, 'video_generate').execute(
    { prompt: 'a cat video', providerId: 'runway' },
    CTX(dir),
  );
  assert.match(out, /^Error: /);
  assert.match(out, /"runway"/);
  assert.match(out, /createVideoProvider/);
  const store = new VideoJobStore(dir, 'test-bot');
  assert.deepEqual(await store.list(), [], 'no job may be created for a key-only provider');
});

/** MOCK video provider — fake in-process backend (NO network, NO key). */
class MockVideoProvider {
  constructor() {
    this.id = 'mock-video';
    this.calls = [];
  }

  async startJob(req) {
    this.calls.push(['start', req]);
    return { providerJobId: 'mock-provider-job-1', status: 'queued' };
  }

  async pollJob(providerJobId) {
    this.calls.push(['poll', providerJobId]);
    return { status: 'running' };
  }
}

test('tools: video_generate wires through a media-resolved OpenAI config (MOCK provider)', async () => {
  const dir = tmpDir('open-bot-media-tools-v095d2-');
  const mock = new MockVideoProvider();
  const tools = createWebMediaTools({
    // Same shape the coordinator's getProviderConfigFor returns for a
    // seeded media key: config built by buildMediaProviderConfig.
    getProviderConfig: async (providerId) => buildMediaProviderConfig(providerId, FAKE_KEYS.openai),
    defaultProviderId: 'openai',
    createVideoProvider: () => mock,
    videoJobPollIntervalMs: 10,
  });
  const out = await tool(tools, 'video_generate').execute(
    { prompt: 'a cat video', providerId: 'openai', durationSeconds: 5 },
    CTX(dir),
  );
  assert.match(out, /Video job created via provider "openai" \(model "sora-2", 5s\)/);
  assert.match(out, /Job ID: (\S+)/);
  const jobId = out.match(/Job ID: (\S+)/)[1];
  const store = new VideoJobStore(dir, 'test-bot');
  const job = await store.read(jobId);
  assert.ok(job, 'job must be persisted');
  assert.equal(job.providerId, 'openai');
  assert.equal(job.model, 'sora-2');
  // The driver starts fire-and-forget: wait until it called startJob.
  const deadline = Date.now() + 5000;
  while (mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(mock.calls[0][0], 'start');
  assert.equal(mock.calls[0][1].model, 'sora-2');
  assert.doesNotMatch(out, /sk-fake/);
});
