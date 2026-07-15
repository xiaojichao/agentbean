import { withLocalMemoryFileLock } from '../../src/memory/file-lock.js';

const [lockFile, mode = 'hold', holdText = '250'] = process.argv.slice(2);
if (!lockFile) throw new Error('lock file required');
const holdMs = Number(holdText);

await withLocalMemoryFileLock(lockFile, async () => {
  process.stdout.write('READY\n');
  if (mode === 'crash') {
    await delay(20);
    process.exit(17);
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
