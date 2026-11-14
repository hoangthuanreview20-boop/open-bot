/**
 * Agent Card builder + validator (v1.02 rescue port of the v1.00
 * work).
 *
 * A2A v1.0 (12 March 2026) defines the Agent Card as the document a
 * client reads before delegating work: name, description, endpoint
 * URL, capabilities, skills. `buildAgentCard` constructs one from
 * the pieces (filling the A2A defaults); `validateAgentCard`
 * fail-closes on a card that is missing the required fields or has
 * the wrong shapes. Signing itself lives in `signing.ts`
 * (Ed25519 over canonical JSON); this module only builds and
 * validates the unsigned card.
 */

import type { A2aAgentCard, A2aAgentSkill } from './types';

export interface AgentCardInput {
  name: string;
  description: string;
  url: string;
  version?: string;
  protocolVersion?: string;
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  skills?: A2aAgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

/** Default protocol version written into a built card. */
export const A2A_CARD_PROTOCOL_VERSION = '1.0';

/** Build an Agent Card from its pieces (A2A defaults filled in). */
export function buildAgentCard(input: AgentCardInput): A2aAgentCard {
  if (!input.name.trim()) throw new Error('Agent Card needs a name.');
  if (!input.description.trim()) throw new Error('Agent Card needs a description.');
  if (!/^https?:\/\//i.test(input.url)) throw new Error('Agent Card url must be http(s).');
  return {
    name: input.name,
    description: input.description,
    ...(input.version ? { version: input.version } : {}),
    url: input.url,
    protocolVersion: input.protocolVersion ?? A2A_CARD_PROTOCOL_VERSION,
    capabilities: {
      streaming: input.streaming ?? false,
      pushNotifications: input.pushNotifications ?? false,
      stateTransitionHistory: input.stateTransitionHistory ?? false,
    },
    defaultInputModes: input.defaultInputModes ?? ['text'],
    defaultOutputModes: input.defaultOutputModes ?? ['text'],
    skills: input.skills ?? [],
    supportedInterfaces: [
      { url: input.url, protocolBinding: 'JSONRPC', protocolVersion: input.protocolVersion ?? A2A_CARD_PROTOCOL_VERSION },
    ],
  };
}

/** Validate a parsed Agent Card (returns the problems, empty = valid). */
export function validateAgentCard(card: unknown): string[] {
  const problems: string[] = [];
  if (typeof card !== 'object' || card === null) return ['card is not an object'];
  const record = card as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.trim() === '') problems.push('card.name is missing');
  if (typeof record.description !== 'string' || record.description.trim() === '') {
    problems.push('card.description is missing');
  }
  if (typeof record.url !== 'string' || !/^https?:\/\//i.test(record.url)) {
    problems.push('card.url must be an http(s) URL');
  }
  if (record.skills !== undefined) {
    if (!Array.isArray(record.skills)) problems.push('card.skills must be an array');
    else {
      for (const skill of record.skills) {
        if (typeof skill !== 'object' || skill === null) {
          problems.push('card.skills entries must be objects');
          break;
        }
        const entry = skill as Record<string, unknown>;
        if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.description !== 'string') {
          problems.push('card.skills entries need id, name and description');
          break;
        }
      }
    }
  }
  if (record.capabilities !== undefined && typeof record.capabilities !== 'object') {
    problems.push('card.capabilities must be an object');
  }
  return problems;
}

/** True when the card passes validation. */
export function isValidAgentCard(card: unknown): card is A2aAgentCard {
  return validateAgentCard(card).length === 0;
}
