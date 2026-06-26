// LOCAL-flavored end-to-end for the codex PTY path.
//
// The mock-based tests in executor-pty.test.ts inject a fake spawnPty, so they verify the codex
// contract (argv, file reply, redaction, error handling) but NOT that the real lazy-import chain
// works: createRequire('node-pty') actually loads the native module, spawnPty spawns a real PTY,
// onData/onExit fire, and extractReply parses real PTY output. This file exercises that chain via
// the default ptySpawnLoader. It is SKIPPED where node-pty has no usable binary (the daemon-next
// CI installs with --ignore-scripts on Linux), so it never breaks CI.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createCommandExecutor } from '../src/executor';

const requireNative = createRequire(import.meta.url);
// require succeeding is not enough: on the daemon-next CI (Linux, --ignore-scripts) node-pty's
// package unpacks but has no usable spawn-helper (no linux prebuild, compilation skipped), so an
// actual spawn would fail. Some local Node/native combinations can also resolve node-pty but never
// deliver PTY data/exit events, so gate this local-only e2e on a short isolated smoke process.
function hasNodePtyBinary(): boolean {
  try {
    const ptyRoot = dirname(requireNative.resolve('node-pty/package.json'));
    const prebuilt = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    const compiled = join(ptyRoot, 'build', 'Release', 'spawn-helper');
    return existsSync(prebuilt) || existsSync(compiled);
  } catch {
    return false;
  }
}

function hasUsableNodePty(): boolean {
  if (!hasNodePtyBinary()) return false;
  const probe = [
    "const pty = require('node-pty');",
    "const child = pty.spawn('/bin/echo', ['agentbean-pty-smoke'], { name: 'xterm-color', cols: 80, rows: 30, cwd: process.cwd(), env: process.env });",
    "let output = '';",
    "child.onData((chunk) => { output += chunk; });",
    "child.onExit((event) => { process.exit(event.exitCode === 0 && output.includes('agentbean-pty-smoke') ? 0 : 2); });",
    "setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(3); }, 1000).unref();",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 2000,
    stdio: 'ignore',
  });
  return result.status === 0;
}

const testWithPty = hasUsableNodePty() ? test : test.skip;

describe('daemon-next codex PTY executor (real node-pty end-to-end)', () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-codex-e2e-')));
  // Reclaim the fake-codex cwd once the block is done so a local run does not leak an
  // agentbean-codex-e2e-* dir under tmpdir every time (the executor only cleans its own
  // --output-last-message dir, not the cwd the test hands to it).
  afterAll(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* already gone */ }
  });

  testWithPty('loads node-pty via the default loader and parses the reply from real PTY output', async () => {
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
