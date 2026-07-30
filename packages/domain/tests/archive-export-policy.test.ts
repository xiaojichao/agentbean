import { describe, expect, test } from 'vitest';

import { assembleArchiveExportManifest, type ArchiveExportArtifactInput } from '../src/archive-export-policy.js';
import type { ProjectChannelWorkspaceRevisionDto } from '@agentbean/contracts';

const NOW = 1_700_000_000_000;

const revision: ProjectChannelWorkspaceRevisionDto = {
  id: 'rev-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  revision: 1,
  files: [{ path: 'README.md', artifactId: 'art-1', filename: 'README.md', mimeType: 'text/markdown', sizeBytes: 42 }],
  createdBy: 'user-governor',
  createdAt: NOW - 1000,
  provenance: { sourceDeviceId: 'device-1', importedAt: NOW - 1000 },
};

function artifact(over: Partial<ArchiveExportArtifactInput> & { id: string }): ArchiveExportArtifactInput {
  return {
    filename: 'out.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: 10,
    createdAt: NOW,
    ...over,
  };
}

describe('assembleArchiveExportManifest', () => {
  test('只投影 role=deliverable 的 artifact 为交付物', () => {
    const manifest = assembleArchiveExportManifest({
      teamId: 'team-1',
      channelId: 'channel-1',
      exportedByUserId: 'user-governor',
      now: NOW,
      revision,
      artifacts: [
        artifact({ id: 'a-deliv', role: 'deliverable', filename: 'final.zip', sizeBytes: 100, sha256: 'abc', workspaceRunId: 'run-1', createdAt: NOW + 2 }),
        artifact({ id: 'a-inter', role: 'intermediate' }),
        artifact({ id: 'a-run', role: 'run_output' }),
        artifact({ id: 'a-attach', role: 'attachment' }),
        artifact({ id: 'a-deliv2', role: 'deliverable', filename: 'report.pdf', createdAt: NOW + 1 }),
      ],
    });

    expect(manifest.deliverables.map((d) => d.artifactId)).toEqual(['a-deliv2', 'a-deliv']);
    expect(manifest.deliverables).toHaveLength(2);
    // 排除 intermediate / run_output / attachment
    expect(manifest.deliverables.every((d) => d.role === 'deliverable')).toBe(true);
  });

  test('保留 revision（含 import provenance）与导出元数据', () => {
    const manifest = assembleArchiveExportManifest({
      teamId: 'team-1',
      channelId: 'channel-1',
      exportedByUserId: 'user-governor',
      now: NOW,
      revision,
      artifacts: [artifact({ id: 'a-1', role: 'deliverable' })],
    });

    expect(manifest.teamId).toBe('team-1');
    expect(manifest.channelId).toBe('channel-1');
    expect(manifest.exportedAt).toBe(NOW);
    expect(manifest.exportedByUserId).toBe('user-governor');
    expect(manifest.revision).toEqual(revision);
    expect(manifest.revision.provenance?.sourceDeviceId).toBe('device-1');
  });

  test('provenance 可选字段存在时携带、缺失时省略', () => {
    const manifest = assembleArchiveExportManifest({
      teamId: 'team-1',
      channelId: 'channel-1',
      exportedByUserId: 'user-governor',
      now: NOW,
      revision,
      artifacts: [
        artifact({ id: 'with-prov', role: 'deliverable', sha256: 'deadbeef', workspaceRunId: 'run-9' }),
        artifact({ id: 'no-prov', role: 'deliverable' }),
      ],
    });

    const withProv = manifest.deliverables.find((d) => d.artifactId === 'with-prov')!;
    expect(withProv.sha256).toBe('deadbeef');
    expect(withProv.workspaceRunId).toBe('run-9');

    const noProv = manifest.deliverables.find((d) => d.artifactId === 'no-prov')!;
    expect(noProv.sha256).toBeUndefined();
    expect(noProv.workspaceRunId).toBeUndefined();
  });

  test('无 deliverable 时返回空数组（非 undefined）', () => {
    const manifest = assembleArchiveExportManifest({
      teamId: 'team-1',
      channelId: 'channel-1',
      exportedByUserId: 'user-governor',
      now: NOW,
      revision,
      artifacts: [artifact({ id: 'a-inter', role: 'intermediate' })],
    });

    expect(manifest.deliverables).toEqual([]);
  });

  test('deliverables 按 createdAt 升序稳定排列', () => {
    const manifest = assembleArchiveExportManifest({
      teamId: 'team-1',
      channelId: 'channel-1',
      exportedByUserId: 'user-governor',
      now: NOW,
      revision,
      artifacts: [
        artifact({ id: 'late', role: 'deliverable', createdAt: 300 }),
        artifact({ id: 'early', role: 'deliverable', createdAt: 100 }),
        artifact({ id: 'mid', role: 'deliverable', createdAt: 200 }),
      ],
    });

    expect(manifest.deliverables.map((d) => d.artifactId)).toEqual(['early', 'mid', 'late']);
  });
});
