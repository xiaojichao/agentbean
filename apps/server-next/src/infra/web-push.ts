import { createECDH, createHash, ECDH } from 'node:crypto';
import webpush from 'web-push';
import type { BrowserPushSubscription } from '../application/push-notification-repository.js';

export interface WebPushSender {
  publicKey: string;
  send(subscription: BrowserPushSubscription, payload: { id: string; recipientId: string; url: string }): Promise<void>;
}
export interface WebPushConfig { subject: string; publicKey: string; privateKey: string }

export function parseWebPushConfig(env: NodeJS.ProcessEnv): WebPushConfig | undefined {
  const publicKey = env.AGENTBEAN_WEB_PUSH_PUBLIC_KEY;
  const privateKey = env.AGENTBEAN_WEB_PUSH_PRIVATE_KEY;
  const subject = env.AGENTBEAN_WEB_PUSH_SUBJECT;
  if (!publicKey && !privateKey && !subject) return undefined;
  try {
    if (!publicKey || !privateKey || !subject || !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) throw new Error();
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (ecdh.getPublicKey().toString('base64url') !== publicKey) throw new Error();
  } catch { throw new Error('AGENTBEAN_WEB_PUSH configuration must include a valid subject and matching VAPID key pair'); }
  return { subject, publicKey: publicKey!, privateKey: privateKey! };
}

/** Fixed browser-provider hosts prevent authenticated callers from turning push into SSRF. */
export function parseBrowserSubscription(value: unknown): { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number } | null {
  try {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.endpoint !== 'string' || candidate.endpoint.length > 4096) return null;
    const url = new URL(candidate.endpoint);
    const trusted = url.hostname === 'fcm.googleapis.com'
      // Chromium's staging GCM endpoint is also returned by ego-browser.
      || url.hostname === 'jmt17.google.com'
      || url.hostname === 'updates.push.services.mozilla.com'
      || url.hostname.endsWith('.push.services.mozilla.com')
      || url.hostname === 'web.push.apple.com'
      || url.hostname.endsWith('.notify.windows.com');
    if (!trusted || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return null;
    const keys = candidate.keys as Record<string, unknown> | undefined;
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
      || !/^[A-Za-z0-9_-]{87}=?$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(keys.auth)) return null;
    const publicKey = Buffer.from(keys.p256dh, 'base64url');
    if (publicKey.length !== 65 || publicKey[0] !== 4 || Buffer.from(keys.auth, 'base64url').length !== 16) return null;
    ECDH.convertKey(publicKey, 'prime256v1');
    if (candidate.expirationTime != null && (typeof candidate.expirationTime !== 'number' || !Number.isFinite(candidate.expirationTime))) return null;
    return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth },
      ...(typeof candidate.expirationTime === 'number' ? { expirationTime: candidate.expirationTime } : {}) };
  } catch { return null; }
}
export function pushSubscriptionId(endpoint: string) { return createHash('sha256').update(endpoint).digest('hex'); }
export function createWebPushSender(config: WebPushConfig): WebPushSender {
  return {
    publicKey: config.publicKey,
    async send(subscription, payload) {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: config, TTL: 3600, urgency: 'high', timeout: 5_000,
        topic: createHash('sha256').update(payload.id).digest('base64url').slice(0, 32),
      });
    },
  };
}
