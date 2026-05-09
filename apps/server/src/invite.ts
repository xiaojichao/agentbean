import { randomBytes } from 'node:crypto';

export function generateInviteCode(length = 8): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}
