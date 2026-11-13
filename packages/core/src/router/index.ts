/**
 * Router v0.96 — chọn model/provider cho mỗi turn qua 3 tầng
 * (structural → semantic → decision), kèm session pinning, fallback
 * ladder, log quyết định và ước tính tiết kiệm local-vs-cloud.
 * Xem docs/router-v096.md.
 */
export {
  structuralScore,
  structuralVerdict,
  STRUCTURAL_TRIVIAL_MAX,
  STRUCTURAL_SIMPLE_MAX,
  STRUCTURAL_MODERATE_MAX,
  DEFAULT_STRUCTURAL_WEIGHTS,
  REASONING_KEYWORDS,
  CONSTRAINT_KEYWORDS,
  TASK_VERBS,
  countCodeSignals,
  countTasks,
} from './structuralScore';
export type {
  StructuralScore,
  StructuralScoreOptions,
  StructuralSignal,
} from './structuralScore';

export {
  SemanticRouter,
  DEFAULT_SEMANTIC_ROUTES,
  DEFAULT_MIN_CONFIDENCE,
  averageVectors,
} from './semanticRouter';
export type {
  SemanticRoute,
  SemanticRouteResult,
  SemanticRouterOptions,
} from './semanticRouter';

export {
  DecisionRouter,
  parseDecisionJson,
  DECISION_ROUTES,
  DEFAULT_DECISION_MODEL,
  DEFAULT_DECISION_TIMEOUT_MS,
  DEFAULT_DECISION_MAX_TOKENS,
  DECISION_SYSTEM_PROMPT,
} from './decisionRouter';
export type {
  DecisionRoute,
  DecisionResult,
  DecisionRouterOptions,
} from './decisionRouter';

export { ModelRouter, DEFAULT_ROUTER_CONFIG } from './router';
export type {
  RouterTarget,
  RouterLayer,
  RouterConfig,
  RouteInput,
  RoutingDecision,
  RouterStats,
  ModelRouterDeps,
} from './router';

export {
  discoverCliTargets,
  discoverApiTargets,
  cliTargetFromEngine,
  cliProviderIdForKind,
  isEngineRoutable,
  isRoutableApiProvider,
  buildAvailableTargets,
  compareCapable,
  ESTIMATED_API_COST_PER_1K_USD,
  ESTIMATED_CONTEXT_LIMIT,
} from './targets';
export type { AvailableTargetsInput } from './targets';

export {
  RouterDecisionStore,
  computeRouterStats,
  validateRouterConfigPatch,
  loadRouterConfigFile,
  saveRouterConfigFile,
  atomicWriteJson,
  ROUTER_DECISIONS_FILE,
  ROUTER_CONFIG_FILE,
  MAX_DECISIONS_PER_BOT,
  MAX_BOTS_IN_STORE,
} from './history';
export type {
  StoredRouterDecision,
  RouterDecisionsFile,
  RouterStatsEntry,
  RouterDecisionStoreOptions,
  RouterConfigValidation,
} from './history';
