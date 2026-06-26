import { afterEach, describe, expect, test, vi } from 'vitest';

describe('daemon 全局错误兜底', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('runDaemonNextCli 注册 unhandledRejection 与 uncaughtException 处理器', async () => {
    const addSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.resetModules();
    const { runDaemonNextCli } = await import('../src/cli');
    await runDaemonNextCli({ profileId: 'default', hostname: 'host', fallbackPrefix: 'daemon-next:', serverUrl: 'http://server.test', listProfiles: true }, {
      listAuthProfiles: () => [],
    });
    const events = addSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain('unhandledRejection');
    expect(events).toContain('uncaughtException');
  });
});
