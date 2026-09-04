// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { pushBinding } from '../lib/browser-push';

afterEach(() => vi.unstubAllGlobals());
function harness() {
  const indexedDB = new IDBFactory();
  vi.stubGlobal('indexedDB', indexedDB);
  const handlers = new Map<string, (event: unknown) => void>();
  const navigate = vi.fn().mockResolvedValue(undefined);
  const focus = vi.fn().mockResolvedValue(undefined);
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const client = { url: 'https://agentbean.test/project/chat', navigate, focus };
  const self = { location: { origin: 'https://agentbean.test' },
    addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    registration: { showNotification }, skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue([client]), openWindow } };
  runInNewContext(readFileSync(new URL('../public/agentbean-push-sw.js', import.meta.url), 'utf8'), { self, indexedDB, URL });
  return { self, showNotification, navigate, focus, openWindow, async emit(name: string, fields: object) {
    let work: Promise<unknown> | undefined;
    handlers.get(name)!({ ...fields, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    await work;
  } };
}
const payload = { id: 'notice', recipientId: 'user', url: '/project/tasks?task=task&notice=notice&noticeTeam=team' };
test('离站 push 展示系统提醒；重复事件不重复；点击复用窗口并定位原交付', async () => {
  const browser = harness();
  await pushBinding({ userId: 'user', publicKey: 'key' });
  await browser.emit('push', { data: { json: () => payload } });
  await browser.emit('push', { data: { json: () => payload } });
  expect(browser.showNotification).toHaveBeenCalledTimes(1);
  const [title, options] = browser.showNotification.mock.calls[0];
  expect(title).toBe('AgentBean 有新的任务交付');
  expect(options).toMatchObject({ tag: 'agentbean:notice', renotify: false, body: '点击查看结果' });
  const close = vi.fn();
  await browser.emit('notificationclick', { notification: { data: options.data, close } });
  expect(close).toHaveBeenCalledOnce();
  expect(browser.navigate).toHaveBeenCalledWith('https://agentbean.test' + payload.url);
  expect(browser.focus).toHaveBeenCalledOnce();
});
test('退出、切换账号与恶意 URL 不展示或打开通知', async () => {
  const browser = harness();
  await pushBinding({ userId: 'other', publicKey: 'key' });
  await browser.emit('push', { data: { json: () => payload } });
  expect(browser.showNotification).not.toHaveBeenCalled();
  await pushBinding({ userId: 'user', publicKey: 'key' });
  for (const url of ['https://evil.test', '//evil.test', '/\\\\evil.test']) {
    await browser.emit('push', { data: { json: () => ({ ...payload, url }) } });
  }
  expect(browser.showNotification).not.toHaveBeenCalled();
  await pushBinding(null);
  await browser.emit('push', { data: { json: () => payload } });
  await browser.emit('notificationclick', { notification: { data: { url: 'https://agentbean.test' + payload.url, recipientId: 'user' }, close: vi.fn() } });
  expect(browser.showNotification).not.toHaveBeenCalled();
  expect(browser.navigate).not.toHaveBeenCalled();
  expect(browser.openWindow).not.toHaveBeenCalled();
});
