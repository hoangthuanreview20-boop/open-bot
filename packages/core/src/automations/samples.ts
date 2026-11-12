/**
 * Sample automations (v0.72c, Team C).
 *
 * Pure seed data, mirroring `SAMPLE_ROUTINES` in `../agent/routines.ts`:
 * the UI can offer these as one-click starting points and the user
 * assigns a bot (botId is '' where a run-agent action needs one) when
 * seeding them. Every sample passes `validateAutomation()` in
 * `engine.ts` — no webhook trigger is used here, because a webhook
 * trigger needs a Vault HMAC key that sample data must never carry.
 *
 * All prompts and messages are in English, for consistency with the
 * sample routines (the one notify message is English too).
 */

import type { Automation } from './types';

/** Fixed placeholder timestamps for the samples (seed data, not real runs). */
const SAMPLE_TIMESTAMP = '2026-11-10T00:00:00.000Z';

/**
 * Four sample automations a new user can seed. `botId` is intentionally
 * empty on the run-agent actions: the caller assigns the bot when
 * seeding (an empty botId means "the default bot" per `Automation`).
 */
export const SAMPLE_AUTOMATIONS: Automation[] = [
  {
    id: 'morning-brief-auto',
    botId: '',
    name: 'Morning brief (auto)',
    trigger: { kind: 'interval', minutes: 480 },
    action: {
      kind: 'run-agent',
      botId: '',
      prompt:
        'Summarise the morning news: check the usual news sources and give a short briefing of the most important headlines, one line each.',
    },
    enabled: true,
    createdAt: SAMPLE_TIMESTAMP,
    updatedAt: SAMPLE_TIMESTAMP,
  },
  {
    id: 'weekly-report-auto',
    botId: '',
    name: 'Weekly report (auto)',
    trigger: { kind: 'cron', expression: '0 9 * * 1' },
    action: {
      kind: 'run-agent',
      botId: '',
      prompt:
        'Summarise this week’s work from the task files: what was finished, what is still open, and what is planned next.',
    },
    enabled: true,
    createdAt: SAMPLE_TIMESTAMP,
    updatedAt: SAMPLE_TIMESTAMP,
  },
  {
    id: 'notes-changed-index',
    botId: '',
    name: 'Notes changed — update index',
    trigger: { kind: 'event', event: 'file-changed', pathPattern: 'notes/*.md' },
    action: {
      kind: 'run-agent',
      botId: '',
      prompt:
        'A note changed. Update the notes index so it lists every note in notes/ with a one-line summary each.',
    },
    enabled: true,
    createdAt: SAMPLE_TIMESTAMP,
    updatedAt: SAMPLE_TIMESTAMP,
  },
  {
    id: 'agent-done-notify',
    botId: '',
    name: 'Agent finished — notify',
    trigger: { kind: 'event', event: 'agent-done' },
    action: {
      kind: 'notify',
      message: 'A bot finished a job — see the result in chat.',
    },
    enabled: true,
    createdAt: SAMPLE_TIMESTAMP,
    updatedAt: SAMPLE_TIMESTAMP,
  },
];

/**
 * Return a fresh deep copy of the sample automations. Automations nest
 * trigger/action objects, so a JSON round-trip is used — mutating the
 * returned array (including nested fields) never touches
 * `SAMPLE_AUTOMATIONS`. All sample fields are JSON-serializable.
 */
export function sampleAutomations(): Automation[] {
  return JSON.parse(JSON.stringify(SAMPLE_AUTOMATIONS)) as Automation[];
}
