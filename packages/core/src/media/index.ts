/**
 * Media keys (v0.95, Team D2) — public surface of packages/core/src/media/.
 *
 * User-supplied API keys for image/video generation models, stored in
 * the Vault namespace 'media' and seeded to the coordinator in memory
 * (RPC `media.setKey`, like `composio.setApiKey`). See mediaKeys.ts.
 */
export {
  MEDIA_API_KEY_MAX_LENGTH,
  MEDIA_PROVIDER_IDS,
  MEDIA_PROVIDERS,
  MEDIA_VAULT_NAMESPACE,
  asMediaKeyVault,
  buildMediaProviderConfig,
  clearMediaApiKey,
  getAllMediaApiKeys,
  getMediaApiKey,
  getMediaKeyStatus,
  getMediaProvider,
  hasMediaApiKey,
  isMediaProviderId,
  maskMediaKeySuffix,
  mediaKeyMissingMessage,
  mediaProviderNoClientMessage,
  redactMediaKey,
  setMediaApiKey,
  validateMediaApiKey,
} from './mediaKeys';
export type {
  MediaClientStatus,
  MediaKeyStatusEntry,
  MediaKeyVault,
  MediaKind,
  MediaProviderDef,
} from './mediaKeys';
