/**
 * Zoom read client (worker F2, v0.89b) — Zoom API v2, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Zoom API
 * (developers.zoom.us/docs/api/rest/reference/):
 *  - `GET /v2/users/me/meetings?type=scheduled&page_size=30` →
 *    `{ meetings: [{ id, topic, start_time, duration, join_url, status }],
 *    page_count, total_records }`.
 *  - `GET /v2/meetings/{meetingId}` → `{ id, topic, start_time, duration,
 *    join_url, agenda, status }`.
 *  - `GET /v2/users/me/recordings?from=YYYY-MM-DD&to=YYYY-MM-DD&page_size=30`
 *    → `{ meetings: [{ id, topic, start_time, duration, recording_files:
 *    [{ id, recording_start, file_type, file_size, download_url }] }],
 *    total_records }`.
 *  - Auth: header `Authorization: Bearer <OAuth / Server-to-Server token>`
 *    (scope `meeting:read`, `recording:read`).
 *
 * Token chỉ đi trong header Authorization, KHÔNG BAO GIỜ được log.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch
 * (mock-verified, chưa đối chiếu live).
 */
import {
  arrayField,
  callJsonObject,
  capLimit,
  isRecord,
  requireNonEmpty,
  strField,
  type ReadClientOptions,
} from './common';

export const ZOOM_API_BASE = 'https://api.zoom.us/v2';

export type ZoomApiOptions = ReadClientOptions;

export type ZoomMeetingType = 'scheduled' | 'live' | 'upcoming' | 'previous';

export interface ZoomMeeting {
  id: string;
  topic?: string;
  startTime?: string;
  duration?: number;
  joinUrl?: string;
  status?: string;
  agenda?: string;
}

export interface ZoomRecordingFile {
  id?: string;
  recordingStart?: string;
  fileType?: string;
  fileSize?: number;
}

export interface ZoomRecording {
  id: string;
  topic?: string;
  startTime?: string;
  duration?: number;
  recordingFiles: ZoomRecordingFile[];
}

function zoomHeaders(opts: ZoomApiOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };
}

function parseMeeting(raw: unknown): ZoomMeeting | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return {
    id: String(id),
    topic: strField(raw, 'topic'),
    startTime: strField(raw, 'start_time'),
    duration: typeof raw['duration'] === 'number' ? (raw['duration'] as number) : undefined,
    joinUrl: strField(raw, 'join_url'),
    status: strField(raw, 'status'),
    agenda: strField(raw, 'agenda'),
  };
}

/** Liệt kê meetings của user (`me`). */
export async function zoomListMeetings(
  opts: ZoomApiOptions,
  type: ZoomMeetingType = 'scheduled',
  pageSize = 30,
): Promise<ZoomMeeting[]> {
  const params = new URLSearchParams({
    type,
    page_size: String(capLimit(pageSize, 300)),
  });
  const rec = await callJsonObject(
    'Zoom',
    opts,
    `${ZOOM_API_BASE}/users/me/meetings?${params.toString()}`,
    'zoomListMeetings',
    { method: 'GET', headers: zoomHeaders(opts) },
  );
  return arrayField(rec, 'meetings')
    .map((m) => parseMeeting(m))
    .filter((m): m is ZoomMeeting => m !== null);
}

/** Đọc một meeting theo id. */
export async function zoomGetMeeting(
  opts: ZoomApiOptions,
  meetingId: string,
): Promise<ZoomMeeting> {
  requireNonEmpty(meetingId, 'Zoom meetingId');
  const rec = await callJsonObject(
    'Zoom',
    opts,
    `${ZOOM_API_BASE}/meetings/${encodeURIComponent(meetingId)}`,
    'zoomGetMeeting',
    { method: 'GET', headers: zoomHeaders(opts) },
  );
  const meeting = parseMeeting(rec);
  if (!meeting) throw new Error('Zoom API returned an unexpected meeting response (zoomGetMeeting).');
  return meeting;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Liệt kê recordings của user (`me`). Không truyền `from`/`to` thì mặc
 * định 30 ngày gần nhất (theo đúng mặc định của Zoom API).
 */
export async function zoomListRecordings(
  opts: ZoomApiOptions,
  from?: string,
  to?: string,
  pageSize = 30,
): Promise<ZoomRecording[]> {
  const toDate = to ?? formatDate(new Date());
  const fromDate = from ?? formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const params = new URLSearchParams({
    from: fromDate,
    to: toDate,
    page_size: String(capLimit(pageSize, 300)),
  });
  const rec = await callJsonObject(
    'Zoom',
    opts,
    `${ZOOM_API_BASE}/users/me/recordings?${params.toString()}`,
    'zoomListRecordings',
    { method: 'GET', headers: zoomHeaders(opts) },
  );
  return arrayField(rec, 'meetings')
    .filter((m): m is Record<string, unknown> => isRecord(m))
    .filter((m) => typeof m['id'] === 'string' || typeof m['id'] === 'number')
    .map((m) => ({
      id: String(m['id']),
      topic: strField(m, 'topic'),
      startTime: strField(m, 'start_time'),
      duration: typeof m['duration'] === 'number' ? (m['duration'] as number) : undefined,
      recordingFiles: arrayField(m, 'recording_files')
        .filter((f): f is Record<string, unknown> => isRecord(f))
        .map((f) => ({
          id: typeof f['id'] === 'string' ? (f['id'] as string) : undefined,
          recordingStart: strField(f, 'recording_start'),
          fileType: strField(f, 'file_type'),
          fileSize: typeof f['file_size'] === 'number' ? (f['file_size'] as number) : undefined,
        })),
    }));
}
