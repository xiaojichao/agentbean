import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSystemInfo, parseOpenClawAgentId, scanAgentOSAgents, scanRuntimes } from '../src/scanner.js';
import packageJson from '../package.json';

describe('scanRuntimes', () => {
  it('returns known runtimes with installed flag', async () => {
    const runtimes = await scanRuntimes();
    expect(runtimes.length).toBeGreaterThanOrEqual(3);
    const names = runtimes.map((r) => r.name);
    expect(names).toContain('Claude Code');
    expect(names).toContain('Codex CLI');
    expect(names).toContain('Kimi CLI');
    // Each runtime has required fields
    for (const rt of runtimes) {
      expect(rt).toHaveProperty('name');
      expect(rt).toHaveProperty('adapterKind');
      expect(rt).toHaveProperty('command');
      expect(rt).toHaveProperty('installed');
      expect(typeof rt.installed).toBe('boolean');
    }
  });
});

describe('collectSystemInfo', () => {
  it('reports the daemon package version', () => {
    expect(collectSystemInfo().daemonVersion).toBe(packageJson.version);
  });
});

describe('parseOpenClawAgentId', () => {
  it('extracts the first OpenClaw agent id from known JSON shapes', () => {
    expect(parseOpenClawAgentId(JSON.stringify({ agents: [{ id: 'ops' }] }))).toBe('ops');
    expect(parseOpenClawAgentId(JSON.stringify([{ agentId: 'main' }]))).toBe('main');
    expect(parseOpenClawAgentId('not-json')).toBeNull();
  });
});

describe('scanAgentOSAgents', () => {
  it('configures discovered OpenClaw gateway agents with an explicit target agent selector', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-openclaw-scan-'));
    const fakeOpenClaw = join(dir, 'openclaw');
    writeFileSync(fakeOpenClaw, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'gateway' && args[1] === 'status') {
  process.stdout.write('running');
  process.exit(0);
}
if (args[0] === 'agents' && args[1] === 'list' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ agents: [{ id: 'ops' }] }));
  process.exit(0);
}
process.exit(1);
`);
    chmodSync(fakeOpenClaw, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath ?? ''}`;
    try {
      const agents = await scanAgentOSAgents();
      const openclaw = agents.find((agent) => agent.adapterKind === 'openclaw');
      expect(openclaw).toMatchObject({
        name: 'OpenClaw-Agent',
        args: ['agent', '--agent', 'ops'],
      });
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('discovers OpenClaw agents even when the legacy gateway is not running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbean-openclaw-scan-'));
    const fakeOpenClaw = join(dir, 'openclaw');
    writeFileSync(fakeOpenClaw, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'gateway' && args[1] === 'status') {
  process.stdout.write('stopped');
  process.exit(0);
}
if (args[0] === 'agents' && args[1] === 'list' && args.includes('--json')) {
  process.stdout.write(JSON.stringify([{ agentId: 'local-ops' }]));
  process.exit(0);
}
process.exit(1);
`);
    chmodSync(fakeOpenClaw, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath ?? ''}`;
    try {
      const agents = await scanAgentOSAgents();
      const openclaw = agents.find((agent) => agent.adapterKind === 'openclaw');
      expect(openclaw).toMatchObject({
        name: 'OpenClaw-Agent',
        args: ['agent', '--agent', 'local-ops'],
      });
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
