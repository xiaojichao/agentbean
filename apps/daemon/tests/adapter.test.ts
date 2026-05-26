import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CodexAdapter, extractCodexReply } from '../src/adapters/codex.js';
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

  it('uses codex exec automation flags when configured args are empty', async () => {
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
      if (!args.includes('--json')) {
        process.stdout.write('BAD:' + JSON.stringify(args));
        process.exit(4);
      }
      const outIdx = args.indexOf('--output-last-message');
      if (outIdx < 0 || !args[outIdx + 1]) {
        process.stdout.write('BAD:' + JSON.stringify(args));
        process.exit(5);
      }
      process.stdout.write('OK:' + args.at(-1));
    `);
    chmodSync(script, 0o755);

    const adapter = new CodexAdapter({ command: script, args: [] });
    const out = await adapter.ask({ prompt: 'hi-codex', history: [] }, new AbortController().signal);
    expect(out).toContain('OK:');
    expect(out).toContain('# user');
    expect(out).toContain('hi-codex');
  });

  it('prefers Codex output-last-message when available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-codex-test-'));
    const script = join(dir, 'fake-codex.cjs');
    writeFileSync(script, `#!/usr/bin/env node
      const { writeFileSync } = require('node:fs');
      const args = process.argv.slice(2);
      const outIdx = args.indexOf('--output-last-message');
      writeFileSync(args[outIdx + 1], 'final from file');
      process.stdout.write('noisy json event');
    `);
    chmodSync(script, 0o755);

    const adapter = new CodexAdapter({ command: script, args: [] });
    const out = await adapter.ask({ prompt: 'hi-codex', history: [] }, new AbortController().signal);
    expect(out).toBe('final from file');
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
    expect(out).toContain('["exec","--skip-git-repo-check","--output-last-message"');
    expect(out).toContain('"--json"');
  });

  it('drops echoed prompt history from Codex terminal output', () => {
    const payload = [
      '# user: shaw',
      '上一轮用户消息',
      '',
      '# assistant: drama',
      '上一轮回复',
      '',
      '# system',
      '历史运行错误',
      '',
      '# user',
      '调用 GPT Image 2，给我生成一张图，图中有4框桃子',
    ].join('\n');
    const raw = `${payload}\n\n已生成文件:\n- /Users/shaw/.agentbean/team/drama/outputs/peach.png`;

    expect(extractCodexReply(raw, payload)).toBe('已生成文件:\n- /Users/shaw/.agentbean/team/drama/outputs/peach.png');
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
  it('passes Claude Code bare mode through when configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-claude-test-'));
    const script = join(dir, 'fake-claude.cjs');
    writeFileSync(script, `#!/usr/bin/env node
      const args = process.argv.slice(2);
      if (args[0] !== '-p') {
        process.stderr.write('missing print mode');
        process.exit(2);
      }
      if (!args.includes('--bare')) {
        process.stderr.write('missing bare mode');
        process.exit(3);
      }
      process.stdout.write('OK:' + args.join(' '));
    `);
    chmodSync(script, 0o755);

    const adapter = new ClaudeCodeAdapter({ command: script, args: ['--bare'] });
    const out = await adapter.ask({ prompt: 'hi', history: [] }, new AbortController().signal);
    expect(out).toContain('OK:-p --bare');
  });

  it('rejects on bad command', async () => {
    const badAdapter = new ClaudeCodeAdapter({ command: '/nonexistent/binary' });
    await expect(
      badAdapter.ask({ prompt: 'hi', history: [] }, new AbortController().signal),
    ).rejects.toThrow();
  });
});

describe('OpenClawAdapter', () => {
  it('invokes openclaw agent --agent main --message <prompt>', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-openclaw-test-'));
    const script = join(dir, 'fake-openclaw.cjs');
    writeFileSync(script, `
      const args = process.argv.slice(1);
      if (!args.includes('agent')) {
        process.stderr.write('missing agent command');
        process.exit(1);
      }
      const agentIdx = args.indexOf('--agent');
      if (agentIdx < 0 || args[agentIdx + 1] !== 'main') {
        process.stderr.write('missing --agent main');
        process.exit(1);
      }
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

  it('drops gateway-run args before invoking agent turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-openclaw-test-'));
    const script = join(dir, 'fake-openclaw.cjs');
    writeFileSync(script, `
      if (process.argv.includes('gateway') || process.argv.includes('run')) {
        process.exit(7);
      }
      const args = process.argv.slice(1);
      if (!args.includes('agent')) {
        process.stderr.write('missing agent command');
        process.exit(1);
      }
      const agentIdx = args.indexOf('--agent');
      if (agentIdx < 0 || args[agentIdx + 1] !== 'main') {
        process.stderr.write('missing --agent main');
        process.exit(1);
      }
      const msgIdx = args.indexOf('--message');
      if (msgIdx >= 0 && args[msgIdx + 1]) {
        process.stdout.write(args[msgIdx + 1]);
      } else {
        process.stderr.write('missing --message');
        process.exit(1);
      }
    `);
    const adapter = new OpenClawAdapter({ command: process.execPath, args: ['gateway', 'run', script] });
    const out = await adapter.ask({ prompt: 'hi-oc', history: [] }, new AbortController().signal);
    expect(out).toBe('hi-oc');
  });

  it('preserves explicitly configured openclaw agent args', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-openclaw-test-'));
    const script = join(dir, 'fake-openclaw.cjs');
    writeFileSync(script, `
      const args = process.argv.slice(1);
      const msgIdx = args.indexOf('-m');
      const agentIdx = args.indexOf('--agent');
      if (!args.includes('agent') || !args.includes('--local') || agentIdx < 0 || args[agentIdx + 1] !== 'main') {
        process.stderr.write('missing configured args');
        process.exit(1);
      }
      if (msgIdx >= 0 && args[msgIdx + 1]) {
        process.stdout.write(args[msgIdx + 1]);
      } else {
        process.stderr.write('missing -m');
        process.exit(1);
      }
    `);
    const adapter = new OpenClawAdapter({ command: process.execPath, args: [script, 'agent', '--local', '-m'] });
    const out = await adapter.ask({ prompt: 'hi-oc', history: [] }, new AbortController().signal);
    expect(out).toBe('hi-oc');
  });

  it('preserves explicitly configured openclaw target selector', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-openclaw-test-'));
    const script = join(dir, 'fake-openclaw.cjs');
    writeFileSync(script, `
      const args = process.argv.slice(1);
      const agentValues = args.filter((arg, index) => args[index - 1] === '--agent');
      if (agentValues.length !== 1 || agentValues[0] !== 'ops') {
        process.stderr.write('wrong agent selector: ' + agentValues.join(','));
        process.exit(1);
      }
      const msgIdx = args.indexOf('--message');
      if (msgIdx >= 0 && args[msgIdx + 1]) {
        process.stdout.write(args[msgIdx + 1]);
      } else {
        process.stderr.write('missing --message');
        process.exit(1);
      }
    `);
    const adapter = new OpenClawAdapter({ command: process.execPath, args: [script, 'agent', '--agent', 'ops'] });
    const out = await adapter.ask({ prompt: 'hi-ops', history: [] }, new AbortController().signal);
    expect(out).toBe('hi-ops');
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

  it('drops multiline Query history from Hermes terminal output', () => {
    const raw = `Query: 你装了哪些 Skills？

---

hermes-agent (assistant): 今天你在用什么模型？

---

@Hermes-Agent hello, 今天你在用什么模型？

Initializing agent...
────────────────────────────────────────

╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮
    我现在加载了以下 Skills：

    - architecture-diagram
    - baoyu-infographic
╰──────────────────────────────────────────────────────────────────────────────╯

Resume this session with:
  hermes --resume 20260520_123456`;

    expect(extractHermesReply(raw)).toBe(`我现在加载了以下 Skills：

- architecture-diagram
- baoyu-infographic`);
  });
});
