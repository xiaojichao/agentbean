// LOCAL-flavored end-to-end for the codex PTY path.
//
// The mock-based tests in executor-pty.test.ts inject a fake spawnPty, so they verify the codex
// contract (argv, file reply, redaction, error handling) but NOT that the real lazy-import chain
// works: createRequire('node-pty') actually loads the native module, spawnPty spawns a real PTY,
// onData/onExit fire, and extractReply parses real PTY output. This file exercises that chain via
// the default ptySpawnLoader. It is SKIPPED where node-pty has no usable binary (the daemon-next
// CI installs with --ignore-scripts on Linux), so it never breaks CI.

import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createCommandExecutor } from '../src/executor';

const requireNative = createRequire(import.meta.url);
// require succeeding is not enough: on the daemon-next CI (Linux, --ignore-scripts) node-pty's
// package unpacks but has no usable spawn-helper (no linux prebuild, compilation skipped), so an
// actual spawn would fail. Gate on a spawn-helper actually being present.
const hasNodePty = (() => {
  try {
    const ptyRoot = dirname(requireNative.resolve('node-pty/package.json'));
    const prebuilt = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    const compiled = join(ptyRoot, 'build', 'Release', 'spawn-helper');
    return existsSync(prebuilt) || existsSync(compiled);
  } catch {
    return false;
  }
})();
const testWithPty = hasNodePty ? test : test.skip;

describe('daemon-next codex PTY executor (real node-pty end-to-end)', () => {
  testWithPty('loads node-pty via the default loader and parses the reply from real PTY output', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-codex-e2e-')));
    // A stand-in for the codex binary: prints a codex-labelled reply to the PTY and exits 0.
    const fakeCodex = join(cwd, 'fake-codex.mjs');
    writeFileSync(
      fakeCodex,
      `process.stdout.write('codex\\nreal pty reply\\nhook: done');\n`,
    );

    const executor = createCommandExecutor({ clock: { now: () => Date.now() } });
    const output = await executor({
      id: 'e2e-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', requestId: 'request-1', prompt: 'hi',
      customAgent: { adapterKind: 'codex', command: process.execPath, args: [fakeCodex], cwd },
    });

    if (typeof output !== 'object') throw new Error('expected structured result');
    // The real lazy-imported node-pty spawned the fake under a PTY; extractReply parsed its output.
    expect(output.body).toBe('real pty reply');
    expect(output.workspaceRun?.status).toBe('succeeded');
    expect(output.workspaceRun?.exitCode).toBe(0);
  });
});
