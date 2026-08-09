// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
  submitPackageArtifactReview: vi.fn(),
  submitPackageReviewAndFinalize: vi.fn(),
  submitPackageReviewAndRejectDelivery: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
    submitPackageArtifactReview: mocks.submitPackageArtifactReview,
    submitPackageReviewAndFinalize: mocks.submitPackageReviewAndFinalize,
    submitPackageReviewAndRejectDelivery: mocks.submitPackageReviewAndRejectDelivery,
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
 * #1061 AC11：卡片按钮可见性完全由 Server 的 availableActions 决定。
 * - 无 channelId：纯静态展示,不查询、不显示按钮;
 * - 有 channelId：渲染 Server 给出的动作,空清单不显示任何按钮;
 * - 无 review 权：不显示审核/最终化按钮(客户端不推断权限)。
 */
describe('OutputPackageCard review actions (#1061 AC11)', () => {
  function reviewActionButtons(): HTMLElement[] {
    return Array.from(document.querySelectorAll('[data-smoke="package-review-action"]'));
  }

  test('无 channelId 时保持静态(不查询、无按钮)', () => {
    render(<OutputPackageCard packageMeta={packageMeta} />);
    expect(screen.getByText('任务「写剧本」交付文件包')).not.toBeNull();
    expect(reviewActionButtons()).toHaveLength(0);
    expect(mocks.getOutputPackage).not.toHaveBeenCalled();
  });

  test('Server 给出审核动作 → 渲染对应按钮;空清单 → 无按钮', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: { taskRevision: 1 },
      availableActions: [{
        collectionId: 'col-1',
        versionId: 'ver-1',
        reviewState: 'pending',
        isFinalVersion: false,
        collectionRevision: 1,
        actions: ['review-approved', 'review-changes-requested', 'review-rejected', 'review-and-finalize'],
      }],
    });
    render(<OutputPackageCard packageMeta={packageMeta} channelId="ch-1" />);
    await waitFor(() => expect(reviewActionButtons().length).toBeGreaterThan(0));
    expect(screen.getByText('待审核')).not.toBeNull();
    expect(screen.getByText('通过')).not.toBeNull();
    expect(screen.getByText('要求修改')).not.toBeNull();
    expect(screen.getByText('拒绝')).not.toBeNull();
    expect(screen.getByText('通过并设为最终版')).not.toBeNull();
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
    await waitFor(() => expect(screen.getByText('已通过 · 最终版')).not.toBeNull());
    expect(reviewActionButtons()).toHaveLength(0);
  });
});
