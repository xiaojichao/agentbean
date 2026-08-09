// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

import { OutputPackageCard } from '../components/OutputPackageCard';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const packageMeta = {
  kind: 'output-package' as const,
  packageId: 'pkg-1',
  taskId: 'task-1',
  taskTitle: '写剧本',
  agentName: 'Agent-A',
  memberCount: 1,
  members: [
    { shortLabel: 'F1', filename: 'ep1.md', artifactVersionId: 'ver-1', collectionId: 'col-1' },
  ],
  workspaceRevisionId: 'rev-1',
  publishId: 'pub-1',
  createdAt: 1000,
};

/**
 * #1061 AC11：卡片只把 Server 投影的 reviewState/isFinalVersion 显示为状态。
 * - 无 channelId：纯静态展示，不查询;
 * - 有 channelId：每个成员只显示一个着色状态标签;
 * - availableActions 中的审核/最终化动作不在成员行展开成按钮。
 */
describe('OutputPackageCard review actions (#1061 AC11)', () => {
  function reviewActionButtons(): HTMLElement[] {
    return Array.from(document.querySelectorAll('[data-smoke="package-review-action"]'));
  }

  function revisionActionButtons(): HTMLElement[] {
    return Array.from(document.querySelectorAll('[data-smoke="package-revise-action"]'));
  }

  test('无 channelId 时保持静态，标签后显示文件包名称', () => {
    render(<OutputPackageCard packageMeta={packageMeta} />);
    expect(screen.getByText('Agent 交付文件包')).not.toBeNull();
    expect(screen.getByText('写剧本')).not.toBeNull();
    expect(document.querySelector('[data-smoke="output-package-name"]')?.textContent).toBe('写剧本');
    expect(document.querySelector('[data-smoke="output-package-title"]')?.textContent).toBe('Agent 交付文件包·写剧本');
    expect(reviewActionButtons()).toHaveLength(0);
    expect(revisionActionButtons()).toHaveLength(0);
    expect(mocks.getOutputPackage).not.toHaveBeenCalled();
  });

  test('Server 状态投影 → 每个文件只显示一个着色状态标签，不显示审核按钮', async () => {
    const statusPackageMeta = {
      ...packageMeta,
      memberCount: 5,
      members: [
        { shortLabel: 'F1', filename: 'pending.md', artifactVersionId: 'ver-pending', collectionId: 'col-pending' },
        { shortLabel: 'F2', filename: 'approved.md', artifactVersionId: 'ver-approved', collectionId: 'col-approved' },
        { shortLabel: 'F3', filename: 'changes.md', artifactVersionId: 'ver-changes', collectionId: 'col-changes' },
        { shortLabel: 'F4', filename: 'rejected.md', artifactVersionId: 'ver-rejected', collectionId: 'col-rejected' },
        { shortLabel: 'F5', filename: 'final.md', artifactVersionId: 'ver-final', collectionId: 'col-final' },
      ],
    };
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: { taskRevision: 1 },
      availableActions: [
        {
          collectionId: 'col-pending',
          versionId: 'ver-pending',
          reviewState: 'pending',
          isFinalVersion: false,
          collectionRevision: 1,
          actions: ['review-approved', 'review-changes-requested', 'review-rejected', 'review-and-finalize'],
        },
        {
          collectionId: 'col-approved',
          versionId: 'ver-approved',
          reviewState: 'approved',
          isFinalVersion: false,
          collectionRevision: 1,
          actions: ['set-final'],
        },
        {
          collectionId: 'col-changes',
          versionId: 'ver-changes',
          reviewState: 'changes_requested',
          isFinalVersion: false,
          collectionRevision: 1,
          actions: ['revise-version'],
        },
        {
          collectionId: 'col-rejected',
          versionId: 'ver-rejected',
          reviewState: 'rejected',
          isFinalVersion: false,
          collectionRevision: 1,
          actions: [],
        },
        {
          collectionId: 'col-final',
          versionId: 'ver-final',
          reviewState: 'approved',
          isFinalVersion: true,
          collectionRevision: 1,
          actions: [],
        },
      ],
    });
    render(<OutputPackageCard
      packageMeta={statusPackageMeta}
      channelId="ch-1"
      onReviseVersion={vi.fn()}
    />);

    await waitFor(() => expect(document.querySelectorAll('[data-smoke="package-review-state"]')).toHaveLength(5));
    const pending = screen.getByText('待审核');
    const approved = screen.getByText('通过');
    const changes = screen.getByText('要求修改');
    const rejected = screen.getByText('拒绝');
    const final = screen.getByText('通过并设为最终版');
    expect(pending.className).toContain('amber');
    expect(approved.className).toContain('emerald');
    expect(changes.className).toContain('orange');
    expect(rejected.className).toContain('red');
    expect(final.className).toContain('violet');
    expect(reviewActionButtons()).toHaveLength(0);
    expect(revisionActionButtons()).toHaveLength(1);
    expect(revisionActionButtons()[0]?.dataset.action).toBe('revise-version');
    expect(mocks.getOutputPackage).toHaveBeenCalledWith({ channelId: 'ch-1', packageId: 'pkg-1' });
  });

  test('无审核权(actions 为空)→ 不显示任何按钮,但展示 Server 的审核状态', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: { taskRevision: 1 },
      availableActions: [{
        collectionId: 'col-1',
        versionId: 'ver-1',
        reviewState: 'approved',
        isFinalVersion: true,
        collectionRevision: 2,
        actions: [],
      }],
    });
    render(<OutputPackageCard packageMeta={packageMeta} channelId="ch-1" />);
    await waitFor(() => expect(screen.getByText('通过并设为最终版')).not.toBeNull());
    expect(reviewActionButtons()).toHaveLength(0);
    expect(revisionActionButtons()).toHaveLength(0);
  });
});
