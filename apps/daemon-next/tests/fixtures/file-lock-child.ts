import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { withLocalMemoryFileLock } from '../../src/memory/file-lock.js';

const [lockFile, mode = 'hold', holdText = '250'] = process.argv.slice(2);
if (!lockFile) throw new Error('lock file required');
const holdMs = Number(holdText);

if (mode === 'partial-create') {
  writeFileSync(`${lockFile}.owner-tmp-crash-${process.pid}`, '{"schemaVersion":2,"ownerToken":', {
    mode: 0o600,
  });
  process.stdout.write('READY\n');
  process.exit(18);
}

if (mode === 'malformed-lock') {
  writeFileSync(lockFile, '{"schemaVersion":2,"ownerToken":', { mode: 0o600 });
  process.stdout.write('READY\n');
  process.exit(20);
}

await withLocalMemoryFileLock(lockFile, async () => {
  process.stdout.write('READY\n');
  if (mode === 'crash') {
    await delay(20);
    process.exit(17);
  }
  if (mode === 'partial-heartbeat') {
    const owner = JSON.parse(readFileSync(lockFile, 'utf8')) as { ownerToken: string };
    writeFileSync(`${lockFile}.heartbeat-${owner.ownerToken}.tmp-crash-${process.pid}`, '{"partial":', {
      mode: 0o600,
    });
    await delay(20);
    process.exit(19);
  }
  if (mode === 'hold-no-heartbeat') {
    const owner = JSON.parse(readFileSync(lockFile, 'utf8')) as { ownerToken: string };
    const heartbeatFile = `${lockFile}.heartbeat-${owner.ownerToken}`;
    rmSync(heartbeatFile);
    mkdirSync(heartbeatFile);
    await delay(holdMs);
    return;
  }
  if (mode === 'hold-stalled-heartbeat') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
    return;
  }
  await delay(holdMs);
}, {
  timeoutMs: 1_000,
  pollMs: 5,
  heartbeatMs: 15,
  staleHeartbeatMs: 60,
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
