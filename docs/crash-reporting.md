# Crash reporting (opt-in, local only) — v0.86, P2-7

Crash reporting records uncaught errors so the user can review what
went wrong. It is **opt-in and local-only**:

- **Default OFF.** Nothing is recorded until the user turns it on in
  Settings → Security → "Báo cáo lỗi (crash)". Toggling applies
  immediately (the collector reads the flag on every crash, no
  restart needed); turning it off stops recording at once.
- **No PII.** Before anything is stored, the message + stack go
  through `redactCrashText` (`packages/core/src/crash/redact.ts`):
  home directory (POSIX and `C:\Users\<name>` spellings) → `<home>`,
  bare user name → `<user>`, `Bearer` tokens, `sk-…` / `xai-…` keys,
  `api_key` / `token` / `password` assignments, and long token-shaped
  runs → `<redacted>`. Message is capped at 2.000 chars, stack at
  8.000 chars.
- **What is recorded:** error message + stack (redacted), source
  (`main` | `renderer`), kind (`uncaughtException` |
  `unhandledRejection` | `renderer-error`), platform, app version,
  Node version (main only), timestamp. **Never recorded:** user name,
  home paths, chat content, file contents, env vars, keys/tokens.
- **No sending.** Reports are stored as one JSON file each under
  `<userData>/crash-reports/` (mode 0600), at most 50 reports / 5 MB
  total — oldest deleted first (rotation). There is **no send
  endpoint** in this wave and no "send" button in the UI; `sent` is
  always `false`. Sending (only when the user presses "send"
  explicitly) is a later wave.
- **UI:** Settings → Security → crash reports section: toggle, list
  (time, source, kind, redacted message), open for detail, delete
  one / delete all (two-step confirm).

## How it is wired

- `packages/core/src/crash/` — `redact.ts`, `report.ts`
  (`buildCrashReport`), `store.ts` (`CrashReportStore`),
  `collector.ts` (`CrashCollector`, `createRendererErrorHandler`),
  all re-exported from `@open-bot/core`.
- Main process (`apps/desktop/src/main/main.ts`): `initCrashReporting()`
  in `bootstrap()` installs the collector's `uncaughtException` /
  `unhandledRejection` handlers; IPC `crash-reports:list/get/delete/
  delete-all` + `crash-report:renderer`; setting
  `crashReportingEnabled` in `settings:get` / `settings:set`.
- Renderer (`apps/desktop/src/renderer/main.tsx`): `window` `error` +
  `unhandledrejection` listeners forward message + stack to main via
  `reportRendererError` (main still applies the opt-in gate +
  redaction). The renderer never imports core's Node runtime.
- UI (`apps/desktop/src/renderer/components/CrashReportsSection.tsx`,
  rendered by `SettingsSecurityTab` as section `crashReports`).

## Deliberate behaviour changes (opt-in contract)

Installing the `uncaughtException` handler means Node's default
"exit the process" behaviour no longer applies in the main process:
the report is recorded and the app keeps running. That is the
contract the user opts into when turning the toggle on. The renderer
hook never changes process behaviour — it only forwards the error.

## Tests

`tests/crash-reporting-v086.test.mjs` (21 tests: redaction incl.
fake home dir / fake keys, report shape + caps, store round-trip /
mode 0600 / corrupt files / count + byte rotation, collector gate
incl. mid-run toggle-off, never-throws) and
`tests/crash-reports-v086-renderer.test.mjs` (Electron harness:
toggle on/off, list, open, delete one, delete all, empty state).
No real sudo, no network, no real user data in tests.
