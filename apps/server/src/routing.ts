export type RouteReason = 'MENTION' | 'FALLBACK' | 'UNKNOWN_MENTION' | 'NO_ONLINE';

export interface RouteAgent {
  id: string;
  name: string;
  status: string;
}

export interface RouteInput {
  body: string;
  members: RouteAgent[];
  candidates?: RouteAgent[];
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
 *    or an online global candidate's name (case-sensitive, trimmed), route only to that
 *    member/candidate; reason = 'MENTION'.
 *  - If "@<name>" is present but no online member/candidate matches, do not fall back to
 *    another Agent; reason = 'UNKNOWN_MENTION'.
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
    const onlineCandidates = (input.candidates ?? []).filter((candidate) =>
      candidate.status === 'online' || candidate.status === 'busy'
    );
    const candidate = onlineCandidates.find((x) => x.name === name);
    if (candidate) return { targets: [candidate], reason: 'MENTION' };
    return { targets: [], reason: online.length === 0 ? 'NO_ONLINE' : 'UNKNOWN_MENTION' };
  }
  if (online.length === 0) {
    return { targets: [], reason: 'NO_ONLINE' };
  }
  return { targets: [online[0]!], reason: 'FALLBACK' };
}
