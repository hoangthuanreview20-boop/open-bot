/**
 * A2A multi-tenancy (v1.02, Team T3 — protocol stack).
 *
 * One open-bot process can serve many tenants (teams, users, bots):
 * each tenant gets its own isolated task space — a tenant only sees,
 * lists, cancels and streams its own tasks, and a task created under
 * tenant A is invisible to tenant B (lookups return "not found", never
 * a leak). Tenancy is opt-in: without `multiTenant: true` the server
 * behaves exactly as before (single tenant, `default`).
 *
 * How a tenant is identified, in priority order:
 *   1. `X-A2A-Tenant` HTTP header (the A2A HTTP layer reads it and
 *      passes it as the request context),
 *   2. `_meta.tenantId` in the JSON-RPC params (direct `handleJsonRpc`
 *      callers / embedded mounts),
 *   3. the server's `defaultTenant` option (default `'default'`).
 *
 * Tasks carry an optional `tenantId` field (see `a2a/types.ts`).
 * Tasks created before tenancy have no field and belong to the
 * default tenant, so old persisted tasks stay visible after upgrade.
 *
 * The client sends its tenant with every request: the
 * `X-A2A-Tenant` header plus `_meta.tenantId` in the params, so both
 * the HTTP layer and a direct server see the same tenant.
 */

import type { A2aTask } from './types';

/** Tenant that owns tasks created before tenancy existed. */
export const DEFAULT_A2A_TENANT = 'default';

/** HTTP header carrying the tenant id. */
export const A2A_TENANT_HEADER = 'x-a2a-tenant';

/** Longest allowed tenant id (keeps header + context ids bounded). */
export const A2A_MAX_TENANT_ID_LENGTH = 64;

/** Error thrown when a tenant id is malformed or access is denied. */
export class A2aTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2aTenantError';
  }
}

/**
 * Tenant ids are short, URL/header-safe labels: letters, digits,
 * `.`, `_`, `-` only, 1–64 chars. Anything else is rejected so a
 * tenant id can never smuggle a path separator, a space or a control
 * character into a header, a context id or a file name.
 */
export function isValidA2aTenantId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > A2A_MAX_TENANT_ID_LENGTH) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Normalize a tenant id from any source: missing / blank → the
 * default tenant; invalid → throw (fail fast, never silently fall
 * back to another tenant's space).
 */
export function normalizeA2aTenantId(value: unknown, defaultTenant: string = DEFAULT_A2A_TENANT): string {
  if (value === undefined || value === null) return defaultTenant;
  if (typeof value !== 'string') throw new A2aTenantError('Tenant id phải là chuỗi.');
  const trimmed = value.trim();
  if (trimmed.length === 0) return defaultTenant;
  if (!isValidA2aTenantId(trimmed)) {
    throw new A2aTenantError(
      `Tenant id không hợp lệ: "${trimmed}" — chỉ dùng chữ, số, ".", "_" và "-", tối đa ${A2A_MAX_TENANT_ID_LENGTH} ký tự.`,
    );
  }
  return trimmed;
}

/** Context of one request: which tenant it runs as. */
export interface A2aTenantContext {
  tenantId: string;
}

/** Inputs a tenant can arrive through (header, `_meta`, explicit). */
export interface A2aTenantResolutionInput {
  /** Explicit tenant id (client option / server call). */
  tenantId?: string;
  /** HTTP headers (lower-cased keys) of the request, if any. */
  headers?: Record<string, string | string[] | undefined>;
  /** JSON-RPC `_meta` of the request, if any. */
  meta?: Record<string, unknown>;
  /** Server default when nothing else names a tenant. */
  defaultTenant?: string;
}

function headerTenantId(headers: Record<string, string | string[] | undefined> | undefined): string | undefined {
  if (!headers) return undefined;
  const raw = headers[A2A_TENANT_HEADER];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0) return raw[0];
  return undefined;
}

/**
 * Resolve the tenant for one request. Header wins over `_meta`,
 * `_meta` wins over the explicit id, and the default tenant is the
 * fallback. Throws `A2aTenantError` on a malformed id.
 */
export function resolveA2aTenant(input: A2aTenantResolutionInput = {}): A2aTenantContext {
  const fromHeader = headerTenantId(input.headers);
  const fromMeta = input.meta !== undefined ? input.meta['tenantId'] : undefined;
  const raw = fromHeader ?? fromMeta ?? input.tenantId;
  return { tenantId: normalizeA2aTenantId(raw, input.defaultTenant ?? DEFAULT_A2A_TENANT) };
}

/** Which tenant owns this task (pre-tenancy tasks → default tenant). */
export function tenantOfTask(task: A2aTask, defaultTenant: string = DEFAULT_A2A_TENANT): string {
  if (typeof task.tenantId === 'string' && task.tenantId.length > 0) return task.tenantId;
  return defaultTenant;
}

/** True when this task belongs to this tenant. */
export function taskBelongsToTenant(
  task: A2aTask,
  tenantId: string,
  defaultTenant: string = DEFAULT_A2A_TENANT,
): boolean {
  return tenantOfTask(task, defaultTenant) === tenantId;
}

/**
 * Enforce isolation: return the task when it belongs to the tenant,
 * otherwise undefined (the caller reports "not found" — never reveal
 * that another tenant owns a task with this id).
 */
export function taskForTenant<T extends A2aTask>(
  task: T | undefined,
  tenantId: string,
  defaultTenant: string = DEFAULT_A2A_TENANT,
): T | undefined {
  if (task === undefined) return undefined;
  return taskBelongsToTenant(task, tenantId, defaultTenant) ? task : undefined;
}

/** Only the tasks of this tenant, newest first (input order kept). */
export function filterTasksByTenant<T extends A2aTask>(
  tasks: readonly T[],
  tenantId: string,
  defaultTenant: string = DEFAULT_A2A_TENANT,
): T[] {
  return tasks.filter((task) => taskBelongsToTenant(task, tenantId, defaultTenant));
}

/**
 * Scope a context id to a tenant so two tenants can use the same
 * plain context id without sharing a conversation. The default
 * tenant keeps its bare context id (backward compatible: old
 * `contextId` values still match).
 */
export function scopeA2aContextId(tenantId: string, contextId: string): string {
  if (tenantId === DEFAULT_A2A_TENANT) return contextId;
  return `${tenantId}:${contextId}`;
}

/** Undo `scopeA2aContextId` — returns the plain context id. */
export function unscopeA2aContextId(scopedContextId: string): { tenantId: string; contextId: string } {
  const idx = scopedContextId.indexOf(':');
  if (idx <= 0) return { tenantId: DEFAULT_A2A_TENANT, contextId: scopedContextId };
  const tenantId = scopedContextId.slice(0, idx);
  if (!isValidA2aTenantId(tenantId)) return { tenantId: DEFAULT_A2A_TENANT, contextId: scopedContextId };
  return { tenantId, contextId: scopedContextId.slice(idx + 1) };
}

/** Header map a client sends for one tenant (for `fetch` / HTTP). */
export function a2aTenantHeaders(tenantId: string | undefined): Record<string, string> {
  if (tenantId === undefined || tenantId === DEFAULT_A2A_TENANT) return {};
  return { [A2A_TENANT_HEADER]: normalizeA2aTenantId(tenantId) };
}
