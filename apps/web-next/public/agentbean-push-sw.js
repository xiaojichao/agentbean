/* Push only: no fetch handler and no application-response cache. */
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function stateOperation(key, value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('agentbean-browser-push', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', value === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('state');
      const operation = value === undefined ? store.get(key) : store.put(value, key);
      let result;
      operation.onsuccess = () => { result = operation.result; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
function safePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  const url = new URL(value, self.location.origin);
  return url.origin === self.location.origin ? url.href : null;
}
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    const binding = await stateOperation('binding');
    if (!binding || payload?.recipientId !== binding.userId || typeof payload.id !== 'string' || payload.id.length > 512) return;
    const url = safePath(payload.url);
    if (!url) return;
    // One tag and a bounded durable history collapse provider retries across SW restarts.
    const seen = await stateOperation('seen') || [];
    if (seen.includes(payload.id)) return;
    await self.registration.showNotification('AgentBean 有新的任务交付', {
      body: '点击查看结果', tag: 'agentbean:' + payload.id, renotify: false,
      data: { url, recipientId: payload.recipientId }, icon: '/icon.svg',
    });
    await stateOperation('seen', [...seen.slice(-199), payload.id]);
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const binding = await stateOperation('binding');
    if (!binding || binding.userId !== event.notification.data?.recipientId) return;
    const url = safePath(event.notification.data?.url?.replace(self.location.origin, ''));
    if (!url) return;
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(url); await existing.focus(); }
    else await self.clients.openWindow(url);
  })());
});
