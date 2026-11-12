/**
 * Canvas module re-exports (v0.6 web & media).
 *
 * The canvas store lives in @open-bot/core because the desktop app and
 * the tools package both need it; it is exported from the package index
 * (`@open-bot/core`) since v0.6.
 */
export { CanvasStore, validateCanvasBlocks, validateCanvasId } from './store';
export type { CanvasBlock, CanvasDocument, CanvasSummary, CanvasWriteOptions } from './store';
