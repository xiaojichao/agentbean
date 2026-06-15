import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createCommandExecutor } from '../src/executor';

describe('daemon-next command executor', () => {
  test('runs a custom agent command with prompt stdin, args, cwd, and dispatch-only env', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'echo-agent.mjs');
    writeFileSync(
      scriptPath,
      [
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  console.log(JSON.stringify({ input, args: process.argv.slice(2), cwd: process.cwd(), tokenPresent: Boolean(process.env.SECRET_TOKEN) }));',
        '  console.error("SECRET_TOKEN=\\"" + process.env.SECRET_TOKEN + "\\"");',
        '});',
      ].join('\n'),
    );

    const executor = createCommandExecutor({
      clock: createClock([1000, 1010]),
    });
    const output = await executor({
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello custom agent',
      customAgent: {
        adapterKind: 'codex',
        command: process.execPath,
        args: [scriptPath, '--model', 'gpt-5.4'],
        cwd,
        env: { SECRET_TOKEN: 'secret-value' },
      },
    });

    expect(typeof output).toBe('object');
    if (typeof output !== 'object') {
      throw new Error('expected structured command result');
    }
    expect(JSON.parse(output.body)).toEqual({
      input: 'hello custom agent',
      args: ['--model', 'gpt-5.4'],
      cwd,
      tokenPresent: true,
    });
    expect(output.workspaceRun).toMatchObject({
      cwd,
      command: `${process.execPath} ${scriptPath} --model gpt-5.4`,
      status: 'succeeded',
      exitCode: 0,
      startedAt: 1000,
      completedAt: 1010,
      logExcerpt: expect.stringContaining('SECRET_TOKEN=[redacted]'),
    });
    expect(output.workspaceRun?.logExcerpt).not.toContain('secret-value');
  });

  test('returns failed workspace run metadata when a custom agent command exits non-zero', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fail-agent.mjs');
    writeFileSync(
      scriptPath,
      [
        'console.log("stdout before failure");',
        'console.error("OPENAI_API_KEY=\\"sk-failed\\"");',
        'process.exit(7);',
      ].join('\n'),
    );

    const executor = createCommandExecutor({
      clock: createClock([2000, 2030]),
    });
    const output = await executor({
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello custom agent',
      customAgent: {
        adapterKind: 'codex',
        command: process.execPath,
        args: [scriptPath],
        cwd,
      },
    });

    expect(output).toEqual({
      body: 'custom agent command exited with code 7',
      workspaceRun: {
        status: 'failed',
        cwd,
        command: `${process.execPath} ${scriptPath}`,
        exitCode: 7,
        startedAt: 2000,
        completedAt: 2030,
        logExcerpt: expect.stringContaining('OPENAI_API_KEY=[redacted]'),
      },
    });
    if (typeof output === 'object') {
      expect(output.workspaceRun?.logExcerpt).toContain('stdout before failure');
      expect(output.workspaceRun?.logExcerpt).not.toContain('sk-failed');
    }
  });

  test('falls back to a deterministic stub reply when no custom command is present', async () => {
    const executor = createCommandExecutor({ fallbackPrefix: 'daemon-next:' });

    await expect(
      executor({
        id: 'dispatch-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        messageId: 'message-1',
        agentId: 'agent-1',
        requestId: 'request-1',
        prompt: 'hello',
      }),
    ).resolves.toBe('daemon-next:hello');
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
