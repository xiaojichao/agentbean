import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * 用 scrypt + 随机 salt 哈希密码，存储格式 `saltHex:hashHex`。
 * 替代旧版 server-next 的裸 SHA256（无 salt、无慢哈希）。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

/** 校验 scrypt 哈希；stored 不含 `:`（旧 SHA256）时返回 false。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const storedHash = Buffer.from(hashHex, 'hex');
  if (storedHash.length !== KEY_LENGTH) return false;

  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) return reject(err);
      if (derivedKey.length !== storedHash.length) return resolve(false);
      resolve(timingSafeEqual(derivedKey, storedHash));
    });
  });
}

/**
 * 迁移期辅助：旧版 server-next 用裸 SHA256 存密码。
 * 登录/改密时若 isLegacyHash 为真，用此函数校验当前密码；
 * 通过后由上层调用 updatePassword 重写为 scrypt，实现无感升级。
 */
export function verifyLegacySha256(password: string, stored: string): boolean {
  return createHash('sha256').update(password).digest('hex') === stored;
}

/** 旧 SHA256 哈希不含 `:`；scrypt 哈希格式为 `saltHex:hashHex`。 */
export function isLegacyHash(stored: string): boolean {
  return !stored.includes(':');
}
