import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function workspaceCwdHash(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex');
}

export function localMemoryDedupeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
