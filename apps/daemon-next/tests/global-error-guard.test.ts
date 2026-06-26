import { afterEach, describe, expect, test, vi } from 'vitest';

describe('daemon 全局错误兜底', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('注册 unhandledRejection 与 uncaughtException 处理器', async () => {
    const addSpy = vi.spyOn(process, 'on');
    vi.resetModules();
    await import('../src/cli');
    const events = addSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain('unhandledRejection');
    expect(events).toContain('uncaughtException');
  });
});
