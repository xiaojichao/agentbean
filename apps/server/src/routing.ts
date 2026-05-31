export type RouteReason = 'MENTION' | 'HUMAN_MENTION' | 'FALLBACK' | 'UNKNOWN_MENTION' | 'NO_ONLINE';

export interface RouteAgent {
  id: string;
  name: string;
  status: string;
}

export interface RouteInput {
  body: string;
  members: RouteAgent[];
  humans?: { id: string; name: string }[];
}

export interface RouteResult {
  targets: RouteAgent[];
  reason: RouteReason;
}

/**
 * Decide which Agent(s) should receive a human message.
 *
 * Specification (per design §8.2):
 *  - If the message starts with "@<name>" and <name> matches an online member's name
 *    (case-sensitive, trimmed), route only to that member; reason = 'MENTION'.
 *  - If "@<name>" is present but no online member matches, do not fall back to
 *    another Agent; reason = 'UNKNOWN_MENTION'.
 *  - If "@<name>" matches a human member instead of an Agent, do not dispatch to an Agent
 *    and do not report an Agent lookup error; reason = 'HUMAN_MENTION'.
 *  - If no mention is present, route to the first online member; reason = 'FALLBACK'.
 *  - If there are no online members at all, return empty targets; reason = 'NO_ONLINE'.
 */
export function routeHumanMessage(input: RouteInput): RouteResult {
  const online = input.members.filter((m) => m.status === 'online' || m.status === 'busy');
  const m = /^\s*@(\S+)/.exec(input.body);
  if (m) {
    const name = m[1];
    const found = online.find((x) => x.name === name);
    if (found) return { targets: [found], reason: 'MENTION' };
    const human = (input.humans ?? []).find((x) => x.name === name);
    if (human) return { targets: [], reason: 'HUMAN_MENTION' };
    return { targets: [], reason: online.length === 0 ? 'NO_ONLINE' : 'UNKNOWN_MENTION' };
  }
  if (online.length === 0) {
    return { targets: [], reason: 'NO_ONLINE' };
  }
  return { targets: [online[0]!], reason: 'FALLBACK' };
}
