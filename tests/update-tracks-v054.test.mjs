/**
 * Tests for v0.54 (P1-9): update theo track + scheduled check (§6).
 *
 * Covered here (no Electron window needed — UpdateService is pure and
 * takes injected storage + checkFn; core tracks module is pure):
 *  - tracks: parse/isUpdateTrack, isUpdateDisabledByEnv, evaluateUpdatePolicy
 *    (update_required thắng; dưới min_client_version thì bắt buộc).
 *  - UpdateService: track mặc định stable + persist; track lạ → stable;
 *    setUpdateTrack đổi feedStatus; track ngoài stable (dogfood/nightly/
 *    lab) từ v0.59 kiểm tra thật qua `checkTrackFn` (mặc định là
 *    `checkForTrackUpdate` — xem tests/update-feed-tracks-v059.test.mjs),
 *    KHÔNG gọi `checkFn` của stable; stub (`stub-no-feed`, không gọi
 *    mạng) chỉ còn khi feed chưa cấu hình (`trackFeedUrl: ''`); track
 *    stable → gọi checkFn, newer → available; checkFn lỗi/throw →
 *    checkFailed + lastError, không throw; tắt bằng env →
 *    errorCode `updateDisabledByEnv`, không gọi checkFn;
 *    quitAndInstallUpdate luôn {installed:false} (chưa có cơ chế cài thật);
 *    scheduleNextPeriodicCheck chạy định kỳ + stop() dừng lịch.
 *
 * Run after building core + desktop main:
 *   npm run build --workspace=@open-bot/core
 *   npx tsc -p apps/desktop/tsconfig.main.json
 *   node --test tests/update-tracks-v054.test.mjs
 * Không gọi mạng thật (checkFn mock), không cần API key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_UPDATE_TRACK,
  UPDATE_DISABLED_BY_ENV_CODE,
  UPDATE_TRACKS,
  evaluateUpdatePolicy,
  isUpdateDisabledByEnv,
  isUpdateTrack,
  parseUpdateTrack,
} from '../packages/core/dist/update/index.js';
import { UpdateService } from '../apps/desktop/dist/main/updateService.js';

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

function mockCheck(result) {
  let calls = 0;
  return {
    calls: () => calls,
    fn: async () => {
      calls += 1;
      return result;
    },
  };
}

const NEWER = {
  available: true,
  currentVersion: '0.50.0',
  latestVersion: '0.51.0',
  latestTag: 'v0.51.0',
  htmlUrl: 'https://example.invalid/releases/v0.51.0',
  checkFailed: false,
};

// ---------------------------------------------------------------------------
// 1. Track + policy (core, thuần túy)
// ---------------------------------------------------------------------------

test('P1-9: track parse/validate + mặc định stable', () => {
  assert.deepEqual([...UPDATE_TRACKS], ['stable', 'dogfood', 'nightly', 'lab']);
  assert.equal(DEFAULT_UPDATE_TRACK, 'stable');
  assert.equal(parseUpdateTrack('nightly'), 'nightly');
  assert.equal(parseUpdateTrack('lab'), 'lab');
  assert.equal(parseUpdateTrack('stable'), 'stable');
  assert.equal(parseUpdateTrack('beta'), 'stable');
  assert.equal(parseUpdateTrack(undefined), 'stable');
  assert.equal(parseUpdateTrack(42), 'stable');
  assert.equal(isUpdateTrack('dogfood'), true);
  assert.equal(isUpdateTrack('beta'), false);
});

test('P1-9: tắt update bằng env → updateDisabledByEnv', () => {
  assert.equal(isUpdateDisabledByEnv({}), false);
  assert.equal(isUpdateDisabledByEnv({ OPEN_BOT_DISABLE_UPDATE: '1' }), true);
  assert.equal(isUpdateDisabledByEnv({ OPEN_BOT_DISABLE_UPDATE: 'true' }), true);
  assert.equal(isUpdateDisabledByEnv({ OPEN_BOT_DISABLE_UPDATE: 'TRUE' }), true);
  assert.equal(isUpdateDisabledByEnv({ OPEN_BOT_DISABLE_UPDATE: '0' }), false);
  assert.equal(isUpdateDisabledByEnv({ OPEN_BOT_DISABLE_UPDATE: 'yes' }), false);
  assert.equal(UPDATE_DISABLED_BY_ENV_CODE, 'updateDisabledByEnv');
});

test('P1-9: evaluateUpdatePolicy — required thắng; dưới min version thì bắt buộc', () => {
  assert.deepEqual(evaluateUpdatePolicy({ currentVersion: '0.50.0' }), {
    required: false,
    belowMinVersion: false,
    reason: null,
  });
  const required = evaluateUpdatePolicy({ currentVersion: '0.50.0', updateRequired: true });
  assert.equal(required.required, true);
  assert.match(required.reason ?? '', /bắt buộc/);
  const below = evaluateUpdatePolicy({ currentVersion: '0.48.0', minClientVersion: '0.49.0' });
  assert.equal(below.required, true);
  assert.equal(below.belowMinVersion, true);
  assert.match(below.reason ?? '', /0.48.0/);
  const above = evaluateUpdatePolicy({ currentVersion: '0.50.0', minClientVersion: '0.49.0' });
  assert.equal(above.required, false);
  assert.equal(above.belowMinVersion, false);
});

// ---------------------------------------------------------------------------
// 2. UpdateService
// ---------------------------------------------------------------------------

test('P1-9: UpdateService — track mặc định + persist + track lạ về stable', () => {
  const storage = memoryStorage('nightly');
  const svc = new UpdateService({ currentVersion: '0.50.0', storage });
  assert.equal(svc.getTrack(), 'nightly');
  const after = svc.setUpdateTrack('lab');
  assert.equal(after.track, 'lab');
  assert.equal(storage.get(), 'lab');
  assert.equal(after.feedStatus, 'github-releases-list');
  const invalid = svc.setUpdateTrack('beta-khong-co');
  assert.equal(invalid.track, 'stable');
  assert.equal(storage.get(), 'stable');
  assert.equal(invalid.feedStatus, 'github-stable');
});

test('P1-9: UpdateService — track ngoài stable kiểm tra qua checkTrackFn (v0.59); stub chỉ khi feed chưa cấu hình', async () => {
  const check = mockCheck(NEWER);
  let trackCalls = 0;
  const svc = new UpdateService({
    currentVersion: '0.50.0',
    storage: memoryStorage('dogfood'),
    checkFn: check.fn,
    checkTrackFn: async () => {
      trackCalls += 1;
      return NEWER;
    },
  });
  const status = await svc.checkForUpdates('startup');
  assert.equal(check.calls(), 0, 'track dogfood không được gọi checkFn của stable');
  assert.equal(trackCalls, 1, 'track dogfood phải kiểm tra qua checkTrackFn');
  assert.equal(status.feedStatus, 'github-releases-list');
  assert.equal(status.available, true);
  assert.equal(status.checkFailed, false);
  assert.ok(status.lastCheckedAt);
  // Đổi sang nightly/lab cũng kiểm tra qua checkTrackFn như nhau.
  svc.setUpdateTrack('nightly');
  assert.equal((await svc.checkForUpdates('manual')).feedStatus, 'github-releases-list');
  assert.equal(trackCalls, 2);
  assert.equal(check.calls(), 0);

  // Stub chỉ còn khi feed chưa cấu hình (trackFeedUrl: '').
  const stubbed = new UpdateService({
    currentVersion: '0.50.0',
    storage: memoryStorage('dogfood'),
    trackFeedUrl: '',
    checkFn: check.fn,
    checkTrackFn: async () => {
      trackCalls += 1;
      return NEWER;
    },
  });
  const stubStatus = await stubbed.checkForUpdates('startup');
  assert.equal(stubStatus.feedStatus, 'stub-no-feed');
  assert.equal(stubStatus.available, false);
  assert.equal(stubStatus.checkFailed, false);
  assert.equal(trackCalls, 2, 'track stub không được gọi checkTrackFn (không có feed)');
});

test('P1-9: UpdateService — stable gọi checkFn; bản mới → available; lỗi → checkFailed, không throw', async () => {
  const check = mockCheck(NEWER);
  const svc = new UpdateService({ currentVersion: '0.50.0', storage: memoryStorage('stable'), checkFn: check.fn });
  const status = await svc.checkForUpdates('startup');
  assert.equal(check.calls(), 1);
  assert.equal(status.available, true);
  assert.equal(status.latestVersion, '0.51.0');
  assert.equal(status.feedStatus, 'github-stable');
  assert.equal(status.checkFailed, false);

  const failing = new UpdateService({
    currentVersion: '0.50.0',
    storage: memoryStorage('stable'),
    checkFn: async () => ({ ...NEWER, available: false, checkFailed: true, error: 'mạng lỗi' }),
  });
  const failed = await failing.checkForUpdates('periodic');
  assert.equal(failed.checkFailed, true);
  assert.equal(failed.available, false);
  assert.equal(failed.lastError, 'mạng lỗi');

  const throwing = new UpdateService({
    currentVersion: '0.50.0',
    storage: memoryStorage('stable'),
    checkFn: async () => {
      throw new Error('fetch nổ');
    },
  });
  const threw = await throwing.checkForUpdates('manual');
  assert.equal(threw.checkFailed, true);
  assert.match(threw.lastError ?? '', /fetch nổ/);
});

test('P1-9: UpdateService — tắt bằng env thì mã updateDisabledByEnv, không gọi checkFn', async () => {
  const check = mockCheck(NEWER);
  const svc = new UpdateService({
    currentVersion: '0.50.0',
    storage: memoryStorage('stable'),
    checkFn: check.fn,
    env: { OPEN_BOT_DISABLE_UPDATE: '1' },
  });
  const status = await svc.checkForUpdates('startup');
  assert.equal(check.calls(), 0);
  assert.equal(status.checkFailed, true);
  assert.equal(status.errorCode, 'updateDisabledByEnv');
  assert.equal(status.available, false);
});

test('P1-9: UpdateService — quitAndInstallUpdate luôn installed:false (chưa có cơ chế cài)', async () => {
  const check = mockCheck(NEWER);
  const svc = new UpdateService({ currentVersion: '0.50.0', storage: memoryStorage('stable'), checkFn: check.fn });
  assert.deepEqual(svc.quitAndInstallUpdate(), {
    installed: false,
    reason: 'Chưa có bản cập nhật để cài đặt.',
  });
  await svc.checkForUpdates('manual');
  const withUpdate = svc.quitAndInstallUpdate();
  assert.equal(withUpdate.installed, false);
  assert.match(withUpdate.reason, /chưa có cơ chế tải/);
});

test('P1-9: UpdateService — setServerPolicy làm policy bắt buộc; lịch định kỳ retry sau lỗi', async () => {
  const svc = new UpdateService({ currentVersion: '0.48.0', storage: memoryStorage('stable') });
  assert.equal(svc.getStatus().updateRequiredByPolicy, false);
  svc.setServerPolicy({ updateRequired: true, minClientVersion: '0.49.0' });
  const status = svc.getStatus();
  assert.equal(status.updateRequired, true);
  assert.equal(status.minClientVersion, '0.49.0');
  assert.equal(status.updateRequiredByPolicy, true);

  // Lịch định kỳ: check lỗi vẫn lên lịch lần sau (retry), stop() dừng hẳn.
  let calls = 0;
  const periodic = new UpdateService({
    currentVersion: '0.50.0',
    storage: memoryStorage('stable'),
    checkFn: async () => {
      calls += 1;
      return { ...NEWER, available: false, checkFailed: true, error: 'lỗi mạng' };
    },
    periodicIntervalMs: 10,
  });
  await periodic.start();
  assert.equal(calls, 1, 'start() check startup 1 lần');
  // Chu kỳ 10ms, chờ 300ms: đủ chỗ cho timer trượt dưới tải CPU (máy
  // build song song) mà vẫn phải có ít nhất 3 lần gọi — kỳ vọng thời
  // gian chặt (15ms/60ms) đã fail flaky khi worker khác đang build.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(calls >= 3, `lịch định kỳ phải retry sau lỗi (gọi ${calls} lần)`);
  periodic.stop();
  const frozen = calls;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, frozen, 'stop() dừng lịch định kỳ');
});
