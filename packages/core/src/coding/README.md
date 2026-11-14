# Coding agent (v1.02, Team T4)

OpenHands-style coding agent: an event-stream loop that writes code
in a confined workspace.

## Loop

```
plan -> reason -> action -> sandboxed execute -> observe -> repeat
```

Every step is recorded as an immutable event in a `CodingEventStore`
(append-only, SHA-256 hash-chained, JSONL-persistable, replayable).
The loop stops on `finish`, on a check failure with no fix attempts
left, or when any budget (steps / tokens / cost / time) runs out.

## Files

| File | What it does |
| --- | --- |
| `events.ts` | Event types + payloads, text caps for logs |
| `store.ts` | Append-only store: hash chain, verify, JSONL, replay |
| `workspace.ts` | Confined file ops (create/edit/write/delete/list); paths can never escape the root |
| `sandboxExec.ts` | argv-only command exec: no shell, scrubbed env, timeout, blocklist, outside-path args rejected |
| `actions.ts` | The six actions + validation + executor |
| `planner.ts` | Deterministic task -> plan (Explore / Implement / Verify / Finish) |
| `budget.ts` | Step/token/cost/time budgets + cost via the shared price table |
| `reasoner.ts` | `Reasoner` interface; `ScriptedReasoner` (tests/eval), `RuleReasoner` (model-free), `ProviderReasoner` (any open-bot Provider is the brain) |
| `agent.ts` | `CodingAgent` loop: plan, reason, act, observe, verify, fix, finish |
| `trace.ts` | Per-run trace + aggregate stats across runs |
| `eval.ts` | Eval harness: sample tasks, pass/fail checks, Markdown report |

## Use

```ts
import { CodingAgent, RuleReasoner } from '@open-bot/core';

const agent = new CodingAgent({
  workspaceRoot: '/tmp/my-task',
  reasoner: new RuleReasoner({
    files: [{ path: 'hello.txt', content: 'hello\n' }],
    verifyArgv: ['node', '-e', 'process.exit(0)'],
  }),
  checks: [{ name: 'smoke', argv: ['node', '-e', 'process.exit(0)'] }],
  persistDir: '/tmp/my-task-logs',
});
const result = await agent.run('Create hello.txt');
// result.status, result.events, result.trace, result.store.replay()
```

Eval:

```ts
import { runEval, sampleEvalTasks, renderEvalReportMarkdown } from '@open-bot/core';
const report = await runEval(sampleEvalTasks());
console.log(renderEvalReportMarkdown(report));
```

## Rules

- No shell: commands are argv arrays, cwd is locked to the workspace.
- No secrets in events: file contents capped, command output capped.
- Local-first: no cloud VM, no accounts, no payments. Any model can
  be the brain through `ProviderReasoner`; the loop also runs
  model-free with `RuleReasoner`.
