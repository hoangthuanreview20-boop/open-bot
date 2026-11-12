/**
 * Client-side helpers thuần túy (dùng chung cho desktop renderer + test).
 */
export {
  PersistedStore,
  PersistedStoreRegistry,
  DraftStore,
  createDraftId,
  createMemoryStorage,
} from './persistedStore';
export type {
  ClientPersistenceReport,
  ClientPersistenceReporter,
  DraftEntry,
  PersistedStoreDef,
  PersistedStoreScope,
  StorageLike,
} from './persistedStore';
