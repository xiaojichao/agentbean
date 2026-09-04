'use client';
import { useEffect, useState } from 'react';
import { getStoredAuthToken, notificationEvents } from '@/lib/socket';
import { browserPushSupported, browserPushRegistration, clearBrowserPush, enableBrowserPush, pushBinding } from '@/lib/browser-push';

export function useBrowserPush({ userId, connected }: { userId?: string; connected: boolean }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('正在检查系统推送…');
  const supported = browserPushSupported();
  useEffect(() => {
    let active = true;
    setEnabled(false);
    setPublicKey(null);
    if (!supported) { setMessage('此浏览器暂不支持系统推送'); return; }
    if (!connected || !userId) { setMessage('连接恢复后可设置系统推送'); return; }
    const token = getStoredAuthToken();
    const sessionChanged = () => {
      if (getStoredAuthToken() !== token) {
        active = false; setEnabled(false); setPublicKey(null);
        void clearBrowserPush().catch(() => undefined);
      }
    };
    window.addEventListener('storage', sessionChanged);
    void (async () => {
      try {
        const binding = await pushBinding();
        if (!active) return;
        if (binding && binding.userId !== userId) await clearBrowserPush();
        const config = await notificationEvents().pushConfig();
        if (!active) return;
        setPublicKey(config.publicKey ?? null);
        if (!config.ok || !config.publicKey) { setMessage('系统推送尚未启用'); return; }
        if (binding && (binding.userId !== userId || binding.publicKey !== config.publicKey || Notification.permission !== 'granted')) {
          const endpoint = await clearBrowserPush();
          if (endpoint) await notificationEvents().pushUnsubscribe({ endpoint });
        }
        const subscription = await (await browserPushRegistration())?.pushManager.getSubscription();
        if (!active) return;
        if (binding?.userId === userId && binding.publicKey === config.publicKey && subscription && Notification.permission === 'granted') {
          const response = await notificationEvents().pushSubscribe({ subscription: subscription.toJSON() });
          if (!active) return;
          setEnabled(response.ok);
          setMessage(response.ok ? '离开页面后也能收到提醒' : '系统推送同步失败，请重新开启');
        } else setMessage(Notification.permission === 'denied' ? '请在浏览器设置中允许通知' : '开启后，离开页面也能收到提醒');
      } catch { if (active) setMessage('系统推送暂时不可用，请稍后重试'); }
    })();
    return () => { active = false; window.removeEventListener('storage', sessionChanged); };
  }, [userId, connected, supported]);
  const toggle = async () => {
    if (!userId || !publicKey || busy) return;
    setBusy(true);
    const token = getStoredAuthToken();
    try {
      if (enabled) {
        const endpoint = await clearBrowserPush();
        if (endpoint) await notificationEvents().pushUnsubscribe({ endpoint });
        setEnabled(false);
        setMessage('系统推送已关闭，侧栏提醒仍保留');
      } else {
        // Permission request must originate directly in this user click.
        setMessage('请在浏览器弹窗中允许通知');
        let timeout: number | undefined;
        let permission: NotificationPermission;
        try {
          permission = await Promise.race([
            Notification.requestPermission(),
            new Promise<never>((_, reject) => {
              timeout = window.setTimeout(() => reject(new Error('系统推送授权尚未完成，请允许通知后重试')), 30_000);
            }),
          ]);
        } finally { window.clearTimeout(timeout); }
        if (permission !== 'granted') { setMessage('请在浏览器设置中允许通知'); return; }
        const subscription = await enableBrowserPush(publicKey);
        const result = await notificationEvents().pushSubscribe({ subscription: subscription.toJSON() });
        if (!result.ok) { await clearBrowserPush(); throw new Error('系统推送开启失败，请稍后重试'); }
        if (getStoredAuthToken() !== token) { await clearBrowserPush(); return; }
        await pushBinding({ userId, publicKey });
        setEnabled(true);
        setMessage('离开页面后也能收到提醒');
      }
    } catch (error) {
      setMessage(error instanceof Error && error.message.startsWith('系统推送') ? error.message : '系统推送开启失败，请稍后重试');
    } finally { setBusy(false); }
  };
  return { enabled, busy, message, available: supported && Boolean(publicKey), connected, toggle };
}

export function BrowserPushSettings({ state }: { state: ReturnType<typeof useBrowserPush> }) {
  const { enabled, busy, message, available, connected, toggle } = state;
  return <div className="border-t border-neutral-200 px-3 py-3" data-smoke="browser-push-settings">
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="font-medium text-neutral-700">系统推送</span>
      {available && <button type="button" onClick={() => { void toggle(); }} disabled={busy || !connected}
        className="text-pink-700 disabled:opacity-50" aria-label={enabled ? '关闭系统推送' : '开启系统推送'}>
        {busy ? '处理中…' : enabled ? '关闭' : '开启'}
      </button>}
    </div>
    <p role="status" className="mt-1 text-xs text-neutral-500">{message}</p>
  </div>;
}
