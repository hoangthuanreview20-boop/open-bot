/**
 * Phone bridge — real handler for the phone tools (v0.59, sóng v0.59+).
 *
 * Problem it solves: `localBridge.ts` used to answer every phone tool
 * (`read-messages`, `send-imessage`, `run-phone-tool`, `use-app`,
 * `send-mail`) with a hardcoded `phone-not-connected`, and the only way
 * to make one work was to inject a per-tool handler function. That
 * proved the dispatch path, but the pairing state was not real — it
 * was a constant.
 *
 * This module makes the pairing state real, without inventing a phone
 * API that does not exist:
 *
 *   - `PhoneTransport` is the replaceable seam. It is the ONLY place
 *     that talks to a phone (or to the daemon that talks to a phone).
 *     Everything above it — pairing check, allowlist, routing, result
 *     normalisation — is transport-independent and fully testable.
 *   - `PhoneBridge` owns the policy: allowlist FIRST, then pairing,
 *     then route. Unpaired (or unreachable transport) is fail-closed:
 *     `{ok:false, reason:'phone-not-connected'}` and the transport's
 *     `callTool` is never invoked — never a fake success.
 *   - `NoPhoneTransport` (the default) reports the true state of this
 *     machine: no phone bridge transport is configured, so no phone is
 *     paired. That is a real reading of local state, not a stub: as
 *     soon as a real transport is plugged in, the same bridge reports
 *     that transport's pairing state instead.
 *   - `SocketPhoneTransport` is one real transport: a local Unix
 *     socket speaking open-bot's OWN JSON-lines bridge protocol
 *     (not any vendor's phone API):
 *       client -> {"type":"pairing"}\n
 *       daemon -> {"paired":true,"channel":"socket","deviceName":"..."} \n
 *       client -> {"type":"tool","toolId":"send-imessage","input":{...},"botId":"..."}\n
 *       daemon -> {"ok":true,"result":"..."} | {"ok":false,"reason":"...","result":"..."} \n
 *     A missing/refusing socket, a timeout, or a malformed reply all
 *     fail closed (unpaired / bridge-error). No daemon implements the
 *     server side yet — the transport is the client half, testable
 *     against a fake socket server (see tests/phone-bridge-v059).
 *
 * What this module deliberately does NOT do: speak iMessage, SMS, or
 * any phone-vendor protocol, or claim a phone is paired when none is.
 * A real phone path (macOS companion, Android bridge, daemon socket)
 * arrives by implementing `PhoneTransport` — the bridge, the
 * allowlist, and `computer_local_tool` do not change.
 */
import * as net from 'node:net';
import type {
  LocalBridgeHandler,
  LocalBridgeHandlerContext,
  LocalBridgeHandlerResult,
} from './localBridge';
import { isPhoneOnlyTool, isPhoneToolAllowed, PHONE_ONLY_TOOL_IDS } from './daemon/phoneTools';

/** Pairing state, as reported by the configured transport (real state). */
export interface PhonePairingStatus {
  /** True only when the transport reports a phone actually paired. */
  paired: boolean;
  /**
   * Which channel the pairing is over: `'none'` (no transport),
   * `'socket'` (local daemon socket), or whatever a real transport
   * reports (e.g. `'macos-companion'`). Never a guess — it comes
   * from the transport.
   */
  channel: string;
  /** Device name when the transport knows it (e.g. "Huy's iPhone"). */
  deviceName?: string;
  /** Human-readable detail (why unpaired, or how the pairing looks). */
  detail?: string;
}

/**
 * The replaceable seam to a phone. Implementations: `NoPhoneTransport`
 * (default — nothing paired), `SocketPhoneTransport` (local daemon
 * socket), or a future real companion transport. A transport MUST NOT
 * fake success: `getPairing` reports what it actually knows, and
 * `callTool` only runs against a paired phone.
 */
export interface PhoneTransport {
  /** Stable id for logs (e.g. `'none'`, `'socket:/tmp/...sock'`). */
  readonly id: string;
  /** Channel label reported in `PhonePairingStatus.channel`. */
  readonly channel: string;
  /** Real pairing state from this transport (never throws — fail-closed inside). */
  getPairing(): Promise<PhonePairingStatus>;
  /** Run one allowlisted phone tool against the paired phone. */
  callTool(
    toolId: string,
    input: Record<string, unknown>,
    ctx: LocalBridgeHandlerContext,
  ): Promise<LocalBridgeHandlerResult>;
}

/** Default transport: no phone bridge is configured on this machine. */
export class NoPhoneTransport implements PhoneTransport {
  readonly id = 'none';
  readonly channel = 'none';

  async getPairing(): Promise<PhonePairingStatus> {
    return {
      paired: false,
      channel: 'none',
      detail:
        'No phone bridge transport is configured, so no phone is paired with open-bot. ' +
        'Plug a PhoneTransport (e.g. a local daemon socket) into PhoneBridge to pair one.',
    };
  }

  async callTool(
    toolId: string,
    _input: Record<string, unknown>,
    _ctx: LocalBridgeHandlerContext,
  ): Promise<LocalBridgeHandlerResult> {
    // Unreachable through PhoneBridge (it checks pairing first), but
    // fail-closed here too so a direct caller can never fake a send.
    return {
      ok: false,
      result: `Local tool "${toolId}" is unavailable: no phone is paired with open-bot.`,
      reason: 'phone-not-connected',
    };
  }
}

export interface SocketPhoneTransportOptions {
  /** Unix socket path the phone-bridge daemon listens on. */
  socketPath: string;
  /** Round-trip timeout, ms. Default 2000. */
  timeoutMs?: number;
}

/**
 * Real transport over a local Unix socket (open-bot's own JSON-lines
 * protocol, see the file header). One connection per request; a
 * missing socket, timeout, or malformed reply fails closed and never
 * throws out of `getPairing` / `callTool`.
 */
export class SocketPhoneTransport implements PhoneTransport {
  readonly id: string;
  readonly channel = 'socket';
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(opts: SocketPhoneTransportOptions) {
    if (typeof opts.socketPath !== 'string' || opts.socketPath === '') {
      throw new Error('SocketPhoneTransport needs a non-empty socketPath.');
    }
    this.socketPath = opts.socketPath;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.id = `socket:${opts.socketPath}`;
  }

  async getPairing(): Promise<PhonePairingStatus> {
    let reply: unknown;
    try {
      reply = await this.roundTrip({ type: 'pairing' });
    } catch (err) {
      return {
        paired: false,
        channel: 'socket',
        detail: `Phone bridge socket unreachable at ${this.socketPath}: ${(err as Error).message}`,
      };
    }
    if (typeof reply !== 'object' || reply === null || typeof (reply as { paired?: unknown }).paired !== 'boolean') {
      return {
        paired: false,
        channel: 'socket',
        detail: `Phone bridge socket at ${this.socketPath} answered pairing with a malformed reply.`,
      };
    }
    const r = reply as { paired: boolean; channel?: unknown; deviceName?: unknown; detail?: unknown };
    return {
      paired: r.paired,
      channel: typeof r.channel === 'string' && r.channel !== '' ? r.channel : 'socket',
      ...(typeof r.deviceName === 'string' ? { deviceName: r.deviceName } : {}),
      ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
    };
  }

  async callTool(
    toolId: string,
    input: Record<string, unknown>,
    ctx: LocalBridgeHandlerContext,
  ): Promise<LocalBridgeHandlerResult> {
    let reply: unknown;
    try {
      reply = await this.roundTrip({
        type: 'tool',
        toolId,
        input,
        botId: ctx.botId,
        ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
        ...(ctx.approvalId !== undefined ? { approvalId: ctx.approvalId } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        result: `Phone tool "${toolId}" failed: bridge socket error: ${(err as Error).message}`,
        reason: 'phone-bridge-error',
      };
    }
    if (typeof reply !== 'object' || reply === null || typeof (reply as { ok?: unknown }).ok !== 'boolean') {
      return {
        ok: false,
        result: `Phone tool "${toolId}" failed: bridge answered with a malformed reply.`,
        reason: 'phone-bridge-error',
      };
    }
    const r = reply as { ok: boolean; result?: unknown; reason?: unknown };
    return {
      ok: r.ok,
      result: typeof r.result === 'string' ? r.result : r.result === undefined ? '' : JSON.stringify(r.result),
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    };
  }

  /** One JSON line out, one JSON line back (or an error). */
  private roundTrip(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy(new Error(`Phone bridge socket timed out after ${this.timeoutMs}ms.`));
          reject(new Error(`Phone bridge socket timed out after ${this.timeoutMs}ms.`));
        }
      }, this.timeoutMs);
      let buffer = '';
      const done = (err: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      socket.on('connect', () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      });
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl >= 0) {
          const line = buffer.slice(0, nl);
          try {
            done(null, JSON.parse(line) as unknown);
          } catch {
            done(new Error('Phone bridge socket answered with invalid JSON.'));
          }
        }
      });
      socket.on('error', (err: Error) => done(err));
      socket.on('close', () => done(new Error('Phone bridge socket closed before replying.')));
    });
  }
}

/**
 * The bridge: policy over a transport. Order is fixed — allowlist,
 * then pairing, then route — so an unknown tool or an unpaired phone
 * can never reach the transport, and an unpaired phone can never
 * produce a fake success.
 */
export class PhoneBridge {
  private readonly transport: PhoneTransport;

  constructor(transport: PhoneTransport = new NoPhoneTransport()) {
    this.transport = transport;
  }

  /** Which transport this bridge routes through (for status/debug). */
  getTransportId(): string {
    return this.transport.id;
  }

  /** Real pairing state from the transport (never throws). */
  async getPairingStatus(): Promise<PhonePairingStatus> {
    try {
      const status = await this.transport.getPairing();
      if (typeof status !== 'object' || status === null || typeof status.paired !== 'boolean') {
        return {
          paired: false,
          channel: this.transport.channel,
          detail: `Phone transport "${this.transport.id}" answered pairing with a malformed reply.`,
        };
      }
      return status;
    } catch (err) {
      return {
        paired: false,
        channel: this.transport.channel,
        detail: `Phone pairing check failed: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Run one phone tool. Fail-closed at every step: not allowlisted →
   * `not-allowlisted`; not a phone tool → `not-a-phone-tool`; not
   * paired → `phone-not-connected` (transport never called); transport
   * error / malformed result → `phone-bridge-error`.
   */
  async callTool(
    toolId: string,
    input: Record<string, unknown>,
    ctx: LocalBridgeHandlerContext,
  ): Promise<LocalBridgeHandlerResult> {
    if (!isPhoneToolAllowed(toolId)) {
      return {
        ok: false,
        result: `Unknown local tool "${toolId}" — refused (not on the daemon phone-tool allowlist: ${PHONE_ONLY_TOOL_IDS.join(', ')}).`,
        reason: 'not-allowlisted',
      };
    }
    if (!isPhoneOnlyTool(toolId)) {
      return {
        ok: false,
        result: `Local tool "${toolId}" is not a phone tool — it runs on this machine, not through the phone bridge.`,
        reason: 'not-a-phone-tool',
      };
    }
    const pairing = await this.getPairingStatus();
    if (!pairing.paired) {
      const where = pairing.channel === 'none' ? '' : ` (channel: ${pairing.channel})`;
      return {
        ok: false,
        result:
          `Local tool "${toolId}" is unavailable: no phone is paired with open-bot${where}. ` +
          (pairing.detail ?? 'Pair a phone (or configure a phone bridge transport) first.'),
        reason: 'phone-not-connected',
      };
    }
    let result: LocalBridgeHandlerResult;
    try {
      result = await this.transport.callTool(toolId, input, ctx);
    } catch (err) {
      return {
        ok: false,
        result: `Phone tool "${toolId}" failed: ${(err as Error).message}`,
        reason: 'phone-bridge-error',
      };
    }
    if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') {
      return {
        ok: false,
        result: `Phone tool "${toolId}" failed: transport answered with a malformed result.`,
        reason: 'phone-bridge-error',
      };
    }
    return result;
  }
}

/** Convenience factory (default transport = none paired). */
export function createPhoneBridge(transport?: PhoneTransport): PhoneBridge {
  return new PhoneBridge(transport);
}

function requireBridgeString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`input_json needs a non-empty string "${name}".`);
  }
  return value;
}

/**
 * Per-tool `LocalBridgeHandler`s backed by a bridge — for hosts that
 * wire phone tools through the `handlers` map instead of passing the
 * bridge itself. Each handler validates its own required fields, then
 * delegates to `bridge.callTool` (which re-checks allowlist + pairing,
 * so a handler can never bypass them). A handler in the map still wins
 * over the bridge in `localBridge.ts` — this factory is only for
 * callers that want bridge-backed handlers explicitly.
 */
export function createPhoneToolHandlers(bridge: PhoneBridge): Partial<Record<string, LocalBridgeHandler>> {
  const handlers: Partial<Record<string, LocalBridgeHandler>> = {};
  handlers['send-imessage'] = async (input, ctx) => {
    requireBridgeString(input, 'to');
    requireBridgeString(input, 'body');
    return bridge.callTool('send-imessage', input, ctx);
  };
  handlers['read-messages'] = async (input, ctx) => bridge.callTool('read-messages', input, ctx);
  handlers['send-mail'] = async (input, ctx) => {
    requireBridgeString(input, 'to');
    requireBridgeString(input, 'subject');
    requireBridgeString(input, 'body');
    return bridge.callTool('send-mail', input, ctx);
  };
  handlers['use-app'] = async (input, ctx) => {
    requireBridgeString(input, 'app');
    return bridge.callTool('use-app', input, ctx);
  };
  handlers['run-phone-tool'] = async (input, ctx) => {
    requireBridgeString(input, 'name');
    return bridge.callTool('run-phone-tool', input, ctx);
  };
  return handlers;
}
