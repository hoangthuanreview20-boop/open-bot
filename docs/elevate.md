# Elevate — run one command with higher privileges — v0.86, P2-10

`sudo` stays on the shell denylist: `shell_exec`, `exec_task` and
shell sessions can **never** run it, with or without approval. The
only elevated path is the `shell_elevate` tool.

## Rules (fail-closed)

1. **Approval every time.** `shell_elevate` has `needsApproval: true`
   and the agent loop shows an approval card (command + `reason`)
   before it runs. There is no permanent grant and no "allow always":
   - auto-approve rules can never match it — rejected at creation
     (`validateAutoApproveRuleInput`), rejected at match time
     (`matchAutoApproveRule`), and rejected again in the loop
     (`tryAutoApprove`);
   - the loop asks even when the bot has `autoApprove` on
     (`executeCallInner`: `elevateAlwaysAsk`).
2. **A reason is required.** `reason` (≥ 8 chars) must explain WHY
   the command needs higher privileges; it is shown on the approval
   card. Empty / one-word reasons are refused before any card.
3. **The denylist still applies.** The INNER command is checked
   against the same denylist as every shell command: `rm -rf /`,
   `curl | sh`, nested `sudo` / `su` / `passwd` are all blocked,
   even after approval. (The check runs on the inner command, not on
   the wrapped `sudo -n …` argv — the wrapper itself contains the
   word `sudo`, which the denylist rightly blocks everywhere else.)
4. **Non-interactive sudo.** Runs as `sudo -n /bin/sh -c <command>`
   (argv array, no shell interpolation). When sudo needs a password
   it fails at once with `ELEVATE_PASSWORD_REQUIRED` — it never hangs
   on a prompt, never retries, and open-bot never asks for or stores
   a password. Configure `NOPASSWD` in sudoers for the command, or
   run it by hand outside open-bot.
5. **Timeout.** Default 60s, max 10 minutes; on timeout the whole
   process group is killed (`ELEVATE_TIMEOUT`).
6. **Windows: unsupported.** No `sudo -n` there, and open-bot does
   not use `runas` (interactive password prompt) — the tool fails
   closed with `ELEVATE_UNSUPPORTED`.
7. **No `pkexec`.** It can pop a graphical auth prompt and hang a
   headless run. When `sudo` is missing the tool fails with a clear
   error instead of guessing another escalator.

## Wiring

- Pure helpers: `packages/core/src/elevate/elevate.ts`
  (`buildElevatedArgv`, `validateElevateRequest`,
  `isPasswordRequiredError`, `formatElevatedResult`, constants),
  re-exported from `@open-bot/core`.
- Tool: `shell_elevate` in `packages/tools/src/shellTools.ts`
  (`createShellTools` option `elevateRunner` injects a fake runner
  for tests; production uses `defaultElevateRunner`, which spawns the
  real argv with a safe env allowlist and capped output). The tool
  does NOT go through `runShell` (that would block the word `sudo`
  in the argv) — it spawns the built argv directly.
- The tool is in the `shell` group (`shell_` prefix) and is not a
  read-only tool, so plan/review mode blocks it like any write tool.

## Known limitation (honest)

The approval gate lives in the agent loop (`needsApproval` + the
guards above). A direct programmatic call to the tool object —
outside a runner, e.g. from a script or a test — bypasses the human
card, exactly like `exec_task` today. Mitigation: `shell_elevate`
is only exposed through the runner in production; never call the
tool object directly outside the loop. A single-use approval token
minted by the loop would close this gap and is a possible later
wave.

## Tests

`tests/elevate-v086.test.mjs` (11 tests): argv shape, validation
(reason + denylist + nested sudo + Windows), password-required
detection + clean error, auto-approve exclusion (match + validate),
tool behaviour with an injected fake runner (runs / denied without
reason / denied for denylisted commands / password failure / exit
code / timeout cap), and `defaultElevateRunner` against a FAKE
`sudo` script on PATH (argv + cwd + timeout kill). **No real sudo
is ever executed in tests, and no privileged command is ever run on
the dev machine to "test" elevate.**
