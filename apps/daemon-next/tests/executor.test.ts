import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createCommandExecutor } from '../src/executor';
import {
  buildChildEnv,
  formatCodexExitFailureBody,
  isCodingRuntimeSecretEnvKey,
  setLoginShellEnvLoaderForTests,
} from '../src/executor-helpers';

describe('daemon-next command executor', () => {
  // Keep unit tests hermetic: never spawn a real login shell for coding-runtime secret lookup.
  beforeEach(() => {
    setLoginShellEnvLoaderForTests(() => ({}));
  });
  afterEach(() => {
    setLoginShellEnvLoaderForTests(() => ({}));
  });
  test('runs a custom agent command with unified Memory prompt stdin, args, cwd, and dispatch-only env', async () => {
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
      memoryContext: [{
        schemaVersion: 1, id: 'memory-1', kind: 'decision', scopeType: 'team',
        content: 'Use the verified runtime.', selectionReason: 'invocation-bound-capsule-currently-authorized',
        provenance: { origin: 'server', capsuleId: 'capsule-1', authorizationDecisionId: 'decision-1', sourceRefs: [] },
      }, {
        schemaVersion: 1, id: 'local-memory-1', kind: 'preference', scopeType: 'local-profile',
        content: 'Device-private preference must stay local.', selectionReason: 'current-device-profile',
        provenance: { origin: 'local', sourceKind: 'manual' },
      }],
      customAgent: {
        adapterKind: 'gemini',
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
      input: expect.stringMatching(/Server 协作记忆[\s\S]*Use the verified runtime\.[\s\S]*\[Device-local Memory redacted\][\s\S]*当前用户输入[\s\S]*hello custom agent/),
      args: ['--model', 'gpt-5.4'],
      cwd,
      tokenPresent: true,
    });
    expect(output.body).not.toContain('Device-private preference must stay local.');
    expect(output.workspaceRun).toMatchObject({
      cwd,
      command: `${process.execPath} ${scriptPath} --model gpt-5.4`,
      status: 'succeeded',
      exitCode: 0,
      startedAt: 1000,
      completedAt: 1010,
      logExcerpt: expect.stringContaining('SECRET_TOKEN=[redacted]'),
    });
    expect(output.workspaceRun?.command).not.toContain('Use the verified runtime.');
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
    expect(logContent).not.toContain('Device-private preference must stay local.');
    expect(output.workspaceRun?.logExcerpt).not.toContain('Device-private preference must stay local.');
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
        adapterKind: 'gemini',
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
        adapterKind: 'gemini',
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
        memoryContext: [{
          schemaVersion: 1, id: 'local-memory-1', kind: 'preference', scopeType: 'local-profile',
          content: 'Device-private fallback context.', selectionReason: 'current-device-profile',
          provenance: { origin: 'local', sourceKind: 'manual' },
        }],
      }),
    ).resolves.toMatch(/daemon-next:[\s\S]*\[Device-local Memory redacted\][\s\S]*hello/);
  });

  test('forwards only safe host env keys plus custom agent env to the child process by default', () => {
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
    // Default path still strips coding secrets — only opt-in includeCodingRuntimeSecrets forwards them.
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test('includeCodingRuntimeSecrets forwards CRS_OAI_KEY / OPENAI_API_KEY but still strips GH_TOKEN', () => {
    setLoginShellEnvLoaderForTests(() => ({
      CRS_OAI_KEY: 'from-login-shell',
      GH_TOKEN: 'ghp_from_shell',
    }));
    const env = buildChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        OPENAI_API_KEY: 'sk-from-process',
        DATABASE_URL: 'postgres://x',
        GH_TOKEN: 'ghp_from_process',
      },
      { OPENAI_API_KEY: 'sk-from-agent' },
      { includeCodingRuntimeSecrets: true },
    );

    // process.env coding key is eligible; customAgent.env wins on collision.
    expect(env.OPENAI_API_KEY).toBe('sk-from-agent');
    // Login shell fills keys absent from process.env.
    expect(env.CRS_OAI_KEY).toBe('from-login-shell');
    // Non-coding secrets stay out even if present on host/login shell.
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(isCodingRuntimeSecretEnvKey('CRS_OAI_KEY')).toBe(true);
    expect(isCodingRuntimeSecretEnvKey('GH_TOKEN')).toBe(false);
  });

  test('formatCodexExitFailureBody keeps non-env failures compact and guides missing env_key', () => {
    expect(formatCodexExitFailureBody(2, 'Error: rate limit exceeded')).toBe(
      'codex exit 2: Error: rate limit exceeded',
    );
    const body = formatCodexExitFailureBody(
      1,
      '{"type":"error","message":"Missing environment variable: CRS_OAI_KEY."}',
    );
    expect(body).toContain('codex exit 1');
    expect(body).toContain('CRS_OAI_KEY');
    expect(body).toContain('环境变量');
    expect(body).toContain('登录 shell');
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
        adapterKind: 'gemini',
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
        adapterKind: 'gemini',
        command: process.execPath,
        args: [scriptPath],
        cwd,
      },
    });

    expect(output).toMatchObject({
      workspaceRun: { status: 'failed' },
    });
  });

  test('runs a hermes agent via oneshot "-z" with the prompt on argv (not stdin), joining history and stripping any metadata', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fake-hermes.mjs');
    const stdinLogPath = join(cwd, 'stdin.log');
    writeFileSync(
      scriptPath,
      [
        `import { writeFileSync } from 'node:fs';`,
        `// Simulate 'hermes -z' oneshot: prompt arrives via the -z/--oneshot argv flag.`,
        `const zIdx = process.argv.indexOf('-z');`,
        `const oneshotIdx = process.argv.indexOf('--oneshot');`,
        `const query = zIdx >= 0 ? process.argv[zIdx + 1] : oneshotIdx >= 0 ? process.argv[oneshotIdx + 1] : '';`,
        `// Oneshot prints only the final reply; emit a stray metadata line too to prove it would still be stripped.`,
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
      memoryContext: [{
        schemaVersion: 1, id: 'server-memory', kind: 'decision', scopeType: 'team',
        content: 'Prefer primary sources.', selectionReason: 'invocation-bound-capsule-currently-authorized',
        provenance: { origin: 'server', capsuleId: 'capsule-1', authorizationDecisionId: 'decision-1', sourceRefs: [] },
      }],
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
    // Oneshot output has any session metadata stripped from the reply body.
    expect(output.body).not.toContain('session_id');
    expect(output.body).not.toContain('fake-session-abc');
    // The prompt reaches the agent via argv, and prior history is joined into it.
    expect(output.body).toContain('collect top 20 AI tweets');
    expect(output.body).toContain('what is trending?');
    expect(output.body).toContain('let me check.');
    expect(output.body).toContain('Prefer primary sources.');
    // The command line uses hermes' non-interactive oneshot mode (-z auto-bypasses tool
    // approvals, so the agent can actually run tools in an async channel with no stdin).
    expect(output.workspaceRun?.command).toContain('-z');
    expect(output.workspaceRun?.command).not.toContain('chat -Q');
    expect(output.workspaceRun?.command).toContain('-z [query elided]');
    expect(output.workspaceRun?.command).not.toContain('collect top 20 AI tweets');
    expect(output.workspaceRun?.command).not.toContain('what is trending?');
    expect(output.workspaceRun?.command).not.toContain('let me check.');
    expect(output.workspaceRun?.command).not.toContain('Prefer primary sources.');
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
        `const zIdx = process.argv.indexOf('-z');`,
        `const oneshotIdx = process.argv.indexOf('--oneshot');`,
        `const qIdx = process.argv.indexOf('-q');`,
        `const queryIdx = process.argv.indexOf('--query');`,
        `const query = zIdx >= 0 ? process.argv[zIdx + 1] : oneshotIdx >= 0 ? process.argv[oneshotIdx + 1] : qIdx >= 0 ? process.argv[qIdx + 1] : queryIdx >= 0 ? process.argv[queryIdx + 1] : '';`,
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
        command: expect.stringContaining('-z [query elided]'),
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

  test('runs an openclaw agent via "agent --agent <id> --message" argv (not stdin), joining history and redacting the message from the run command', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fake-openclaw.mjs');
    const stdinLogPath = join(cwd, 'stdin.log');
    writeFileSync(
      scriptPath,
      [
        `import { writeFileSync } from 'node:fs';`,
        `// Simulate 'openclaw agent --agent <id> --message <prompt>': prompt via --message argv.`,
        `const mIdx = process.argv.indexOf('--message');`,
        `const dashM = process.argv.indexOf('-m');`,
        `const idx = mIdx >= 0 ? mIdx : dashM;`,
        `const message = idx >= 0 ? process.argv[idx + 1] : '';`,
        `process.stdout.write('REPLY:' + message + '\\n');`,
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
      prompt: 'summarize the openclaw docs',
      history: [
        { messageId: 'm-prev-user', senderKind: 'human' as const, senderId: 'u1', body: 'what is openclaw?', createdAt: 1 },
        { messageId: 'm-prev-agent', senderKind: 'agent' as const, senderId: 'a1', body: 'an agent runtime.', createdAt: 2 },
      ],
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        // scanner supplies ['agent', '--agent', <id>]; scriptPath fronts it so node runs the fake.
        args: [scriptPath, 'agent', '--agent', 'main'],
        cwd,
      },
    });

    expect(typeof output).toBe('object');
    if (typeof output !== 'object') {
      throw new Error('expected structured command result');
    }
    // The prompt reaches the agent via the --message argv, and prior history is joined into it.
    expect(output.body).toContain('summarize the openclaw docs');
    expect(output.body).toContain('what is openclaw?');
    expect(output.body).toContain('an agent runtime.');
    // The command line uses openclaw's one-shot agent form, with the message redacted.
    expect(output.workspaceRun?.command).toContain('agent');
    expect(output.workspaceRun?.command).toContain('--agent');
    expect(output.workspaceRun?.command).toContain('--message');
    expect(output.workspaceRun?.command).toContain('[message elided]');
    expect(output.workspaceRun?.command).not.toContain('summarize the openclaw docs');
    expect(output.workspaceRun?.command).not.toContain('what is openclaw?');
    // The prompt is NOT piped through stdin for openclaw.
    expect(readFileSync(stdinLogPath, 'utf8')).toBe('(empty)');
    expect(output.workspaceRun?.status).toBe('succeeded');
    expect(output.workspaceRun?.exitCode).toBe(0);
  });

  test('openclaw surfaces stderr (not just the exit code) when the agent command fails, so the real error reaches the user', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fake-openclaw-fail.mjs');
    writeFileSync(
      scriptPath,
      [
        `// Simulate openclaw failing before replying: emit a diagnostic on stderr, then exit 1.`,
        `process.stderr.write('Error: agent main not found\\n');`,
        `process.exit(1);`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({ clock: createClock([1000, 1010]) });
    const output = await executor({
      id: 'dispatch-fail',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hi',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [scriptPath, 'agent', '--agent', 'main'],
        cwd,
      },
    });

    expect(typeof output).toBe('object');
    if (typeof output !== 'object') {
      throw new Error('expected structured command result');
    }
    // The real cause (stderr) must reach the user instead of a bare exit code —
    // otherwise a failing OpenClaw run is indistinguishable from any other failure.
    expect(output.body).toContain('agent main not found');
    expect(output.body).not.toBe('custom agent command exited with code 1');
    expect(output.workspaceRun?.status).toBe('failed');
    expect(output.workspaceRun?.exitCode).toBe(1);
  });

  test('openclaw keeps doctor/config warning panels out of chat replies while preserving them in run logs', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const warningOnlyScriptPath = join(cwd, 'fake-openclaw-warning-only.mjs');
    const warningThenReplyScriptPath = join(cwd, 'fake-openclaw-warning-reply.mjs');
    const warningOnlySuccessScriptPath = join(cwd, 'fake-openclaw-warning-only-success.mjs');
    const warningThenLongReplyScriptPath = join(cwd, 'fake-openclaw-warning-long-reply.mjs');
    const incompleteWarningHeadingScriptPath = join(cwd, 'fake-openclaw-incomplete-warning-heading.mjs');
    const warningPanels = [
      '│',
      '◇  Doctor warnings ──────────────────────────────────────────────────────╮',
      '│                                                                        │',
      '│  - Left plugin install index in place because shared SQLite state has  │',
      '│    conflicting plugin install metadata for: discord, openclaw-weixin,  │',
      '│    slack                                                               │',
      '├────────────────────────────────────────────────────────────────────────╯',
      '│',
      '◇  Config warnings ────────────────────────────────────────────────────────╮',
      '│                                                                          │',
      '│  - plugins: plugin openclaw-weixin: duplicate plugin id resolved by      │',
      '│    explicit config-selected plugin; global plugin will be overridden by  │',
      '│    config plugin                                                         │',
      '│    (/Users/xiao/.openclaw/extensions/openclaw-weixin/index.ts)           │',
      '├──────────────────────────────────────────────────────────────────────────╯',
    ].join('\n');
    writeFileSync(
      warningOnlyScriptPath,
      [
        `process.stdout.write(${JSON.stringify(`${warningPanels}\n`)});`,
        `process.exit(1);`,
      ].join('\n'),
    );
    writeFileSync(
      warningThenReplyScriptPath,
      [
        `process.stdout.write(${JSON.stringify(`${warningPanels}\nOpenClaw actual answer\n`)});`,
      ].join('\n'),
    );
    writeFileSync(
      warningOnlySuccessScriptPath,
      [
        `process.stdout.write(${JSON.stringify(`${warningPanels}\n`)});`,
      ].join('\n'),
    );
    writeFileSync(
      warningThenLongReplyScriptPath,
      [
        `process.stdout.write(${JSON.stringify(`${warningPanels}\n${'OpenClaw long answer '.repeat(130)}\n`)});`,
      ].join('\n'),
    );
    writeFileSync(
      incompleteWarningHeadingScriptPath,
      [
        `process.stdout.write(${JSON.stringify('◇ Doctor warnings mentioned by the model\nThis is the real reply body\n')});`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({
      clock: createClock([1000, 1010, 2000, 2010, 3000, 3010, 4000, 4010, 5000, 5010]),
    });
    const failedOutput = await executor({
      id: 'dispatch-openclaw-warning-only',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hi',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [warningOnlyScriptPath, 'agent', '--agent', 'main'],
        cwd,
      },
    });
    const succeededOutput = await executor({
      id: 'dispatch-openclaw-warning-reply',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-2',
      agentId: 'agent-1',
      requestId: 'request-2',
      prompt: 'hi again',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [warningThenReplyScriptPath, 'agent', '--agent', 'main'],
        cwd,
      },
    });
    const warningOnlySuccessOutput = await executor({
      id: 'dispatch-openclaw-warning-only-success',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-3',
      agentId: 'agent-1',
      requestId: 'request-3',
      prompt: 'warning only success',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [warningOnlySuccessScriptPath, 'agent', '--agent', 'main'],
        cwd,
      },
    });
    const longReplyOutput = await executor({
      id: 'dispatch-openclaw-warning-long-reply',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-4',
      agentId: 'agent-1',
      requestId: 'request-4',
      prompt: 'long reply',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [warningThenLongReplyScriptPath, 'agent', '--agent', 'main'],
        cwd,
      },
    });
    const incompleteHeadingOutput = await executor({
      id: 'dispatch-openclaw-incomplete-warning-heading',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-5',
      agentId: 'agent-1',
      requestId: 'request-5',
      prompt: 'summarize warnings',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [incompleteWarningHeadingScriptPath, 'agent', '--agent', 'main'],
        cwd,
      },
    });

    if (
      typeof failedOutput !== 'object'
      || typeof succeededOutput !== 'object'
      || typeof warningOnlySuccessOutput !== 'object'
      || typeof longReplyOutput !== 'object'
      || typeof incompleteHeadingOutput !== 'object'
    ) {
      throw new Error('expected structured command results');
    }
    expect(failedOutput.body).toBe('custom agent command exited with code 1');
    expect(failedOutput.body).not.toContain('Doctor warnings');
    expect(failedOutput.body).not.toContain('openclaw-weixin');
    expect(failedOutput.workspaceRun?.status).toBe('failed');
    expect(failedOutput.workspaceRun?.exitCode).toBe(1);
    const failedLogContent = Buffer.from(failedOutput.artifacts?.[0]?.contentBase64 ?? '', 'base64').toString('utf8');
    expect(failedLogContent).toContain('Doctor warnings');
    expect(failedLogContent).toContain('openclaw-weixin');

    expect(succeededOutput.body).toBe('OpenClaw actual answer');
    expect(succeededOutput.body).not.toContain('Config warnings');
    expect(succeededOutput.body).not.toContain('openclaw-weixin');
    expect(succeededOutput.workspaceRun?.status).toBe('succeeded');
    expect(succeededOutput.workspaceRun?.exitCode).toBe(0);

    expect(warningOnlySuccessOutput.body).toBe('');
    expect(warningOnlySuccessOutput.body).not.toContain('Doctor warnings');
    expect(warningOnlySuccessOutput.body).not.toContain('openclaw-weixin');
    expect(warningOnlySuccessOutput.workspaceRun?.status).toBe('succeeded');
    expect(warningOnlySuccessOutput.workspaceRun?.exitCode).toBe(0);

    expect(longReplyOutput.body.length).toBeGreaterThan(2000);
    expect(longReplyOutput.body).toBe(`${'OpenClaw long answer '.repeat(130)}`.trim());
    expect(longReplyOutput.body).not.toContain('Config warnings');

    expect(incompleteHeadingOutput.body).toBe('◇ Doctor warnings mentioned by the model\nThis is the real reply body');
    expect(incompleteHeadingOutput.workspaceRun?.status).toBe('succeeded');
    expect(incompleteHeadingOutput.workspaceRun?.exitCode).toBe(0);
  });

  test('normalizes openclaw custom args so agent options stay under the agent subcommand', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fake-openclaw.mjs');
    writeFileSync(
      scriptPath,
      [
        `const args = process.argv.slice(2);`,
        `const mIdx = args.indexOf('--message');`,
        `process.stdout.write(JSON.stringify({ args, message: mIdx >= 0 ? args[mIdx + 1] : null }));`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({ clock: createClock([1000, 1010, 2000, 2010, 3000, 3010]) });
    const localOutput = await executor({
      id: 'dispatch-local',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'local prompt',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [scriptPath, '--local'],
        cwd,
      },
    });
    const equalsOutput = await executor({
      id: 'dispatch-equals',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-2',
      agentId: 'agent-1',
      requestId: 'request-2',
      prompt: 'equals prompt',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [scriptPath, '--agent=ops', '--message=stale prompt'],
        cwd,
      },
    });
    const messageFileOutput = await executor({
      id: 'dispatch-message-file',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-3',
      agentId: 'agent-1',
      requestId: 'request-3',
      prompt: 'file prompt',
      customAgent: {
        adapterKind: 'openclaw',
        command: process.execPath,
        args: [scriptPath, '--session-key=agent:ops:incident-42', '--message-file', join(cwd, 'stale.md'), '--local'],
        cwd,
      },
    });

    if (typeof localOutput !== 'object' || typeof equalsOutput !== 'object' || typeof messageFileOutput !== 'object') {
      throw new Error('expected structured command results');
    }
    const localRun = JSON.parse(localOutput.body) as { args: string[]; message: string };
    const equalsRun = JSON.parse(equalsOutput.body) as { args: string[]; message: string };
    const messageFileRun = JSON.parse(messageFileOutput.body) as { args: string[]; message: string };

    expect(localRun.args).toEqual(['agent', '--agent', 'main', '--local', '--message', 'local prompt']);
    expect(localRun.message).toBe('local prompt');
    expect(equalsRun.args).toEqual(['agent', '--agent=ops', '--message', 'equals prompt']);
    expect(equalsRun.args).not.toContain('--agent');
    expect(equalsRun.args).not.toContain('main');
    expect(equalsRun.message).toBe('equals prompt');
    expect(messageFileRun.args).toEqual(['agent', '--session-key=agent:ops:incident-42', '--message', 'file prompt', '--local']);
    expect(messageFileRun.args).not.toContain('--message-file');
    expect(messageFileRun.message).toBe('file prompt');
    expect(localOutput.workspaceRun?.command).toContain('fake-openclaw.mjs agent --agent main --local --message [message elided]');
    expect(equalsOutput.workspaceRun?.command).toContain('fake-openclaw.mjs agent --agent=ops --message [message elided]');
    expect(messageFileOutput.workspaceRun?.command).toContain('fake-openclaw.mjs agent --session-key=agent:ops:incident-42 --message [message elided] --local');
    expect(equalsOutput.workspaceRun?.command).not.toContain('equals prompt');
    expect(equalsOutput.workspaceRun?.command).not.toContain('stale prompt');
    expect(messageFileOutput.workspaceRun?.command).not.toContain('file prompt');
    expect(messageFileOutput.workspaceRun?.command).not.toContain('stale.md');
  });

  test('runs a claude-code agent in print mode (-p) with the prompt on stdin (history joined), keeping it out of the run command', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fake-claude.mjs');
    writeFileSync(
      scriptPath,
      [
        `// Simulate 'claude -p': read prompt from stdin; only reply when -p/--print is set.`,
        `let input = '';`,
        `process.stdin.setEncoding('utf8');`,
        `process.stdin.on('data', (c) => { input += c; });`,
        `process.stdin.on('end', () => {`,
        `  const hasP = process.argv.includes('-p') || process.argv.includes('--print');`,
        `  process.stdout.write('REPLY:' + (hasP ? input : 'NO_PRINT_MODE') + '\\n');`,
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
      prompt: 'explain closures',
      memoryContext: [{
        schemaVersion: 1, id: 'local-memory', kind: 'procedural', scopeType: 'local-workspace',
        content: 'Use a small example.', selectionReason: 'current-device-profile-cwd',
        provenance: { origin: 'local', sourceKind: 'manual' },
      }],
      history: [
        { messageId: 'm-prev-user', senderKind: 'human' as const, senderId: 'u1', body: 'what is a callback?', createdAt: 1 },
        { messageId: 'm-prev-agent', senderKind: 'agent' as const, senderId: 'a1', body: 'a function passed as an argument.', createdAt: 2 },
      ],
      customAgent: {
        adapterKind: 'claude-code',
        command: process.execPath,
        args: [scriptPath],
        cwd,
      },
    });

    expect(typeof output).toBe('object');
    if (typeof output !== 'object') {
      throw new Error('expected structured command result');
    }
    // -p puts claude in print (non-interactive) mode; the prompt (with joined history) reaches it via stdin.
    expect(output.body).toContain('explain closures');
    expect(output.body).toContain('what is a callback?');
    expect(output.body).toContain('a function passed as an argument.');
    expect(output.body).toContain('[Device-local Memory redacted]');
    expect(output.body).not.toContain('Use a small example.');
    // The command line carries -p but never the prompt (it travels on stdin, not argv).
    expect(output.workspaceRun?.command).toContain('-p');
    expect(output.workspaceRun?.command).not.toContain('explain closures');
    expect(output.workspaceRun?.command).not.toContain('what is a callback?');
    expect(output.workspaceRun?.command).not.toContain('Use a small example.');
    expect(output.workspaceRun?.status).toBe('succeeded');
    expect(output.workspaceRun?.exitCode).toBe(0);
  });

  test('claude-code surfaces stderr (not just the exit code) when the agent command fails, so the real error reaches the user', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-executor-')));
    const scriptPath = join(cwd, 'fake-claude-fail.mjs');
    writeFileSync(
      scriptPath,
      [
        `// Simulate 'claude -p' writing partial stdout before an upstream gateway error.`,
        `process.stdout.write('warming up claude-code\\n');`,
        `process.stderr.write('API Error: 529 [该模型当前访问量过大，请您稍后再试]\\n');`,
        `process.exit(1);`,
      ].join('\n'),
    );

    const executor = createCommandExecutor({ clock: createClock([1000, 1010]) });
    const output = await executor({
      id: 'dispatch-claude-fail',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: '你在用什么模型',
      customAgent: {
        adapterKind: 'claude-code',
        command: process.execPath,
        args: [scriptPath],
        cwd,
      },
    });

    expect(typeof output).toBe('object');
    if (typeof output !== 'object') {
      throw new Error('expected structured command result');
    }
    // The real cause (stderr) must reach the user instead of a bare exit code —
    // otherwise a failing claude-code run (e.g. upstream gateway 529) is
    // indistinguishable from any other failure.
    expect(output.body).toContain('该模型当前访问量过大');
    expect(output.body).not.toContain('warming up claude-code');
    expect(output.body).not.toBe('custom agent command exited with code 1');
    expect(output.workspaceRun?.status).toBe('failed');
    expect(output.workspaceRun?.exitCode).toBe(1);
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
