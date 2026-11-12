# OS notifications (v0.87c)

System notifications when a bot finishes a run, needs approval, or a
run fails — via Electron `Notification`, main process only.

## What it does

| Event | When it fires | Click opens |
|---|---|---|
| Run complete | A chat run (`chat:send`) finishes successfully | That bot's chat (`open-bot://bot/<id>`) |
| Approval needed | The coordinator raises `approval-needed` (a tool call waits) | That bot's chat |
| Run error | A chat run (`chat:send`) fails | That bot's chat |

Text follows the user's saved locale (vi/en/zh/ja/es/fr — templates in
`packages/core/src/notifications/text.ts`). The error text is the
already-redacted run error (`redactErrorText` in `chat:send`); no key
or secret ever reaches a notification.

Only chat runs notify. Background runs through the Local API, dream
runs, and automation runs do **not** send notifications — the chat
thread is the surface the user is looking at, and notifying for every
background run would be spam by design.

A run the user stopped (`chat:stop`) does **not** send a "run
complete" notification: stopped is not finished.

## Architecture

```
coordinator event / chat:send (main.ts)
  -> notifyBotEvent(kind, botId, { tool?, error?, dedupeKey? })
  -> NotificationService.notify(request)          # packages/core/src/notifications/service.ts (pure, no Electron)
  -> show adapter: new Electron.Notification()    # main.ts only
  -> click -> onActivate(route) -> deliverDeepLink(route)  # same path as the OS deep-link handler
```

The renderer **never** calls Electron `Notification` directly. It can
only ask main via IPC:

- `notifications:send` — validated by core (`validateNotificationRequest`);
  bad input returns `{ shown: false, reason: 'invalid' }`, never throws.
- `notifications:test` — the Settings "Send test" button; fires one
  sample run-complete notification for the app itself.

The core service is Electron-free on purpose: the anti-spam rules are
unit-tested in plain node with a fake `show` (see
`tests/notifications-v087c.test.mjs`).

## Anti-spam

Settings → General → Notifications, one toggle per kind. **Defaults:
all three ON.** Rationale: these are the events the user asked to be
told about; each kind can be switched off individually, and the rules
below stop bursts. The setting is stored in `settings.json`
(`notifications: { runComplete, approval, runError }`); a missing or
non-boolean value resolves to ON, never silently OFF.

- **Dedupe window: 10 s.** Same kind + bot + title (or the same
  explicit `dedupeKey`, e.g. one approval `callId`) inside 10 s shows
  once. Approval notifications dedupe by call id.
- **Rate limit: 5 per kind per rolling 60 s.** Further notifications
  of that kind are dropped and counted (`suppressed` in the outcome);
  other kinds are unaffected.
- **Unsupported platform:** when `Notification.isSupported()` is
  false the service returns `{ shown: false, reason: 'unsupported' }`
  instead of pretending a popup appeared.

`notify()` never throws — a notification is best-effort, and a failure
in this path must never take down a run. A throwing `show` adapter is
reported as `unsupported` with the detail in the outcome.

## Honest verification limits

**A real popup on screen has NOT been verified.** This VM is headless:
there is no notification daemon, no desktop environment, and
`Notification.isSupported()` returns false here. What *is* verified:

- The full logic chain (service + dedupe + rate limit + click route +
  per-kind toggles + validation) with a fake `show` — 10/10 in
  `tests/notifications-v087c.test.mjs`.
- The Settings UI (toggles, "Send test", the not-shown notice naming
  the reason, load failure) in a real Electron renderer under xvfb —
  `tests/notifications-v087c-renderer.test.mjs`.
- `npm run build` + `npm run typecheck` green in all 4 workspaces.

What still needs a real desktop to confirm: that `new
Notification(...).show()` actually pops up on macOS / Windows / a
Linux desktop with a daemon, that the click focuses the window and
opens the right bot, and that the OS-level notification permission
prompts (macOS especially) behave. The "Send test" button exists
exactly so a user on a real machine can check this in one click.

## Files

- `packages/core/src/notifications/service.ts` — service, settings,
  validation, dedupe/rate-limit constants
- `packages/core/src/notifications/text.ts` — localised title/body
  templates (6 locales)
- `apps/desktop/src/main/main.ts` — Electron adapter, settings
  storage, IPC `notifications:send` / `notifications:test`, hooks in
  `routeCoordinatorEvent` (approval) and `chat:send` (run done/error)
- `apps/desktop/src/main/preload.ts` + `apps/desktop/src/renderer/global.d.ts`
  — `sendNotification` / `testNotification`
- `apps/desktop/src/renderer/components/NotificationsSection.tsx` —
  Settings → General section (+ `settingsTabs.ts` entry)
- `apps/desktop/src/renderer/i18n/locales/*.json` —
  `settings.notifications.*` (12 keys × 6 locales; 1322 → 1334 keys on the rebased tree — siblings added 12 of their own in between)
