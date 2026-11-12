/**
 * @open-bot/core/perf — job queue, worker pool, tool-result cache.
 * Public surface for the perf module (imported by the desktop main
 * process and by @open-bot/tools; NOT re-exported from the package
 * root index).
 */
export { JobQueue } from './queue';
export type { EnqueueOptions, JobFn, JobHandle, JobQueueOptions, JobQueueStats } from './queue';
export { WorkerPool, defaultPoolSize, DEFAULT_MAX_JOB_TIME_MS } from './pool';
export type { WorkerPoolOptions, WorkerPoolStats } from './pool';
export {
  ToolResultCache,
  cacheKeyFor,
  stableStringify,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
  SUGGESTED_CACHEABLE_TOOLS,
} from './cache';
export type { ToolResultCacheOptions, ToolResultCacheStats } from './cache';
