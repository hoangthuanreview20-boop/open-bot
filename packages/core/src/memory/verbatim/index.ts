/**
 * Verbatim local memory (v1.01, Đội T4) — barrel export.
 *
 * Tầng memory nguyên văn, local-first, không cần API key:
 * lưu đúng câu chữ đã nói (kèm wing/room/drawer + nguồn + thời gian),
 * recall hybrid (BM25 + embedding Ollama local), MCP server 5 tool,
 * auto-save hook cuối session (rule-based, opt-in).
 */
export {
  normalizeVerbatimText,
  verbatimHash,
  normalizeVerbatimSlot,
  normalizeVerbatimTag,
  verbatimMatchesFilter,
  publicVerbatimRecord,
} from './types';
export type {
  VerbatimSource,
  VerbatimRecord,
  SaveVerbatimInput,
  VerbatimFilter,
  VerbatimListOptions,
  VerbatimRecallHit,
  VerbatimFallbackReason,
  VerbatimRecallResult,
  VerbatimRecallOptions,
  VerbatimEmbedder,
  VerbatimStats,
  VerbatimBackend,
  VerbatimSaveResult,
} from './types';

export { openVerbatimBackend } from './backends/index';
export type { VerbatimBackendKind, OpenVerbatimBackendOptions, OpenVerbatimBackendResult } from './backends/index';
export { SqliteVerbatimBackend, VERBATIM_SQLITE_FILE, VERBATIM_SQLITE_SCHEMA_VERSION } from './backends/sqlite';
export type { SqliteVerbatimBackendOptions } from './backends/sqlite';
export { JsonlVerbatimBackend, VERBATIM_JSONL_FILE } from './backends/jsonl';
export type { JsonlVerbatimBackendOptions } from './backends/jsonl';

export {
  hybridRecall,
  keywordRecall,
  normalizeScores,
  recencyBoost,
  VERBATIM_DEFAULT_MIN_SIMILARITY,
  VERBATIM_DEFAULT_SEMANTIC_WEIGHT,
  VERBATIM_RECENCY_BOOST_MAX,
  VERBATIM_RECENCY_WINDOW_DAYS,
} from './recall';

export {
  chunkVerbatimText,
  chunkTranscriptTurns,
  roleToSource,
  VERBATIM_DEFAULT_MAX_CHUNK_CHARS,
  VERBATIM_DEFAULT_MIN_CHUNK_CHARS,
} from './chunker';
export type { VerbatimChunk, VerbatimChunkOptions } from './chunker';

export {
  extractVerbatimCandidates,
  splitIntoSentences,
  countCandidatesByKind,
  VERBATIM_EXTRACT_MIN_LENGTH,
  VERBATIM_EXTRACT_MAX_LENGTH,
} from './extract';
export type { VerbatimTurn, VerbatimCandidate, VerbatimExtractOptions } from './extract';

export {
  VerbatimMemoryStore,
  VERBATIM_DEFAULT_DIR_NAME,
  VERBATIM_DEFAULT_MAX_RECORDS,
  VERBATIM_MAX_TEXT_CHARS,
} from './store';
export type { VerbatimMemoryStoreOptions, BackfillResult } from './store';

export {
  migrateLongTermToVerbatim,
  migrateTranscriptToVerbatim,
  readTranscriptFile,
} from './migrate';
export type {
  MigrateLongTermResult,
  MigrateTranscriptOptions,
  MigrateTranscriptResult,
  TranscriptTurnInput,
} from './migrate';

export {
  VerbatimAutosave,
  createVerbatimAutosaveHook,
  VERBATIM_AUTOSAVE_HOOK_NAME,
  VERBATIM_AUTOSAVE_DEFAULT_MAX_PER_SESSION,
  VERBATIM_AUTOSAVE_DEFAULT_MIN_CONFIDENCE,
} from './autosave';
export type {
  VerbatimLlmExtractor,
  VerbatimTurnsProvider,
  VerbatimAutosaveOptions,
  VerbatimIngestResult,
} from './autosave';

export {
  createVerbatimMcpTools,
  createVerbatimMemoryMcpServer,
  runVerbatimMemoryMcpStdio,
  runVerbatimMemoryMcpHttp,
  isVerbatimMcpToolName,
  isVerbatimMcpWriteTool,
  VERBATIM_MCP_TOOL_NAMES,
} from './mcp';
export type { VerbatimMcpToolName, VerbatimMcpServerOptions, VerbatimMcpHttpOptions } from './mcp';

export {
  openVerbatimStoreForWorkspace,
  registerVerbatimAutosave,
  VERBATIM_WORKSPACE_REL_DIR,
} from './register';
export type {
  OpenVerbatimStoreForWorkspaceOptions,
  OpenVerbatimStoreForWorkspaceResult,
  RegisterVerbatimAutosaveOptions,
} from './register';

export {
  consolidateVerbatim,
  applyVerbatimDedup,
  softNormalizeVerbatimText,
  verbatimTokenSet,
  jaccardSimilarity,
} from './consolidate';
export type {
  VerbatimDuplicateGroup,
  VerbatimNearDuplicatePair,
  VerbatimConsolidateReport,
  VerbatimConsolidateOptions,
} from './consolidate';

export {
  buildVerbatimWakeUp,
  formatVerbatimWakeUpLine,
  createVerbatimWakeUpHook,
  verbatimWakeUpHeader,
  VERBATIM_WAKEUP_DEFAULT_RECENT,
  VERBATIM_WAKEUP_DEFAULT_RELEVANT,
  VERBATIM_WAKEUP_DEFAULT_MAX_CHARS,
  VERBATIM_WAKEUP_DEFAULT_MAX_CHARS_PER_RECORD,
  VERBATIM_WAKEUP_HOOK_NAME,
} from './wakeup';
export type {
  VerbatimWakeUpOptions,
  VerbatimWakeUpSection,
  VerbatimWakeUpResult,
} from './wakeup';
