import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DeviceWorkspaceSnapshotDto } from '../../../packages/contracts/src/index.js';
import {
  assertDeviceWorkspaceSnapshotReady,
  isDeviceWorkspaceSnapshotReady,
  materializeDeviceWorkspaceSnapshot,
} from '../src/workspace-snapshot.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function snapshot(content = 'hello'): DeviceWorkspaceSnapshotDto {
  return {
    id: 'snapshot-1', teamId: 'team-1', channelId: 'channel-1', workspaceRevisionId: 'revision-1', immutable: true,
    inputSet: {
      id: 'input-set-1', contractVersion: 1, selections: [{ kind: 'version', collectionId: 'collection-1', versionId: 'version-1' }],
      items: [{ collectionId: 'collection-1', artifactVersionId: 'version-1', artifactId: 'artifact-1', path: 'README.md', filename: 'README.md', mimeType: 'text/plain', sizeBytes: Buffer.byteLength(content), sha256: sha256(content) }],
    },
    provenance: { createdByDeviceId: 'device-1', agentId: 'agent-1', taskId: 'task-1', taskAttempt: 1, workspaceRunId: 'run-1', createdAt: 1 },
  };
}

function response(content: string, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(content), { status: 200, headers });
}

describe('#1043 Device immutable snapshot', () => {
  test('downloads only selected files, validates identity/size/hash, then atomically commits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbean-snapshot-'));
    const target = join(home, 'snapshots', 'revision-1');
    const result = await materializeDeviceWorkspaceSnapshot({
      snapshot: snapshot(), snapshotDir: target, serverUrl: 'https://server.test', token: 'token', teamId: 'team-1', channelId: 'channel-1',
      fetch: async (_url, init) => {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
        return response('hello', { 'x-artifact-version-id': 'version-1' });
      },
    });
    expect(result).toMatchObject({ ok: true, written: ['README.md'] });
    expect(existsSync(join(target, 'manifest.json'))).toBe(true);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('hello');
    await assertDeviceWorkspaceSnapshotReady(target, snapshot());
  });

  test('hash mismatch leaves no usable snapshot and offline start is rejected', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbean-snapshot-bad-'));
    const target = join(home, 'snapshots', 'revision-1');
    const result = await materializeDeviceWorkspaceSnapshot({
      snapshot: snapshot(), snapshotDir: target, serverUrl: 'https://server.test', token: 'token', teamId: 'team-1', channelId: 'channel-1',
      fetch: async () => response('tampered', { 'x-artifact-version-id': 'version-1' }),
    });
    expect(result).toMatchObject({ ok: false, error: 'SIZE_MISMATCH' });
    expect(await isDeviceWorkspaceSnapshotReady(target, snapshot())).toBe(false);
    await expect(assertDeviceWorkspaceSnapshotReady(target, snapshot())).rejects.toThrow('SNAPSHOT_INCOMPLETE');
  });

  test('rejects a download that does not prove the requested artifact version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbean-snapshot-identity-'));
    const target = join(home, 'snapshots', 'revision-1');
    const result = await materializeDeviceWorkspaceSnapshot({
      snapshot: snapshot(), snapshotDir: target, serverUrl: 'https://server.test', token: 'token', teamId: 'team-1', channelId: 'channel-1',
      fetch: async () => response('hello'),
    });
    expect(result).toMatchObject({ ok: false, error: 'IDENTITY_MISMATCH' });
  });

  test('rejects a snapshot routed to a different channel projection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbean-snapshot-channel-'));
    const result = await materializeDeviceWorkspaceSnapshot({
      snapshot: snapshot(), snapshotDir: join(home, 'snapshots', 'revision-1'), serverUrl: 'https://server.test', token: 'token', teamId: 'team-1', channelId: 'channel-other',
      fetch: async () => response('hello', { 'x-artifact-version-id': 'version-1' }),
    });
    expect(result).toMatchObject({ ok: false, error: 'SNAPSHOT_INVALID' });
  });

  test('complete snapshot remains usable when server is unavailable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbean-snapshot-offline-'));
    const target = join(home, 'snapshots', 'revision-1');
    const frozen = snapshot();
    await materializeDeviceWorkspaceSnapshot({
      snapshot: frozen, snapshotDir: target, serverUrl: 'https://server.test', token: 'token', teamId: 'team-1', channelId: 'channel-1',
      fetch: async () => response('hello', { 'x-artifact-version-id': 'version-1' }),
    });
    const offline = await materializeDeviceWorkspaceSnapshot({
      snapshot: frozen, snapshotDir: target, serverUrl: '', token: '', teamId: 'team-1', channelId: 'channel-1',
      fetch: async () => { throw new Error('offline'); },
    });
    expect(offline).toMatchObject({ ok: true, snapshotDir: target });
  });
});
