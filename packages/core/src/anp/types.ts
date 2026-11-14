/**
 * ANP (Agent Network Protocol) — shared types (v1.02, Team T3).
 *
 * ANP is the discovery layer above A2A/MCP: agents find each other by
 * decentralized identity (DID) instead of a central directory. This is
 * a deliberately small, extensible stub — the ANP spec is still
 * evolving, so open-bot implements only the stable core:
 *   - `did:key` identity from an Ed25519 key (see `anp/did.ts`),
 *   - a minimal DID document (see `anp/did.ts`),
 *   - a local registry + well-known document fetch (see
 *     `anp/registry.ts` and `anp/discovery.ts`).
 *
 * Nothing here copies another implementation: the shapes are written
 * from the DID Core / `did:key` method descriptions (public specs)
 * and the ANP idea of "DID document + discovery", with open-bot's own
 * field layout. Remote ANP protocols (peer DID exchange, signed
 * announcements over the network) are future work — the registry and
 * discovery interfaces are built to accept them without breaking.
 *
 * Private keys NEVER leave this machine: only the public DID document
 * is shared (registered or served over HTTP).
 */

/** A `did:key:...` identifier. */
export type AnpDid = string;

/** One verification method inside a DID document (Ed25519 only). */
export interface AnpVerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: AnpDid;
  /** Raw 32-byte Ed25519 public key, base64 (NOT base64url). */
  publicKeyBase64: string;
}

/** One service endpoint advertised in a DID document. */
export interface AnpServiceEndpoint {
  id: string;
  type: string;
  /** Endpoint URL, e.g. the agent's A2A base URL. */
  serviceEndpoint: string;
}

/**
 * Minimal DID document: id, one verification method, authentication
 * and optional service endpoints. Enough for another agent to verify
 * a signature from this identity and to reach its A2A endpoint.
 */
export interface AnpDidDocument {
  '@context': string[];
  id: AnpDid;
  verificationMethod: AnpVerificationMethod[];
  authentication: string[];
  service?: AnpServiceEndpoint[];
}

/** A local ANP identity: DID + keypair. The private key stays local. */
export interface AnpAgentIdentity {
  /** `did:key:z...` derived from the public key. */
  did: AnpDid;
  /** Human-readable agent name (local label, not part of the DID). */
  name: string;
  /** Ed25519 public key, base64 of the raw 32 bytes. */
  publicKeyBase64: string;
  /** Ed25519 private key, PKCS#8 PEM — NEVER share or log. */
  privateKeyPem: string;
  /** ISO-8601 creation time. */
  createdAt: string;
}

/** One agent known to the local ANP registry. */
export interface AnpAgentRecord {
  did: AnpDid;
  name: string;
  /** A2A base URL of the agent, when known. */
  url?: string;
  /** Capability / skill tags (free-form, e.g. `['chat', 'code']`). */
  skills: string[];
  /** The agent's DID document (public part only). */
  didDocument: AnpDidDocument;
  /** ISO-8601 first registration. */
  registeredAt: string;
  /** ISO-8601 last update. */
  updatedAt: string;
}

/** Query for `AnpRegistry.find()`. Every field is optional. */
export interface AnpDiscoveryQuery {
  /** Only agents advertising this skill/capability tag. */
  skill?: string;
  /** Case-insensitive substring over the agent name. */
  nameContains?: string;
  /** Max records returned (default 50). */
  limit?: number;
}
