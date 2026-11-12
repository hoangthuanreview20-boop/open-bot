/**
 * Self-update check — public surface of packages/core/src/update/ (v0.7).
 */
export {
  checkForUpdate,
  checkForTrackUpdate,
  compareSemver,
  parseSemver,
  pickReleaseForTrack,
  releaseMatchesTrack,
  UPDATE_REPO,
  UPDATE_RELEASES_API,
  UPDATE_RELEASES_LIST_API,
} from './checker';
export type { GitHubReleaseSummary, UpdateCheckResult, UpdateFetchLike } from './checker';

// --- v0.54 (P1-9): update track + chính sách update_required / min_client_version ---
export {
  DEFAULT_UPDATE_TRACK,
  UPDATE_DISABLED_BY_ENV_CODE,
  UPDATE_DISABLED_ENV_VAR,
  UPDATE_TRACKS,
  evaluateUpdatePolicy,
  isUpdateDisabledByEnv,
  isUpdateTrack,
  parseUpdateTrack,
} from './tracks';
export type { UpdatePolicyInput, UpdatePolicyResult, UpdateTrack } from './tracks';
