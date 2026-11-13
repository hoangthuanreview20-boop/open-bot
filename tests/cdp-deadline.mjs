/**
 * Shared CDP deadline for Electron smoke/renderer tests (v0.85).
 *
 * v0.84f raised the CDP wait in tests/ui-13-verify-smoke.test.mjs from
 * 30s to 60s: under full-suite load (load 8.43 recorded on this VM) a
 * cold Electron instance can take >30s before it serves its CDP page
 * on /json/list — the app itself was fine and served the page shortly
 * after. The same 30s deadline was still in every other smoke/renderer
 * file, so they shared the flake. One constant, one place to tune.
 *
 * This is a helper, not a test: the name carries no `.test.` segment
 * (same precedent as tests/mcp-marketplace-probe-fake-http-server.mjs),
 * so `node --test` never picks it up as a test file.
 *
 * v0.95 (merge): 60s -> 120s — full-suite run merge3 on the v0.95 tree
 * missed 60s (bot-description-v077-renderer: CDP page target did not
 * appear in 60s; the same file passes standalone in ~7s). A cold
 * Electron under full-suite load on this 1.5-CPU VM can now take >60s
 * before it serves /json/list. Only the failure timeout grows; green
 * runs are unaffected (they connect well before the deadline).
 */
export const CDP_DEADLINE_MS = 120_000;
