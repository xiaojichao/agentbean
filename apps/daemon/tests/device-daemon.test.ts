import { describe, expect, it } from 'vitest';
import { createDeviceSocketOptions, nativeDirectoryPickerCommands } from '../src/device-daemon.js';

describe('device daemon socket options', () => {
  it('allows Socket.IO transport fallback for long-running device connections', () => {
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

    expect(options).not.toHaveProperty('transports');
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
    expect(nativeDirectoryPickerCommands('darwin')[0]).toMatchObject({ command: 'osascript' });
    expect(nativeDirectoryPickerCommands('win32')[0]).toMatchObject({ command: 'powershell.exe' });
    expect(nativeDirectoryPickerCommands('linux').map((cmd) => cmd.command)).toEqual(['zenity', 'kdialog']);
  });
});
