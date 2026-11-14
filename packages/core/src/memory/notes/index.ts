/**
 * Evolving notes — public API (v1.01, Đội T5).
 *
 * Entry point duy nhất mà code ngoài `memory/notes/` cần import:
 *   import { EvolvingNoteStore, AutoLinkEngine, RevisitEngine, ... } from '@open-bot/core';
 */
export * from './types';
export * from './similarity';
export * from './store';
export * from './autolink';
export * from './revisit';
export * from './graphExport';
export * from './sync';
export * from './benchmark/index';
