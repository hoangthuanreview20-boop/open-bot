/**
 * Machine policy (v0.7, ROADMAP §2a: "ghim backend/website qua policy
 * của máy").
 *
 * File `<userData>/policy.json` (optional, written by an admin / MDM,
 * NOT by the app). When absent, everything behaves as before.
 *
 *   {
 *     "backendBaseUrl": "https://llm.cong-ty.local/v1",
 *     "allowedProviders": ["xai", "ollama"],
 *     "disableTelemetry": true
 *   }
 *
 * Semantics:
 *  - `backendBaseUrl`: overrides the DEFAULT baseUrl of every allowed
 *    provider except local ones (ollama) — a company self-hosts its
 *    own OpenAI-compatible backend and points the app at it. An
 *    explicit per-provider baseUrl the USER typed in Settings still
 *    wins over the policy default (policy pins the default, it does
 *    not confiscate user settings).
 *  - `allowedProviders`: only these providers are offered/usable.
 *    Unknown ids are ignored (not an error — a policy written for a
 *    newer version must not break an older app).
 *  - `disableTelemetry`: recorded and honoured (the app currently
 *    sends no telemetry at all, so this is a no-op guard for the
 *    future — the flag is still read and exposed).
 *
 * Invalid file (bad JSON / wrong types) does NOT break startup: the
 * policy is ignored and the errors are returned for the host to log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const POLICY_FILE = 'policy.json';

/** Provider ids that run locally and must never be re-pointed at a remote backend. */
const LOCAL_PROVIDERS = new Set(['ollama']);

export interface MachinePolicy {
  backendBaseUrl?: string;
  allowedProviders?: string[];
  disableTelemetry?: boolean;
}

export interface LoadPolicyResult {
  /** Null when no policy.json exists, or when it exists but is invalid. */
  policy: MachinePolicy | null;
  /** Why an existing file was ignored (empty when the policy loaded). */
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse + validate raw policy content; returns errors instead of throwing. */
export function parsePolicy(raw: unknown): LoadPolicyResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { policy: null, errors: ['Policy phải là một JSON object.'] };
  const policy: MachinePolicy = {};
  if (raw['backendBaseUrl'] !== undefined) {
    if (typeof raw['backendBaseUrl'] !== 'string' || !raw['backendBaseUrl'].trim()) {
      errors.push('Policy "backendBaseUrl" phải là chuỗi không rỗng.');
    } else {
      try {
        const url = new URL(raw['backendBaseUrl'].trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          errors.push('Policy "backendBaseUrl" phải bắt đầu bằng http:// hoặc https://.');
        } else {
          policy.backendBaseUrl = url.toString().replace(/\/$/, '');
        }
      } catch {
        errors.push('Policy "backendBaseUrl" không phải URL hợp lệ.');
      }
    }
  }
  if (raw['allowedProviders'] !== undefined) {
    if (
      !Array.isArray(raw['allowedProviders']) ||
      raw['allowedProviders'].some((p) => typeof p !== 'string' || !p.trim())
    ) {
      errors.push('Policy "allowedProviders" phải là mảng chuỗi không rỗng.');
    } else {
      policy.allowedProviders = (raw['allowedProviders'] as string[]).map((p) => p.trim());
    }
  }
  if (raw['disableTelemetry'] !== undefined) {
    if (typeof raw['disableTelemetry'] !== 'boolean') {
      errors.push('Policy "disableTelemetry" phải là true/false.');
    } else {
      policy.disableTelemetry = raw['disableTelemetry'];
    }
  }
  if (errors.length > 0) return { policy: null, errors };
  return { policy, errors };
}

/** Read `<dir>/policy.json` when it exists; missing file = no policy (not an error). */
export function loadPolicy(dir: string): LoadPolicyResult {
  const filePath = path.join(dir, POLICY_FILE);
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { policy: null, errors: [] };
    return { policy: null, errors: [`Không đọc được policy.json: ${(err as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { policy: null, errors: ['policy.json không phải JSON hợp lệ — bỏ qua policy.'] };
  }
  return parsePolicy(parsed);
}

/** Is this provider allowed under the policy (no policy = all allowed)? */
export function isProviderAllowed(policy: MachinePolicy | null, providerId: string): boolean {
  if (!policy?.allowedProviders) return true;
  return policy.allowedProviders.includes(providerId);
}

/**
 * Effective default baseUrl for a provider: the policy backend when
 * the policy pins one and the provider is allowed + not local,
 * otherwise the built-in default. A user-typed baseUrl (passed as
 * `userBaseUrl`) always wins over both.
 */
export function effectiveBaseUrl(
  policy: MachinePolicy | null,
  providerId: string,
  builtInDefault: string,
  userBaseUrl?: string,
): string {
  if (userBaseUrl && userBaseUrl.trim()) return userBaseUrl.trim();
  if (
    policy?.backendBaseUrl &&
    isProviderAllowed(policy, providerId) &&
    !LOCAL_PROVIDERS.has(providerId)
  ) {
    return policy.backendBaseUrl;
  }
  return builtInDefault;
}
