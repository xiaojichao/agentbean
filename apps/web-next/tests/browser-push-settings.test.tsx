// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BrowserPushSettings, useBrowserPush } from '../components/browser-push-settings';

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const mocks = vi.hoisted(() => ({
  config: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), binding: vi.fn(), clear: vi.fn(),
  enable: vi.fn(), registration: vi.fn(), permission: vi.fn(),
}));
vi.mock('@/lib/socket', () => ({
  getStoredAuthToken: () => 'test-token',
  notificationEvents: () => ({ pushConfig: mocks.config, pushSubscribe: mocks.subscribe, pushUnsubscribe: mocks.unsubscribe }),
}));
vi.mock('@/lib/browser-push', () => ({
  browserPushSupported: () => true, browserPushRegistration: mocks.registration,
  clearBrowserPush: mocks.clear, enableBrowserPush: mocks.enable, pushBinding: mocks.binding,
}));
function Surface({ userId = 'user' }: { userId?: string }) {
  return <BrowserPushSettings state={useBrowserPush({ userId, connected: true })} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ ok: true, publicKey: 'key' });
  mocks.binding.mockResolvedValue(null);
  mocks.registration.mockResolvedValue(undefined);
  mocks.subscribe.mockResolvedValue({ ok: true });
  mocks.unsubscribe.mockResolvedValue({ ok: true });
  mocks.clear.mockResolvedValue('https://fcm.googleapis.com/test');
  mocks.enable.mockResolvedValue({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/test' }) });
  mocks.permission.mockResolvedValue('granted');
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: mocks.permission });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
test('授权未响应时提示用户并恢复按钮，过期的授权结果不偷偷开启推送', async () => {
  let grant!: (permission: NotificationPermission) => void;
  mocks.permission.mockReturnValue(new Promise<NotificationPermission>((resolve) => { grant = resolve; }));
  render(<Surface />);
  const button = await screen.findByLabelText('开启系统推送');
  vi.useFakeTimers();
  fireEvent.click(button);
  expect(screen.getByText('请在浏览器弹窗中允许通知')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('系统推送授权尚未完成，请允许通知后重试')).toBeTruthy();
  expect((button as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { grant('granted'); });
  expect(mocks.enable).not.toHaveBeenCalled();
});
test('只有点击才请求权限；开启保存绑定；关闭清理本地与服务端订阅', async () => {
  render(<Surface />);
  const enable = await screen.findByLabelText('开启系统推送');
  expect(mocks.permission).not.toHaveBeenCalled();
  fireEvent.click(enable);
  await screen.findByLabelText('关闭系统推送');
  expect(mocks.permission).toHaveBeenCalledTimes(1);
  expect(mocks.binding).toHaveBeenCalledWith({ userId: 'user', publicKey: 'key' });
  fireEvent.click(screen.getByLabelText('关闭系统推送'));
  await screen.findByText('系统推送已关闭，侧栏提醒仍保留');
  expect(mocks.clear).toHaveBeenCalledOnce();
  expect(mocks.unsubscribe).toHaveBeenCalledWith({ endpoint: 'https://fcm.googleapis.com/test' });
});
test('拒绝授权不注册订阅；Server 未配置时不显示开启按钮', async () => {
  mocks.permission.mockResolvedValue('denied');
  const view = render(<Surface />);
  fireEvent.click(await screen.findByLabelText('开启系统推送'));
  await screen.findByText('请在浏览器设置中允许通知');
  expect(mocks.enable).not.toHaveBeenCalled();
  view.unmount();
  mocks.config.mockResolvedValue({ ok: true, publicKey: null });
  render(<Surface />);
  await screen.findByText('系统推送尚未启用');
  expect(screen.queryByLabelText('开启系统推送')).toBeNull();
});
test('换账号先撤销旧本机绑定，绝不自动继承其他账号的订阅', async () => {
  mocks.binding.mockResolvedValue({ userId: 'old-user', publicKey: 'key' });
  render(<Surface />);
  await waitFor(() => expect(mocks.clear).toHaveBeenCalled());
  expect(mocks.subscribe).not.toHaveBeenCalled();
  expect(mocks.permission).not.toHaveBeenCalled();
});
