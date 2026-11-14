/**
 * Gateway configuration store (v1.02 rescue port of the v1.00 work).
 *
 * JSON file store (atomic temp + rename, mode 0600). A corrupt file
 * loads as the default config (all channels disabled — fail-closed,
 * never half-enabled). Tokens are NOT stored here; they live in the
 * Vault under namespace 'gateway' (see `types.ts`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  GATEWAY_CHANNELS,
  defaultGatewayConfig,
  type GatewayChannelConfig,
  type GatewayChannelId,
  type GatewayConfig,
} from './types';

/** File-backed gateway configuration. */
export class GatewayConfigStore {
  private readonly filePath: string;
  private config: GatewayConfig;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.config = this.load();
  }

  get(): GatewayConfig {
    return structuredClone(this.config);
  }

  /** Replace the whole config (validated: version + all channels present). */
  set(config: GatewayConfig): GatewayConfig {
    this.config = normalizeGatewayConfig(config);
    this.persist();
    return this.get();
  }

  /** Change one channel's config (merged over the current one). */
  setChannel(channel: GatewayChannelId, partial: Partial<GatewayChannelConfig>): GatewayChannelConfig {
    const current = this.config.channels[channel];
    const next: GatewayChannelConfig = { ...current, ...partial, channel };
    this.config.channels[channel] = next;
    this.persist();
    return { ...next };
  }

  getChannel(channel: GatewayChannelId): GatewayChannelConfig {
    return { ...this.config.channels[channel] };
  }

  /** Enable/disable one channel. */
  setChannelEnabled(channel: GatewayChannelId, enabled: boolean): GatewayChannelConfig {
    return this.setChannel(channel, { enabled });
  }

  private load(): GatewayConfig {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return normalizeGatewayConfig(parsed as GatewayConfig);
      }
    } catch {
      // Missing or corrupt: default (all channels disabled).
    }
    return defaultGatewayConfig();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Config is best-effort; a failed write must not break the gateway.
    }
  }
}

/** Fill missing channels / fields with defaults (unknown fields dropped). */
export function normalizeGatewayConfig(input: GatewayConfig): GatewayConfig {
  const base = defaultGatewayConfig();
  const channels = { ...base.channels };
  if (typeof input.channels === 'object' && input.channels !== null) {
    for (const channel of GATEWAY_CHANNELS) {
      const raw = (input.channels as Record<string, unknown>)[channel];
      if (typeof raw === 'object' && raw !== null) {
        const entry = raw as Partial<GatewayChannelConfig>;
        channels[channel] = {
          channel,
          enabled: entry.enabled === true,
          ...(entry.mock === true ? { mock: true } : {}),
          ...(typeof entry.botName === 'string' ? { botName: entry.botName } : {}),
          ...(typeof entry.webhookPath === 'string' ? { webhookPath: entry.webhookPath } : {}),
        };
      }
    }
  }
  return {
    version: 1,
    channels,
    ...(typeof input.defaultBotId === 'string' ? { defaultBotId: input.defaultBotId } : {}),
    maxHistoryPerSession:
      typeof input.maxHistoryPerSession === 'number' && input.maxHistoryPerSession > 0
        ? Math.floor(input.maxHistoryPerSession)
        : base.maxHistoryPerSession,
  };
}
