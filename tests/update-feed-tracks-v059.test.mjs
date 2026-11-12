/**
 * Tests for v0.59 — update feed thật cho track ngoài stable
 * (core checkForTrackUpdate + UpdateService):
 *   - `checkForTrackUpdate` (core): lấy danh sách releases (fake
 *     fetch — KHÔNG gọi mạng thật), chọn release theo tag kênh
 *     (`-dogfood` / `-nightly` / `-lab`, prerelease), so semver với
 *     bản hiện tại. Feed giả có bản mới hơn → báo có mới; không có
 *     release cho kênh → báo không (không phải lỗi); feed lỗi →
 *     checkFailed, fail soft.
 *   - `UpdateService`: track ngoài stable dùng `checkTrackFn`
 *     (mặc định là `checkForTrackUpdate` với global fetch — test
 *     stub global fetch để kiểm chứng đường chạy mặc định); feed
 *     chưa cấu hình (`trackFeedUrl: ''`) thì vẫn `stub-no-feed`,
 *     không gọi mạng; lỗi feed thì fail soft như track stable.
 *
 * Run after building core + desktop main:
 *   npm run build --workspace=@open-bot/core
 *   npx tsc -p apps/desktop/tsconfig.main.json
 *   node --test tests/update-feed-tracks-v059.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UPDATE_RELEASES_LIST_API,
  checkForTrackUpdate,
  pickReleaseForTrack,
  releaseMatchesTrack,
} from '../packages/core/dist/update/index.js';
import { UpdateService, feedStatusForTrack } from '../apps/desktop/dist/main/updateService.js';

function memoryStorage(initial = null) {
  let track = initial;
  return {
    loadTrack: () => track,
    saveTrack: (t) => {
      track = t;
    },
    get: () => track,
  };
}

/** Fake fetch returning a fixed releases list; records every URL it is called with. */
function fakeFeedFetch(releases, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return { ok, status, json: async () => releases };
  };
  return { fn, calls };
}

const STABLE_RELEASE = {
  tag_name: 'v0.58.0',
  prerelease: false,
  html_url: 'https://example.invalid/releases/v0.58.0',
};
const DOGFOOD_RELEASE = {
  tag_name: 'v0.59.0-dogfood.1',
  prerelease: true,
  html_url: 'https://example.invalid/releases/v0.59.0-dogfood.1',
};
const NIGHTLY_RELEASE = {
  tag_name: 'v0.59.0-nightly.20261109',
  prerelease: true,
  html_url: 'https://example.invalid/releases/v0.59.0-nightly.20261109',
};
const LAB_OLD_RELEASE = {
  tag_name: 'v0.49.0-lab.1',
  prerelease: true,
  html_url: 'https://example.invalid/releases/v0.49.0-lab.1',
};

const FEED_ALL = [DOGFOOD_RELEASE, NIGHTLY_RELEASE, STABLE_RELEASE, LAB_OLD_RELEASE];

// ---------------------------------------------------------------------------
// 1. Channel matching (pure)
// ---------------------------------------------------------------------------

test('v0.59 feed: releaseMatchesTrack / pickReleaseForTrack chọn đúng kênh theo tag', () => {
  assert.equal(releaseMatchesTrack(STABLE_RELEASE, 'stable'), true);
  assert.equal(releaseMatchesTrack(DOGFOOD_RELEASE, 'stable'), false);
  assert.equal(releaseMatchesTrack(DOGFOOD_RELEASE, 'dogfood'), true);
  assert.equal(releaseMatchesTrack(DOGFOOD_RELEASE, 'nightly'), false);
  assert.equal(releaseMatchesTrack(NIGHTLY_RELEASE, 'nightly'), true);
  assert.equal(releaseMatchesTrack(LAB_OLD_RELEASE, 'lab'), true);
  assert.equal(releaseMatchesTrack({ tag_name: '', prerelease: true }, 'lab'), false);
  assert.equal(releaseMatchesTrack({ tag_name: 'v1.0.0-lab.1', prerelease: false }, 'lab'), false);

  assert.equal(pickReleaseForTrack(FEED_ALL, 'dogfood')?.tag_name, 'v0.59.0-dogfood.1');
  assert.equal(pickReleaseForTrack(FEED_ALL, 'nightly')?.tag_name, 'v0.59.0-nightly.20261109');
  assert.equal(pickReleaseForTrack(FEED_ALL, 'stable')?.tag_name, 'v0.58.0');
  assert.equal(pickReleaseForTrack([STABLE_RELEASE], 'lab'), null, 'không có release lab → null');
  assert.equal(pickReleaseForTrack([], 'nightly'), null);
});

// ---------------------------------------------------------------------------
// 2. checkForTrackUpdate with a fake feed (no real network)
// ---------------------------------------------------------------------------

test('v0.59 feed: feed giả có bản mới hơn cho kênh → báo có mới, đúng tag + URL', async () => {
  const feed = fakeFeedFetch(FEED_ALL);
  const res = await checkForTrackUpdate({
    currentVersion: '0.58.0',
    track: 'dogfood',
    fetchImpl: feed.fn,
  });
  assert.equal(res.available, true);
  assert.equal(res.latestVersion, '0.59.0-dogfood.1', 'latestVersion keeps the channel suffix (tag minus v, like stable)');
  assert.equal(res.latestTag, 'v0.59.0-dogfood.1');
  assert.equal(res.htmlUrl, 'https://example.invalid/releases/v0.59.0-dogfood.1');
  assert.equal(res.checkFailed, false);
  assert.deepEqual(feed.calls, [UPDATE_RELEASES_LIST_API]);
});

test('v0.59 feed: không có release cho kênh → báo không có mới, KHÔNG phải lỗi', async () => {
  const feed = fakeFeedFetch([STABLE_RELEASE]);
  const res = await checkForTrackUpdate({
    currentVersion: '0.58.0',
    track: 'nightly',
    fetchImpl: feed.fn,
  });
  assert.equal(res.available, false);
  assert.equal(res.checkFailed, false);
  assert.equal(res.latestVersion, null);
  assert.equal(res.latestTag, null);

  // Release của kênh có nhưng cũ hơn bản đang chạy → cũng không có mới.
  const old = fakeFeedFetch(FEED_ALL);
  const lab = await checkForTrackUpdate({
    currentVersion: '0.50.0',
    track: 'lab',
    fetchImpl: old.fn,
  });
  assert.equal(lab.available, false);
  assert.equal(lab.checkFailed, false);
  assert.equal(lab.latestTag, 'v0.49.0-lab.1');
});

test('v0.59 feed: feed lỗi → fail soft (checkFailed, không throw, không báo có mới)', async () => {
  const httpError = fakeFeedFetch({ message: 'Not Found' }, { ok: false, status: 404 });
  const res404 = await checkForTrackUpdate({
    currentVersion: '0.58.0',
    track: 'nightly',
    fetchImpl: httpError.fn,
  });
  assert.equal(res404.checkFailed, true);
  assert.equal(res404.available, false);
  assert.match(res404.error ?? '', /Not Found/);

  const throwing = await checkForTrackUpdate({
    currentVersion: '0.58.0',
    track: 'nightly',
    fetchImpl: async () => {
      throw new Error('mạng rớt');
    },
  });
  assert.equal(throwing.checkFailed, true);
  assert.equal(throwing.available, false);
  assert.match(throwing.error ?? '', /mạng rớt/);

  const malformed = fakeFeedFetch({ not: 'a list' });
  const bad = await checkForTrackUpdate({
    currentVersion: '0.58.0',
    track: 'lab',
    fetchImpl: malformed.fn,
  });
  assert.equal(bad.checkFailed, true);
  assert.equal(bad.available, false);
});

test('v0.59 feed: releasesListApiUrl cấu hình được — fetch gọi đúng URL đó', async () => {
  const customUrl = 'https://example.invalid/feeds/nightly.json';
  const feed = fakeFeedFetch([NIGHTLY_RELEASE]);
  const res = await checkForTrackUpdate({
    currentVersion: '0.58.0',
    track: 'nightly',
    fetchImpl: feed.fn,
    releasesListApiUrl: customUrl,
  });
  assert.equal(res.available, true);
  assert.deepEqual(feed.calls, [customUrl]);
});

// ---------------------------------------------------------------------------
// 3. UpdateService wiring
// ---------------------------------------------------------------------------

test('v0.59 feed: feedStatusForTrack — stable + các track khác + chưa cấu hình feed', () => {
  assert.equal(feedStatusForTrack('stable'), 'github-stable');
  assert.equal(feedStatusForTrack('dogfood'), 'github-releases-list');
  assert.equal(feedStatusForTrack('nightly'), 'github-releases-list');
  assert.equal(feedStatusForTrack('lab'), 'github-releases-list');
  assert.equal(feedStatusForTrack('dogfood', false), 'stub-no-feed');
  assert.equal(feedStatusForTrack('nightly', false), 'stub-no-feed');
  assert.equal(feedStatusForTrack('stable', false), 'github-stable', 'stable không phụ thuộc feed kênh');
});

test('v0.59 feed: UpdateService — track nightly dùng checkTrackFn, bản mới → available', async () => {
  let stableCalls = 0;
  let trackCalls = [];
  const svc = new UpdateService({
    currentVersion: '0.58.0',
    storage: memoryStorage('nightly'),
    checkFn: async () => {
      stableCalls += 1;
      return { available: false, currentVersion: '0.58.0', latestVersion: null, latestTag: null, htmlUrl: null, checkFailed: false };
    },
    checkTrackFn: async (opts) => {
      trackCalls.push(opts.track);
      return {
        available: true,
        currentVersion: opts.currentVersion,
        latestVersion: '0.59.0',
        latestTag: 'v0.59.0-nightly.20261109',
        htmlUrl: 'https://example.invalid/releases/v0.59.0-nightly.20261109',
        checkFailed: false,
      };
    },
  });
  const status = await svc.checkForUpdates('startup');
  assert.equal(stableCalls, 0, 'track nightly không được gọi checkFn của stable');
  assert.deepEqual(trackCalls, ['nightly']);
  assert.equal(status.feedStatus, 'github-releases-list');
  assert.equal(status.available, true);
  assert.equal(status.latestVersion, '0.59.0');
  assert.equal(status.latestTag, 'v0.59.0-nightly.20261109');
  assert.equal(status.checkFailed, false);
});

test('v0.59 feed: UpdateService — track lab không có bản mới → available false, không lỗi', async () => {
  const svc = new UpdateService({
    currentVersion: '0.58.0',
    storage: memoryStorage('lab'),
    checkTrackFn: async () => ({
      available: false,
      currentVersion: '0.58.0',
      latestVersion: null,
      latestTag: null,
      htmlUrl: null,
      checkFailed: false,
    }),
  });
  const status = await svc.checkForUpdates('manual');
  assert.equal(status.feedStatus, 'github-releases-list');
  assert.equal(status.available, false);
  assert.equal(status.checkFailed, false);
});

test('v0.59 feed: UpdateService — feed track lỗi/throw thì fail soft, không throw', async () => {
  const failing = new UpdateService({
    currentVersion: '0.58.0',
    storage: memoryStorage('dogfood'),
    checkTrackFn: async () => ({
      available: false,
      currentVersion: '0.58.0',
      latestVersion: null,
      latestTag: null,
      htmlUrl: null,
      checkFailed: true,
      error: 'feed lỗi',
    }),
  });
  const failed = await failing.checkForUpdates('periodic');
  assert.equal(failed.checkFailed, true);
  assert.equal(failed.available, false);
  assert.equal(failed.lastError, 'feed lỗi');

  const throwing = new UpdateService({
    currentVersion: '0.58.0',
    storage: memoryStorage('nightly'),
    checkTrackFn: async () => {
      throw new Error('fetch nổ');
    },
  });
  const threw = await throwing.checkForUpdates('manual');
  assert.equal(threw.checkFailed, true);
  assert.match(threw.lastError ?? '', /fetch nổ/);
});

test('v0.59 feed: UpdateService — trackFeedUrl rỗng thì stub-no-feed, KHÔNG gọi mạng', async () => {
  let trackCalls = 0;
  const svc = new UpdateService({
    currentVersion: '0.58.0',
    storage: memoryStorage('dogfood'),
    trackFeedUrl: '',
    checkTrackFn: async () => {
      trackCalls += 1;
      return { available: true, currentVersion: '0.58.0', latestVersion: '0.59.0', latestTag: 'v0.59.0', htmlUrl: null, checkFailed: false };
    },
  });
  const status = await svc.checkForUpdates('startup');
  assert.equal(trackCalls, 0, 'feed chưa cấu hình thì không được gọi checkTrackFn');
  assert.equal(status.feedStatus, 'stub-no-feed');
  assert.equal(status.available, false);
  assert.equal(status.checkFailed, false);
  // Đổi sang stable thì vẫn kiểm tra bình thường (không bị stub theo).
  svc.setUpdateTrack('stable');
  assert.equal(svc.getStatus().feedStatus, 'github-stable');
});

test('v0.59 feed: UpdateService — đường chạy mặc định dùng global fetch (stub, không mạng thật)', async () => {
  const originalFetch = globalThis.fetch;
  const feed = fakeFeedFetch(FEED_ALL);
  globalThis.fetch = feed.fn;
  try {
    const svc = new UpdateService({
      currentVersion: '0.58.0',
      storage: memoryStorage('nightly'),
    });
    const status = await svc.checkForUpdates('startup');
    assert.equal(status.feedStatus, 'github-releases-list');
    assert.equal(status.available, true);
    assert.equal(status.latestTag, 'v0.59.0-nightly.20261109');
    assert.deepEqual(feed.calls, [UPDATE_RELEASES_LIST_API]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
