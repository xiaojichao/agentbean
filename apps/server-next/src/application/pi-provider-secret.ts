import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

/**
 * AES-256-GCM encryption for PI Provider API keys.
 * Key material comes from AGENTBEAN_PI_SECRET_KEY (deployment secret).
 * Ciphertext is stored; DTOs, logs, and errors never echo plain or cipher text.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const KEY_VERSION = 1;

export interface EncryptedPiProviderSecret {
  readonly keyVersion: number;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly fingerprint: string;
}

export type PiSecretKeyResolution =
  | { readonly ok: true; readonly key: Buffer }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

export function resolvePiSecretKey(env: NodeJS.ProcessEnv = process.env): PiSecretKeyResolution {
  const raw = env.AGENTBEAN_PI_SECRET_KEY?.trim();
  if (!raw) return { ok: false, reason: 'missing' };
  // Accept 32-byte raw utf8, 64-char hex, or arbitrary passphrase (scrypt-derived).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return { ok: true, key: Buffer.from(raw, 'hex') };
  }
  if (Buffer.byteLength(raw, 'utf8') === KEY_LENGTH) {
    return { ok: true, key: Buffer.from(raw, 'utf8') };
  }
  try {
    const key = scryptSync(raw, 'agentbean-pi-provider-v1', KEY_LENGTH);
    return { ok: true, key };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export function encryptPiProviderApiKey(
  apiKey: string,
  key: Buffer,
): EncryptedPiProviderSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    keyVersion: KEY_VERSION,
    ciphertext: encrypted,
    iv,
    authTag,
    fingerprint: fingerprintApiKey(apiKey),
  };
}

export function decryptPiProviderApiKey(
  secret: Pick<EncryptedPiProviderSecret, 'ciphertext' | 'iv' | 'authTag'>,
  key: Buffer,
): string {
  const decipher = createDecipheriv(ALGORITHM, key, secret.iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(secret.authTag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
}

/** Short non-reversible fingerprint for rotation recognition. */
export function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 12);
}

export function serializeEncryptedSecret(secret: EncryptedPiProviderSecret): string {
  // Storage format: v1.<iv_b64url>.<tag_b64url>.<cipher_b64url>
  return [
    `v${secret.keyVersion}`,
    secret.iv.toString('base64url'),
    secret.authTag.toString('base64url'),
    secret.ciphertext.toString('base64url'),
  ].join('.');
}

export function parseEncryptedSecret(serialized: string): EncryptedPiProviderSecret | null {
  const parts = serialized.split('.');
  if (parts.length !== 4) return null;
  const [version, ivB64, tagB64, cipherB64] = parts;
  if (!version || !ivB64 || !tagB64 || !cipherB64) return null;
  const match = /^v(\d+)$/.exec(version);
  if (!match) return null;
  try {
    return {
      keyVersion: Number(match[1]),
      iv: Buffer.from(ivB64, 'base64url'),
      authTag: Buffer.from(tagB64, 'base64url'),
      ciphertext: Buffer.from(cipherB64, 'base64url'),
      fingerprint: '',
    };
  } catch {
    return null;
  }
}
