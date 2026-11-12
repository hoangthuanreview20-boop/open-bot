/**
 * Connected apps (M7) — public surface of packages/core/src/apps/.
 *
 * Catalog app thống nhất, OAuth một lần chia sẻ cho mọi bot, trạng
 * thái auth rõ ràng, cap số tool theo từng app. Xem README.md trong
 * thư mục này.
 */
export { AppRegistry, BUILTIN_APPS, createDefaultAppRegistry, defaultAppRegistry, getApp, getAppToolNames, listApps, appIdForTool } from './catalog';
export { SharedAppAuthStore, deriveAppAuthStatus } from './authStore';
export type { AppClientConfig, SharedAppAuthStoreOptions } from './authStore';
export {
  validateGithubPat,
  saveValidatedGithubPat,
  githubPatValidationErrorMessage,
  githubPatApiBase,
  GithubPatRevalidator,
  GITHUB_PAT_VALIDATE_URL,
  DEFAULT_GITHUB_PAT_TIMEOUT_MS,
  DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS,
  GITHUB_PAT_REVOKED_DETAIL,
  GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL,
  GITHUB_PAT_UNCHECKABLE_RATE_LIMIT_DETAIL,
  GITHUB_PAT_UNCHECKABLE_FORBIDDEN_DETAIL,
} from './githubToken';
export type {
  GithubPatFetchFn,
  GithubPatValidation,
  GithubPatRevalidateOutcome,
  GithubPatRevalidateResult,
  GithubPatRevalidatorOptions,
  SaveValidatedGithubPatOptions,
  ValidateGithubPatOptions,
} from './githubToken';
export { DEFAULT_APP_TOOL_CAP, applyAppToolCaps, capAppTools } from './toolCap';
export type { AppCapReport, CappedTools } from './toolCap';
export type { AppAuthStatus, AppAuthType, AppDefinition, AppSource, AppStatusView, AppToolRef } from './types';
