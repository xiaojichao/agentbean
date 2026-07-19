import { chmod, lstat, mkdir } from 'node:fs/promises';

export async function ensurePrivateDeviceServiceDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!stats.isDirectory() || (currentUid !== undefined && stats.uid !== currentUid)) {
    throw new Error('SERVICE_DIRECTORY_UNSAFE');
  }
  await chmod(path, 0o700);
}
