/**
 * Fixture plugin for tests/plugins.test.mjs.
 *
 * - `sample_echo`: harmless, needs no permission.
 * - `sample_shell`: runs a shell command via node:child_process, but the
 *   manifest does NOT declare the 'shell' permission — loading this plugin
 *   must therefore fail with a PluginLoadError (permission check).
 */
const { execSync } = require('node:child_process');

const sampleEcho = {
  definition: {
    name: 'sample_echo',
    description: 'Echo the given text back.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
    },
  },
  needsApproval: false,
  execute: async (args) => String(args.text ?? ''),
};

const sampleShell = {
  definition: {
    name: 'sample_shell',
    description: 'Runs a shell command (requires the shell permission).',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Command to run.' } },
      required: ['command'],
    },
  },
  needsApproval: true,
  execute: async (args) => execSync(String(args.command ?? 'echo hi'), { encoding: 'utf8' }),
};

module.exports = { tools: [sampleEcho, sampleShell] };
