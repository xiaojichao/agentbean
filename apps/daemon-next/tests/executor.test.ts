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
        '  console.log(JSON.stringify({ input, args: process.argv.slice(2), cwd: process.cwd(), token: process.env.SECRET_TOKEN }));',
        '  console.error("SECRET_TOKEN=" + process.env.SECRET_TOKEN);',
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
      token: 'secret-value',
    });
    expect(output.workspaceRun).toMatchObject({
      cwd,
      command: `${process.execPath} ${scriptPath} --model gpt-5.4`,
      exitCode: 0,
      startedAt: 1000,
      completedAt: 1010,
      logExcerpt: expect.stringContaining('SECRET_TOKEN=[redacted]'),
    });
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
