// @vitest-environment jsdom

import React from 'react';
import { renderToString } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
  }),
}));

import { ProjectFilesBoard, type ProjectFilesBoardProps } from '../components/project/ProjectFilesBoard';
import type { OutputPackageMeta } from '../lib/output-package';
import type { ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';

afterEach(() => { cleanup(); vi.clearAllMocks(); revisionRequests.length = 0; });

/** 逻辑产物视图左栏聚合模型(与 file-group-model.test.ts 同源 fixture)。 */

const pkg1 = {
  schemaVersion: 1 as const,
  packageId: 'pkg-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  revision: 1,
  deliveryId: 'del-1',
  publishId: 'pub-1',
  workspaceRevisionId: 'ws-1',
  agentId: 'agent-a',
  taskId: 'task-1',
  taskBinding: 'managed' as const,
  taskRevision: 2,
  taskAttempt: 1,
  memberCount: 2,
  reviewState: 'pending' as const,
  status: 'recorded' as const,
  createdAt: 1000,
};

const pkg2 = {
  ...pkg1,
  packageId: 'pkg-2',
  deliveryId: 'del-2',
  publishId: 'pub-2',
  workspaceRevisionId: 'ws-2',
  agentId: 'agent-b',
  taskId: 'task-2',
  taskRevision: 1,
  reviewState: 'approved' as const,
  createdAt: 2000,
};

const pendingDelivery = {
  publishId: 'pub-3',
  workspaceRevisionId: 'ws-3',
  agentId: 'agent-b',
  taskId: 'task-2',
  taskAttempt: 2,
  committedAt: 2500,
};

function version(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    teamId: 'team-1',
    channelId: 'channel-1',
    collectionId: 'col-1',
    versionNumber: 1,
    artifact: { id: `art-${id}`, filename: `${id}.md` },
    source: { stageId: 'stage-1', taskId: 'task-1', taskRevision: 1 },
    lineage: [],
    promotedBy: 'user-1',
    createdAt: 800,
    reviews: [],
    reviewState: 'pending',
    packageMemberships: [],
    ...overrides,
  };
}

const library = {
  archived: false,
  collections: [
    {
      id: 'col-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      name: 'script.ep01',
      kind: 'script',
      revision: 5,
      currentVersionId: 'ver-c1',
      versions: [
        version('ver-1', {
          versionNumber: 1,
          createdAt: 800,
          reviewState: 'approved',
          packageMemberships: [{ packageId: 'pkg-1', sequence: 1, shortLabel: 'F1', deliveredAt: 1000 }],
        }),
        version('ver-rej', {
          versionNumber: 2,
          createdAt: 1100,
          reviewState: 'rejected',
          reviews: [{
            id: 'rev-rej', teamId: 'team-1', channelId: 'channel-1', collectionId: 'col-1',
            versionId: 'ver-rej', decision: 'rejected', comment: '需要重做', basis: [],
            reviewedBy: 'user-1', createdAt: 1150,
          }],
        }),
        version('ver-img', {
          versionNumber: 1,
          createdAt: 900,
          reviewState: 'pending',
          artifact: { id: 'art-img', teamId: 'team-1', channelId: 'channel-1', filename: '场景参考图.png', mimeType: 'image/png', sizeBytes: 1024, createdAt: 900 },
        }),
        version('ver-c1', {
          versionNumber: 4,
          createdAt: 1500,
          reviewState: 'pending',
          revisionBasis: { revisedFromVersionId: 'ver-1', basisReviewId: 'rev-1' },
        }),
      ],
      finalizations: [],
      createdBy: 'user-1',
      createdAt: 800,
      updatedAt: 1500,
    },
    {
      id: 'col-2',
      teamId: 'team-1',
      channelId: 'channel-1',
      name: 'character.sheet',
      kind: 'character',
      revision: 2,
      currentVersionId: 'ver-c2',
      finalVersionId: 'ver-c2',
      versions: [
        version('ver-c2', {
          collectionId: 'col-2',
          versionNumber: 3,
          createdAt: 1200,
          reviewState: 'approved',
        }),
      ],
      finalizations: [],
      createdBy: 'user-1',
      createdAt: 900,
      updatedAt: 1200,
    },
  ],
};

const stages = [
  { id: 'stage-1', name: '剧本', goal: '产出第 1 集剧本', taskId: 'task-1' },
  { id: 'stage-2', name: '服装', goal: '产出服装参考图', taskId: 'task-2' },
  { id: 'stage-3', name: '分镜', goal: '产出分镜图组', taskId: 'task-3' },
];

const agentNames = new Map([
  ['agent-a', '剧本Agent'],
  ['agent-b', '服装Agent'],
]);

const readyProjection = {
  policy: 'current' as const,
  status: 'ready' as const,
  members: [
    {
      sequence: 1, shortLabel: 'F1', collectionId: 'col-1', versionId: 'ver-c1',
      versionNumber: 4, artifactId: 'art-c1', filename: '第1集剧本.md',
      reviewState: 'pending' as const, isFinalVersion: false, collectionRevision: 5,
    },
    {
      sequence: 2, shortLabel: 'F2', collectionId: 'col-2', versionId: 'ver-c2',
      versionNumber: 3, artifactId: 'art-c2', filename: '角色表.md',
      reviewState: 'approved' as const, isFinalVersion: true, collectionRevision: 2,
    },
  ],
  blockers: [],
  omitted: [],
  consistencyToken: { schemaVersion: 1, entries: [] },
};

const blockedCurrentProjection = {
  ...readyProjection,
  status: 'not_ready' as const,
  members: readyProjection.members.map((member) => member.versionId === 'ver-c1'
    ? { ...member, reviewState: 'rejected' as const }
    : member),
  blockers: [{
    code: 'current_not_formal' as const,
    collectionId: 'col-1',
    shortLabel: 'F1',
    filename: '第1集剧本.md',
  }],
};

const notReadyFinalProjection = {
  policy: 'final' as const,
  status: 'not_ready' as const,
  members: [],
  blockers: [
    { code: 'missing_final' as const, collectionId: 'col-1', shortLabel: 'F1', filename: '第1集剧本.md' },
  ],
  omitted: [],
  consistencyToken: { schemaVersion: 1, entries: [] },
};

const readyFinalProjection = {
  ...readyProjection,
  policy: 'final' as const,
  members: readyProjection.members.map((member) => ({ ...member, isFinalVersion: true })),
};

const packageDetail = {
  package: {
    schemaVersion: 1,
    packageId: 'pkg-2',
    teamId: 'team-1',
    channelId: 'channel-1',
    revision: 1,
    deliveryId: 'del-2',
    publishId: 'pub-2',
    workspaceRevisionId: 'ws-2',
    agentId: 'agent-b',
    taskId: 'task-2',
    taskBinding: 'managed',
    taskAttempt: 1,
    members: [
      { artifactVersionId: 'ver-c1', collectionId: 'col-1', shortLabel: 'F1', filename: '第1集剧本.md', sourcePath: 'outputs/scripts/ep1.md' },
      { artifactVersionId: 'ver-c2', collectionId: 'col-2', shortLabel: 'F2', filename: '角色表.md', sourcePath: 'outputs/characters/role.md' },
    ],
    memberCount: 2,
    status: 'recorded',
    createdAt: 2000,
  },
  // #1062:F1 成员被拒 → Server 下发 latestReviewId,「基于此修改」basis 冻结它。
  availableActions: [{
    collectionId: 'col-1', versionId: 'ver-c1', reviewState: 'rejected',
    isFinalVersion: false, collectionRevision: 5, latestReviewId: 'rev-latest', actions: ['revise-version'],
  }],
  projection: readyProjection,
};

const revisionRequests: Parameters<NonNullable<ProjectFilesBoardProps['onOpenRevisionEditor']>>[] = [];

interface BoardCallbacks {
  onOpenPackagePreview?: ProjectFilesBoardProps['onOpenPackagePreview'];
  onOpenReadOnlyArtifact?: ProjectFilesBoardProps['onOpenReadOnlyArtifact'];
  canDecideVersion?: ProjectFilesBoardProps['canDecideVersion'];
  onReview?: ProjectFilesBoardProps['onReview'];
  onFinalize?: ProjectFilesBoardProps['onFinalize'];
  onPromote?: ProjectFilesBoardProps['onPromote'];
  canPromote?: boolean;
  promotableArtifacts?: ProjectFilesBoardProps['promotableArtifacts'];
  libraryOverride?: ProjectFilesBoardProps['library'];
}

function renderBoard(callbacks: BoardCallbacks = {}) {
  const collected: ProjectReferenceSelectionRequestDto[] = [];
  render(<ProjectFilesBoard
    channelId="channel-1"
    packages={[pkg1, pkg2]}
    pendingDeliveries={[pendingDelivery]}
    library={callbacks.libraryOverride === undefined ? library : callbacks.libraryOverride}
    stages={stages}
    agentNames={agentNames}
    dataRevision={0}
    onAddReference={(selection) => collected.push(selection)}
    onOpenRevisionEditor={(request) => revisionRequests.push(request)}
    canPromote={callbacks.canPromote ?? false}
    promotableArtifacts={callbacks.promotableArtifacts ?? []}
    onPromote={callbacks.onPromote ?? vi.fn().mockResolvedValue(null)}
    {...(callbacks.onOpenPackagePreview ? { onOpenPackagePreview: callbacks.onOpenPackagePreview } : {})}
    {...(callbacks.onOpenReadOnlyArtifact ? { onOpenReadOnlyArtifact: callbacks.onOpenReadOnlyArtifact } : {})}
    {...(callbacks.canDecideVersion ? { canDecideVersion: callbacks.canDecideVersion } : {})}
    {...(callbacks.onReview ? { onReview: callbacks.onReview } : {})}
    {...(callbacks.onFinalize ? { onFinalize: callbacks.onFinalize } : {})}
  />);
  return collected;
}

describe('ProjectFilesBoard 首帧(renderToString)', () => {
  test('左栏三类卡片 + 工具栏 + 七列表头在 effect 未跑的首帧即渲染', () => {
    const html = renderToString(React.createElement(ProjectFilesBoard, {
      channelId: 'channel-1',
      packages: [pkg1, pkg2],
      pendingDeliveries: [pendingDelivery],
      library,
      stages,
      agentNames,
      dataRevision: 0,
      onAddReference: () => {},
    }));
    expect(html).toContain('data-smoke="project-files-board"');
    expect(html).toContain('data-smoke="output-package-item"');
    expect(html).toContain('data-smoke="output-package-pending"');
    expect(html).toContain('data-smoke="project-artifact-collection"');
    expect(html).toContain('data-smoke="file-group-waiting"');
    expect(html).toContain('data-smoke="output-package-review-state"');
    expect(html).toContain('data-smoke="files-toolbar-search"');
    expect(html).toContain('data-smoke="files-filter-chip"');
    expect(html).toContain('data-smoke="files-ref-current"');
    expect(html).toContain('data-smoke="files-ref-final"');
    expect(html).toContain('data-smoke="files-ref-multi"');
    // 首帧无缓存:默认选中的首卡(pending)无成员行,不崩(表格在有行时才渲染表头)。
    expect(html).toContain('暂无文件行');
    expect(html).not.toContain('data-smoke="file-version-row"');
  });
});

describe('ProjectFilesBoard 左栏卡片与右栏表格', () => {
  test('选中输出包 → 懒加载 projection → 成员行七列', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, ...packageDetail, asOf: 2000, audienceScope: 'team-1:channel-1:u-1' });
    renderBoard();
    // 默认选中首卡为 pending,点击 pkg-2 卡。
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(2);
    });
    // 七列表头(§8.7)。
    const headers = Array.from(document.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['名称', '类型 / 阶段', '来源', '当前版', '最终版', '审核', '动作']);
    const firstRow = document.querySelector('[data-smoke="file-version-row"][data-version-id="ver-c1"]')!;
    expect(firstRow.textContent).toContain('第1集剧本.md');
    expect(firstRow.textContent).toContain('collection: script.ep01');
    expect(firstRow.textContent).toContain('script');
    expect(firstRow.textContent).toContain('剧本');
    expect(firstRow.textContent).toContain('@服装Agent');
    expect(firstRow.textContent).toContain('outputs/scripts/ep1.md');
    expect(firstRow.textContent).toContain('v4 current');
    expect(firstRow.textContent).toContain('server revision r5');
    expect(firstRow.textContent).toContain('待审核');
    // F2 行:final 成员。
    const secondRow = document.querySelector('[data-smoke="file-version-row"][data-version-id="ver-c2"]')!;
    expect(secondRow.textContent).toContain('v3 final');
    expect(secondRow.textContent).toContain('已通过');
    // 包卡短编号摘要随投影加载。
    await waitFor(() => {
      const card = document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!;
      expect(card.textContent).toContain('F1 v4');
      expect(card.textContent).toContain('F2 v3');
    });
  });

  test('current projection not_ready 时仍保留可解析成员行与修订入口', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      ...packageDetail,
      package: {
        ...packageDetail.package,
        members: [
          { ...packageDetail.package.members[0], artifactVersionId: 'ver-delivered-c1' },
          packageDetail.package.members[1],
        ],
      },
      projection: blockedCurrentProjection,
      asOf: 2000,
      audienceScope: 'team-1:channel-1:u-1',
    });
    renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]')).toHaveLength(2);
    });
    expect(document.querySelector('[data-smoke="files-package-projection-blocked"]')).not.toBeNull();
    expect(document.querySelector('[data-smoke="files-row-revise"][data-version-id="ver-c1"]')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-smoke="files-row-revise"][data-version-id="ver-c1"]')!);
    expect(revisionRequests).toEqual([{
      collectionId: 'col-1',
      collectionName: 'script.ep01',
      filename: '第1集剧本.md',
      baseVersionId: 'ver-c1',
      sourceVersionId: 'ver-c1',
      basisReviewId: 'rev-latest',
      collectionRevision: 5,
    }]);
  });

  test('选中文件集合 → 版本行(当前版/最终版/审核/来源)同步渲染', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="project-artifact-collection"][data-collection-id="col-1"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(4);
    });
    const currentRow = document.querySelector('[data-smoke="file-version-row"][data-version-id="ver-c1"]')!;
    expect(currentRow.textContent).toContain('v4 current');
    expect(currentRow.textContent).toContain('人工修改');
    expect(currentRow.textContent).toContain('待审核');
    expect(currentRow.textContent).toContain('未设置');
    const oldRow = document.querySelector('[data-smoke="file-version-row"][data-version-id="ver-1"]')!;
    expect(oldRow.textContent).toContain('Agent 交付');
    expect(oldRow.textContent).toContain('已通过');
    const rejectedRow = document.querySelector('[data-smoke="file-version-row"][data-version-id="ver-rej"]')!;
    expect(rejectedRow.textContent).toContain('已拒绝');
  });

  test('选中等待上游卡 → 右侧阶段目标占位', () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="file-group-waiting"]')!);
    expect(document.querySelector('[data-smoke="files-waiting-placeholder"]')!.textContent).toContain('分镜');
    expect(document.querySelector('[data-smoke="files-waiting-placeholder"]')!.textContent).toContain('产出分镜图组');
  });

  test('筛选 chip 与搜索作用于左栏卡片', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard();
    // 待审核:pkg-1(pending) + col-1(current pending);pkg-2(approved)/col-2(approved)排除。
    fireEvent.click(document.querySelector('[data-smoke="files-filter-chip"][data-filter="pending_review"]')!);
    await waitFor(() => {
      const cards = Array.from(document.querySelectorAll('[data-smoke="output-package-item"], [data-smoke="project-artifact-collection"]'));
      expect(cards.map((card) => card.getAttribute('data-package-id') ?? card.getAttribute('data-collection-id')))
        .toEqual(['col-1', 'pkg-1']);
    });
    // 有 final:仅 col-2(pkg final 事实需投影 enrichment,未加载时恒 false)。
    fireEvent.click(document.querySelector('[data-smoke="files-filter-chip"][data-filter="has_final"]')!);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="project-artifact-collection"]')).not.toBeNull();
      expect(document.querySelector('[data-smoke="output-package-item"]')).toBeNull();
      expect(document.querySelector('[data-smoke="project-artifact-collection"]')!.getAttribute('data-collection-id')).toBe('col-2');
    });
    // 搜索:按集合名。
    fireEvent.click(document.querySelector('[data-smoke="files-filter-chip"][data-filter="all"]')!);
    fireEvent.change(document.querySelector('[data-smoke="files-toolbar-search"]')!, { target: { value: 'script.ep01' } });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="output-package-item"], [data-smoke="project-artifact-collection"]').length).toBe(1);
      expect(document.querySelector('[data-smoke="project-artifact-collection"]')!.getAttribute('data-collection-id')).toBe('col-1');
    });
    // 搜索:按 Agent 名(pkg-2 的 agent-b → 服装Agent)。
    fireEvent.change(document.querySelector('[data-smoke="files-toolbar-search"]')!, { target: { value: '服装Agent' } });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="output-package-item"]').length).toBe(1);
      expect(document.querySelector('[data-smoke="output-package-item"]')!.getAttribute('data-package-id')).toBe('pkg-2');
    });
  });

  test('有 final 按 final projection ready 判断，不要求 current 恰好等于 final', async () => {
    mocks.getOutputPackage.mockImplementation(async ({ packageId, projection }: {
      packageId: string;
      projection?: { policy: string };
    }) => {
      if (projection?.policy !== 'final') return { ok: false };
      return packageId === 'pkg-2'
        ? { ok: true, projection: readyFinalProjection }
        : { ok: true, projection: notReadyFinalProjection };
    });
    renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="files-filter-chip"][data-filter="has_final"]')!);
    await waitFor(() => {
      const packageCards = Array.from(document.querySelectorAll('[data-smoke="output-package-item"]'));
      expect(packageCards.map((card) => card.getAttribute('data-package-id'))).toEqual(['pkg-2']);
    });
  });
});

describe('ProjectFilesBoard 整包引用三入口(#1063 同语义)', () => {
  test('引用当前包:ready → package_projection 选择(带 revision fence)', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, ...packageDetail, asOf: 2000, audienceScope: 'team-1:channel-1:u-1' });
    const collected = renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(2);
    });
    fireEvent.click(document.querySelector('[data-smoke="files-ref-current"]')!);
    await waitFor(() => {
      expect(collected).toHaveLength(1);
    });
    expect(collected[0]).toEqual({
      kind: 'package_projection',
      packageId: 'pkg-2',
      policy: 'current',
      expectedMemberRevisions: [
        { collectionId: 'col-1', revision: 5 },
        { collectionId: 'col-2', revision: 2 },
      ],
    });
  });

  test('引用最终版包:not_ready → blockers 清单,不产生选择', async () => {
    mocks.getOutputPackage.mockImplementation(async ({ projection }: { projection?: { policy: string } }) => {
      if (projection?.policy === 'final') {
        return { ok: true, projection: notReadyFinalProjection, asOf: 2000, audienceScope: 'team-1:channel-1:u-1' };
      }
      return { ok: true, ...packageDetail, asOf: 2000, audienceScope: 'team-1:channel-1:u-1' };
    });
    const collected = renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(2);
    });
    fireEvent.click(document.querySelector('[data-smoke="files-ref-final"]')!);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="files-ref-blockers"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-smoke="files-ref-blockers"]')!.textContent).toContain('尚未设置最终版');
    expect(collected).toHaveLength(0);
  });

  test('多选引用:勾选成员 → package_members 显式选择', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, ...packageDetail, asOf: 2000, audienceScope: 'team-1:channel-1:u-1' });
    const collected = renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(2);
    });
    fireEvent.click(document.querySelector('[data-smoke="files-ref-multi"]')!);
    expect(document.querySelectorAll('[data-smoke="files-row-select"]').length).toBe(2);
    fireEvent.click(document.querySelectorAll('[data-smoke="files-row-select"]')[0]!);
    fireEvent.click(document.querySelectorAll('[data-smoke="files-row-select"]')[1]!);
    expect(screen.getByText('已选 2 个文件')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-smoke="files-multi-confirm"]')!);
    await waitFor(() => {
      expect(collected).toHaveLength(1);
    });
    expect(collected[0]).toEqual({
      kind: 'package_members',
      packageId: 'pkg-2',
      members: [
        { collectionId: 'col-1', versionId: 'ver-c1' },
        { collectionId: 'col-2', versionId: 'ver-c2' },
      ],
    });
    // 确认后退出多选态。
    expect(document.querySelector('[data-smoke="files-multi-confirm"]')).toBeNull();
  });

  test('行内引用:包成员行 → package_members 单选;集合版本行 → artifact_version', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: true, ...packageDetail, asOf: 2000, audienceScope: 'team-1:channel-1:u-1' });
    const collected = renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(2);
    });
    fireEvent.click(document.querySelector('[data-smoke="files-row-ref"][data-version-id="ver-c1"]')!);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual({
      kind: 'package_members',
      packageId: 'pkg-2',
      members: [{ collectionId: 'col-1', versionId: 'ver-c1' }],
    });
    // 切到集合视图,行内引用为 artifact_version。
    fireEvent.click(document.querySelector('[data-smoke="project-artifact-collection"][data-collection-id="col-1"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(4);
    });
    fireEvent.click(document.querySelector('[data-smoke="files-row-ref"][data-version-id="ver-c1"]')!);
    expect(collected).toHaveLength(2);
    expect(collected[1]).toEqual({ kind: 'artifact_version', collectionId: 'col-1', versionId: 'ver-c1' });
  });
});

/** 选中 col-1 集合并等待 4 个版本行渲染。 */
async function selectCollection1() {
  fireEvent.click(document.querySelector('[data-smoke="project-artifact-collection"][data-collection-id="col-1"]')!);
  await waitFor(() => {
    expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(4);
  });
}

/** 选中 pkg-2 包并等待 2 个成员行渲染(带 availableActions 拒绝态)。 */
async function selectPackage2(callbacks: BoardCallbacks = {}) {
  mocks.getOutputPackage.mockResolvedValue({ ok: true, ...packageDetail, asOf: 2000, audienceScope: 'team-1:channel-1:u-1' });
  renderBoard(callbacks);
  fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
  await waitFor(() => {
    expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(2);
  });
}

describe('ProjectFilesBoard 行动作(步骤 6)', () => {
  test('集合行 Markdown「预览/编辑」→ onOpenRevisionEditor(basis 只传 sourceVersionId,无包) ', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard();
    await selectCollection1();
    fireEvent.click(document.querySelector('[data-smoke="files-row-preview-edit"][data-version-id="ver-c1"]')!);
    expect(revisionRequests).toEqual([{
      collectionId: 'col-1',
      collectionName: 'script.ep01',
      filename: 'ver-c1.md',
      baseVersionId: 'ver-c1',
      sourceVersionId: 'ver-c1',
      collectionRevision: 5,
    }]);
  });

  test('集合行「基于此修改」→ basisReviewId 取最新审核记录', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard();
    await selectCollection1();
    fireEvent.click(document.querySelector('[data-smoke="files-row-revise"][data-version-id="ver-rej"]')!);
    expect(revisionRequests).toHaveLength(1);
    expect(revisionRequests[0]).toMatchObject({
      collectionId: 'col-1',
      baseVersionId: 'ver-rej',
      sourceVersionId: 'ver-rej',
      basisReviewId: 'rev-rej',
      collectionRevision: 5,
    });
  });

  test('集合行非 Markdown「查看」→ onOpenReadOnlyArtifact(ArtifactViewer 只读)', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    const opened: unknown[] = [];
    renderBoard({ onOpenReadOnlyArtifact: (artifact) => opened.push(artifact) });
    await selectCollection1();
    fireEvent.click(document.querySelector('[data-smoke="files-row-view"][data-version-id="ver-img"]')!);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ id: 'art-img', filename: '场景参考图.png', mimeType: 'image/png' });
  });

  test('集合行「详情」展开 → VersionDecisionPanel 经 onReview/onFinalize 回调执行(AC6)', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    const finalize = vi.fn().mockResolvedValue(null);
    const review = vi.fn().mockResolvedValue(null);
    renderBoard({ canDecideVersion: () => true, onFinalize: finalize, onReview: review });
    await selectCollection1();
    // 已通过且非 final 的 ver-1 展开 → 「设为最终版」。
    fireEvent.click(document.querySelector('[data-smoke="files-row-detail"][data-version-id="ver-1"]')!);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="files-version-detail"]')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('设为最终版'));
    await waitFor(() => {
      expect(finalize).toHaveBeenCalledWith({
        collectionId: 'col-1',
        versionId: 'ver-1',
        expectedCollectionRevision: 5,
        reason: '从项目文件库确认最终版',
      });
    });
    // 展开面板内也可追加审核。
    fireEvent.click(screen.getByText('追加审核'));
    expect(document.querySelector('form')).not.toBeNull();
  });

  test('包成员行「预览/编辑」→ onOpenPackagePreview(Server 详情构建 meta,聚焦成员)', async () => {
    const opened: { meta: OutputPackageMeta; versionId?: string }[] = [];
    await selectPackage2({ onOpenPackagePreview: (meta, versionId) => opened.push({ meta, versionId }) });
    fireEvent.click(document.querySelector('[data-smoke="files-row-preview-edit"][data-version-id="ver-c1"]')!);
    expect(opened).toHaveLength(1);
    expect(opened[0].versionId).toBe('ver-c1');
    expect(opened[0].meta.packageId).toBe('pkg-2');
    expect(opened[0].meta.members).toEqual([
      { shortLabel: 'F1', filename: '第1集剧本.md', artifactVersionId: 'ver-c1', collectionId: 'col-1' },
      { shortLabel: 'F2', filename: '角色表.md', artifactVersionId: 'ver-c2', collectionId: 'col-2' },
    ]);
  });

  test('包 current 已前移时按 collection 找回冻结成员身份聚焦预览', async () => {
    const opened: { meta: OutputPackageMeta; versionId?: string }[] = [];
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      ...packageDetail,
      package: {
        ...packageDetail.package,
        members: [
          { ...packageDetail.package.members[0], artifactVersionId: 'ver-delivered-c1' },
          { ...packageDetail.package.members[1], artifactVersionId: 'ver-delivered-c2' },
        ],
      },
      asOf: 2000,
      audienceScope: 'team-1:channel-1:u-1',
    });
    renderBoard({ onOpenPackagePreview: (meta, versionId) => opened.push({ meta, versionId }) });
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]')).toHaveLength(2);
    });
    fireEvent.click(document.querySelector('[data-smoke="files-row-preview-edit"][data-version-id="ver-c2"]')!);
    expect(opened).toHaveLength(1);
    expect(opened[0].versionId).toBe('ver-delivered-c2');
  });

  test('包成员行「基于此修改」→ basisReviewId 从 availableActions.latestReviewId 冻结 + package/delivery provenance', async () => {
    await selectPackage2();
    fireEvent.click(document.querySelector('[data-smoke="files-row-revise"][data-version-id="ver-c1"]')!);
    expect(revisionRequests).toEqual([{
      collectionId: 'col-1',
      collectionName: 'script.ep01',
      filename: '第1集剧本.md',
      baseVersionId: 'ver-c1',
      sourceVersionId: 'ver-c1',
      basisReviewId: 'rev-latest',
      packageId: 'pkg-2',
      deliveryId: 'del-2',
      collectionRevision: 5,
    }]);
  });

  test('包成员修订入口严格服从 Server revise-version action', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      ...packageDetail,
      availableActions: packageDetail.availableActions.map((entry) => ({ ...entry, actions: [] })),
      asOf: 2000,
      audienceScope: 'team-1:channel-1:u-1',
    });
    renderBoard();
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(2);
    });
    expect(document.querySelector('[data-smoke="files-row-revise"][data-version-id="ver-c1"]')).toBeNull();
  });

  test('归档频道的详情只读，不暴露追加审核或设为最终版入口', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard({
      libraryOverride: { ...library, archived: true },
      canDecideVersion: () => true,
      onReview: vi.fn().mockResolvedValue(null),
      onFinalize: vi.fn().mockResolvedValue(null),
      onOpenReadOnlyArtifact: vi.fn(),
    });
    await selectCollection1();
    expect(document.querySelector('[data-smoke="files-row-preview-edit"][data-version-id="ver-c1"]')).toBeNull();
    expect(document.querySelector('[data-smoke="files-row-revise"][data-version-id="ver-rej"]')).toBeNull();
    expect(document.querySelector('[data-smoke="files-row-view"][data-version-id="ver-c1"]')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-smoke="files-row-detail"][data-version-id="ver-1"]')!);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="files-version-detail"]')).not.toBeNull();
    });
    expect(screen.queryByText('追加审核')).toBeNull();
    expect(screen.queryByText('设为最终版')).toBeNull();
  });

  test('归档频道的包成员不暴露预览编辑或修订入口', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      ...packageDetail,
      asOf: 2000,
      audienceScope: 'team-1:channel-1:u-1',
    });
    renderBoard({
      libraryOverride: { ...library, archived: true },
      onOpenPackagePreview: vi.fn(),
    });
    fireEvent.click(document.querySelector('[data-smoke="output-package-item"][data-package-id="pkg-2"]')!);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-smoke="file-version-row"]')).toHaveLength(2);
    });
    expect(document.querySelector('[data-smoke="files-row-preview-edit"]')).toBeNull();
    expect(document.querySelector('[data-smoke="files-row-revise"]')).toBeNull();
  });

  test('被拒绝的非 Markdown 集合版本仅可查看，不暴露基于此修改', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    const rejectedImageLibrary = {
      ...library,
      collections: library.collections.map((collection) => collection.id !== 'col-1'
        ? collection
        : {
            ...collection,
            versions: collection.versions.map((entry) => entry.id !== 'ver-img'
              ? entry
              : {
                  ...entry,
                  reviewState: 'rejected',
                  reviews: [{
                    id: 'rev-img', teamId: 'team-1', channelId: 'channel-1', collectionId: 'col-1',
                    versionId: 'ver-img', decision: 'rejected', comment: '图片需调整', basis: [],
                    reviewedBy: 'user-1', createdAt: 1250,
                  }],
                }),
          }),
    };
    renderBoard({
      libraryOverride: rejectedImageLibrary,
      onOpenReadOnlyArtifact: vi.fn(),
    });
    await selectCollection1();
    expect(document.querySelector('[data-smoke="files-row-view"][data-version-id="ver-img"]')).not.toBeNull();
    expect(document.querySelector('[data-smoke="files-row-revise"][data-version-id="ver-img"]')).toBeNull();
  });
});

describe('ProjectFilesBoard 提升入口(步骤 7)', () => {
  test('canPromote 且有待提升文件 → 工具栏按钮 → PromoteArtifactForm 复用', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard({ canPromote: true, promotableArtifacts: [{ id: 'art-x', filename: 'x.md' }] });
    fireEvent.click(document.querySelector('[data-smoke="files-promote-open"]')!);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="files-promote-form"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-smoke="files-promote-form"]')!.textContent).toContain('提升为版本');
    // 取消关闭表单(表单右上角 X 按钮,title=取消)。
    fireEvent.click(document.querySelector('[title="取消"]')!);
    await waitFor(() => {
      expect(document.querySelector('[data-smoke="files-promote-form"]')).toBeNull();
    });
  });

  test('canPromote 但无可提升文件 → 提示文案而非按钮', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard({ canPromote: true });
    expect(document.querySelector('[data-smoke="files-promote-open"]')).toBeNull();
    expect(document.body.textContent).toContain('先在文件视图中打开目标文件所在目录');
  });

  test('canPromote=false → 无提升入口', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    renderBoard();
    expect(document.querySelector('[data-smoke="files-promote-open"]')).toBeNull();
    expect(document.body.textContent).not.toContain('先在文件视图中打开目标文件所在目录');
  });
});

describe('ProjectFilesBoard 无项目画像回退(#1134 gate 放宽)', () => {
  test('无 library/stages(未创建阶段)仅输出包 → 输出包卡渲染、无等待上游/集合卡、右栏占位不崩', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false });
    render(<ProjectFilesBoard
      channelId="channel-1"
      packages={[pkg1]}
      pendingDeliveries={[]}
      library={null}
      stages={[]}
      agentNames={agentNames}
      dataRevision={0}
      onAddReference={() => {}}
    />);
    expect(document.querySelectorAll('[data-smoke="output-package-item"]').length).toBe(1);
    expect(document.querySelectorAll('[data-smoke="output-package-pending"]').length).toBe(0);
    expect(document.querySelectorAll('[data-smoke="project-artifact-collection"]').length).toBe(0);
    expect(document.querySelectorAll('[data-smoke="file-group-waiting"]').length).toBe(0);
    // 默认选中首卡(pkg-1):投影失败也落态(失败写缓存)→ 右栏占位,不崩、不永远转圈。
    await waitFor(() => {
      expect(screen.getByText('暂无文件行')).toBeTruthy();
    });
    expect(document.querySelectorAll('[data-smoke="file-version-row"]').length).toBe(0);
  });
});
