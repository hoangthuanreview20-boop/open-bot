/**
 * Auth — public surface of packages/core/src/auth/ (v0.7).
 * Multi-layer login, credential namespaces, OAuth, machine policy.
 */
export {
  getLocalProfile,
  getOrCreateLocalProfile,
  loadLocalProfile,
  saveLocalProfile,
  setLocalDisplayName,
  validateLocalProfile,
  getProviderIdentity,
  setProviderIdentity,
  deleteProviderIdentity,
  listProviderIdentities,
  validateProviderIdentity,
  PROFILE_FILE,
  IDENTITY_NAMESPACE,
} from './identity';
export type { LocalProfile, ProviderIdentity } from './identity';
export {
  CREDENTIAL_NAMESPACES,
  namespaceFor,
  migrateCredentials,
  auditCredentialNamespaces,
} from './credentials';
export type { CredentialKind, CredentialMigrationMove, CredentialMigrationReport } from './credentials';
export {
  OAUTH_PROVIDERS,
  isOAuthSupported,
  getOAuthProvider,
  buildAuthUrl,
  newOAuthState,
  createOAuthCallbackServer,
  exchangeCodeForTokens,
} from './oauth';
export type {
  OAuthProviderConfig,
  OAuthCallbackServer,
  CreateOAuthCallbackServerOptions,
  TokenExchangeResult,
  FetchLike,
} from './oauth';
export {
  loadPolicy,
  parsePolicy,
  isProviderAllowed,
  effectiveBaseUrl,
  POLICY_FILE,
} from './policy';
export type { MachinePolicy, LoadPolicyResult } from './policy';
