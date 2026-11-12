/**
 * Load MCP server config from `<workspaceDir>/.open-bot/mcp.json`.
 *
 * File format:
 *   { "servers": { "<name>": {
 *       "command": "npx", "args": ["-y", "some-mcp-server"],
 *       "env": { "FOO": "bar" },
 *       "url": "https://example.com/mcp",
 *       "headers": { "Authorization": "Bearer <token>" }
 *   } } }
 *
 * A server uses stdio when it has `command`, streamable HTTP when it has
 * `url` (stdio wins if both are set).
 *
 * Security:
 *  - Missing file → `{ servers: {} }` (no servers configured, not an error).
 *  - Invalid JSON / bad shape → a clear Error (the file content is never
 *    echoed back, so a token pasted in the file cannot leak via the error).
 *  - Auth limitation (v0.2): NO OAuth flow. Only a static `Authorization`
 *    header the user typed into mcp.json themselves is supported. This
 *    file lives in `.open-bot/` and must never be committed — it can hold
 *    secrets. This loader never logs header/token values and never reads
 *    secrets from any other file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpConfig, McpServerConfig } from './types';

export const MCP_CONFIG_REL_PATH = path.join('.open-bot', 'mcp.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringRecord(value: unknown, field: string, serverName: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Invalid MCP config: server "${serverName}": "${field}" must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== 'string') {
      throw new Error(
        `Invalid MCP config: server "${serverName}": "${field}.${key}" must be a string`,
      );
    }
    out[key] = val;
  }
  return out;
}

function validateServer(name: string, raw: unknown): McpServerConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid MCP config: server "${name}" must be an object`);
  }
  const command = raw['command'];
  const url = raw['url'];
  if (command !== undefined && typeof command !== 'string') {
    throw new Error(`Invalid MCP config: server "${name}": "command" must be a string`);
  }
  if (url !== undefined && typeof url !== 'string') {
    throw new Error(`Invalid MCP config: server "${name}": "url" must be a string`);
  }
  if ((!command || !command.trim()) && (!url || !url.trim())) {
    throw new Error(
      `Invalid MCP config: server "${name}" must have "command" (stdio) or "url" (streamable HTTP)`,
    );
  }
  if (typeof url === 'string' && url.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid MCP config: server "${name}": "url" is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Invalid MCP config: server "${name}": "url" must be http:// or https://`,
      );
    }
  }
  const args = raw['args'];
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new Error(`Invalid MCP config: server "${name}": "args" must be an array of strings`);
    }
  }
  const config: McpServerConfig = {
    name:
      typeof raw['name'] === 'string' && raw['name'].trim() ? (raw['name'] as string) : name,
  };
  if (typeof command === 'string' && command.trim()) config.command = command;
  if (Array.isArray(args)) config.args = [...(args as string[])];
  if (raw['env'] !== undefined) config.env = validateStringRecord(raw['env'], 'env', name);
  if (typeof url === 'string' && url.trim()) config.url = url;
  if (raw['headers'] !== undefined) {
    config.headers = validateStringRecord(raw['headers'], 'headers', name);
  }
  return config;
}

export function loadMcpConfig(workspaceDir: string): McpConfig {
  const filePath = path.join(workspaceDir, MCP_CONFIG_REL_PATH);
  if (!fs.existsSync(filePath)) return { servers: {} };
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read MCP config at ${MCP_CONFIG_REL_PATH}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid MCP config at ${MCP_CONFIG_REL_PATH}: not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid MCP config at ${MCP_CONFIG_REL_PATH}: top level must be an object with a "servers" field`);
  }
  const serversRaw = parsed['servers'];
  if (serversRaw === undefined) return { servers: {} };
  if (!isRecord(serversRaw)) {
    throw new Error(`Invalid MCP config at ${MCP_CONFIG_REL_PATH}: "servers" must be an object`);
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(serversRaw)) {
    servers[name] = validateServer(name, raw);
  }
  return { servers };
}

/**
 * v0.14: add one MCP server to `<workspaceDir>/.open-bot/mcp.json` when
 * it is not there yet (plugin bundles declare their MCP server in the
 * bundle manifest; installing the bundle wires it in like a user editing
 * mcp.json by hand). An existing server with the SAME name is NEVER
 * overwritten — the user's own config wins; the caller logs the outcome.
 * Returns `{ added: true }` when the file was written, otherwise
 * `{ added: false, reason: 'already-present' | 'exists-different' }`.
 * Secrets in `config` (e.g. a static Authorization header) are written
 * to the file as-is — mcp.json lives in `.open-bot/` and must never be
 * committed; this function never logs the config.
 */
export function ensureMcpServer(
  workspaceDir: string,
  name: string,
  config: McpServerConfig,
): { added: boolean; reason?: 'already-present' | 'exists-different' } {
  const current = loadMcpConfig(workspaceDir);
  const existing = current.servers[name];
  if (existing) {
    return {
      added: false,
      reason:
        JSON.stringify(existing) === JSON.stringify(config)
          ? 'already-present'
          : 'exists-different',
    };
  }
  const filePath = path.join(workspaceDir, MCP_CONFIG_REL_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next: McpConfig = { servers: { ...current.servers, [name]: config } };
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return { added: true };
}
