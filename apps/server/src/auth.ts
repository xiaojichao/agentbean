export interface ParsedToken {
  userId: string;
  networkId: string;
  random: string;
}

export function parseToken(token: string): ParsedToken | null {
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  return { userId: parts[0]!, networkId: parts[1]!, random: parts[2]! };
}

export function generateToken(userId: string, networkId: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${userId}:${networkId}:${random}`;
}

export function verifyUserToken(
  token: string,
  globalDb: { users: { get(id: string): { id: string } | null } },
): ParsedToken | null {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const user = globalDb.users.get(parsed.userId);
  if (!user) return null;
  return parsed;
}
