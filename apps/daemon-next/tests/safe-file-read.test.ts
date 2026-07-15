import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { readRegularFileNoFollow, SafeFileReadError } from '../src/memory/safe-file-read';

describe('safe file read', () => {
  test('模拟 Windows 无 O_NOFOLLOW 时以 lstat/realpath/fstat identity 读取同一 handle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbean-safe-read-fallback-'));
    const file = join(root, 'items.json');
    writeFileSync(file, '{"ok":true}', { mode: 0o600 });

    const snapshot = await readRegularFileNoFollow(file, 128, { forceIdentityFallback: true });

    expect(snapshot.data.toString('utf8')).toBe('{"ok":true}');
    expect(snapshot.metadata.isFile()).toBe(true);
  });

  test('模拟 Windows fallback 时 final symlink 必须 fail closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbean-safe-read-symlink-'));
    const outside = join(root, 'outside.json');
    const linked = join(root, 'linked.json');
    writeFileSync(outside, '{"secret":true}');
    symlinkSync(outside, linked);

    await expect(readRegularFileNoFollow(linked, 128, { forceIdentityFallback: true }))
      .rejects.toBeInstanceOf(SafeFileReadError);
  });
});
