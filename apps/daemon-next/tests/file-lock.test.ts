import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { withLocalMemoryFileLock } from '../src/memory/file-lock';

const childFixture = fileURLToPath(new URL('./fixtures/file-lock-child.ts', import.meta.url));

describe('local Memory cross-process file lock', () => {
  test('child process 崩溃后 ESRCH 立即按 token/inode 回收，不等待 heartbeat stale', async () => {
    const lockFile = join(mkdtempSync(join(tmpdir(), 'agentbean-lock-crash-')), 'items.lock');
    const child = startChild(lockFile, 'crash');
    await child.ready;
    await expect(child.exited).resolves.toBe(17);

    let acquired = false;
    await withLocalMemoryFileLock(lockFile, async () => {
      acquired = true;
    }, { timeoutMs: 500, pollMs: 5, heartbeatMs: 10, staleHeartbeatMs: 60_000 });

    expect(acquired).toBe(true);
  });

  test('create 原子发布前崩溃只留下 partial temp，不阻塞立即重启', async () => {
    const lockFile = join(mkdtempSync(join(tmpdir(), 'agentbean-lock-partial-create-')), 'items.lock');
    const child = startChild(lockFile, 'partial-create');
    await child.ready;
    await expect(child.exited).resolves.toBe(18);

    expect(existsSync(lockFile)).toBe(false);
    await expect(withLocalMemoryFileLock(lockFile, async () => 'restarted', {
      timeoutMs: 200, pollMs: 5, heartbeatMs: 10, staleHeartbeatMs: 100,
    })).resolves.toBe('restarted');
  });

  test('历史 malformed lock 经 grace 与稳定 inode 复验后可恢复', async () => {
    const lockFile = join(mkdtempSync(join(tmpdir(), 'agentbean-lock-malformed-')), 'items.lock');
    const child = startChild(lockFile, 'malformed-lock');
    await child.ready;
    await expect(child.exited).resolves.toBe(20);

    await expect(withLocalMemoryFileLock(lockFile, async () => 'restarted', {
      timeoutMs: 500, pollMs: 5, heartbeatMs: 10, staleHeartbeatMs: 100,
      malformedGraceMs: 40,
    })).resolves.toBe('restarted');
  });

  test('heartbeat 中途崩溃只留下 partial temp，已发布 heartbeat 保持完整且可立即恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbean-lock-partial-heartbeat-'));
    const lockFile = join(root, 'items.lock');
    const child = startChild(lockFile, 'partial-heartbeat');
    await child.ready;
    await expect(child.exited).resolves.toBe(19);
    expect(lockHeartbeat(lockFile)).toBeGreaterThan(0);
    expect(readdirSync(root).some((name) => name.includes('.tmp-crash-'))).toBe(true);

    await expect(withLocalMemoryFileLock(lockFile, async () => 'restarted', {
      timeoutMs: 500, pollMs: 5, heartbeatMs: 10, staleHeartbeatMs: 60_000,
    })).resolves.toBe('restarted');
  });

  test('slow owner 持续 heartbeat 时不可被抢锁，释放后下一进程可获取', async () => {
    const lockFile = join(mkdtempSync(join(tmpdir(), 'agentbean-lock-slow-')), 'items.lock');
    const child = startChild(lockFile, 'hold', 250);
    await child.ready;
    const firstHeartbeat = lockHeartbeat(lockFile);
    await delay(80);
    expect(lockHeartbeat(lockFile)).toBeGreaterThan(firstHeartbeat);

    await expect(withLocalMemoryFileLock(lockFile, async () => undefined, {
      timeoutMs: 60, pollMs: 5, heartbeatMs: 10, staleHeartbeatMs: 40,
    })).rejects.toThrow('LOCAL_MEMORY_LOCK_TIMEOUT');
    await expect(child.exited).resolves.toBe(0);
    await expect(withLocalMemoryFileLock(lockFile, async () => 'next', {
      timeoutMs: 200, pollMs: 5, heartbeatMs: 10, staleHeartbeatMs: 50,
    })).resolves.toBe('next');
  });

  test('finally 只删除自己的 token/inode，不删除已被替换的新 owner 锁', async () => {
    const lockFile = join(mkdtempSync(join(tmpdir(), 'agentbean-lock-owner-')), 'items.lock');
    const replacement = {
      schemaVersion: 2, ownerToken: 'replacement-owner', pid: process.pid, createdAt: Date.now(),
    };

    await withLocalMemoryFileLock(lockFile, async () => {
      rmSync(lockFile);
      writeFileSync(lockFile, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    }, { timeoutMs: 200, pollMs: 5, heartbeatMs: 50, staleHeartbeatMs: 200 });

    expect(existsSync(lockFile)).toBe(true);
    expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({ ownerToken: 'replacement-owner' });
    rmSync(lockFile);
  });
});

function startChild(
  lockFile: string,
  mode: 'crash' | 'hold' | 'partial-create' | 'partial-heartbeat' | 'malformed-lock',
  holdMs = 250,
): {
  readonly process: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly exited: Promise<number | null>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', childFixture, lockFile, mode, String(holdMs)], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    const timeout = setTimeout(() => rejectReady(new Error(`child lock timeout: ${stderr}`)), 2_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('READY')) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once('exit', (code) => {
      if (!stdout.includes('READY')) {
        clearTimeout(timeout);
        rejectReady(new Error(`child exited ${String(code)} before ready: ${stderr}`));
      }
    });
  });
  return { process: child, ready, exited };
}

function lockHeartbeat(lockFile: string): number {
  const owner = JSON.parse(readFileSync(lockFile, 'utf8')) as { ownerToken: string };
  const heartbeat = JSON.parse(
    readFileSync(`${lockFile}.heartbeat-${owner.ownerToken}`, 'utf8'),
  ) as { heartbeatAt: unknown };
  return Number(heartbeat.heartbeatAt);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
