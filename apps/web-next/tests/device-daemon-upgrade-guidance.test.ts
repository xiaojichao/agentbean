import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { daemonUpgradeGuidance } from '../lib/daemon-version';

describe('device daemon upgrade guidance', () => {
  test('routes macOS upgrade instructions by installed version', () => {
    expect(daemonUpgradeGuidance('0.3.12')).toEqual({
      mode: 'bootstrap',
      command: 'npm install -g @agentbean/daemon@latest && agentbean device install && agentbean device restart',
      description: expect.stringContaining('仅执行这一次'),
    });
    expect(daemonUpgradeGuidance('0.3.13')).toEqual({
      mode: 'self-update',
      command: 'agentbean update',
      description: expect.stringContaining('安全重启 Device Service'),
    });
    expect(daemonUpgradeGuidance('0.4.0').mode).toBe('self-update');
    expect(daemonUpgradeGuidance('0.3.11').mode).toBe('legacy');
    expect(daemonUpgradeGuidance('0.3.13-beta.1').mode).toBe('legacy');
    expect(daemonUpgradeGuidance('unknown').mode).toBe('legacy');
  });

  test('renders an always-visible macOS upgrade card above current Device Service recovery guidance', () => {
    const source = readFileSync(new URL('../app/[teamPath]/devices/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('data-smoke="daemon-upgrade-guidance"');
    const connectionStart = source.indexOf('{/* DEVICE SERVICE RECOVERY */}', start);
    const end = source.indexOf('{/* AGENT GROUPS */}', start);
    const guidanceAndConnection = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(connectionStart).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(start);
    expect(guidanceAndConnection).toContain('upgradeGuidance.description');
    expect(guidanceAndConnection).toContain('upgradeGuidance.command');
    expect(guidanceAndConnection).toContain('复制命令');
    expect(guidanceAndConnection).toContain('DEVICE_SERVICE_RECOVERY_COMMAND');
    expect(source).toContain("const DEVICE_SERVICE_RECOVERY_COMMAND = 'agentbean device install && agentbean device restart'");
    expect(guidanceAndConnection).toContain('生成重新连接命令');
    expect(guidanceAndConnection).not.toContain('device.connectCommand');
    expect(source).toContain("devicePlatform === 'darwin' || devicePlatform === 'macos'");
    expect(source).not.toContain('!devicePlatform ||');
  });

  test('add-device dialog explains the system-service handoff and lists copyable follow-up commands', () => {
    const source = readFileSync(new URL('../app/[teamPath]/devices/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function AddDeviceDialog');
    const end = source.indexOf('function AgentGroup', start);
    const dialog = source.slice(start, end);

    expect(dialog).toContain('operationCommands');
    expect(dialog).toContain('后续管理');
    expect(dialog).toContain('命令显示连接成功后即可关闭终端');
    expect(dialog).toContain('高级操作');
    expect(dialog).not.toContain('/device-login/');
  });
});
