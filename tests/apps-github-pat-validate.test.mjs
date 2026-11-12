/**
 * Tests for v0.69a: validate the GitHub PAT against api.github.com
 * BEFORE saving it (IPC `apps:set-token` used to store any string
 * ≤500 chars straight into the Vault; a wrong PAT only surfaced when
 * a bot called a GitHub tool).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/apps-github-pat-validate.test.mjs
 *
 * No live network, no real token: every test passes a mock fetchFn
 * (the fake PAT is visibly fake, 'ghp_test_...'). The default fetch
 * (global fetch → api.github.com) is never exercised here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GITHUB_PAT_TIMEOUT_MS,
  GITHUB_PAT_VALIDATE_URL,
  githubPatValidationErrorMessage,
  saveValidatedGithubPat,
  validateGithubPat,
} from '../packages/core/dist/apps/index.js';

const FAKE_PAT = 'ghp_test_fake_token';

/** Mock fetchFn recording every call; Headers-like `.get` (case-insensitive). */
function mockFetch({ status = 200, body = { login: 'octocat' }, headers = {}, jsonThrows = false } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => {
          const key = Object.keys(headers).find(
            (h) => h.toLowerCase() === String(name).toLowerCase(),
          );
          return key ? headers[key] : null;
        },
      },
      json: async () => {
        if (jsonThrows) throw new Error('bad json (test)');
        return body;
      },
      text: async () => JSON.stringify(body),
    };
  };
  return { calls, fetchFn };
}

// ---------------------------------------------------------------------------
// validateGithubPat — status mapping
// ---------------------------------------------------------------------------

test('validate: 200 returns ok + login, calls GET /user with Bearer + Accept + User-Agent', async () => {
  const { calls, fetchFn } = mockFetch({ status: 200, body: { login: 'octocat' } });
  const result = await validateGithubPat(FAKE_PAT, { fetchFn });
  assert.deepEqual(result, { ok: true, login: 'octocat' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].url, GITHUB_PAT_VALIDATE_URL);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_PAT}`);
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.headers['User-Agent'], 'open-bot');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'a timeout signal is passed to fetch');
});

test('validate: 200 without a login in the body is still ok (status proves the token lives)', async () => {
  const { fetchFn } = mockFetch({ status: 200, body: {} });
  assert.deepEqual(await validateGithubPat(FAKE_PAT, { fetchFn }), { ok: true });
  const { fetchFn: badJson } = mockFetch({ status: 200, jsonThrows: true });
  assert.deepEqual(
    await validateGithubPat(FAKE_PAT, { fetchFn: badJson }),
    { ok: true },
    'an unparsable 200 body is still ok',
  );
});

test('validate: 401 is invalid, 403 is forbidden, 5xx/404 is network (not "token wrong")', async () => {
  assert.deepEqual(
    await validateGithubPat(FAKE_PAT, { fetchFn: mockFetch({ status: 401 }).fetchFn }),
    { ok: false, reason: 'invalid' },
  );
  assert.deepEqual(
    await validateGithubPat(FAKE_PAT, { fetchFn: mockFetch({ status: 403 }).fetchFn }),
    { ok: false, reason: 'forbidden' },
  );
  assert.deepEqual(
    await validateGithubPat(FAKE_PAT, { fetchFn: mockFetch({ status: 500 }).fetchFn }),
    { ok: false, reason: 'network' },
  );
  assert.deepEqual(
    await validateGithubPat(FAKE_PAT, { fetchFn: mockFetch({ status: 404 }).fetchFn }),
    { ok: false, reason: 'network' },
  );
});

test('validate: 403 with X-RateLimit-Remaining 0 is flagged rate-limited', async () => {
  const { fetchFn } = mockFetch({
    status: 403,
    headers: { 'X-RateLimit-Remaining': '0' },
  });
  assert.deepEqual(await validateGithubPat(FAKE_PAT, { fetchFn }), {
    ok: false,
    reason: 'forbidden',
    rateLimited: true,
  });
  // Non-zero remaining: forbidden, but not a rate limit.
  const { fetchFn: someLeft } = mockFetch({
    status: 403,
    headers: { 'X-RateLimit-Remaining': '42' },
  });
  assert.deepEqual(await validateGithubPat(FAKE_PAT, { fetchFn: someLeft }), {
    ok: false,
    reason: 'forbidden',
  });
});

test('validate: 403 rate limit is also detected with plain-object headers (no .get)', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return {
      ok: false,
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
      json: async () => ({ message: 'API rate limit exceeded' }),
      text: async () => 'API rate limit exceeded',
    };
  };
  assert.deepEqual(await validateGithubPat(FAKE_PAT, { fetchFn }), {
    ok: false,
    reason: 'forbidden',
    rateLimited: true,
  });
});

test('validate: a fetch that throws is network, never a leak of the token', async () => {
  const fetchFn = async () => {
    throw new Error('fetch failed (test)');
  };
  assert.deepEqual(await validateGithubPat(FAKE_PAT, { fetchFn }), {
    ok: false,
    reason: 'network',
  });
});

test('validate: blank token is invalid without any network call', async () => {
  const { calls, fetchFn } = mockFetch({ status: 200 });
  assert.deepEqual(await validateGithubPat('   ', { fetchFn }), {
    ok: false,
    reason: 'invalid',
  });
  assert.deepEqual(await validateGithubPat('', { fetchFn }), {
    ok: false,
    reason: 'invalid',
  });
  assert.equal(calls.length, 0, 'no request is made for an empty token');
});

test('validate: surrounding whitespace is trimmed before the request', async () => {
  const { calls, fetchFn } = mockFetch({ status: 200 });
  await validateGithubPat(`  ${FAKE_PAT}  `, { fetchFn });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_PAT}`);
});

// ---------------------------------------------------------------------------
// validateGithubPat — timeout really cancels the request
// ---------------------------------------------------------------------------

test('validate: slow fetch that respects the signal is aborted by the timeout', async () => {
  const seen = [];
  const fetchFn = async (_url, init = {}) => {
    seen.push(init);
    await new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => {
          const err = new Error('aborted (test)');
          err.name = 'AbortError';
          reject(err);
        },
        { once: true },
      );
    });
  };
  const started = Date.now();
  const result = await validateGithubPat(FAKE_PAT, { fetchFn, timeoutMs: 50 });
  assert.deepEqual(result, { ok: false, reason: 'network' });
  assert.ok(Date.now() - started < 2000, 'timeout fires promptly, does not wait for the fetch');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal.aborted, true, 'the signal handed to fetch was aborted');
});

test('validate: slow fetch that IGNORES the signal still cannot hang past the timeout', async () => {
  // A fetch implementation that never resolves and never listens to
  // the signal: the Promise.race against the timeout must still end
  // the validation instead of hanging the caller (e.g. the UI).
  const fetchFn = () => new Promise(() => {});
  const started = Date.now();
  const result = await validateGithubPat(FAKE_PAT, { fetchFn, timeoutMs: 50 });
  assert.deepEqual(result, { ok: false, reason: 'network' });
  assert.ok(Date.now() - started < 2000, 'validation ends at the timeout even with a deaf fetch');
});

test('validate: default timeout is 10s', () => {
  assert.equal(DEFAULT_GITHUB_PAT_TIMEOUT_MS, 10_000);
});

// ---------------------------------------------------------------------------
// Error messages — clear Vietnamese, never contain the token
// ---------------------------------------------------------------------------

test('error messages: exact Vietnamese wording per reason, token never included', () => {
  const cases = [
    [{ ok: false, reason: 'invalid' }, /PAT không đúng hoặc đã hết hạn/],
    [{ ok: false, reason: 'forbidden' }, /GitHub từ chối token \(có thể hết hạn/],
    [
      { ok: false, reason: 'forbidden', rateLimited: true },
      /hết giới hạn gọi API \(rate limit\)/,
    ],
    [{ ok: false, reason: 'network' }, /Không kiểm tra được PAT \(lỗi mạng\/timeout\)/],
  ];
  for (const [result, pattern] of cases) {
    const message = githubPatValidationErrorMessage(result);
    assert.match(message, pattern);
    assert.ok(!message.includes(FAKE_PAT), 'error message must never contain the token');
    assert.ok(!message.includes('ghp_'), 'error message must never contain a token prefix');
  }
});

// ---------------------------------------------------------------------------
// saveValidatedGithubPat — save only after a successful validation
// ---------------------------------------------------------------------------

test('save: token is saved + seeded only when validation succeeds, with the login', async () => {
  const saved = [];
  const seeded = [];
  const { fetchFn } = mockFetch({ status: 200, body: { login: 'octocat' } });
  const out = await saveValidatedGithubPat({
    token: `  ${FAKE_PAT}  `,
    fetchFn,
    save: async (t) => {
      saved.push(t);
    },
    onSaved: async (t, login) => {
      seeded.push([t, login]);
    },
  });
  assert.deepEqual(out, { login: 'octocat' });
  assert.deepEqual(saved, [FAKE_PAT], 'the trimmed token is saved once');
  assert.deepEqual(seeded, [[FAKE_PAT, 'octocat']], 'seed receives the token + login label');
});

test('save: validation failure (401) saves nothing, seeds nothing, throws in Vietnamese', async () => {
  const saved = [];
  const seeded = [];
  const { fetchFn } = mockFetch({ status: 401 });
  await assert.rejects(
    saveValidatedGithubPat({
      token: FAKE_PAT,
      fetchFn,
      save: async (t) => {
        saved.push(t);
      },
      onSaved: async (t, login) => {
        seeded.push([t, login]);
      },
    }),
    (err) => {
      assert.match(err.message, /PAT không đúng hoặc đã hết hạn/);
      assert.ok(!err.message.includes(FAKE_PAT), 'thrown error must never contain the token');
      return true;
    },
  );
  assert.deepEqual(saved, [], 'Vault save must NOT be called when validation fails');
  assert.deepEqual(seeded, [], 'coordinator seed must NOT be called when validation fails');
});

test('save: network failure and rate-limited 403 also save nothing', async () => {
  for (const [mockOpts, pattern] of [
    [{ status: 500 }, /Không kiểm tra được PAT/],
    [{ status: 403, headers: { 'X-RateLimit-Remaining': '0' } }, /hết giới hạn gọi API/],
  ]) {
    const saved = [];
    const { fetchFn } = mockFetch(mockOpts);
    await assert.rejects(
      saveValidatedGithubPat({
        token: FAKE_PAT,
        fetchFn,
        save: async (t) => {
          saved.push(t);
        },
      }),
      pattern,
    );
    assert.deepEqual(saved, [], `no save on ${JSON.stringify(mockOpts)}`);
  }
});

test('save: blank token saves nothing and makes no network call', async () => {
  const saved = [];
  const { calls, fetchFn } = mockFetch({ status: 200 });
  await assert.rejects(
    saveValidatedGithubPat({
      token: '   ',
      fetchFn,
      save: async (t) => {
        saved.push(t);
      },
    }),
    /PAT không đúng/,
  );
  assert.deepEqual(saved, []);
  assert.equal(calls.length, 0);
});

test('save: a failing seed (onSaved throws) does not fail the save — best-effort like main before', async () => {
  const saved = [];
  const { fetchFn } = mockFetch({ status: 200, body: { login: 'octocat' } });
  const out = await saveValidatedGithubPat({
    token: FAKE_PAT,
    fetchFn,
    save: async (t) => {
      saved.push(t);
    },
    onSaved: async () => {
      throw new Error('coordinator down (test)');
    },
  });
  assert.deepEqual(out, { login: 'octocat' });
  assert.deepEqual(saved, [FAKE_PAT], 'the Vault save still happened');
});

test('save: works without onSaved (no coordinator running)', async () => {
  const saved = [];
  const { fetchFn } = mockFetch({ status: 200, body: { login: 'octocat' } });
  const out = await saveValidatedGithubPat({ token: FAKE_PAT, fetchFn, save: (t) => saved.push(t) });
  assert.deepEqual(out, { login: 'octocat' });
  assert.deepEqual(saved, [FAKE_PAT]);
});
