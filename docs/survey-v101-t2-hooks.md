# Survey — v1.01 T2: Agent lifecycle hooks (shell-command hooks, subagent/compact/prompt events, test-gate)

## 1. What already exists (base a37b4d6, v0.98)

The repo already has a solid in-process hook system (`packages/core/src/hooks/`):

- **Events (5):** `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`
  (`types.ts`). Decisions are `allow | block | modify` with `reason`,
  `args` (PreToolUse rewrite), `output` (PostToolUse rewrite), `context`
  (SessionStart injection + PreToolUse `hook_additional_contexts`, v0.41).
- **Registry** (`registry.ts`): function hooks by name, enable/disable
  persisted in `<stateDir>/hooks-enabled.json`, `applySettings()` for the
  `hooks` settings section (unknown names reported, never thrown),
  `registerScriptHook()` for node-script hooks.
- **Runner** (`runner.ts`): registration order, first `block` wins,
  `modify` chains, per-hook timeout (default 5s, coordinator raises it
  to 10s), fail-closed on hook error (`onHookError: 'block'` default),
  never throws — every `run*` resolves an outcome object.
- **Script runner** (`scriptRunner.ts`, v0.18): runs `node <script>`
  out-of-process in its own process group, one JSON line on stdin
  (`{ event, ...input }`), decision = last non-empty stdout line as JSON.
  Non-zero exit = error. Safe env allowlist (no secrets). Path must be
  inside allowed dirs (realpath-checked).
- **Wiring:** `AgentRunner` (`agent/loop.ts`) already takes `opts.hooks`
  and runs SessionStart / PreToolUse / PostToolUse / SessionEnd / Stop
  at the right points. `Coordinator.getHookRegistry()` owns the shared
  registry (denylist hook from `@open-bot/tools`, glob-rules hook,
  bundle script hooks) and `getHookRunner()` builds the runner.
  `runSubagent()` in `loop.ts` spawns a child `AgentRunner` (same
  provider/tools, fork depth +1, optional role/shadow workspace) and
  returns `[subagent <id>] done|timeout|lỗi: …`.
- **Compaction** (`agent/compaction.ts`): pure `checkAndCompact()` called
  from `runLoopWithHarness` after each step when `compaction.contextLimit`
  is set. No hook points.
- **Settings UI:** `SettingsView` lists built-in hooks via IPC
  `hooks:list` / `hooks:toggle` (main keeps its own registry copy purely
  for listing). Only enable/disable — no creation, no commands, no log.
- **Tests:** `node --test` (`.mjs` in `tests/`, importing `dist/`),
  e.g. `tests/hooks.test.mjs`, `tests/hook-script-v018.test.mjs`,
  `tests/loop-wiring.test.mjs` (real `AgentRunner` + scripted mock
  provider). i18n: 6 locales under
  `apps/desktop/src/renderer/i18n/locales/` (`en/vi/es/fr/ja/zh`).

## 2. Ideas learned (general lifecycle-hook concept, re-implemented here)

The lifecycle-hook idea, as understood from the general concept (not
copied from any repo — no code, text, or asset of another project is
reproduced here):

- A hook is deterministic automation at a fixed lifecycle point, outside
  the model's decision loop. The model can forget a prompt instruction;
  a hook always runs.
- More lifecycle points are useful than the current five: when a
  subagent starts/stops, when context is compacted, and when the user
  submits a prompt. Each point needs its own payload and its own
  block/modify semantics (a block means something different per point).
- Hooks should be definable as **shell commands** in settings, not only
  as code: the user writes a command, the host spawns it, sends the
  event as JSON on stdin, and reads the decision. Convention: exit
  code **2 = block** (the action is refused, with a reason), exit 0 =
  allow (optionally with a JSON decision on stdout), any other non-zero
  exit = hook error (fail-closed, like a throwing function hook).
- **SubagentStop as a quality gate:** when a subagent finishes, a hook
  can run the test suite (or a linter/typecheck) and, on failure, block
  the stop and return extra context (`additionalContext`) telling the
  subagent — via the lead agent — what failed, so it goes back and
  fixes it instead of the run accepting broken work.
- Hooks need **operability**: a per-event configuration (which events,
  timeout), an execution log (what ran, what it decided, how long it
  took, what failed), and a Settings UI to manage them — otherwise they
  are invisible automation that nobody can debug.

## 3. Gaps this wave closes

1. **Missing events:** `SubagentStart`, `SubagentStop`, `PreCompact`,
   `PostCompact`, `UserPromptSubmit` do not exist.
2. **No shell-command hooks:** settings can only declare function hooks
   that already exist in code; a user cannot add a hook without writing
   TypeScript. `scriptRunner` only runs `node <script>` files, treats
   every non-zero exit as an error, and has no exit-2-block semantics.
3. **No test gate:** nothing runs tests on subagent stop or feeds the
   failure back.
4. **No execution log:** hook runs are only visible via an optional
   logger callback; there is no queryable record.
5. **No command-hook management UI:** Settings only toggles built-ins.
6. **Loop gaps:** `runSubagent` fires no lifecycle events; compaction
   fires none; `run()` fires no event for the submitted prompt.
   The child runner does not inherit the parent's `hooks`, so tool
   hooks do not apply inside subagents.

## 4. Design (this wave)

### 4.1 New events + decision field (`hooks/types.ts`)

- `HookEventKind` grows to 10:
  `PreToolUse, PostToolUse, SessionStart, SessionEnd, Stop,`
  `SubagentStart, SubagentStop, PreCompact, PostCompact, UserPromptSubmit`.
- New payloads:
  - `SubagentStartEvent { subagentId, name?, task, instructions? }` —
    block cancels the spawn (no child is created).
  - `SubagentStopEvent { subagentId, name?, status, output, durationMs, reason? }` —
    `status` is `done | timeout | error`; block rejects the stop.
  - `PreCompactEvent { messageCount, tokensBefore, contextLimit }` —
    block skips this compaction round.
  - `PostCompactEvent { summarizedCount, tokensBefore, tokensAfter, summaryText?, fallbackUsed }` —
    block reverts to the pre-compaction messages; `modify` + `context`
    appends a hook note the model sees.
  - `UserPromptSubmitEvent { prompt, sessionId? }` — block refuses the
    turn with a message; `modify` + `context` prepends context lines.
- `HookDecision` gains `additionalContext?: string` — the SubagentStop
  gate channel: when a hook blocks a subagent stop, this text is handed
  back (to the subagent on retry, and to the lead agent in the summary)
  explaining what must be fixed. `context` keeps its existing meaning
  (injection into the current call/session).

### 4.2 Shell-command hooks (`hooks/shellCommandRunner.ts`, new)

- `runHookCommand(command, event, input, opts)`:
  spawns the command through the platform shell (`/bin/sh -c` on POSIX,
  `cmd.exe /c` on Windows) in its own process group, sends one JSON line
  `{ event, ...input }` on stdin, captures stdout (tail-capped) and
  stderr (tail-capped), kills the group on timeout.
- Exit-code protocol:
  - `0` → decision = last non-empty stdout line parsed as JSON
    (same shapes as the script protocol: `{ action }`, `{ decision }`,
    nested `{ decision: { action } }`); no/blank output = `allow`.
  - `2` → `block`; reason = last stdout line (plain text allowed), else
    stderr tail, else a default message.
  - any other non-zero / signal / timeout / spawn failure → rejected
    Error (runner treats it as a hook error, fail-closed).
- Env: safe allowlist (same rule as `scriptRunner`: minimal vars, any
  secret-looking name dropped) + `OPENBOT_HOOK_EVENT=<event>` +
  per-hook `env` entries from settings (validated: secret-looking names
  rejected at validation time). Secrets of the parent process are never
  inherited.
- Validation (`validateHookCommandConfig`): name matches `HOOK_NAME_RE`,
  command non-empty, events non-empty subset of `ALL_HOOK_EVENTS`,
  `timeoutMs` within 100..300_000, env keys/values are strings without
  secret-looking names.

### 4.3 Settings schema + registry (`hooks/types.ts`, `hooks/registry.ts`)

- `HookCommandSettingsEntry { name, command, events, timeoutMs?, enabled?, env? }`;
  `HookSettings` gains `commands?: HookCommandSettingsEntry[]`.
- `HookSource` gains `'command'`.
- `HookRegistry.registerCommandHook(def, opts)` wraps `runHookCommand`
  in a `HookFn` (cwd = `ctx.workspaceDir ?? def.workspaceDir`), stores
  the config for listing, validates eagerly (bad command config throws
  `HookRegistrationError` at registration time).
- `HookRegistry.applyCommandSettings(settings, opts)` syncs settings to
  the registry: register new, re-register changed, unregister removed,
  report `{ applied, removed, unknown, invalid[] }`. Never throws for a
  bad entry — a bad settings line must not break the agent.
- `HookRegistry.listCommandHooks()` returns the stored command configs
  (for Settings UI + coordinator reload).

### 4.4 Runner (`hooks/runner.ts`)

- New methods, same contract as the existing ones (never throw, first
  block wins, modify chains, fail-closed on hook error where a block
  is meaningful):
  - `runSubagentStart(input, ctx): SubagentStartOutcome`
    (`decision, reason?, blockedBy?, hookErrors, hooksRun`).
  - `runSubagentStop(input, ctx): SubagentStopOutcome`
    (`decision, additionalContext?, reason?, blockedBy?, …`) — collects
    `additionalContext` from every blocking/modifying hook, in order.
  - `runPreCompact / runPostCompact`: `CompactHookOutcome`
    (`decision, context[], reason?, blockedBy?, …`).
  - `runUserPromptSubmit`: `UserPromptSubmitOutcome`
    (`decision, context[], reason?, blockedBy?, …`).
- Optional `HookRunnerOptions.executionLog?: HookExecutionLog` — every
  hook invocation is recorded (see 4.6) from the single `invokeOne`
  choke point, so all current and new `run*` methods are covered.

### 4.5 Test gate (`hooks/testGate.ts`, new)

- `runTestGate({ command, cwd, timeoutMs, maxOutputChars })` runs a
  test command through the shell, captures output, returns
  `{ passed, exitCode, durationMs, output, failedSummary }`.
  `passed` = exit 0. `failedSummary` = last lines of output trimmed
  for the model (failures first when recognisable).
- `createTestGateHook({ name?, command?, timeoutMs?, … })` returns a
  `HookDefinition` for `SubagentStop`: pass → `allow`; fail/timeout →
  `block` with `additionalContext` built by
  `buildTestGateAdditionalContext(result, subagentName)` — the failing
  output plus an instruction to fix and re-run. A `block` without a
  test command configured is never produced (fail-open for a missing
  config would hide broken work; instead the hook reports the
  misconfiguration in its reason and allows — the gate must be
  explicitly configured to gate).
- Pure helpers are unit-tested without spawning; the spawn path is
  tested with tiny shell commands (`true`/`false`/`echo`), never the
  real suite.

### 4.6 Execution log (`hooks/hookLog.ts`, new)

- `HookExecutionLog` — in-memory ring buffer (default 500 records,
  configurable), `record(entry)`, `list({ event?, hookName?, decision?, limit? })`,
  `clear()`, `toJSONL()`, optional best-effort JSONL file append
  (`filePath` option; failures are swallowed, never crash a run).
- `HookExecutionRecord { seq, at, hookName, event, action, durationMs, reason?, error?, timedOut }`.

### 4.7 Loop integration (`agent/loop.ts`)

- `run()`: after SessionStart, before the guardrail/fork work, fire
  `runUserPromptSubmit({ prompt: userText })`. Block → return the
  reason as the turn result (no provider call, no fork). `modify` +
  `context` lines are prepended to the user message as a hook-context
  block.
- `runSubagent()`: fire `runSubagentStart({ subagentId, task, … })`
  before spawning; block → return `[subagent <id>] blocked by hook …`
  without creating a child. After the child settles, fire
  `runSubagentStop({ status, output, durationMs })`; on block, run the
  child **once more** with `additionalContext` appended to its task
  (bounded retry: 1), then fire SubagentStop again for the retry and
  accept that result — but if it blocks again, the additionalContext is
  appended to the returned summary so the lead agent still sees it.
  The child inherits the parent's `hooks` so tool hooks apply inside
  subagents too.
- Compaction point in `runLoopWithHarness`: before
  `checkAndCompact`, fire `runPreCompact`; block → skip this round.
  After a successful compaction, fire `runPostCompact`; block → revert
  to the pre-compaction messages; `modify` + `context` lines are added
  as a hook-note user message after the summary.
- All hook calls are wrapped in the runner's never-throw contract plus
  the loop's existing defensive `try/catch` style; a hook failure never
  crashes a run (fail-closed only where the runner already does that:
  PreToolUse/SubagentStart/PreCompact/UserPromptSubmit blocks).

### 4.8 Coordinator + main + Settings UI

- `Coordinator.getHookRegistry()`: after the built-ins, load command
  hooks from `<hooksStateDir>/hooks-commands.json` (same dir as
  `hooks-enabled.json`) via `applyCommandSettings`, and attach a
  `HookExecutionLog` (file `<stateDir>/hook-executions.jsonl`) to the
  runner in `getHookRunner()`. Also register the test-gate hook when
  `settings.commands` contains a `test-gate` entry? No — the test gate
  is a command hook like any other: a user enables it by adding a
  command hook on `SubagentStop` whose command runs the tests; the
  `testGate` module is the reusable helper a host (or a built-in
  preset) uses. The coordinator registers one built-in preset hook
  `subagent-test-gate` (disabled unless a test command is configured
  in settings) — see `hooks/testGate.ts` `createTestGateHook`.
- Main (`apps/desktop/src/main/main.ts`): new IPC
  `hooks:commands-list` / `hooks:commands-save` /
  `hooks:commands-delete` / `hooks:log-list`, backed by
  `hooks-commands.json` in `userData` (validated in core, never trust
  renderer input) and by reading the coordinator's log file. Main's
  listing registry also registers command hooks (stub handler) so
  `hooks:list` shows them with source `'command'`.
- Renderer (`SettingsView` hooks section): command-hook manager —
  list (name, command, events, timeout, enabled), add/edit form,
  delete with confirm, per-hook enable toggle, and a "recent hook
  runs" log view (from `hooks:log-list`). Reuses existing
  `callOpenBot` + `ConfirmModal` patterns.
- i18n: new `settings.hooksCommand*` / `settings.hooksLog*` keys in
  all 6 locales.

### 4.9 Tests (node:test, `.mjs`, against `dist/`)

- `tests/hooks-lifecycle-v101.test.mjs` — new events in the runner:
  block/modify chaining, SubagentStop additionalContext collection,
  PreCompact/PostCompact/UserPromptSubmit outcomes, fail-closed
  behaviour, unknown-event validation.
- `tests/hooks-command-v101.test.mjs` — shell command hooks: exit 0/2/
  other, JSON decision parsing, stdin payload, timeout kill, env
  safety (secret-looking vars never reach the child), config
  validation, `applyCommandSettings` sync (add/update/remove/invalid).
- `tests/hooks-testgate-v101.test.mjs` — gate pass/fail/timeout,
  additionalContext content, missing-command behaviour.
- `tests/hooks-log-v101.test.mjs` — ring buffer cap, filters, JSONL,
  file append (best-effort).
- `tests/hooks-loop-v101.test.mjs` — `AgentRunner` + mock provider:
  UserPromptSubmit block skips the provider; SubagentStart block
  prevents spawn; SubagentStop block triggers one retry with the gate
  context; PreCompact block skips compaction; PostCompact block
  reverts messages.
- `tests/hooks-settings-ui-v101.test.mjs` — IPC handler logic is in
  main (Electron, not unit-testable here); instead test the core
  settings validation + registry sync the IPC relies on (covered by
  the command test file) and the i18n key parity across the 6 locales.

## 5. Non-goals / limits

- No new hook *language* — shell commands only (node scripts already
  exist via `registerScriptHook`).
- No remote hook execution, no hook marketplace, no per-bot command
  hooks (settings are global; per-bot scoping is a later wave).
- SubagentStop retry is bounded to **one** retry — a gate that keeps
  failing must surface to the lead agent, not loop forever.
- Command hooks run with the bot's workspace as cwd and a minimal env;
  they cannot see the parent's secrets by design.
- The Settings UI manages command hooks; built-in function hooks stay
  toggle-only (as before).
