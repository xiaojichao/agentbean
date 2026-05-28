import { describe, expect, it } from 'vitest';
import { createDeviceSocketOptions, nativeDirectoryPickerCommands, resolveCustomAgentRuntime } from '../src/device-daemon.js';

describe('device daemon socket options', () => {
  it('prefers WebSocket while keeping Socket.IO polling fallback for long-running device connections', () => {
    const options = createDeviceSocketOptions({
      token: 'token',
      deviceId: 'device-1',
      networkId: 'team-1',
      agents: [],
      systemInfo: {
        hostname: 'mac-mini',
        platform: 'darwin',
        release: '25.0.0',
        arch: 'arm64',
        cpus: 10,
        cpuModel: 'Apple M1 Pro',
        totalMemory: 1024,
        nodeVersion: 'v24.0.0',
        daemonVersion: '0.0.0-test',
      },
    });

    expect(options.transports).toEqual(['websocket', 'polling']);
    expect(options.rememberUpgrade).toBe(true);
    expect(options.reconnection).toBe(true);
    expect(options.reconnectionDelay).toBe(1_000);
    expect(options.reconnectionDelayMax).toBe(10_000);
    expect(options.timeout).toBe(20_000);
    expect(options.auth).toMatchObject({
      token: 'token',
      deviceId: 'device-1',
      networkId: 'team-1',
      daemonVersion: '0.0.0-test',
      capabilities: { customAgentDispatch: true, directoryPicker: true },
    });
  });

  it('uses native folder chooser commands for supported desktop platforms', () => {
    const macPicker = nativeDirectoryPickerCommands('darwin')[0];
    expect(macPicker).toMatchObject({ command: 'osascript' });
    expect(macPicker.args).toContain('tell application "Finder" to activate');
    expect(macPicker.args.join('\n')).toContain('default location (path to home folder)');
    expect(nativeDirectoryPickerCommands('win32')[0]).toMatchObject({ command: 'powershell.exe' });
    expect(nativeDirectoryPickerCommands('linux').map((cmd) => cmd.command)).toEqual(['zenity', 'kdialog']);
  });

  it('falls back to the detected runtime command for stale custom agent paths', () => {
    const resolved = resolveCustomAgentRuntime({
      id: 'custom-1',
      name: 'codexcli001',
      adapterKind: 'codex',
      command: '/old/node/bin/codex',
    }, [
      { name: 'Codex CLI', adapterKind: 'codex', command: '/opt/homebrew/bin/codex', installed: true },
    ]);

    expect(resolved.command).toBe('/opt/homebrew/bin/codex');
  });

  it('keeps a valid absolute custom agent command instead of blindly replacing it', () => {
    const resolved = resolveCustomAgentRuntime({
      id: 'custom-2',
      name: 'local-codex',
      adapterKind: 'codex',
      command: process.execPath,
    }, [
      { name: 'Codex CLI', adapterKind: 'codex', command: '/opt/homebrew/bin/codex', installed: true },
    ]);

    expect(resolved.command).toBe(process.execPath);
  });

  it('falls back to the basename when a saved absolute custom agent command is missing', () => {
    const resolved = resolveCustomAgentRuntime({
      id: 'custom-3',
      name: 'test-Agent',
      adapterKind: 'codex',
      command: '/old/node/bin/codex',
    }, []);

    expect(resolved.command).toBe('codex');
  });

  it('uses the detected Claude Code runtime when a custom agent has no saved command', () => {
    const resolved = resolveCustomAgentRuntime({
      id: 'custom-4',
      name: 'claude-code-agent',
      adapterKind: 'claude-code',
      command: '',
    }, [
      {
        name: 'Claude Code',
        adapterKind: 'claude-code',
        command: '/Users/shaw/.local/share/claude-latest/current/claude',
        installed: true,
      },
    ]);

    expect(resolved.command).toBe('/Users/shaw/.local/share/claude-latest/current/claude');
  });
});
