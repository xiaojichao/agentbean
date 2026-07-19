import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { daemonUpgradeGuidance } from '../lib/daemon-version';

describe('device daemon upgrade guidance', () => {
  test('routes macOS upgrade instructions by installed version', () => {
    expect(daemonUpgradeGuidance('0.3.12')).toEqual({
      mode: 'bootstrap',
      command: 'npm install -g @agentbean/daemon@latest',
      description: expect.stringContaining('仅执行这一次'),
    });
    expect(daemonUpgradeGuidance('0.3.13')).toEqual({
      mode: 'self-update',
      command: 'agentbean update',
      description: expect.stringContaining('安全重启 Device Service'),
    });
    expect(daemonUpgradeGuidance('0.4.0').mode).toBe('self-update');
    expect(daemonUpgradeGuidance('0.3.11').mode).toBe('legacy');
    expect(daemonUpgradeGuidance('unknown').mode).toBe('legacy');
  });

  test('renders an always-visible, copyable macOS upgrade card and retains the legacy path', () => {
    const source = readFileSync(new URL('../app/[teamPath]/devices/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('data-smoke="daemon-upgrade-guidance"');
    const connectionStart = source.indexOf('{/* CONNECTION */}', start);
    const end = source.indexOf('{/* AGENT GROUPS */}', start);
    const guidanceAndConnection = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(connectionStart).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(start);
    expect(guidanceAndConnection).toContain('upgradeGuidance.description');
    expect(guidanceAndConnection).toContain('upgradeGuidance.command');
    expect(guidanceAndConnection).toContain('复制命令');
    expect(guidanceAndConnection).toContain("upgradeGuidance.mode === 'legacy'");
    expect(guidanceAndConnection).toContain('生成新连接命令进行升级');
  });
});
