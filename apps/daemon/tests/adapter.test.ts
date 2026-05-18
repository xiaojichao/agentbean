import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { OpenClawAdapter } from '../src/adapters/openclaw.js';
import { HermesAdapter, extractHermesReply } from '../src/adapters/hermes.js';

describe('CodexAdapter', () => {
  it('passes payload as command-line argument via PTY', async () => {
    const adapter = new CodexAdapter({
      command: 'node',
      args: ['-e', 'process.stdout.write("OK:" + process.argv.length)'],
    });
    const out = await adapter.ask({
      prompt: 'hello',
      history: [{ role: 'user', speaker: 'shaw', body: 'prev', at: 0 }],
    }, new AbortController().signal);
    expect(out).toContain('OK:');
  });

  it('uses codex exec when configured args are empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-codex-test-'));
    const script = join(dir, 'fake-codex.cjs');
    writeFileSync(script, `#!/usr/bin/env node
      const args = process.argv.slice(2);
      if (args[0] !== 'exec') {
        process.stdout.write('BAD:' + JSON.stringify(args));
        process.exit(2);
      }
      if (args[1] !== '--skip-git-repo-check') {
        process.stdout.write('BAD:' + JSON.stringify(args));
        process.exit(3);
      }
      process.stdout.write('OK:' + args[2]);
    `);
    chmodSync(script, 0o755);

    const adapter = new CodexAdapter({ command: script, args: [] });
    const out = await adapter.ask({ prompt: 'hi-codex', history: [] }, new AbortController().signal);
    expect(out).toContain('OK:');
    expect(out).toContain('# user');
    expect(out).toContain('hi-codex');
  });

  it('adds the trusted-directory bypass to configured codex exec args', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-codex-test-'));
    const script = join(dir, 'fake-codex.cjs');
    writeFileSync(script, `#!/usr/bin/env node
      const args = process.argv.slice(2);
      process.stdout.write(JSON.stringify(args));
    `);
    chmodSync(script, 0o755);

    const adapter = new CodexAdapter({ command: script, args: ['exec', '--json'] });
    const out = await adapter.ask({ prompt: 'hi-codex', history: [] }, new AbortController().signal);
    expect(out).toContain('["exec","--skip-git-repo-check","--json"');
  });

  it('aborts the child process on signal', async () => {
    const adapter = new CodexAdapter({
      command: 'node',
      args: ['-e', 'setTimeout(() => process.stdout.write("late"), 50000)'],
    });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    await expect(adapter.ask({ prompt: '', history: [] }, ctl.signal)).rejects.toThrow();
  }, 15_000);
});

describe('ClaudeCodeAdapter', () => {
  it('rejects on bad command', async () => {
    const badAdapter = new ClaudeCodeAdapter({ command: '/nonexistent/binary' });
    await expect(
      badAdapter.ask({ prompt: 'hi', history: [] }, new AbortController().signal),
    ).rejects.toThrow();
  });
});

describe('OpenClawAdapter', () => {
  it('invokes openclaw chat send --message <prompt>', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-openclaw-test-'));
    const script = join(dir, 'fake-openclaw.cjs');
    writeFileSync(script, `
      const args = process.argv.slice(1);
      const msgIdx = args.indexOf('--message');
      if (msgIdx >= 0 && args[msgIdx + 1]) {
        process.stdout.write('OC:' + args[msgIdx + 1]);
      } else {
        process.stderr.write('missing --message');
        process.exit(1);
      }
    `);
    const adapter = new OpenClawAdapter({ command: process.execPath, args: [script] });
    const out = await adapter.ask({ prompt: 'hi-oc', history: [] }, new AbortController().signal);
    expect(out).toBe('OC:hi-oc');
  });

  it('rejects empty openclaw output', async () => {
    const adapter = new OpenClawAdapter({
      command: '/bin/sh',
      args: ['-c', 'exit 0'],
    });
    await expect(
      adapter.ask({ prompt: 'hi-oc', history: [] }, new AbortController().signal),
    ).rejects.toThrow('openclaw produced empty output');
  });
});

describe('HermesAdapter', () => {
  it('invokes hermes chat -q <prompt>', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-hermes-test-'));
    const script = join(dir, 'fake-hermes.cjs');
    writeFileSync(script, `
      const args = process.argv.slice(1);
      const qIdx = args.indexOf('-q');
      if (qIdx >= 0 && args[qIdx + 1]) {
        process.stdout.write(args[qIdx + 1]);
      } else {
        process.stderr.write('missing -q');
        process.exit(1);
      }
    `);
    const adapter = new HermesAdapter({ command: process.execPath, args: [script] });
    const out = await adapter.ask({ prompt: 'hi-h', history: [] }, new AbortController().signal);
    expect(out).toBe('hi-h');
  });

  it('drops gateway-run args before invoking chat -q', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-hermes-test-'));
    const script = join(dir, 'fake-hermes.cjs');
    writeFileSync(script, `
      if (process.argv.includes('gateway') || process.argv.includes('run')) {
        process.exit(7);
      }
      const args = process.argv.slice(1);
      const qIdx = args.indexOf('-q');
      if (qIdx >= 0 && args[qIdx + 1]) {
        process.stdout.write(args[qIdx + 1]);
      } else {
        process.stderr.write('missing -q');
        process.exit(1);
      }
    `);
    const adapter = new HermesAdapter({ command: process.execPath, args: ['gateway', 'run', script] });
    const out = await adapter.ask({ prompt: 'hi-h', history: [] }, new AbortController().signal);
    expect(out).toBe('hi-h');
  });

  it('rejects empty hermes output with a useful error', async () => {
    const adapter = new HermesAdapter({
      command: '/bin/sh',
      args: ['-c', 'exit 0'],
    });
    await expect(
      adapter.ask({ prompt: 'hi-h', history: [] }, new AbortController().signal),
    ).rejects.toThrow('hermes produced empty output');
  });

  it('extracts the assistant reply from Hermes terminal output', () => {
    const raw = `Query: @Hermes-Agent hello, 你牛叉。
Initializing agent...
────────────────────────────────────────

╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮
    哈喽！谢谢夸奖 😎

    我是 OpenSNS，OpenCompany 的社媒运营专员，随时待命！

    - 内容选题 / 文案撰写 / 多平台改写
╰──────────────────────────────────────────────────────────────────────────────╯

Resume this session with:
  hermes --resume 20260518_165640_752445

Session:        20260518_165640_752445
Duration:       14s
Messages:       2 (1 user, 0 tool calls)`;

    expect(extractHermesReply(raw)).toBe(`哈喽！谢谢夸奖 😎

我是 OpenSNS，OpenCompany 的社媒运营专员，随时待命！

- 内容选题 / 文案撰写 / 多平台改写`);
  });
});
