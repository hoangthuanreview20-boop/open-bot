/**
 * MCP 2.0 agent tools (v0.97, Team T1).
 *
 * Exposes the MCP 2.0 surface to the agent as ordinary tools, so the
 * model can use a stateless server, poll a long-running task, scan a
 * server's tool descriptions for poisoning, or validate an MCP App
 * before rendering it — without the coordinator writing new glue
 * for each operation.
 *
 * Tools:
 *   - `mcp2_discover_server` — `server/discover` on a configured
 *     server (no handshake, no session).
 *   - `mcp2_call_tool_mrtr` — call a tool through the MRTR driver;
 *     follow-up answers come from the tool arguments (`input`,
 *     `samplingText`, `elicitation`, `roots`, `confirm`).
 *   - `mcp2_task_poll` / `mcp2_task_cancel` — poll / cancel a
 *     long-running task handle (`tasks/get`, `tasks/cancel`).
 *   - `mcp2_scan_tool_descriptions` — poisoning scan over a
 *     server's `tools/list` (see `poisoning.ts`).
 *   - `mcp2_validate_app` — validate MCP App HTML + build the
 *     sandboxed iframe descriptor (CSP included).
 *
 * Safety: servers come only from the workspace `.open-bot/mcp.json`
 * (same rule as `mcpTools.ts` — the agent never invents a command).
 * Every server call opens a short-lived stateless client and closes
 * it afterwards; nothing here pools or caches a connection, and no
 * credential ever appears in a result. `mcp2_call_tool_mrtr` needs
 * approval like `mcp_call_tool` does, because an external tool can
 * act outside the machine.
 */
import type { Tool, ToolContext } from '@open-bot/core';
import { connectMcp } from '@open-bot/core/dist/mcp/client';
import { loadMcpConfig } from '@open-bot/core/dist/mcp/config';
import type { McpServerConfig } from '@open-bot/core/dist/mcp/types';
import { runMultiRoundTrip } from '@open-bot/core/dist/mcp/mrtr';
import type { MrtrHandlers } from '@open-bot/core/dist/mcp/mrtr';
import { scanToolRegistry } from '@open-bot/core/dist/mcp/poisoning';
import {
  buildAppFrameDescriptor,
  parseAppResource,
} from '@open-bot/core/dist/mcp/apps';
import { truncateText as truncate } from './truncate';

function getStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tool argument "${name}" is required and must be a non-empty string.`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined) return {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Tool argument "${name}" must be an object.`);
}

function getServerConfig(workspaceDir: string, serverName: string): McpServerConfig {
  const config = loadMcpConfig(workspaceDir);
  const server = config.servers[serverName];
  if (!server) {
    const known = Object.keys(config.servers);
    throw new Error(
      `MCP server "${serverName}" is not configured` +
        (known.length > 0
          ? `. Configured servers: ${known.join(', ')}.`
          : '. No MCP servers are configured yet — add one to .open-bot/mcp.json in the workspace.'),
    );
  }
  return server;
}

/** Open a short-lived stateless client for one server; caller closes it. */
async function openStatelessClient(workspaceDir: string, serverName: string) {
  const server = getServerConfig(workspaceDir, serverName);
  return connectMcp({ ...server, name: serverName, stateless: true });
}

export function createMcpV097Tools(): Tool[] {
  const discoverTool: Tool = {
    definition: {
      name: 'mcp2_discover_server',
      description:
        'Describe an MCP server without any handshake (MCP 2.0 server/discover). ' +
        'Returns the protocol version, capabilities and extensions the server offers. ' +
        'The server comes only from .open-bot/mcp.json — the agent cannot choose an arbitrary command.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        },
        required: ['server'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        const discovered = await client.discover?.();
        if (!discovered) {
          return (
            `MCP server "${serverName}" does not support server/discover (pre-2.0 server). ` +
            `It still works with stateless requests — every request carries its own _meta.`
          );
        }
        const lines = [
          `MCP server "${serverName}":`,
          `- protocolVersion: ${discovered.protocolVersion}`,
          `- server: ${discovered.serverInfo.name} ${discovered.serverInfo.version}`,
          `- capabilities: ${Object.keys(discovered.capabilities).join(', ') || '(none)'}`,
        ];
        if (discovered.supportedVersions?.length) {
          lines.push(`- supportedVersions: ${discovered.supportedVersions.join(', ')}`);
        }
        if (discovered.extensions?.length) {
          lines.push(`- extensions: ${discovered.extensions.join(', ')}`);
        }
        if (discovered.note) lines.push(`- note: ${discovered.note}`);
        return truncate(lines.join('\n'));
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const mrtrTool: Tool = {
    definition: {
      name: 'mcp2_call_tool_mrtr',
      description:
        'Call a tool on a configured MCP server through Multi Round-Trip Requests (MCP 2.0). ' +
        'When the server answers with a follow-up need (more input, a model completion, a user value, ' +
        'workspace roots, or a confirmation), the follow-up is answered from the arguments of this tool: ' +
        '`input` for needs_input, `samplingText` for needs_sampling, `elicitation` for needs_elicitation, ' +
        '`roots` for needs_roots, `confirm` for needs_confirmation. ' +
        'Needs approval because an external MCP tool can act outside the machine.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          tool: { type: 'string', description: 'Name of the tool on that server (see mcp_list_tools).' },
          arguments: { type: 'object', description: 'Arguments object for the tool (default: {}).', additionalProperties: true },
          input: { type: 'object', description: 'Extra arguments to answer a needs_input follow-up round.', additionalProperties: true },
          samplingText: { type: 'string', description: 'Text to answer a needs_sampling follow-up round.' },
          elicitation: { type: 'object', description: 'Fields to answer a needs_elicitation follow-up round.', additionalProperties: true },
          roots: {
            type: 'array',
            description: 'Workspace roots to answer a needs_roots follow-up round.',
            items: { type: 'object', properties: { uri: { type: 'string' }, name: { type: 'string' } }, required: ['uri'] },
          },
          confirm: { type: 'boolean', description: 'Answer for a needs_confirmation follow-up round (default: false — refuse).' },
          maxRounds: { type: 'number', description: 'Maximum round trips before giving up (default 8).' },
        },
        required: ['server', 'tool'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const toolName = getStringArg(args, 'tool');
      const toolArgs = getObjectArg(args, 'arguments');
      const input = getObjectArg(args, 'input');
      const elicitation = getObjectArg(args, 'elicitation');
      const samplingText = getOptionalStringArg(args, 'samplingText');
      const roots = Array.isArray(args['roots']) ? (args['roots'] as Array<{ uri: string; name?: string }>) : undefined;
      const confirm = typeof args['confirm'] === 'boolean' ? args['confirm'] : false;
      const maxRounds = typeof args['maxRounds'] === 'number' && args['maxRounds'] >= 1
        ? Math.floor(args['maxRounds'])
        : 8;
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const handlers: MrtrHandlers = {
          onNeedsInput: async () => ({ ...input }),
          onNeedsSampling: async () => {
            if (samplingText === undefined) {
              throw new Error('Server needs sampling but no samplingText was provided to mcp2_call_tool_mrtr.');
            }
            return samplingText;
          },
          onNeedsElicitation: async () => ({ ...elicitation }),
          onNeedsRoots: async () => roots ?? [],
          onNeedsConfirmation: async () => confirm,
        };
        const outcome = await runMultiRoundTrip(
          { requestJsonRpc: (method, params) => client.requestJsonRpc!(method, params) },
          'tools/call',
          { name: toolName, arguments: toolArgs },
          handlers,
          { maxRounds },
        );
        const resultText = typeof outcome.result === 'string'
          ? outcome.result
          : JSON.stringify(outcome.result, null, 2);
        return truncate(
          `MRTR call to "${toolName}" on "${serverName}" completed in ${outcome.rounds} round(s):\n${resultText ?? ''}`,
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const taskPollTool: Tool = {
    definition: {
      name: 'mcp2_task_poll',
      description:
        'Poll a long-running MCP task on a configured server (tasks/get, MCP Tasks extension). ' +
        'Returns the task status, progress, and the final result when completed.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          taskId: { type: 'string', description: 'Task id returned when the task was created.' },
        },
        required: ['server', 'taskId'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const taskId = getStringArg(args, 'taskId');
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const raw = await client.requestJsonRpc('tasks/get', { taskId });
        return truncate(`Task ${taskId} on "${serverName}":\n${JSON.stringify(raw, null, 2)}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const taskCancelTool: Tool = {
    definition: {
      name: 'mcp2_task_cancel',
      description:
        'Cancel a long-running MCP task on a configured server (tasks/cancel, MCP Tasks extension).',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          taskId: { type: 'string', description: 'Task id to cancel.' },
        },
        required: ['server', 'taskId'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const taskId = getStringArg(args, 'taskId');
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const raw = await client.requestJsonRpc('tasks/cancel', { taskId });
        return truncate(`Task ${taskId} on "${serverName}" cancel requested:\n${JSON.stringify(raw, null, 2)}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const scanTool: Tool = {
    definition: {
      name: 'mcp2_scan_tool_descriptions',
      description:
        'Scan the tool descriptions of a configured MCP server for description-poisoning patterns ' +
        '(hidden instructions, instruction overrides, exfiltration URLs, credential harvesting, encoded blobs). ' +
        'Returns a verdict per tool (clean / suspicious / poisoned) with the matching rule for each finding. ' +
        'Use before trusting a new server\'s tools.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        },
        required: ['server'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        const tools = await client.listTools();
        const report = scanToolRegistry(
          tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
        );
        const lines = [
          `Description-poisoning scan of MCP server "${serverName}":`,
          `- scanned: ${report.scanned} tools — clean: ${report.clean}, suspicious: ${report.suspicious}, poisoned: ${report.poisoned}`,
        ];
        for (const entry of report.tools) {
          if (entry.result.verdict === 'clean') continue;
          lines.push(
            `- ${entry.name}: ${entry.result.verdict} (score ${entry.result.score}) — ` +
              entry.result.findings.map((f) => `${f.rule} [${f.severity}]: ${f.message}`).join('; '),
          );
        }
        if (report.poisoned === 0 && report.suspicious === 0) {
          lines.push('- No suspicious pattern found in any tool description.');
        }
        return truncate(lines.join('\n'));
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const validateAppTool: Tool = {
    definition: {
      name: 'mcp2_validate_app',
      description:
        'Validate an MCP App (interactive HTML from an MCP server) before rendering it. ' +
        'Refuses apps that try to escape the sandbox (remote scripts, top navigation, direct host access, ' +
        'remote fetches) and returns the sandboxed iframe descriptor (sandbox flags + strict CSP) for apps that pass.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'App URI, e.g. ui://server/app-name.' },
          html: { type: 'string', description: 'The app HTML document to validate.' },
          title: { type: 'string', description: 'Optional display title for the app frame.' },
        },
        required: ['uri', 'html'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      const uri = getStringArg(args, 'uri');
      const html = getStringArg(args, 'html');
      const title = getOptionalStringArg(args, 'title');
      const app = parseAppResource({
        uri,
        html,
        ...(title ? { title } : {}),
        mimeType: 'text/html',
      });
      const descriptor = buildAppFrameDescriptor(app);
      const lines = [
        `MCP App "${descriptor.title}" (${descriptor.uri}) is safe to render:`,
        `- sandbox: ${descriptor.sandbox}`,
        `- CSP: ${descriptor.csp}`,
        `- html bytes: ${new TextEncoder().encode(descriptor.srcdoc).length}`,
      ];
      if (descriptor.warnings.length > 0) {
        lines.push(
          `- warnings: ` +
            descriptor.warnings.map((w) => `${w.code}: ${w.message}`).join('; '),
        );
      }
      return truncate(lines.join('\n'));
    },
  };

  return [discoverTool, mrtrTool, taskPollTool, taskCancelTool, scanTool, validateAppTool];
}

/** Unbound placeholders (same pattern as MCP_TOOLS / GIT_TOOLS). */
export const MCP_V097_TOOLS: Tool[] = createMcpV097Tools();
