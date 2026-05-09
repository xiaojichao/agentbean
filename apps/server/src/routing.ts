import type { AgentRuntime } from './registry.js';

export type RouteReason = 'MENTION' | 'FALLBACK' | 'UNKNOWN_MENTION' | 'NO_ONLINE';

export interface RouteInput {
  body: string;
  members: AgentRuntime[];
}

export interface RouteResult {
  targets: AgentRuntime[];
  reason: RouteReason;
}

/**
 * Decide which Agent(s) should receive a human message.
 *
 * Specification (per design §8.2):
 *  - If the message starts with "@<name>" and <name> matches an online member's name
 *    (case-sensitive, trimmed), route only to that member; reason = 'MENTION'.
 *  - If "@<name>" is present but no online member matches, fall back to the first online
 *    member; reason = 'UNKNOWN_MENTION'.
 *  - If no mention is present, route to the first online member; reason = 'FALLBACK'.
 *  - If there are no online members at all, return empty targets; reason = 'NO_ONLINE'.
 */
export function routeHumanMessage(input: RouteInput): RouteResult {
  const online = input.members.filter((m) => m.status === 'online' || m.status === 'busy');
  if (online.length === 0) {
    return { targets: [], reason: 'NO_ONLINE' };
  }

  const m = /^\s*@(\S+)/.exec(input.body);
  if (m) {
    const name = m[1];
    const found = online.find((x) => x.name === name);
    if (found) return { targets: [found], reason: 'MENTION' };
    return { targets: [online[0]!], reason: 'UNKNOWN_MENTION' };
  }
  return { targets: [online[0]!], reason: 'FALLBACK' };
}
