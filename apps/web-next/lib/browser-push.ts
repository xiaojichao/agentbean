export interface PushBinding { userId: string; publicKey: string }
const DATABASE = 'agentbean-browser-push';

export async function pushBinding(value?: PushBinding | null): Promise<PushBinding | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(new Error('推送设置无法保存'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', value === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('state');
      let result: PushBinding | null = null;
      const operation = value === undefined ? store.get('binding') : store.put(value, 'binding');
      operation.onsuccess = () => { result = value === undefined ? operation.result ?? null : value; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(new Error('推送设置无法保存')); };
    };
  });
}
export function browserPushSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator
    && 'PushManager' in window && 'Notification' in window && 'indexedDB' in window;
}
export async function browserPushRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!browserPushSupported()) return undefined;
  return navigator.serviceWorker.getRegistration('/agentbean-push-sw.js');
}
/** Clear the local binding first, so queued pushes cannot appear under the next account. */
export async function clearBrowserPush(): Promise<string | null> {
  if (!browserPushSupported()) return null;
  await pushBinding(null);
  const registration = await browserPushRegistration();
  if (!registration) return null;
  const subscription = await registration.pushManager.getSubscription();
  const shown = await registration.getNotifications();
  shown.forEach((notification) => notification.close());
  if (subscription) await subscription.unsubscribe();
  return subscription?.endpoint ?? null;
}
export async function enableBrowserPush(publicKey: string): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.register('/agentbean-push-sw.js', { scope: '/', updateViaCache: 'none' });
  if (!registration.active) await new Promise<void>((resolve, reject) => {
    const worker = registration.installing ?? registration.waiting;
    if (!worker) { reject(new Error('系统推送初始化失败')); return; }
    const timeout = window.setTimeout(() => reject(new Error('系统推送初始化超时')), 10_000);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') { clearTimeout(timeout); resolve(); }
      else if (worker.state === 'redundant') { clearTimeout(timeout); reject(new Error('系统推送初始化失败')); }
    });
  });
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
}
