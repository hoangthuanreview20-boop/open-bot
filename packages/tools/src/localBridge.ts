/**
 * Computer-local bridge (v0.53, P1-7 — REA deep-dive lần 2 §3.3 +
 * §2.5: Grok's `GrokBotUserComputerLocalToolCall` is ONE general
 * local tool — `tool_id` + `input_json` + optional `approval_id` +
 * `conversation_id` + `image_uploads` — routed through the daemon's
 * phone-tool allowlist).
 *
 * Original code, same shape: a single tool, `computer_local_tool`,
 * that dispatches by `tool_id`:
 *   - local file/shell tools (`read-file`, `list-directory`,
 *     `write-file`, `run-command`, `send-input`,
 *     `read-ai-tool-setup`) run on THIS machine — file ops inside
 *     the workspace (`resolveWithin`), shell ops through the
 *     local-exec-daemon (which does its own denylist precheck);
 *   - phone tools (`read-messages`, `send-imessage`,
 *     `run-phone-tool`, `use-app`, `send-mail`) go through an
 *     injectable handler map OR a `PhoneBridge` (phoneBridge.ts).
 *     The bridge checks the REAL pairing state from its transport
 *     (default: no transport configured → no phone paired) and routes
 *     the call to the paired phone when there is one; unpaired is
 *     fail-closed with reason `phone-not-connected`. No phone is
 *     paired and no phone handler is registered by default, so they
 *     answer with a structured "unavailable" result naming what is
 *     missing — never a fake success, never a silent drop.
 *     `read-ai-tool-setup` reports that same real pairing state
 *     (`phoneConnected` / `phoneChannel`) instead of a constant.
 *
 * Every call is allowlist-checked FIRST (`assertPhoneToolAllowed`
 * from daemon/phoneTools — the Grok §2.5 allowlist): an unknown
 * `tool_id` is refused fail-closed before any dispatch.
 * `image_uploads` are workspace-relative paths, validated with
 * `resolveWithin` and stat'ed (only path/exists/size are reported,
 * never file contents). When `verifyApproval` is provided, a given
 * `approval_id` must verify, or the call is refused; without a
 * verifier the id is recorded as unverified and the tool still goes
 * through the loop's normal approval flow (`needsApproval: true`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { resolveWithin } from './sandbox';
import type { ShellDaemon } from './daemon';
import type { PhoneBridge } from './phoneBridge';
import {
  assertPhoneToolAllowed,
  isPhoneToolAllowed,
  PHONE_ONLY_TOOL_IDS,
  PHONE_TOOL_IDS,
} from './daemon/phoneTools';
import { MAX_LOCAL_BRIDGE_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_LOCAL_BRIDGE_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_LOCAL_BRIDGE_RESULT_CHARS };
/** Max attached images per call (Grok carries `image_uploads`, capped here). */
export const MAX_IMAGE_UPLOADS = 10;

export interface LocalBridgeOptions {
  /** Daemon for run-command / send-input (same pattern as shellTools/localTools). */
  getDaemon?: () => ShellDaemon | null | undefined;
  /** Fixed workspace directory (defaults to ctx.workspaceDir). */
  workspaceDir?: string;
  /**
   * Real handlers for phone tools (`send-imessage`, `send-mail`,
   * `use-app`, `run-phone-tool`, `read-messages`). Absent = the tool
   * answers "unavailable" with a clear reason (no phone paired /
   * no connector). Handlers receive the parsed `input_json` object.
   * A handler here wins over `phoneBridge` below (back-compat).
   */
  handlers?: Partial<Record<string, LocalBridgeHandler>>;
  /**
   * Real phone bridge (phoneBridge.ts): checks the REAL pairing state
   * from its transport and routes phone tools to the paired phone.
   * Absent = phone tools answer "unavailable" (`phone-not-connected`).
   * The bridge itself fail-closes when unpaired, so a bridge with no
   * transport configured behaves exactly like no bridge at all.
   */
  phoneBridge?: PhoneBridge;
  /**
   * Verify an `approval_id` against the host's approval store.
   * Absent = ids are recorded but not verified (the loop's own
   * approval flow still gates the tool via `needsApproval`).
   */
  verifyApproval?: (approvalId: string) => boolean | Promise<boolean>;
}

/** What a phone-tool handler returns (structured, JSON-serializable). */
export interface LocalBridgeHandlerResult {
  ok: boolean;
  /** Human-readable result (or reason when ok:false). */
  result?: string;
  /** Machine-readable reason when unavailable / failed. */
  reason?: string;
}

export interface LocalBridgeHandlerContext {
  workspaceDir: string;
  botId: string;
  conversationId?: string;
  approvalId?: string;
  imageUploads: ImageUploadInfo[];
}

export type LocalBridgeHandler = (
  input: Record<string, unknown>,
  ctx: LocalBridgeHandlerContext,
) => Promise<LocalBridgeHandlerResult> | LocalBridgeHandlerResult;

/** One validated image upload (metadata only — never file contents). */
export interface ImageUploadInfo {
  /** Workspace-relative path as given. */
  path: string;
  exists: boolean;
  sizeBytes: number | null;
}


function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function parseInputJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Argument "input_json" must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Argument "input_json" must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function requireInputString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`input_json needs a non-empty string "${name}".`);
  }
  return value;
}

/** Default "unavailable" answer for phone tools with no handler registered. */
function phoneUnavailable(toolId: string): LocalBridgeHandlerResult {
  const reasons: Record<string, string> = {
    'send-imessage':
      'No phone is paired with open-bot, so iMessage cannot be sent from here. ' +
      'On macOS, use the imessage_draft tool to prepare a draft instead.',
    'read-messages':
      'No phone is paired with open-bot, so messages cannot be read from here.',
    'send-mail':
      'No mail connector is wired into the local bridge. Use the email_send tool (Gmail OAuth) instead.',
    'use-app':
      'No phone/desktop app bridge is connected, so no app can be opened from here.',
    'run-phone-tool':
      'No phone is paired with open-bot, so no phone tool can run from here.',
  };
  return {
    ok: false,
    result: `Local tool "${toolId}" is unavailable: ${reasons[toolId] ?? 'no handler is registered for this tool.'}`,
    reason: 'phone-not-connected',
  };
}

export function createLocalBridgeTools(opts: LocalBridgeOptions = {}): Tool[] {
  const resolveWorkspace = (ctx: ToolContext): string => opts.workspaceDir || ctx.workspaceDir;

  function validateImageUploads(
    workspaceDir: string,
    uploads: string[],
  ): ImageUploadInfo[] {
    if (uploads.length > MAX_IMAGE_UPLOADS) {
      throw new Error(
        `Too many image_uploads (${uploads.length}) — max ${MAX_IMAGE_UPLOADS} per call.`,
      );
    }
    return uploads.map((relPath) => {
      if (relPath === '') throw new Error('image_uploads entries must be non-empty paths.');
      const fullPath = resolveWithin(workspaceDir, relPath);
      let sizeBytes: number | null = null;
      let exists = false;
      try {
        const stat = fs.statSync(fullPath);
        exists = stat.isFile();
        sizeBytes = stat.isFile() ? stat.size : null;
      } catch {
        exists = false;
      }
      if (!exists) {
        throw new Error(`image_upload "${relPath}" does not exist in the workspace.`);
      }
      return { path: relPath, exists, sizeBytes };
    });
  }

  const computerLocalTool: Tool = {
    definition: {
      name: 'computer_local_tool',
      description:
        'General computer-local tool bridge (Grok GrokBotUserComputerLocalToolCall shape): ' +
        'run one allowlisted local/phone tool by tool_id with input_json. ' +
        `Allowed tool_id values: ${PHONE_TOOL_IDS.join(', ')}. ` +
        'Local tools run on this machine (read-file / list-directory / write-file inside the workspace; ' +
        'run-command / send-input through the local-exec-daemon). Phone tools (read-messages / send-imessage / ' +
        'run-phone-tool / use-app / send-mail) need a paired phone or connector — pass a PhoneBridge to route ' +
        'them through its transport (pairing is checked for real), otherwise they answer ' +
        '"unavailable" instead of pretending to work. approval_id (optional) links the call to an approval; ' +
        'conversation_id (optional) tags it; image_uploads (optional) are workspace-relative image paths ' +
        'attached to the call (validated, metadata only).',
      parameters: {
        type: 'object',
        properties: {
          tool_id: { type: 'string', description: `One of: ${PHONE_TOOL_IDS.join(', ')}.` },
          input_json: {
            type: 'string',
            description:
              'JSON object for the tool, e.g. run-command: {"command":"echo","args":["hi"]}; ' +
              'read-file: {"path":"notes.txt"}; write-file: {"path":"notes.txt","content":"..."}; ' +
              'list-directory: {"path":"."}; send-input: {"sessionId":"...","input":"..."}; ' +
              'send-imessage: {"to":"+84...","body":"..."}; send-mail: {"to":"a@b.c","subject":"...","body":"..."}; ' +
              'use-app: {"app":"..."}; run-phone-tool: {"name":"...","args":{}}.',
          },
          approval_id: { type: 'string', description: 'Optional approval id this call runs under (verified when the host provides a verifier).' },
          conversation_id: { type: 'string', description: 'Optional conversation id this call belongs to.' },
          image_uploads: {
            type: 'array',
            items: { type: 'string' },
            description: `Optional workspace-relative image paths attached to the call (max ${MAX_IMAGE_UPLOADS}).`,
          },
        },
        required: ['tool_id', 'input_json'],
        additionalProperties: false,
      },
    },
    // It can write files, run commands and send messages — always ask.
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const workspaceDir = resolveWorkspace(ctx);
        const toolId = getStringArg(args, 'tool_id');
        const inputJson = getStringArg(args, 'input_json');
        const approvalId = getOptionalStringArg(args, 'approval_id');
        const conversationId = getOptionalStringArg(args, 'conversation_id');
        const uploads = getStringArrayArg(args, 'image_uploads');

        // 1. Allowlist FIRST (daemon §2.5) — unknown tool_id never reaches a handler.
        try {
          assertPhoneToolAllowed(toolId);
        } catch (err) {
          return errorResult((err as Error).message);
        }
        const input = parseInputJson(inputJson);
        const imageUploads = validateImageUploads(workspaceDir, uploads);

        // 2. Approval link: verify when the host can, record otherwise.
        let approvalVerified: boolean | null = null;
        if (approvalId !== undefined && opts.verifyApproval) {
          approvalVerified = await opts.verifyApproval(approvalId);
          if (!approvalVerified) {
            return errorResult(
              `approval_id "${approvalId}" did not verify — refusing to run local tool "${toolId}".`,
            );
          }
        }

        const handlerCtx: LocalBridgeHandlerContext = {
          workspaceDir,
          botId: ctx.botId,
          ...(conversationId !== undefined ? { conversationId } : {}),
          ...(approvalId !== undefined ? { approvalId } : {}),
          imageUploads,
        };

        // 3. Dispatch.
        const outcome = await dispatchLocalTool(toolId, input, handlerCtx, opts);
        return truncate(
          JSON.stringify(
            {
              ok: outcome.ok,
              tool_id: toolId,
              ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
              ...(approvalId !== undefined ? { approval_id: approvalId } : {}),
              ...(approvalVerified !== null ? { approval_verified: approvalVerified } : {}),
              image_uploads: imageUploads,
              result: outcome.result ?? '',
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [computerLocalTool];
}

async function dispatchLocalTool(
  toolId: string,
  input: Record<string, unknown>,
  ctx: LocalBridgeHandlerContext,
  opts: LocalBridgeOptions,
): Promise<LocalBridgeHandlerResult> {
  const { workspaceDir } = ctx;
  switch (toolId) {
    case 'read-file': {
      const relPath = requireInputString(input, 'path');
      const fullPath = resolveWithin(workspaceDir, relPath);
      let text: string;
      try {
        text = fs.readFileSync(fullPath, 'utf8');
      } catch {
        return { ok: false, result: `Cannot read file "${relPath}" (missing or unreadable).`, reason: 'read-failed' };
      }
      return { ok: true, result: text };
    }
    case 'list-directory': {
      const relPath = typeof input['path'] === 'string' ? (input['path'] as string) : '.';
      const fullPath = resolveWithin(workspaceDir, relPath);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(fullPath, { withFileTypes: true });
      } catch {
        return { ok: false, result: `Cannot list directory "${relPath}" (missing or unreadable).`, reason: 'read-failed' };
      }
      return {
        ok: true,
        result: JSON.stringify(
          entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
          null,
          2,
        ),
      };
    }
    case 'write-file': {
      const relPath = requireInputString(input, 'path');
      const content = requireInputString(input, 'content');
      const fullPath = resolveWithin(workspaceDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      return { ok: true, result: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to "${relPath}".` };
    }
    case 'run-command': {
      const daemon = opts.getDaemon?.();
      if (!daemon) {
        return {
          ok: false,
          result: 'Local daemon is not available, so run-command cannot run (fail-closed).',
          reason: 'daemon-unavailable',
        };
      }
      const command = requireInputString(input, 'command');
      const rawArgs = input['args'];
      const execArgs =
        rawArgs === undefined
          ? []
          : Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === 'string')
            ? (rawArgs as string[])
            : (() => {
                throw new Error('input_json "args" must be an array of strings.');
              })();
      const cwdRaw = input['cwd'];
      const timeoutRaw = input['timeoutMs'];
      let stdout = '';
      let stderr = '';
      const result = await daemon.exec(
        {
          command,
          args: execArgs,
          ...(typeof cwdRaw === 'string' ? { cwd: cwdRaw } : {}),
          ...(typeof timeoutRaw === 'number' ? { timeoutMs: timeoutRaw } : {}),
          workspaceDir,
        },
        {
          onStdout: (chunk) => {
            stdout += chunk;
          },
          onStderr: (chunk) => {
            stderr += chunk;
          },
        },
      );
      return {
        ok: result.exitCode === 0,
        result: JSON.stringify(
          {
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            stdout,
            stderr,
          },
          null,
          2,
        ),
        ...(result.exitCode === 0 ? {} : { reason: 'non-zero-exit' }),
      };
    }
    case 'send-input': {
      const daemon = opts.getDaemon?.();
      if (!daemon) {
        return {
          ok: false,
          result: 'Local daemon is not available, so send-input cannot run (fail-closed).',
          reason: 'daemon-unavailable',
        };
      }
      const sessionId = requireInputString(input, 'sessionId');
      const text = requireInputString(input, 'input');
      const res = await daemon.writeSession(sessionId, text);
      return res.ok
        ? { ok: true, result: `Sent ${text.length} chars to session "${sessionId}".` }
        : { ok: false, result: `Session "${sessionId}" is not open.`, reason: 'session-not-found' };
    }
    case 'read-ai-tool-setup': {
      const daemon = opts.getDaemon?.();
      // Real pairing state from the bridge (never throws — the bridge
      // fail-closes internally). Without a bridge there is no phone.
      const pairing = opts.phoneBridge ? await opts.phoneBridge.getPairingStatus() : null;
      return {
        ok: true,
        result: JSON.stringify(
          {
            platform: process.platform,
            daemonAvailable: daemon !== null && daemon !== undefined,
            allowedTools: PHONE_TOOL_IDS,
            phoneTools: PHONE_ONLY_TOOL_IDS,
            phoneConnected: pairing?.paired ?? false,
            phoneChannel: pairing?.channel ?? 'none',
            ...(pairing?.deviceName ? { phoneDeviceName: pairing.deviceName } : {}),
            ...(pairing?.detail ? { phoneDetail: pairing.detail } : {}),
            note: pairing?.paired
              ? 'Phone tools route through the paired phone bridge.'
              : 'Phone tools report unavailable until a phone is paired or a connector is wired via handlers / phoneBridge.',
          },
          null,
          2,
        ),
      };
    }
    default: {
      // Phone tools (and any future allowlisted id): a registered
      // handler runs it first (back-compat), then the phone bridge
      // (real pairing check + route), otherwise the honest
      // "unavailable" answer.
      if (!isPhoneToolAllowed(toolId)) {
        return { ok: false, result: `Unknown local tool "${toolId}".`, reason: 'not-allowlisted' };
      }
      const handler = opts.handlers?.[toolId];
      if (handler) return handler(input, ctx);
      if (opts.phoneBridge) return opts.phoneBridge.callTool(toolId, input, ctx);
      return phoneUnavailable(toolId);
    }
  }
}

/** Unbound placeholders (same pattern as other tool factories). */
export const LOCAL_BRIDGE_TOOLS: Tool[] = createLocalBridgeTools();
