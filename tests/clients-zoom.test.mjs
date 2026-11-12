/**
 * Tests for Zoom direct read client (worker F2, v0.89b).
 *
 * Wire shape theo Zoom API v2 (developers.zoom.us/docs/api/rest/reference):
 * GET /v2/users/me/meetings, GET /v2/meetings/{id},
 * GET /v2/users/me/recordings.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-zoom.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zoomGetMeeting,
  zoomListMeetings,
  zoomListRecordings,
} from '../packages/core/dist/clients/zoom.js';

/** Mock fetch: handler(url, init) -> { status, body }. Captures calls. */
function makeFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init ?? {});
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.body,
    };
  };
  return { calls, fetch: fetchFn };
}

const TOKEN = 'zoom-test-token';

test('zoomListMeetings: trả meetings, type + page_size trong URL', async () => {
  const mock = makeFetch(() => ({
    body: {
      meetings: [
        { id: 123, topic: 'Standup', start_time: '2026-11-12T09:00:00Z', duration: 30, join_url: 'https://zoom.us/j/123', status: 'waiting' },
      ],
      page_count: 1,
      total_records: 1,
    },
  }));
  const meetings = await zoomListMeetings({ token: TOKEN, fetch: mock.fetch }, 'scheduled', 10);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].id, '123');
  assert.equal(meetings[0].topic, 'Standup');
  assert.equal(meetings[0].startTime, '2026-11-12T09:00:00Z');
  assert.match(mock.calls[0].url, /api\.zoom\.us\/v2\/users\/me\/meetings/);
  assert.match(mock.calls[0].url, /type=scheduled/);
  assert.match(mock.calls[0].url, /page_size=10/);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('zoomGetMeeting: đọc meeting theo id, kèm agenda', async () => {
  const mock = makeFetch(() => ({
    body: { id: 456, topic: 'Review', start_time: '2026-11-12T10:00:00Z', duration: 60, join_url: 'https://zoom.us/j/456', agenda: 'Q4 review', status: 'waiting' },
  }));
  const meeting = await zoomGetMeeting({ token: TOKEN, fetch: mock.fetch }, '456');
  assert.equal(meeting.id, '456');
  assert.equal(meeting.agenda, 'Q4 review');
  assert.match(mock.calls[0].url, /\/v2\/meetings\/456$/);
});

test('zoomListRecordings: trả recordings với recording_files', async () => {
  const mock = makeFetch(() => ({
    body: {
      meetings: [
        {
          id: 789,
          topic: 'All hands',
          start_time: '2026-11-10T09:00:00Z',
          duration: 45,
          recording_files: [{ id: 'f1', recording_start: '2026-11-10T09:00:00Z', file_type: 'MP4', file_size: 123456 }],
        },
      ],
      total_records: 1,
    },
  }));
  const recs = await zoomListRecordings({ token: TOKEN, fetch: mock.fetch }, '2026-10-12', '2026-11-11');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].recordingFiles.length, 1);
  assert.equal(recs[0].recordingFiles[0].fileType, 'MP4');
  assert.match(mock.calls[0].url, /\/v2\/users\/me\/recordings/);
  assert.match(mock.calls[0].url, /from=2026-10-12/);
  assert.match(mock.calls[0].url, /to=2026-11-11/);
});

test('zoomListMeetings: 401 → lỗi rõ, không lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => zoomListMeetings({ token: TOKEN, fetch: mock.fetch }),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /zoom-test-token/);
      return true;
    },
  );
});

test('zoomGetMeeting: 404 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 404, body: {} }));
  await assert.rejects(() => zoomGetMeeting({ token: TOKEN, fetch: mock.fetch }, '999'), /404/);
});

test('zoomGetMeeting: meetingId rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(() => zoomGetMeeting({ token: TOKEN, fetch: mock.fetch }, ''), /required/);
  assert.equal(mock.calls.length, 0);
});
