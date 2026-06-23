import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildChildEnv, createCommandExecutor } from '../src/executor';

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
    expect(output.artifacts).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^workspace-log-/),
        filename: 'workspace-run.log',
        mimeType: 'text/plain',
        relativePath: 'logs/workspace-run.log',
        pathKind: 'workspace',
        contentBase64: expect.any(String),
      }),
    ]);
    const logContent = Buffer.from(output.artifacts?.[0]?.contentBase64 ?? '', 'base64').toString('utf8');
    expect(logContent).toContain('SECRET_TOKEN=[redacted]');
    expect(logContent).not.toContain('secret-value');
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

    expect(output).toMatchObject({
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
      expect(output.artifacts?.[0]).toMatchObject({
        filename: 'workspace-run.log',
        relativePath: 'logs/workspace-run.log',
        pathKind: 'workspace',
      });
      const logContent = Buffer.from(output.artifacts?.[0]?.contentBase64 ?? '', 'base64').toString('utf8');
      expect(logContent).toContain('stdout before failure');
      expect(logContent).toContain('OPENAI_API_KEY=[redacted]');
      expect(logContent).not.toContain('sk-failed');
    }
  });

  test('caps full workspace run log artifacts while preserving the tail', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'long-log-agent.mjs');
    writeFileSync(
      scriptPath,
      [
        `process.stdout.write("start-" + "x".repeat(${2 * 1024 * 1024 + 4096}) + "-tail");`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({
      clock: createClock([3000, 3030]),
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

    if (typeof output !== 'object') {
      throw new Error('expected structured command result');
    }
    const logContent = Buffer.from(output.artifacts?.[0]?.contentBase64 ?? '', 'base64').toString('utf8');
    expect(logContent).toContain('workspace run log truncated');
    expect(logContent).toContain('-tail');
    expect(logContent.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 256);
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

  test('forwards only safe host env keys plus custom agent env to the child process', () => {
    const env = buildChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        USER: 'u',
        OPENAI_API_KEY: 'sk-leak',
        DATABASE_URL: 'postgres://x',
        AWS_ACCESS_KEY_ID: 'AKIA',
        GH_TOKEN: 'ghp_leak',
        LC_ALL: 'en_US.UTF-8',
        TMPDIR: '/tmp',
      },
      { CUSTOM_TOOL_TOKEN: 'injected', PATH: '/custom/bin' },
    );

    expect(env.HOME).toBe('/home/u');
    expect(env.USER).toBe('u');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.TMPDIR).toBe('/tmp');
    expect(env.PATH).toBe('/custom/bin');
    expect(env.CUSTOM_TOOL_TOKEN).toBe('injected');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test('force-kills a custom agent command that ignores SIGTERM after timeout', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const pidFile = join(cwd, 'child.pid');
    const scriptPath = join(cwd, 'stubborn.mjs');
    writeFileSync(
      scriptPath,
      [
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `process.on('SIGTERM', () => {});`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({
      timeoutMs: 500,
      killGraceMs: 30,
      clock: createClock([5000, 5530]),
    });

    const running = executor({
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        adapterKind: 'codex',
        command: process.execPath,
        args: [scriptPath],
        cwd,
      },
    });
    await waitForFile(pidFile);
    await expect(running).rejects.toThrow('timed out after 500ms');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    // SIGTERM is ignored, so SIGKILL must fire at timeoutMs + killGraceMs.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isProcessAlive(pid)).toBe(false);
  });

  test('terminates a custom agent command whose output exceeds the accumulated byte cap', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'flood.mjs');
    writeFileSync(
      scriptPath,
      [
        `const block = 'x'.repeat(8192);`,
        `setInterval(() => { process.stdout.write(block); }, 1);`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({
      maxAccumulatedBytes: 4096,
      clock: createClock([1000, 1010]),
    });

    const output = await executor({
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        adapterKind: 'codex',
        command: process.execPath,
        args: [scriptPath],
        cwd,
      },
    });

    expect(output).toMatchObject({
      workspaceRun: { status: 'failed' },
    });
  });

  test('runs a hermes agent via "chat -Q -q" with the prompt on argv (not stdin), joining history and stripping session metadata', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fake-hermes.mjs');
    const stdinLogPath = join(cwd, 'stdin.log');
    writeFileSync(
      scriptPath,
      [
        `import { writeFileSync } from 'node:fs';`,
        `// Simulate 'hermes chat -Q -q': quiet output, prompt arrives via the -q argv flag.`,
        `const qIdx = process.argv.indexOf('-q');`,
        `const queryIdx = process.argv.indexOf('--query');`,
        `const query = qIdx >= 0 ? process.argv[qIdx + 1] : queryIdx >= 0 ? process.argv[queryIdx + 1] : '';`,
        `process.stdout.write('\\nsession_id: fake-session-abc\\n');`,
        `process.stdout.write('REPLY:' + query + '\\n');`,
        `// Record whether anything arrived on stdin (must stay empty for hermes).`,
        `let stdinData = '';`,
        `process.stdin.setEncoding('utf8');`,
        `process.stdin.on('data', (c) => { stdinData += c; });`,
        `process.stdin.on('end', () => {`,
        `  writeFileSync(${JSON.stringify(stdinLogPath)}, stdinData.length ? stdinData : '(empty)');`,
        `});`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({ clock: createClock([1000, 1010]) });
    const output = await executor({
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'collect top 20 AI tweets',
      history: [
        { messageId: 'm-prev-user', senderKind: 'human' as const, senderId: 'u1', body: 'what is trending?', createdAt: 1 },
        { messageId: 'm-prev-agent', senderKind: 'agent' as const, senderId: 'a1', body: 'let me check.', createdAt: 2 },
      ],
      customAgent: {
        adapterKind: 'hermes',
        command: process.execPath,
        args: [scriptPath],
        cwd,
      },
    });

    expect(typeof output).toBe('object');
    if (typeof output !== 'object') {
      throw new Error('expected structured command result');
    }
    // Hermes quiet output has its session metadata stripped from the reply body.
    expect(output.body).not.toContain('session_id');
    expect(output.body).not.toContain('fake-session-abc');
    // The prompt reaches the agent via argv, and prior history is joined into it.
    expect(output.body).toContain('collect top 20 AI tweets');
    expect(output.body).toContain('what is trending?');
    expect(output.body).toContain('let me check.');
    // The command line uses hermes' non-interactive quiet query mode.
    expect(output.workspaceRun?.command).toContain('chat -Q -q');
    expect(output.workspaceRun?.command).toContain('-q [query elided]');
    expect(output.workspaceRun?.command).not.toContain('collect top 20 AI tweets');
    expect(output.workspaceRun?.command).not.toContain('what is trending?');
    expect(output.workspaceRun?.command).not.toContain('let me check.');
    // The prompt is NOT piped through stdin for hermes.
    expect(readFileSync(stdinLogPath, 'utf8')).toBe('(empty)');
    expect(output.workspaceRun?.status).toBe('succeeded');
    expect(output.workspaceRun?.exitCode).toBe(0);
  });

  test('rewrites hermes gateway and preconfigured query args without persisting prompt text', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fake-hermes.mjs');
    writeFileSync(
      scriptPath,
      [
        `const qIdx = process.argv.indexOf('-q');`,
        `const queryIdx = process.argv.indexOf('--query');`,
        `const query = qIdx >= 0 ? process.argv[qIdx + 1] : queryIdx >= 0 ? process.argv[queryIdx + 1] : '';`,
        `process.stdout.write('QUERY:' + query + '\\n');`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({ clock: createClock([1000, 1010, 2000, 2010]) });
    const gatewayOutput = await executor({
      id: 'dispatch-gateway',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'gateway prompt',
      customAgent: {
        adapterKind: 'hermes',
        command: process.execPath,
        args: ['gateway', 'run', scriptPath],
        cwd,
      },
    });
    const queryOutput = await executor({
      id: 'dispatch-query',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-2',
      agentId: 'agent-1',
      requestId: 'request-2',
      prompt: 'replacement prompt',
      customAgent: {
        adapterKind: 'hermes',
        command: process.execPath,
        args: [scriptPath, 'chat', '--query', 'stale prompt'],
        cwd,
      },
    });

    expect(gatewayOutput).toMatchObject({
      body: 'QUERY:gateway prompt',
      workspaceRun: {
        command: expect.stringContaining('chat -Q -q [query elided]'),
      },
    });
    expect(queryOutput).toMatchObject({
      body: 'QUERY:replacement prompt',
      workspaceRun: {
        command: expect.stringContaining('chat -Q --query [query elided]'),
      },
    });
    if (typeof gatewayOutput !== 'object' || typeof queryOutput !== 'object') {
      throw new Error('expected structured command results');
    }
    expect(gatewayOutput.workspaceRun?.command).not.toContain('gateway prompt');
    expect(queryOutput.workspaceRun?.command).not.toContain('replacement prompt');
    expect(queryOutput.workspaceRun?.command).not.toContain('stale prompt');
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected file was not written: ${path}`);
}
