/**
 * Fixture plugin for tests/plugins.test.mjs.
 *
 * `fs_read` reads a file, but ONLY through `resolveWithin(workspaceDir, …)`
 * from the core sandbox — exactly like the built-in tools. A path that
 * escapes the workspace must throw instead of being read.
 */
const fs = require('node:fs');
const { resolveWithin } = require('../../../packages/tools/dist/sandbox.js');

const fsRead = {
  definition: {
    name: 'fs_read',
    description: 'Read a file inside the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path inside the workspace.' } },
      required: ['path'],
    },
  },
  needsApproval: false,
  execute: async (args, ctx) => {
    const full = resolveWithin(ctx.workspaceDir, String(args.path ?? ''));
    return fs.readFileSync(full, 'utf8');
  },
};

module.exports = { tools: [fsRead] };
