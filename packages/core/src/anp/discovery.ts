/**
 * ANP discovery (v1.02, Team T3).
 *
 * Discovery answers one question: "given a DID or a URL, who is this
 * agent and how do I reach it?" Two mechanisms, both local-first:
 *   1. Local registry lookup — `resolveAnpDid(registry, did)` answers
 *      from agents this machine already knows (no network at all).
 *   2. Well-known document fetch — `discoverAnpAgent(baseUrl)` GETs
 *      `/.well-known/anp/did.json` from the agent itself and validates
 *      the document (id matches the DID, key matches the DID) before
 *      trusting it; the caller decides whether to register the result.
 *
 * This is a stub by design: the ANP spec's remote discovery (peer
 * exchange, relays, signed announcements) is not implemented yet.
 * The shapes are stable — when a remote mechanism lands it plugs in
 * as another `AnpDiscoverySource` without changing callers.
 *
 * Safety: discovery only fetches http(s) URLs, with a short timeout
 * and a small body cap. A discovered document is data until validated;
 * `validateAnpDidDocument` is the gate.
 */

import type { AnpAgentIdentity, AnpAgentRecord, AnpDid, AnpDidDocument } from './types';
import { anpDidDocument, validateAnpDidDocument } from './did';
import { recordForIdentity, type AnpRegistry } from './registry';

/** Path of the well-known DID document below an agent's base URL. */
export const ANP_WELL_KNOWN_DID_PATH = '/.well-known/anp/did.json';

/** Default discovery fetch timeout (ms). */
export const ANP_DISCOVERY_TIMEOUT_MS = 10_000;
/** Largest DID document body accepted (bytes). */
export const ANP_DISCOVERY_MAX_BODY_BYTES = 65_536;

/** Error thrown when discovery fails (network / invalid document). */
export class AnpDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnpDiscoveryError';
  }
}

export type AnpFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Options for `discoverAnpAgent`. */
export interface AnpDiscoverOptions {
  /** Custom fetch (tests inject a fake; default is global fetch). */
  fetchFn?: AnpFetchFn;
  /** Request timeout in ms (default `ANP_DISCOVERY_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Register the discovered agent into this registry when given. */
  registry?: AnpRegistry;
  /** Capability tags to attach to the registered record. */
  skills?: string[];
}

/** What `discoverAnpAgent` found (and registered, when asked). */
export interface AnpDiscoveredAgent {
  record: AnpAgentRecord;
  /** True when the agent was newly registered into the registry. */
  registered: boolean;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fetch and validate the DID document at an agent's well-known path.
 * Throws `AnpDiscoveryError` on network failure, non-2xx status,
 * oversize body, bad JSON or a document that fails validation.
 */
export async function fetchAnpDidDocument(
  baseUrl: string,
  options: { fetchFn?: AnpFetchFn; timeoutMs?: number } = {},
): Promise<AnpDidDocument> {
  if (!isHttpUrl(baseUrl)) {
    throw new AnpDiscoveryError(`ANP discovery chỉ dùng http(s) URL — nhận được "${baseUrl}".`);
  }
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? ANP_DISCOVERY_TIMEOUT_MS;
  const url = new URL(ANP_WELL_KNOWN_DID_PATH, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    throw new AnpDiscoveryError(
      `Không lấy được ANP DID document từ ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new AnpDiscoveryError(`Agent tại ${url} trả HTTP ${res.status} cho ANP DID document.`);
  }
  const text = await res.text();
  if (text.length > ANP_DISCOVERY_MAX_BODY_BYTES) {
    throw new AnpDiscoveryError(`ANP DID document tại ${url} quá lớn (${text.length} byte > ${ANP_DISCOVERY_MAX_BODY_BYTES}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AnpDiscoveryError(`ANP DID document tại ${url} không phải JSON hợp lệ.`);
  }
  const validated = validateAnpDidDocument(parsed);
  if (validated === null) {
    throw new AnpDiscoveryError(`ANP DID document tại ${url} không hợp lệ (id/key không khớp DID).`);
  }
  return parsed as AnpDidDocument;
}

/**
 * Discover an agent by its base URL: fetch its DID document, build a
 * record (name from the document's service or the DID itself — the
 * minimal document carries no display name, so the caller can rename
 * it after discovery), and optionally register it.
 */
export async function discoverAnpAgent(baseUrl: string, options: AnpDiscoverOptions = {}): Promise<AnpDiscoveredAgent> {
  const doc = await fetchAnpDidDocument(baseUrl, options);
  const service = doc.service?.find((s) => s.type === 'A2AEndpoint');
  const name = service?.serviceEndpoint ?? doc.id;
  const record: Omit<AnpAgentRecord, 'registeredAt' | 'updatedAt'> = {
    did: doc.id,
    name,
    url: baseUrl,
    skills: options.skills ?? [],
    didDocument: doc,
  };
  if (options.registry) {
    const already = options.registry.has(doc.id);
    const stored = options.registry.register(record);
    return { record: stored, registered: !already };
  }
  const now = new Date().toISOString();
  return { record: { ...record, registeredAt: now, updatedAt: now }, registered: false };
}

/** Resolve a DID from the local registry (no network). */
export function resolveAnpDid(registry: AnpRegistry, did: AnpDid): AnpAgentRecord | undefined {
  return registry.resolve(did);
}

/**
 * Announce the local identity: build its DID document (with the A2A
 * endpoint when given) and register it in the local registry so other
 * local lookups — and the well-known HTTP handler the caller serves —
 * agree on the same document. Returns the stored record.
 */
export function announceAnpAgent(
  registry: AnpRegistry,
  identity: AnpAgentIdentity,
  options: { url?: string; skills?: string[] } = {},
): AnpAgentRecord {
  const doc = anpDidDocument(identity, options.url);
  return registry.register(recordForIdentity(identity, doc, options));
}

/**
 * Serve helper: the JSON body a caller returns for
 * `GET /.well-known/anp/did.json` for the local identity. The caller
 * owns the HTTP layer; this only builds the (public) document.
 */
export function localAnpDidDocument(identity: AnpAgentIdentity, serviceEndpoint?: string): AnpDidDocument {
  return anpDidDocument(identity, serviceEndpoint);
}
