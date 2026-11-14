/**
 * OpenHands-style coding agent (v1.02, Team T4).
 *
 * Event-stream coding agent: reason -> action -> sandboxed execute ->
 * observe, with a replayable event log, a confined workspace, run
 * budgets, per-run traces, and an eval harness.
 *
 * Any model can be the brain: plug any open-bot Provider into
 * `ProviderReasoner`, or run model-free with `RuleReasoner` /
 * `ScriptedReasoner`. Local-first: no cloud VM, no accounts, no
 * payments; everything runs on the user's machine.
 */

export * from './events';
export * from './store';
export * from './workspace';
export * from './sandboxExec';
export * from './actions';
export * from './planner';
export * from './budget';
export * from './reasoner';
export * from './agent';
export * from './trace';
export * from './eval';
