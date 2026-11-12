/**
 * Visual cron builder (UI-13, v0.62) — pure helpers, no React, no IPC.
 *
 * The Automations form used to take a raw 5-field cron expression
 * (`0 9 * * 1-5`) with only a placeholder hint. The builder composes
 * that same expression from three friendly controls — minute, hour,
 * days of week — plus presets, and describes the result in plain
 * language. The text input stays editable: anything the builder cannot
 * parse back (day-of-month, month, steps, lists it did not produce) is
 * shown as-is with a "Cron: …" summary instead of a wrong one.
 *
 * Weekdays use cron numbers: 0 = Sunday … 6 = Saturday. The builder
 * only ever produces `*` (every day), `1-5` (weekdays), a single day,
 * or a sorted comma list — `parseCronFields` accepts exactly those
 * shapes back (plus `*` for minute/hour, which the hourly preset
 * produces).
 */
export interface CronBuilderFields {
  /** '0'–'59' (the builder never produces '*' for minutes). */
  minute: string;
  /** '0'–'23' or '*' (hourly). */
  hour: string;
  /** Weekday numbers 0–6; [] = every day. */
  weekdays: number[];
}

export const CRON_PRESETS: Array<{ key: string; labelKey: string; fields: CronBuilderFields }> = [
  { key: 'daily', labelKey: 'automations.cronPresetDaily', fields: { minute: '0', hour: '9', weekdays: [] } },
  { key: 'weekdays', labelKey: 'automations.cronPresetWeekdays', fields: { minute: '0', hour: '9', weekdays: [1, 2, 3, 4, 5] } },
  { key: 'hourly', labelKey: 'automations.cronPresetHourly', fields: { minute: '0', hour: '*', weekdays: [] } },
  { key: 'weekly', labelKey: 'automations.cronPresetWeekly', fields: { minute: '0', hour: '9', weekdays: [1] } },
];

export const CRON_DEFAULT_FIELDS: CronBuilderFields = { minute: '0', hour: '9', weekdays: [1, 2, 3, 4, 5] };

function isMinute(value: string): boolean {
  // 1–2 digits, leading zero allowed ("09" is a normal cron minute).
  return /^\d{1,2}$/.test(value) && Number(value) >= 0 && Number(value) <= 59;
}

function isHour(value: string): boolean {
  // '*' (hourly) or 0–23, leading zero allowed ("09" is a normal cron hour).
  return value === '*' || (/^\d{1,2}$/.test(value) && Number(value) >= 0 && Number(value) <= 23);
}

function isWeekday(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}

function weekdaysField(weekdays: number[]): string {
  const days = [...new Set(weekdays)].filter(isWeekday).sort((a, b) => a - b);
  if (days.length === 0 || days.length === 7) return '*';
  if (days.length === 5 && days.join(',') === '1,2,3,4,5') return '1-5';
  return days.join(',');
}

/** Compose a 5-field cron expression from builder fields. */
export function buildCronExpression(fields: CronBuilderFields): string {
  const minute = isMinute(fields.minute) ? String(Number(fields.minute)) : '0';
  const hour = isHour(fields.hour) ? fields.hour : '9';
  return `${minute} ${hour} * * ${weekdaysField(fields.weekdays)}`;
}

/**
 * Parse a 5-field expression back into builder fields, or null when it
 * uses shapes the builder cannot represent (day-of-month/month other
 * than `*`, steps, ranges other than 1-5, `*` minutes, …).
 */
export function parseCronFields(expression: string): CronBuilderFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (dom !== '*' || month !== '*') return null;
  if (!isMinute(minute)) return null;
  if (!isHour(hour)) return null;
  let weekdays: number[];
  if (dow === '*') {
    weekdays = [];
  } else if (dow === '1-5') {
    weekdays = [1, 2, 3, 4, 5];
  } else if (/^0?[0-6](,0?[0-6])*$/.test(dow)) {
    weekdays = dow.split(',').map(Number);
    if (!weekdays.every(isWeekday) || new Set(weekdays).size !== weekdays.length) return null;
  } else {
    return null;
  }
  // Normalise leading zeros ("09" → "9") so the builder controls and
  // the summary always show the canonical form.
  return { minute: String(Number(minute)), hour: hour === '*' ? '*' : String(Number(hour)), weekdays };
}

/** 2026-11-08 is a Sunday — the reference date for weekday names. */
function weekdayName(day: number, locale: string, style: 'long' | 'short'): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 10, 8 + day)),
    );
  } catch {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] ?? String(day);
  }
}

export function weekdayLongName(day: number, locale: string): string {
  return weekdayName(day, locale, 'long');
}

export function weekdayShortName(day: number, locale: string): string {
  return weekdayName(day, locale, 'short');
}

type CronT = (key: string, vars?: Record<string, string>) => string;

/**
 * Plain-language summary of an expression: daily / weekdays / one
 * weekday / hourly when the shape matches, otherwise the raw
 * expression (never a wrong paraphrase).
 */
export function describeCron(expression: string, t: CronT, locale: string): string {
  const fields = parseCronFields(expression);
  if (!fields) return t('automations.cronSummaryCustom', { expression: expression.trim() });
  if (fields.hour === '*') {
    return t('automations.cronSummaryHourly', { minute: fields.minute });
  }
  const time = `${fields.hour.padStart(2, '0')}:${fields.minute.padStart(2, '0')}`;
  if (fields.weekdays.length === 0) {
    return t('automations.cronSummaryDaily', { time });
  }
  if (fields.weekdays.join(',') === '1,2,3,4,5') {
    return t('automations.cronSummaryWeekdays', { time });
  }
  if (fields.weekdays.length === 1) {
    return t('automations.cronSummaryWeekly', {
      day: weekdayLongName(fields.weekdays[0] as number, locale),
      time,
    });
  }
  return t('automations.cronSummaryCustom', { expression: expression.trim() });
}
