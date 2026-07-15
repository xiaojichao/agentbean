import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function workspaceCwdHash(cwd: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(cwd);
  } catch {
    canonical = resolve(cwd);
  }
  return createHash('sha256').update(canonical).digest('hex');
}

export function localMemoryDedupeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
