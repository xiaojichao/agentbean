// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
  submitPackageArtifactReview: vi.fn(),
  artifactCollections: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
    submitPackageArtifactReview: mocks.submitPackageArtifactReview,
    artifactCollections: mocks.artifactCollections,
  }),
}));

import { OutputPackageCard } from '../components/OutputPackageCard';
import type { ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// 默认:无产物库信息(file-sub 不渲染),getOutputPackage 由各用例自设。
mocks.artifactCollections.mockResolvedValue({ ok: false });

const packageMeta = {
  kind: 'output-package' as const,
  packageId: 'pkg-1',
  taskId: 'task-1',
  taskTitle: '写剧本',
  agentName: 'Agent-A',
  memberCount: 2,
  members: [
    { shortLabel: 'F1', filename: 'ep1.md', artifactVersionId: 'ver-1', collectionId: 'col-1' },
    { shortLabel: 'F2', filename: 'ep2.md', artifactVersionId: 'ver-2', collectionId: 'col-2' },
  ],
  workspaceRevisionId: 'rev-1',
  publishId: 'pub-1',
  createdAt: 1000,
};

const readyProjection = {
  policy: 'current' as const,
  status: 'ready' as const,
  members: [
    {
      sequence: 1, shortLabel: 'F1', collectionId: 'col-1', versionId: 'ver-1',
      versionNumber: 1, artifactId: 'art-1', filename: 'ep1.md',
      reviewState: 'pending' as const, isFinalVersion: false, collectionRevision: 3,
    },
    {
      sequence: 2, shortLabel: 'F2', collectionId: 'col-2', versionId: 'ver-2',
      versionNumber: 1, artifactId: 'art-2', filename: 'ep2.md',
      reviewState: 'pending' as const, isFinalVersion: false, collectionRevision: 1,
    },
  ],
  blockers: [],
  omitted: [],
  consistencyToken: { schemaVersion: 1, entries: [] },
};

const notReadyProjection = {
  policy: 'final' as const,
  status: 'not_ready' as const,
  members: [],
  blockers: [{ code: 'missing_final' as const, collectionId: 'col-1', shortLabel: 'F1', filename: 'ep1.md' }],
  omitted: [],
  consistencyToken: { schemaVersion: 1, entries: [] },
};

/**
 * #1063 AC5/AC10：卡片引用入口。
 * - 整包 current:预览 ready → package_projection 选择(带 expectedMemberRevisions fence);
 * - 整包 final:预览 not_ready → 阻断清单,不产生选择;
 * - 成员单选/多选 → package_members;
 * - rejected/changes_requested 成员仍可引用，但文件包卡片暂时不显示“基于此修改”。
 */
describe('OutputPackageCard package reference (#1063)', () => {
  function collectSelections(): ProjectReferenceSelectionRequestDto[] {
    const collected: ProjectReferenceSelectionRequestDto[] = [];
    render(<OutputPackageCard
      packageMeta={packageMeta}
      channelId="channel-1"
      onAddReference={(selection) => collected.push(selection)}
    />);
    return collected;
  }

  test('整包 current:ready → package_projection 选择含 revision fence', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true, projection: readyProjection, asOf: 100, audienceScope: 'team-1:channel-1:u-1',
    });
    const collected: ProjectReferenceSelectionRequestDto[] = [];
    render(<OutputPackageCard
      packageMeta={packageMeta}
      channelId="channel-1"
      onAddReference={(selection) => collected.push(selection)}
    />);
    fireEvent.click(document.querySelector('[data-smoke="output-package-projection-ref"]')!);
    await waitFor(() => {
      expect(mocks.getOutputPackage).toHaveBeenCalledWith({
        channelId: 'channel-1', packageId: 'pkg-1', projection: { policy: 'current' },
      });
      expect(collected).toHaveLength(1);
    });
    expect(collected[0]).toEqual({
      kind: 'package_projection',
      packageId: 'pkg-1',
      policy: 'current',
      expectedMemberRevisions: [
        { collectionId: 'col-1', revision: 3 },
        { collectionId: 'col-2', revision: 1 },
      ],
    });
  });

  test('整包 final:not_ready → 阻断清单,不产生选择', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true, projection: notReadyProjection, asOf: 100, audienceScope: 'team-1:channel-1:u-1',
    });
    const collected: ProjectReferenceSelectionRequestDto[] = [];
    render(<OutputPackageCard
      packageMeta={packageMeta}
      channelId="channel-1"
      onAddReference={(selection) => collected.push(selection)}
    />);
    // 点击 final 按钮(第三个,顺序 current/final/delivered)。
    fireEvent.click(document.querySelectorAll('[data-smoke="output-package-projection-ref"]')[1]!);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="output-package-projection-blockers"]')).not.toBeNull();
    });
    expect(screen.getByText(/尚未设置最终版/)).not.toBeNull();
    expect(collected).toHaveLength(0);
  });

  test('成员单选与多选 → package_members 显式选择', () => {
    const collected: ProjectReferenceSelectionRequestDto[] = [];
    render(<OutputPackageCard
      packageMeta={packageMeta}
      channelId="channel-1"
      onAddReference={(selection) => collected.push(selection)}
    />);
    // 单选 F1。
    fireEvent.click(document.querySelectorAll('[data-smoke="output-package-member-ref"]')[0]!);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual({
      kind: 'package_members', packageId: 'pkg-1',
      members: [{ collectionId: 'col-1', versionId: 'ver-1' }],
    });
  });

  test('多选:进入选择态勾选两个成员 → 引用所选', () => {
    const collected: ProjectReferenceSelectionRequestDto[] = [];
    render(<OutputPackageCard
      packageMeta={packageMeta}
      channelId="channel-1"
      onAddReference={(selection) => collected.push(selection)}
    />);
    fireEvent.click(document.querySelector('[data-smoke="output-package-member-select-toggle"]')!);
    fireEvent.click(document.querySelectorAll('[data-smoke="output-package-member-select"]')[0]!);
    fireEvent.click(document.querySelectorAll('[data-smoke="output-package-member-select"]')[1]!);
    expect(screen.getByText('已选 2 个文件')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-smoke="output-package-member-select-confirm"]')!);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual({
      kind: 'package_members', packageId: 'pkg-1',
      members: [
        { collectionId: 'col-1', versionId: 'ver-1' },
        { collectionId: 'col-2', versionId: 'ver-2' },
      ],
    });
  });

  test('rejected 成员保留状态与引用入口，但不显示“基于此修改”', async () => {
    mocks.artifactCollections.mockResolvedValue({ ok: true, library: { collections: [{
      id: 'col-1', name: 'ep1.md', currentVersionId: 'ver-1',
      versions: [{ id: 'ver-1', versionNumber: 1 }],
    }] } });
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      availableActions: [{
        collectionId: 'col-1', versionId: 'ver-1', reviewState: 'rejected',
        isFinalVersion: false, collectionRevision: 3, actions: [],
      }],
      asOf: 100, audienceScope: 'team-1:channel-1:u-1',
    });
    const collected: ProjectReferenceSelectionRequestDto[] = [];
    render(<OutputPackageCard
      packageMeta={packageMeta}
      channelId="channel-1"
      onAddReference={(selection) => collected.push(selection)}
    />);
    await waitFor(() => {
      expect(screen.getByText('拒绝')).not.toBeNull();
    });
    expect(document.querySelector('[data-smoke="output-package-member-based-on"]')).toBeNull();
    expect(screen.queryByText('基于此修改')).toBeNull();
    expect(document.querySelector('[data-smoke="output-package-member-ref"]')).not.toBeNull();
    expect(collected).toHaveLength(0);
  });
});


/** 原型对齐:成员行 file-sub(collection 名 · current server 版本 · 来源/修改时间)。 */
describe('OutputPackageCard 成员行 file-sub', () => {
  test('显示 collection 名、current server 版本与手动修改来源', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, availableActions: [], package: undefined });
    mocks.artifactCollections.mockResolvedValue({
      ok: true,
      library: {
        archived: false,
        collections: [
          {
            id: 'col-1',
            name: 'script.ep01',
            currentVersionId: 'ver-cur-1',
            versions: [
              { id: 'ver-cur-1', versionNumber: 4, createdAt: Date.now(), revisionBasis: { sourceVersionId: 'ver-1' } },
            ],
          },
          {
            id: 'col-2',
            name: 'character.sheet',
            currentVersionId: 'ver-cur-2',
            versions: [
              { id: 'ver-cur-2', versionNumber: 3, createdAt: Date.now() },
            ],
          },
        ],
      },
    });
    render(<OutputPackageCard packageMeta={packageMeta} channelId="channel-1" />);
    await waitFor(() => {
      const subs = Array.from(document.querySelectorAll('[data-smoke="package-member-sub"]'));
      expect(subs.length).toBe(2);
    });
    const subs = Array.from(document.querySelectorAll('[data-smoke="package-member-sub"]')).map((el) => el.textContent);
    expect(subs[0]).toContain('collection: script.ep01');
    expect(subs[0]).toContain('current server v4');
    expect(subs[0]).toContain('手动修改');
    expect(subs[1]).toContain('collection: character.sheet');
    expect(subs[1]).toContain('current server v3');
    expect(subs[1]).toContain('Agent 交付');
  });

  test('artifactCollections 失败时降级不显示 file-sub,不抛错', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, availableActions: [], package: undefined });
    mocks.artifactCollections.mockRejectedValue(new Error('boom'));
    render(<OutputPackageCard packageMeta={packageMeta} channelId="channel-1" />);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="output-package-card"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-smoke="package-member-sub"]')).toBeNull();
  });
});
