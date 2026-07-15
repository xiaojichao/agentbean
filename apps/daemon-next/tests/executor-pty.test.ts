import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { extractCodexReply, normalizeCodexExecArgs, renderCodexPayload } from '../src/executor-pty';
import { createCommandExecutor } from '../src/executor';

describe('daemon-next codex PTY executor', () => {
  test('normalizeCodexExecArgs injects the exec subcommand and required flags for empty args', () => {
    const result = normalizeCodexExecArgs([], '/tmp/last-message.txt');
    expect(result.args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--output-last-message', '/tmp/last-message.txt',
      '--json',
    ]);
    expect(result.outputLastMessagePath).toBe('/tmp/last-message.txt');
  });

  test('normalizeCodexExecArgs honours a user-configured output path and avoids duplicating flags', () => {
    const result = normalizeCodexExecArgs(
      ['exec', '--skip-git-repo-check', '--output-last-message', '/custom/out.txt'],
      '/tmp/default.txt',
    );
    expect(result.args).toContain('--json');
    expect(result.args.filter((a) => a === '--skip-git-repo-check')).toHaveLength(1);
    expect(result.args.filter((a) => a === '--output-last-message')).toHaveLength(1);
    const outIdx = result.args.indexOf('--output-last-message');
    expect(result.args[outIdx + 1]).toBe('/custom/out.txt');
    expect(result.outputLastMessagePath).toBe('/custom/out.txt');
  });

  test('normalizeCodexExecArgs leaves a non-exec subcommand untouched (no flag injection)', () => {
    const result = normalizeCodexExecArgs(['login'], '/tmp/default.txt');
    expect(result.args).toEqual(['login']);
    expect(result.outputLastMessagePath).toBeUndefined();
  });

  test('extractCodexReply returns the content after the codex label', () => {
    const output = '\n\ncodex\nThe answer is 42\n\nhook: done';
    expect(extractCodexReply(output)).toBe('The answer is 42');
  });

  test('extractCodexReply strips the echoed payload that a PTY writes back into the output', () => {
    const payload = '# user\nwhat is the meaning of life?';
    const output = `${payload}\n\ncodex\n42\n\nhook: done`;
    expect(extractCodexReply(output, payload)).toBe('42');
  });

  test('renderCodexPayload joins history and prompt with codex role markers', () => {
    const payload = renderCodexPayload({
      prompt: 'do the thing',
      history: [
        { senderKind: 'human', body: 'context here' },
        { senderKind: 'agent', body: 'got it' },
      ],
    });
    expect(payload).toBe('# user\ncontext here\n\n# assistant\ngot it\n\n# user\ndo the thing');
  });

  describe('codex dispatch via createCommandExecutor (PTY path)', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-codex-pty-')));
    // The cwd fixture is shared across the tests below; reclaim it once the whole block is done
    // so a test run does not leak an agentbean-codex-pty-* dir under tmpdir every time.
    afterAll(() => {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* already gone */ }
    });

    test('runs codex under a PTY with normalized exec argv and reads the reply from --output-last-message', async () => {
      let capturedCommand: string | undefined;
      let capturedArgs: string[] | undefined;
      const fakeSpawn = (cmd: string, args: string[]) => {
        capturedCommand = cmd;
        capturedArgs = args;
        // Simulate codex writing its final reply to the --output-last-message file.
        const outIdx = args.indexOf('--output-last-message');
        const outPath = outIdx >= 0 ? args[outIdx + 1] : '';
        if (outPath) writeFileSync(outPath, 'Hello from codex');
        return {
          onData: () => {},
          onExit: (cb: (e: { exitCode: number }) => void) => cb({ exitCode: 0 }),
          kill: () => {},
        };
      };

      const executor = createCommandExecutor({
        // Inject a fake PTY spawner so the test never touches real node-pty.
        ptySpawnLoader: async () => fakeSpawn,
        clock: createClock([1000, 1010]),
      });
      const output = await executor({
        id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
        agentId: 'agent-1', requestId: 'request-1', prompt: 'write a function',
        memoryContext: [{
          schemaVersion: 1, id: 'memory-1', kind: 'procedural', scopeType: 'local-workspace',
          content: 'Run the matching build.', selectionReason: 'current-device-profile-cwd',
          provenance: { origin: 'local', sourceKind: 'scan' },
        }],
        customAgent: { adapterKind: 'codex', command: 'codex', args: [], cwd },
      });

      expect(typeof output).toBe('object');
      if (typeof output !== 'object') throw new Error('expected structured result');
      expect(capturedCommand).toBe('codex');
      expect(capturedArgs).toEqual(expect.arrayContaining(['exec', '--skip-git-repo-check', '--output-last-message', '--json']));
      // The joined prompt travels as the trailing positional argument.
      expect(capturedArgs?.[capturedArgs.length - 1]).toMatch(
        /# user\n## AgentBean 运行时记忆[\s\S]*当前 Device 本地记忆[\s\S]*Run the matching build\.[\s\S]*write a function/,
      );
      // The reply is read from the --output-last-message file.
      expect(output.body).toBe('Hello from codex');
      // The prompt is redacted from the persisted run command.
      expect(output.workspaceRun?.command).not.toContain('write a function');
      expect(output.workspaceRun?.command).not.toContain('Run the matching build.');
      expect(output.workspaceRun?.status).toBe('succeeded');
      expect(output.workspaceRun?.exitCode).toBe(0);
    });

    test('returns an explicit failure (not a silent banner-as-success) when the PTY runtime is unavailable', async () => {
      const executor = createCommandExecutor({
        ptySpawnLoader: async () => { throw new Error('Cannot find module node-pty'); },
        clock: createClock([1000, 1010]),
      });
      const output = await executor({
        id: 'dispatch-2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
        agentId: 'agent-1', requestId: 'request-1', prompt: 'do something',
        customAgent: { adapterKind: 'codex', command: 'codex', args: [], cwd },
      });
      expect(typeof output).toBe('object');
      if (typeof output !== 'object') throw new Error('expected structured result');
      // The error is surfaced explicitly — never a silent banner-as-success.
      expect(output.body).toContain('node-pty');
      expect(output.workspaceRun?.status).toBe('failed');
      expect(output.workspaceRun?.cwd).toBe(cwd);
    });

    test('reports a codex non-zero exit as a failed run surfacing the output detail', async () => {
      const fakeSpawn = () => ({
        onData: (cb: (d: string) => void) => cb('Error: rate limit exceeded\n'),
        onExit: (cb: (e: { exitCode: number }) => void) => cb({ exitCode: 2 }),
        kill: () => {},
      });
      const executor = createCommandExecutor({
        ptySpawnLoader: async () => fakeSpawn,
        clock: createClock([1000, 1010]),
      });
      const output = await executor({
        id: 'dispatch-3', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
        agentId: 'agent-1', requestId: 'request-1', prompt: 'do something',
        customAgent: { adapterKind: 'codex', command: 'codex', args: [], cwd },
      });
      if (typeof output !== 'object') throw new Error('expected structured result');
      expect(output.body).toContain('codex exit 2');
      expect(output.body).toContain('rate limit exceeded');
      expect(output.workspaceRun?.status).toBe('failed');
      expect(output.workspaceRun?.exitCode).toBe(2);
    });

    test('reports a codex timeout as a failed run (AGENTBEAN_CODEX_TIMEOUT_MS overrides the 15min default)', async () => {
      const prev = process.env.AGENTBEAN_CODEX_TIMEOUT_MS;
      process.env.AGENTBEAN_CODEX_TIMEOUT_MS = '30';
      try {
        const fakeSpawn = () => ({
          onData: () => {},
          onExit: () => {}, // never fires — simulates a hung codex
          kill: () => {},
        });
        const executor = createCommandExecutor({
          ptySpawnLoader: async () => fakeSpawn,
          killGraceMs: 10,
          clock: createClock([1000, 1010]),
        });
        const output = await executor({
          id: 'dispatch-4', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
          agentId: 'agent-1', requestId: 'request-1', prompt: 'do something',
          customAgent: { adapterKind: 'codex', command: 'codex', args: [], cwd },
        });
        if (typeof output !== 'object') throw new Error('expected structured result');
        expect(output.body).toContain('超时');
        expect(output.workspaceRun?.status).toBe('failed');
        expect(output.workspaceRun?.cwd).toBe(cwd);
      } finally {
        if (prev === undefined) delete process.env.AGENTBEAN_CODEX_TIMEOUT_MS;
        else process.env.AGENTBEAN_CODEX_TIMEOUT_MS = prev;
      }
    });
  });
});

function createClock(values: number[]) {
  let index = 0;
  return {
    now() {
      const value = values[index];
      index += 1;
      if (value === undefined) {
        throw new Error('clock sequence exhausted');
      }
      return value;
    },
  };
}
