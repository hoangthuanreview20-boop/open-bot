/**
 * Tests for v0.70: revalidate the GitHub PAT when the app status is
 * queried, so a token revoked AFTER it was saved is caught before a
 * bot calls a GitHub tool (v0.69a only validated at paste time).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/github-pat-revalidate-v070.test.mjs
 *
 * No live network, no real token: every test passes a mock fetchFn
 * (the fake PAT is visibly fake, 'ghp_test_...'). The default fetch
 * (global fetch → api.github.com) is never exercised here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AppRegistry,
  BUILTIN_APPS,
  DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS,
  GITHUB_PAT_REVOKED_DETAIL,
  GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL,
  GithubPatRevalidator,
  SharedAppAuthStore,
} from '../packages/core/dist/apps/index.js';

/** In-memory TokenStore (same shape as the helper in apps-m7.test.mjs). */
function memoryTokenStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async getToken(id) {
      const v = map.get(id);
      return v ? { ...v } : null;
    },
    async setToken(id, token) {
      map.set(id, { ...token });
    },
    async clearToken(id) {
      map.delete(id);
    },
  };
}

const FAKE_PAT = 'ghp_test_fake_token';

/** Mock fetchFn with a switchable mode; records every call. */
function mockFetch() {
  const calls = [];
  let mode = 'ok'; // 'ok' | 'revoked' | 'down' | 'rate-limited' | 'forbidden'
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (mode === 'down') throw new Error('fetch failed (test)');
    if (mode === 'revoked') {
      return {
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({ message: 'Bad credentials' }),
        text: async () => 'Bad credentials',
      };
    }
    if (mode === 'rate-limited') {
      return {
        ok: false,
        status: 403,
        headers: { get: (name) => (name.toLowerCase() === 'x-ratelimit-remaining' ? '0' : null) },
        json: async () => ({ message: 'API rate limit exceeded' }),
        text: async () => 'API rate limit exceeded',
      };
    }
    if (mode === 'forbidden') {
      return {
        ok: false,
        status: 403,
        headers: { get: () => '42' },
        json: async () => ({ message: 'Forbidden' }),
        text: async () => 'Forbidden',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ login: 'octocat' }),
      text: async () => '{"login":"octocat"}',
    };
  };
  return {
    calls,
    fetchFn,
    setMode: (next) => {
      mode = next;
    },
  };
}

/** Controllable clock (ms) for cache-expiry tests. */
function fakeClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

/** A SharedAppAuthStore whose 'github' token is a local variable. */
function githubStore({ fetchFn, nowMs, cacheMs } = {}) {
  let plainToken = null;
  const store = new SharedAppAuthStore({
    store: memoryTokenStore(),
    getPlainToken: async () => plainToken,
    setPlainToken: async (_ns, _key, value) => {
      plainToken = value;
    },
    clearPlainToken: async () => {
      plainToken = null;
    },
    ...(fetchFn ? { githubPatFetchFn: fetchFn } : {}),
    ...(cacheMs !== undefined ? { githubPatRevalidateCacheMs: cacheMs } : {}),
    ...(nowMs ? { nowMs } : {}),
  });
  return {
    store,
    getToken: () => plainToken,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('revalidate: default cache window is 1 hour', () => {
  assert.equal(DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS, 3_600_000);
});

// ---------------------------------------------------------------------------
// GithubPatRevalidator — cache behaviour
// ---------------------------------------------------------------------------

test('revalidator: valid token is cached — second check within the hour makes no second fetch', async () => {
  const { calls, fetchFn } = mockFetch();
  const clock = fakeClock();
  const revalidator = new GithubPatRevalidator({ fetchFn, nowMs: clock.nowMs });

  const first = await revalidator.check(FAKE_PAT);
  assert.equal(first.outcome, 'valid');
  assert.equal(first.login, 'octocat');
  assert.equal(first.fromCache, false);
  assert.equal(calls.length, 1);

  clock.advance(59 * 60 * 1000);
  const second = await revalidator.check(FAKE_PAT);
  assert.equal(second.outcome, 'valid');
  assert.equal(second.fromCache, true);
  assert.equal(second.checkedAtMs, first.checkedAtMs, 'cache hit reports the original check time');
  assert.equal(calls.length, 1, 'no second request inside the cache window');

  // Past the hour the cache expires and GitHub is asked again.
  clock.advance(2 * 60 * 1000);
  const third = await revalidator.check(FAKE_PAT);
  assert.equal(third.outcome, 'valid');
  assert.equal(third.fromCache, false);
  assert.equal(calls.length, 2);
});

test('revalidator: 401 is invalid with re-paste guidance, and is NOT cached', async () => {
  const { calls, fetchFn, setMode } = mockFetch();
  const revalidator = new GithubPatRevalidator({ fetchFn });

  setMode('revoked');
  const result = await revalidator.check(FAKE_PAT);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.detail, GITHUB_PAT_REVOKED_DETAIL);
  assert.match(result.detail, /không còn hiệu lực/);
  assert.match(result.detail, /dán lại/);
  assert.ok(!JSON.stringify(result).includes(FAKE_PAT), 'result must never contain the token');
  assert.equal(calls.length, 1);

  // An invalid result is not cached: once the token works again the
  // next check asks GitHub instead of repeating the stale 401.
  setMode('ok');
  const again = await revalidator.check(FAKE_PAT);
  assert.equal(again.outcome, 'valid');
  assert.equal(calls.length, 2);
});

test('revalidator: a valid result invalidated later is not served from cache', async () => {
  const { calls, fetchFn, setMode } = mockFetch();
  const clock = fakeClock();
  const revalidator = new GithubPatRevalidator({ fetchFn, nowMs: clock.nowMs });

  assert.equal((await revalidator.check(FAKE_PAT)).outcome, 'valid');
  assert.equal(calls.length, 1);
  // Token revoked after it was saved and cached: past the cache
  // window the next check must see the 401, not the stale 'valid'.
  setMode('revoked');
  clock.advance(DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS + 1000);
  const result = await revalidator.check(FAKE_PAT);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.detail, GITHUB_PAT_REVOKED_DETAIL);
  assert.equal(calls.length, 2);
  // And the invalid result clears the old valid cache entry.
  setMode('ok');
  assert.equal((await revalidator.check(FAKE_PAT)).outcome, 'valid');
  assert.equal(calls.length, 3, 'no stale valid cache survives a 401');
});

test('revalidator: network failure is unknown (not invalid), keeps the old status, and is not cached', async () => {
  const { calls, fetchFn, setMode } = mockFetch();
  const revalidator = new GithubPatRevalidator({ fetchFn });

  setMode('down');
  const result = await revalidator.check(FAKE_PAT);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.detail, GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL);
  assert.match(result.detail, /giữ trạng thái cũ/);
  assert.ok(!JSON.stringify(result).includes(FAKE_PAT), 'result must never contain the token');
  assert.equal(calls.length, 1);

  // Unknown is not cached: the next check retries GitHub.
  setMode('ok');
  assert.equal((await revalidator.check(FAKE_PAT)).outcome, 'valid');
  assert.equal(calls.length, 2);
});

test('revalidator: 403 (rate-limited or not) is unknown, never "token wrong"', async () => {
  const { calls, fetchFn, setMode } = mockFetch();
  const revalidator = new GithubPatRevalidator({ fetchFn });

  setMode('rate-limited');
  const limited = await revalidator.check(FAKE_PAT);
  assert.equal(limited.outcome, 'unknown');
  assert.match(limited.detail, /rate limit/);

  setMode('forbidden');
  const forbidden = await revalidator.check(FAKE_PAT);
  assert.equal(forbidden.outcome, 'unknown');
  assert.match(forbidden.detail, /tạm thời từ chối/);
  assert.equal(calls.length, 2, 'unknown results are not cached');
});

test('revalidator: blank token is invalid without any network call', async () => {
  const { calls, fetchFn } = mockFetch();
  const revalidator = new GithubPatRevalidator({ fetchFn });
  assert.equal((await revalidator.check('   ')).outcome, 'invalid');
  assert.equal((await revalidator.check('')).outcome, 'invalid');
  assert.equal(calls.length, 0);
});

test('revalidator: seedValid avoids a fetch; clear forces a fresh check', async () => {
  const { calls, fetchFn } = mockFetch();
  const revalidator = new GithubPatRevalidator({ fetchFn });

  revalidator.seedValid('octocat');
  const seeded = await revalidator.check(FAKE_PAT);
  assert.equal(seeded.outcome, 'valid');
  assert.equal(seeded.login, 'octocat');
  assert.equal(seeded.fromCache, true);
  assert.equal(calls.length, 0, 'a seeded valid result needs no request');

  revalidator.clear();
  const afterClear = await revalidator.check(FAKE_PAT);
  assert.equal(afterClear.outcome, 'valid');
  assert.equal(afterClear.fromCache, false);
  assert.equal(calls.length, 1);
});

test('revalidator: concurrent checks for the same token share one fetch', async () => {
  let resolveFetch;
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    await new Promise((resolve) => {
      resolveFetch = resolve;
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ login: 'octocat' }),
      text: async () => '{"login":"octocat"}',
    };
  };
  const revalidator = new GithubPatRevalidator({ fetchFn });
  const both = Promise.all([revalidator.check(FAKE_PAT), revalidator.check(FAKE_PAT)]);
  // Let both checks reach the in-flight fetch, then release it.
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveFetch();
  const [first, second] = await both;
  assert.equal(first.outcome, 'valid');
  assert.equal(second.outcome, 'valid');
  assert.equal(calls.length, 1, 'parallel status queries must not fan out to GitHub');
});

test('revalidator: slow fetch that ignores the signal still ends at the timeout as unknown', async () => {
  const fetchFn = () => new Promise(() => {});
  const revalidator = new GithubPatRevalidator({ fetchFn, timeoutMs: 50 });
  const started = Date.now();
  const result = await revalidator.check(FAKE_PAT);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.detail, GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL);
  assert.ok(Date.now() - started < 2000, 'revalidation ends at the timeout even with a deaf fetch');
});

// ---------------------------------------------------------------------------
// SharedAppAuthStore.getStatus — revoked after save, network keeps status
// ---------------------------------------------------------------------------

test('store: token revoked after save is caught by the next status check', async () => {
  const { calls, fetchFn, setMode } = mockFetch();
  const clock = fakeClock();
  const { store } = githubStore({ fetchFn, nowMs: clock.nowMs });

  assert.equal(await store.getStatus('github'), 'not_connected');
  await store.connectPlainToken('github', FAKE_PAT);
  assert.equal(await store.getStatus('github'), 'connected');
  assert.equal(store.getAccountLabel('github'), 'octocat', 'login from validation becomes the account label');
  assert.equal(store.getStatusDetail('github'), undefined);
  assert.equal(calls.length, 1);

  // The token is revoked on GitHub after it was saved. Inside the
  // cache window the status is still the cached 'connected'; past
  // the window the next status check sees the 401.
  setMode('revoked');
  assert.equal(await store.getStatus('github'), 'connected', 'cached valid result still applies');
  clock.advance(DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS + 1000);
  assert.equal(await store.getStatus('github'), 'expired');
  assert.match(store.getStatusDetail('github'), /không còn hiệu lực/);
  assert.match(store.getStatusDetail('github'), /dán lại/);

  const statuses = await store.listStatuses();
  const github = statuses.find((s) => s.app.id === 'github');
  assert.equal(github.authStatus, 'expired');
  assert.match(github.authStatusDetail, /không còn hiệu lực/);
  assert.ok(
    !JSON.stringify(statuses).includes(FAKE_PAT),
    'status views must never contain the token',
  );
  assert.ok(!JSON.stringify(statuses).includes('ghp_'), 'no token prefix in status views');
});

test('store: network failure keeps the previous connected status and records the reason', async () => {
  const { calls, fetchFn, setMode } = mockFetch();
  const clock = fakeClock();
  const { store } = githubStore({ fetchFn, nowMs: clock.nowMs });

  await store.connectPlainToken('github', FAKE_PAT);
  assert.equal(await store.getStatus('github'), 'connected');
  assert.equal(calls.length, 1);

  setMode('down');
  clock.advance(DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS + 1000);
  assert.equal(
    await store.getStatus('github'),
    'connected',
    'an uncheckable token must not be marked broken',
  );
  assert.match(store.getStatusDetail('github'), /Không kiểm tra được token GitHub/);
  assert.match(store.getStatusDetail('github'), /giữ trạng thái cũ/);
  const callsAfterDown = calls.length;

  // The failure was not cached: the next check retries, and a
  // healthy answer clears the recorded reason.
  setMode('ok');
  assert.equal(await store.getStatus('github'), 'connected');
  assert.equal(calls.length, callsAfterDown + 1, 'unknown result is retried, not cached');
  assert.equal(store.getStatusDetail('github'), undefined);
  const statuses = await store.listStatuses();
  assert.equal(statuses.find((s) => s.app.id === 'github').authStatusDetail, undefined);
});

test('store: disconnect clears the revalidation cache', async () => {
  const { calls, fetchFn } = mockFetch();
  const { store } = githubStore({ fetchFn });

  await store.connectPlainToken('github', FAKE_PAT);
  assert.equal(await store.getStatus('github'), 'connected');
  assert.equal(calls.length, 1);
  assert.equal(await store.getStatus('github'), 'connected', 'second check uses the cache');
  assert.equal(calls.length, 1);

  assert.equal(await store.disconnect('github'), true);
  assert.equal(await store.getStatus('github'), 'not_connected');
  assert.equal(calls.length, 1, 'no validation for a removed token');

  await store.connectPlainToken('github', FAKE_PAT);
  assert.equal(await store.getStatus('github'), 'connected');
  assert.equal(calls.length, 2, 'a re-saved token is validated fresh, not from the old cache');
});

test('store: non-github token apps never call the GitHub API', async () => {
  const { calls, fetchFn } = mockFetch();
  const otherApp = {
    id: 'other-pat',
    label: 'Other PAT',
    description: 'Another pasted-token app (test only).',
    icon: '🔑',
    authType: 'token',
    vaultNamespace: 'other',
    vaultKey: 'token',
    tools: [{ name: 'other_pat_tool', description: 'test tool', needsApproval: false }],
  };
  const registry = new AppRegistry([...BUILTIN_APPS, otherApp]);
  let plainTokens = new Map();
  const store = new SharedAppAuthStore({
    store: memoryTokenStore(),
    registry,
    getPlainToken: async (namespace, key) => plainTokens.get(`${namespace}/${key}`) ?? null,
    setPlainToken: async (namespace, key, value) => {
      plainTokens.set(`${namespace}/${key}`, value);
    },
    clearPlainToken: async (namespace, key) => {
      plainTokens.delete(`${namespace}/${key}`);
    },
    githubPatFetchFn: fetchFn,
  });

  await store.connectPlainToken('other-pat', FAKE_PAT);
  assert.equal(await store.getStatus('other-pat'), 'connected');
  assert.equal(await store.getStatus('github'), 'not_connected');
  assert.equal(calls.length, 0, 'only the github app may trigger a GitHub validation');
  assert.equal(store.getStatusDetail('other-pat'), undefined);
});
