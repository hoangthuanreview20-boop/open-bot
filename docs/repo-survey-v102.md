# Repo survey — v1.02 rescue (2026-11-14)

Cycle research synthesis + the audit/port report for the v0.99/v1.00
rescue wave. Main went v0.98 → v1.01 directly, so branches
`merge/v099` and `merge/v100` were never merged; this wave audited
them against main (`6d10758`, v1.01, 254,047 TS lines) and ported
only what was genuinely missing. All ideas below are learned from
the cited sources — no code, text, or assets copied from any outside
repo, xAI, or Cursor.

## 1. Memory 2026 — three architectures, one lesson

The 2026 consensus is that memory is its own architectural layer,
not a prompt trick. Three serious designs compete, and they are not
competitors on the same axis:

| System | Core abstraction | Best at |
| --- | --- | --- |
| Mem0 v3 | Extracted facts in a vector store | Drop-in user memory, personalization |
| Letta (MemGPT) | Editable memory blocks + archival tiers | Stateful long-running agents |
| Zep (Graphiti) | Temporal knowledge graph | Facts that change over time, audit |

### Mem0 v3 (April 2026)

- **Single-pass ADD-only extraction**: one LLM call per add; no
  UPDATE/DELETE. Old facts are kept, newer dated facts outrank them
  through time-aware retrieval. Simpler, cheaper, fewer failure modes
  than the old extract→update→delete loop.
- **Fused retrieval**: semantic search + BM25 + entity linking,
  fused into one ranking. Default `top_k` dropped from 100 to 20,
  threshold 0.1.
- **Multi-scope memory**: user / agent / app / run scopes instead of
  one flat store.
- **Graph memory removed from the open-source SDK in v3** — it is
  Platform-only now. The headline benchmarks (LoCoMo 92.5 vs 71.4,
  LongMemEval 94.4 vs 67.8, BEAM 1M 64.1) are managed-platform
  figures, not SDK figures.
- **Caveats that matter for a local-first build**: telemetry is on by
  default (PostHog, 10% sampling) until `MEM0_TELEMETRY=false`;
  BM25/entity extraction is English-only; a cross-tenant
  session-scoping leak was disclosed 2026-10-20. SDK is Apache-2.0,
  ~67k stars.
- **Mem0 is weak at temporal reasoning** — flat extracted facts have
  no validity window, so "what was true, and when?" needs a graph.
  Zep scores 63.8% vs Mem0's 49.0% on LongMemEval (GPT-4o) on
  temporal tasks, a gap Zep attributes to temporal graph retrieval
  vs flat vector retrieval. Lesson for open-bot: keep the fact store
  AND the temporal graph; they answer different questions.

Sources: mem0ai/mem0 GitHub README; ithab.directory; reviewramble.com;
developersdigest.tech; appstackbuilder.com.

### Letta / MemGPT — memory blocks + sleep-time compute

- MemGPT (UC Berkeley, arXiv 2310.08560, Oct 2023) treats the context
  window as RAM and external storage as disk: the agent pages
  information in and out with tool calls. Letta is the framework the
  same researchers ship (v0.16.7, March 2026).
- **Memory blocks**: small, labeled, editable sections pinned in
  every prompt — `human` (facts about the user), `persona` (agent
  behavior), plus user-defined blocks (`Task`, `Project`, `Safety`).
  The agent edits its own core memory by calling ordinary tools.
- **Three tiers**: core (in-context blocks) / recall (searchable full
  history on disk) / archival (explicitly filed knowledge, usually
  vector- or graph-backed).
- **Sleep-time compute** (added 2025): a second, background agent
  runs during idle time between turns to reorganize memory —
  consolidate blocks, invalidate contradicted archival records,
  learn from recent interactions — so the live agent starts its next
  turn from cleaner context instead of raw history. Letta reports
  ~5x less test-time compute for equal accuracy on math-reasoning
  benchmarks (Stateful GSM-Symbolic, Stateful AIME), or up to +13%
  (GSM) / +18% (AIME) accuracy at a fixed budget — vendor-reported
  numbers on their own benchmarks, not independently replicated.
- On the original Deep Memory Retrieval evaluation, MemGPT lifted
  GPT-4's long-conversation fact recall from 32.1% (fixed context)
  to 92.5%.

Sources: seekvana.com/library/agentic-ai/memory-research-memgpt-letta-sleep-time;
chatforest.com/reviews/letta-memgpt-stateful-agent-framework/;
reactify-solutions.com/articles/ai-agent-memory-systems-2026;
aiengineeringfromscratch.docpage.cn/en/14-agent-engineering/memory-blocks-sleep-time-compute/;
frenchydigital.com/blog/ai-agent-memory-architecture-2026.

### Zep / Graphiti — temporal knowledge graph

- Graphiti (open source, Apache-2.0, ~24k stars) ingests
  **episodes** (a turn, a JSON record, a document). Each episode is
  kept verbatim as provenance; an LLM extracts entities (nodes) and
  facts (edges).
- **Bi-temporal modelling**: every edge carries four timestamps —
  `valid_at` / `invalid_at` (world time: when the fact was true)
  and `created_at` / `expired_at` (system time: when the system
  learned / superseded it). A contradicting fact does not delete the
  old edge; it writes `invalid_at`. The graph never serves a stale
  fact as current, yet can answer what was believed at any point in
  the past — exactly what audit trails and compliance want.
- Zep reports Graphiti beating MemGPT 94.8% vs 93.4% on Deep Memory
  Retrieval (first-party paper). Retrieval under 200ms; Zep Cloud
  from $125/mo; Zep Community Edition is deprecated — self-hosting
  now means raw Graphiti on Neo4j / FalkorDB / Kuzu.
- **What open-bot took from this**: facts need validity windows, not
  just timestamps; invalidation beats deletion; episodes are
  provenance, not garbage.

Sources: agentmarketcap.ai/blog/2026/04/07/persistent-agent-memory-market-letta-mem0-zep-2026;
aiworkflowlab.dev/article/agent-memory-mem0-vs-letta-vs-zep-2026;
dataaspirant.com/blog/mem0-vs-letta-vs-zep/;
agentopsguide.com/ai-agent-memory-frameworks/.

### What open-bot already had, and what this wave added

- Already in main (v1.01): memory blocks (`memory/blocks.ts`),
  long-term memory, temporal KG (`memory/graph.ts`), sleep agent,
  consolidation, hybrid search, provenance.
- This wave added the missing pieces: **Deep Dream**
  (`memory/dream.ts`) — nightly deterministic distillation of daily
  notes into durable facts + promotion to the `human` block, with a
  scheduler that ticks once a day at a configured local hour; and
  **job memory** (`memory/jobMemory.ts`) — keyed, job-scoped facts
  with an explicit promote-to-long-term step, so a job's working
  notes never pollute user memory until the host promotes them.

## 2. Protocol stack 2026 — MCP, A2A, ACP, ANP

### MCP — the current spec is 2026-07-28, not 2025-11-25

- The 2025-11-25 revision (Streamable HTTP transport, experimental
  Tasks, URL-mode elicitation) was superseded. The **2026-07-28**
  spec makes the core **stateless**: no `initialize` handshake, no
  `Mcp-Session-Id`, HTTP+SSE deprecated; Streamable HTTP is the
  transport. Anything built against the 2025-11-25 handshake
  assumptions needs re-checking.
- MCP was donated to the Agentic AI Foundation (Linux Foundation)
  on 2025-12-09.

### A2A v1.0 — signed cards, tasks, multi-tenancy

- A2A v1.0 released 2026-03-12 (v1.0.1 on 2026-05-28); joined the
  Agentic AI Foundation 2026-08-17; 150+ supporting orgs.
- Agent Cards (signed), task lifecycle, push notifications,
  multi-tenancy, three bindings (JSON-RPC, gRPC, HTTP+JSON).
- **IBM's Agent Communication Protocol (ACP) merged into A2A in
  August 2025**; the IBM repo is archived (latest release v1.0.3,
  2026-08-21). That ACP is a REST protocol from BeeAI (March 2025)
  and is a **different protocol from Zed's Agent Client Protocol**.

### ACP — the acronym correction

- Open-bot's `acp/` implements **Zed's Agent Client Protocol**
  (editor ↔ coding agent, stable v1, schema 1.24.1, 2026-09-30):
  NDJSON JSON-RPC over stdio, `initialize` / `session/new` /
  `session/prompt` / `session/cancel`, permission requests, fs
  capabilities. It is NOT IBM's ACP and NOT the A2A-merged ACP.
  The v0.99 docs called it "ACP" without this distinction; this
  survey records the correction so future work does not confuse the
  two.
- The A2A ↔ ACP bridge in this wave (`a2a/acpAdapter.ts`) maps ACP
  `end_turn` → A2A `completed`, `cancelled` → `cancelled` (A2A
  spells it with two Ls), everything else → `failed`.

### ANP — the identity layer

- The Agent Network Protocol adds a fourth layer under the
  application protocols: **DID-based identity** (ANP 1.2 mentioned
  in 2026 coverage). Agents identify each other with
  decentralized identifiers instead of bearer tokens tied to one
  provider. Open-bot does not implement ANP; the takeaway is
  architectural — identity should be a layer, not a field in every
  protocol.

Sources: danilchenko.dev; jitendrazaa.com; neuralpartners.ai;
getmaxim.ai; codex.danielvaughan.com (MCP/A2A/ACP/ANP coverage,
verified in this cycle's earlier research pass).

## 3. OpenHands — the event stream as single source of truth

- OpenHands (ex-OpenDevin, All-Hands-AI, MIT, ~74k stars, v1.7.0
  May 2026, ~77% SWE-Bench Verified with Claude Sonnet 4.5) is the
  most-adopted open agent framework. The V1 SDK (Nov 2025 paper,
  arXiv 2511.03690, accepted MLSys 2026) rebuilt the V0 monolith
  into four decoupled packages: SDK (agent definitions), Tools
  (action handlers), Workspace (execution environments), Server.
- **The core idea**: the conversation is a typed, append-only,
  immutable stream of **Action** and **Observation** events. The
  agent is a stateless pure function from event history to next
  event; all mutable context lives in one event-sourced
  `ConversationState`. Pause, resume, fork, deterministic replay,
  and full audit trails come for free.
- The loop is **reason → action → exec → observe**: the agent
  reasons, emits an Action, the sandboxed workspace executes it and
  returns an Observation, which goes back into the next prompt.
  Self-correction is a side effect of letting the model see its own
  consequences. A `ThinkTool` gives the model a slot to reason
  without committing to an action.
- CodeActAgent: instead of 20 bespoke tools, give the model bash,
  Python (Jupyter), and a browser DSL and let it express any action
  as code. Tool use is unified through one
  Action → Execution → Observation contract.
- **What open-bot took from this**: the durable journal
  (`durable/journal.ts`) is open-bot's event log — append-only,
  idempotency keys, replay-to-resume; the tracer's spans are the
  observation side. What open-bot did NOT copy: the agent itself
  stays stateful (coordinator + checkpoints), because the local
  loop needs mutable working state; the event log is the recovery
  mechanism, not the whole architecture.

Sources: dev.to/lynkr/run-openhands-on-any-model-you-want-1mnd;
dev.to/truongpx396/openhands-deep-dive-build-your-own-guide-1al0;
arxiv.org/html/2511.03690v2; docs.openhands.dev/sdk/arch/agent.

## 4. Audit outcome — v0.99/v1.00 vs main v1.01

Diff sizes (merge-base): `main...merge/v099` = 148 files,
33,724 insertions; `main...merge/v100` = 93 files, 22,076 insertions.

### Already in main — skipped (not ported, not counted)

- A2A server/client/tasks/signing, delegation, push, network policy,
  history. (Only JWS compact + card builder/validator + ACP adapter
  were missing.)
- ACP **client-side** providers (`providers/cli/acp.ts`: `AcpClient`,
  `BaseAcpCliProvider`, `CodexAppServerClient`) + detected CLI
  engines.
- Coordinator (main's v1.01 coordinator is newer: risk budget +
  temporal KG + sleep agent; v099's is an older base — untouched).
- Agent loop checkpoints, compaction, token counting.
- Memory blocks, long-term, temporal graph, sleep agent,
  consolidation, hybrid search, provenance, memfs.
- Sandbox box/env/gate/signin (only hardening v2 was missing).
- Skills loader/registry/marketplace/builtin (only discovery,
  matching, token budget, script runner, evolved skills were
  missing).
- Vault core, session store, durable file, webhook keys.
- Tracing store/tracer (only `SpanEvent`, `'router'` span kind, and
  the observability layer were missing).
- Channels/groupchat (the multi-channel gateway is distinct).
- Session file snapshots (`session/box.ts`) — the full-state
  substrate snapshot is distinct.

### Ported in this wave (worktree `open-bot-v102-rescue`, branch `v102-rescue`)

| Feature | Files |
| --- | --- |
| ACP agent side (Zed ACP v1) | `core/src/acp/` — types, NDJSON JSON-RPC transport + in-memory peer pair, session store (0600), agent server (initialize v1 only, session new/load/resume/prompt/cancel/list/close/delete, config options, permission requests, fs gated by client capability), client (incl. `spawnAcpAgent`, per-turn `onUpdate`), PATH detection via real `initialize` handshake, external-agent wrapper |
| Context engineering | `core/src/context/` — estimator (chars/4 + known model limits), budget, pruning (relevance + recency + pinning), cache hints (provider support + hit-rate tracker), compaction history, lead agent (topological waves), long task (state machine + staleness), task checkpoints, virtual computer (scoped fs + commands), long-run compaction |
| Durable execution | `core/src/durable/` — append-only journal (idempotency keys, checkpoints, verify, prune), durable session (heartbeat + registry), recovery (interrupted-run detection), resume (replay + `DurableRunner` never re-executes a finished step/tool) |
| Observability | `core/src/observability/` — cost (wraps `usage/pricing.ts`, local models $0), OTel export (JSONL), trace query (filter/aggregate/cost-by-model/day buckets) + `SpanEvent` + `'router'` span kind in tracing |
| Multi-agent orchestration | `core/src/orchestra/` — blackboard (optimistic locking), fan-out waves, merge (first-writer-wins file conflicts), policy (retry/escalate), supervisor (attempt loop, retry on another worker), store, plan adapter, service |
| Multi-channel gateway | `core/src/gateway/` — config store (fail-closed), shared sessions (one user id across channels), per-sender rate limiter, adapters (Telegram/Slack/Discord/WhatsApp normalize + format), manager (receive/route/reply/send, audit without message text), mock transport |
| Session substrate | `core/src/session/substrate.ts` — checksummed bot-state snapshots (v2), sensitive files never copied, tamper refused on restore |
| Deep Dream + job memory | `core/src/memory/dream.ts` (deterministic rule-based distillation, no model call; promotes ≥0.8-confidence facts to the `human` block; daily scheduler), `core/src/memory/jobMemory.ts` (keyed job facts, explicit promote) |
| Skills additions | `core/src/skills/` — discovery (multi-root scan, first-root-wins dedupe), matching (reuses registry scorer, normalized 0..1), token budget, script runner (allowlist + escape guard), evolved skills (propose from repeated tool sequences, approve → SKILL.md, feedback → evolve) + 3 builtin skills (`commit-message`, `release-notes`, `summarize-file`; 8 → 11) |
| Sandbox hardening v2 | `core/src/sandbox/` — allowlist (hosts/paths/commands), profiles (strict/standard/permissive), quota tracker, audit log, enforcer (always-denied credential paths), config store + egress-gate redirect blocking in `gate.ts` (3xx to another host re-checked) |
| A2A additions | `core/src/a2a/` — card builder/validator, discovery (`/.well-known/agent-card.json`), JWS compact (Ed25519 sign/verify), ACP adapter |
| Vault additions | `core/src/vault/` — scoped vault (one namespace visible), encrypted export/import (AES-256-GCM + scrypt, one namespace only), audit log |
| Tools (12) | `packages/tools/src/rescueV102Tools.ts` — `context_measure_budget`, `context_prune_history`, `durable_list_resumable`, `durable_resume_state`, `orchestra_run`, `orchestra_list_sessions`, `gateway_status`, `gateway_send`, `dream_run`, `substrate_snapshot`, `substrate_list_snapshots`, `acp_detect_agents` (mutating ones need approval; registry 238 → 250) |

### Bugs found and fixed while testing (all verified by new tests)

1. **Sandbox allowlist `paths: ['.']` matched nothing** — `'src/index.ts'.startsWith('./')` is false, so every built-in profile denied every write. `isPathAllowed` now treats `.` as the workspace root (relative paths allowed, absolute/`..` denied).
2. **`isCommandAllowed` compared the whole command line** (`'git status' !== 'git'`) — the enforcer denied every command with arguments. It now takes the first whitespace token as the command name.
3. **Tracer redacted `tokensUsed`** — `sanitizeValue` treats any key containing "token" as a credential, so durable checkpoints resumed with `tokensUsed: '<redacted>'`. Added `tokensUsed` + `totalTokens` to `TOKEN_COUNT_KEYS` (same precedent as the v0.33 `inputTokens` fix).
4. **Resume lost tool-call identity** — the journal sanitizer stringifies values at depth 4, so a checkpoint's `call: {id}` arrived as the string `'{"id":"c1"}'` and `DurableRunner` re-executed the tool. `resumeRunFromJournal` now parses stringified calls back.
5. **Snapshot copied itself** — `takeBotSessionSnapshot` writes `state.json` inside the work dir before walking it, so every snapshot contained a stale copy of its own state. The walk now skips the bot's own snapshots directory.
6. **`matchSkillsWithConfig` saturated at 1.0** — `scoreSkill` returns raw points (up to ~35) but the matcher clamped with `min(1, base)`, so every skill with any keyword hit scored 1.0 and ranking collapsed to input order. Scores are now normalized on the 20-point scale of a full two-word name hit, with a name tiebreak (matching the registry's own matcher).
7. **ACP client ↔ A2A adapter interface mismatch** — the adapter's runner passes a per-prompt `onUpdate` callback as the 3rd `prompt()` argument, but the protocol client took an `AbortSignal` there (`signal?.addEventListener is not a function`). `prompt()` now accepts either a per-turn update callback or a signal, and dispatches updates to both the constructor handler and per-turn handlers.
8. **Orchestra tool fanned out with one worker** — a wave runs subtasks in parallel and each needs a distinct worker, so a 2-subtask run with 1 worker escalated the second subtask ("no worker available"). The tool now creates one worker entry per subtask (all backed by the same subagent runner).

### Not done (scope decisions)

- No UI panels, no IPC, no i18n changes (no new UI strings were
  added, so no 6-locale work was needed).
- Coordinator/loop not wired to the journal/tracer/orchestra —
  integration points only, as in the v0.99 docs.
- `acp/provider.ts` (ACP as a provider) and CLI/desktop wiring from
  v0.99 were not ported — only the protocol modules + tools.
- Gateway has no real HTTP transport (host-injected; mock in tests).
- Substrate is an application-state snapshot, not a process/OS
  snapshot.
- ACP acronym: this wave implements Zed's ACP, not IBM's ACP
  (see §2).

## 5. Verification

- Core + tools typecheck clean (`tsc -p packages/core/tsconfig.json`,
  `tsc -p packages/tools/tsconfig.json`, both `--noEmit` and emit).
- New tests (9 files, 71 tests): `acp-v102`, `context-v102`,
  `durable-v102`, `orchestra-v102`, `gateway-v102`,
  `substrate-dream-v102`, `skills-sandbox-v102`, `a2a-vault-v102`,
  `rescue-v102-tools` — **71 pass, 0 fail**.
- Affected existing suites: `skills-builtin-v072c`,
  `skills-standard`, `skills`, `conversation-history-v085`,
  `coordinator`, `v014-integration`, `wiring-v07` — all green
  (55 tests).
- Line count and HEAD are in the wave report (parent agent).
