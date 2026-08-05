import { describe, expect, test } from 'vitest';
import {
  blobUrlFromBase64,
  localReadMatchesArtifact,
  pickLocalReadFileDevice,
} from '../lib/local-artifact-read';
import type { Artifact, DeviceInfo } from '../lib/schema';

// #1084 切片3 web「本机优先」纯逻辑：
// - pickLocalReadFileDevice：本机 + 在线 + tree 浏览模式门控（gotcha #6）
// - localReadMatchesArtifact：sha256 版本最新性校验（gotcha #5）
// - blobUrlFromBase64：base64 → Blob URL

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 'dev-1',
    teamId: 'team-1',
    lastSeenAt: Date.now(),
    status: 'online',
    agentIds: [],
    isLocal: true,
    capabilities: { fsBrowse: true },
    ...overrides,
  } as DeviceInfo;
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'a-1',
    filename: 'report.md',
    mimeType: 'text/markdown',
    sizeBytes: 5,
    relativePath: 'report.md',
    sha256: 'abc123',
    createdAt: 0,
    ...overrides,
  } as Artifact;
}

describe('pickLocalReadFileDevice', () => {
  test('本机 + 在线 + tree 模式 → 命中', () => {
    const devices = [makeDevice()];
    expect(pickLocalReadFileDevice(devices)?.id).toBe('dev-1');
  });

  test('非本机设备被排除', () => {
    const devices = [makeDevice({ id: 'remote', isLocal: false })];
    expect(pickLocalReadFileDevice(devices)).toBeNull();
  });

  test('离线设备被排除（本机优先命中需在线）', () => {
    const devices = [makeDevice({ status: 'offline' })];
    expect(pickLocalReadFileDevice(devices)).toBeNull();
  });

  test('无 fsBrowse 能力且 daemon 版本不足 → 非 tree → 排除', () => {
    // fsBrowse 缺失 + 无 daemonVersion → fail-closed 非 tree
    const devices = [makeDevice({ capabilities: undefined, daemonVersionInfo: undefined, latestDaemonVersion: undefined })];
    expect(pickLocalReadFileDevice(devices)).toBeNull();
  });

  test('fsBrowse=false 显式无能力 → 排除（不走版本回退）', () => {
    const devices = [makeDevice({ capabilities: { fsBrowse: false } })];
    expect(pickLocalReadFileDevice(devices)).toBeNull();
  });

  test('空列表 / null → null', () => {
    expect(pickLocalReadFileDevice(null)).toBeNull();
    expect(pickLocalReadFileDevice([])).toBeNull();
    expect(pickLocalReadFileDevice(undefined)).toBeNull();
  });

  test('多设备中选本机在线 tree 那台', () => {
    const devices = [
      makeDevice({ id: 'remote', isLocal: false }),
      makeDevice({ id: 'offline-local', status: 'offline' }),
      makeDevice({ id: 'win' }),
    ];
    expect(pickLocalReadFileDevice(devices)?.id).toBe('win');
  });
});

describe('localReadMatchesArtifact', () => {
  test('sha256 完全相等 → 命中', () => {
    const result = { ok: true as const, sha256: 'abc', contentBase64: 'x' };
    const artifact = makeArtifact({ sha256: 'abc' });
    expect(localReadMatchesArtifact(result, artifact)).toBe(true);
  });

  test('sha256 不等（本机落后）→ 拒绝（回退 server）', () => {
    const result = { ok: true as const, sha256: 'old', contentBase64: 'x' };
    const artifact = makeArtifact({ sha256: 'new' });
    expect(localReadMatchesArtifact(result, artifact)).toBe(false);
  });

  test('artifact 无 sha256 → 无法判最新性 → 拒绝', () => {
    const result = { ok: true as const, sha256: 'abc', contentBase64: 'x' };
    const artifact = makeArtifact({ sha256: null });
    expect(localReadMatchesArtifact(result, artifact)).toBe(false);
  });

  test('readFile 失败回包 → 拒绝', () => {
    const result = { ok: false as const, error: 'PATH_NOT_FOUND' as const };
    const artifact = makeArtifact({ sha256: 'abc' });
    expect(localReadMatchesArtifact(result, artifact)).toBe(false);
  });
});

describe('blobUrlFromBase64', () => {
  test('base64 → blob: URL（jsdom 支持 Blob/createObjectURL）', () => {
    const url = blobUrlFromBase64('aGVsbG8=', 'text/plain');
    expect(url).toMatch(/^blob:/);
    // revoke 不抛错（避免内存泄漏）
    expect(() => URL.revokeObjectURL(url)).not.toThrow();
  });

  test('mime 缺失回退 application/octet-stream', () => {
    const url = blobUrlFromBase64('aGVsbG8=', undefined);
    expect(url).toMatch(/^blob:/);
    URL.revokeObjectURL(url);
  });
});
