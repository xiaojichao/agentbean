// @vitest-environment jsdom

/**
 * #1065 AC2 Chat 卡片入口:「打开审核 Task」与「继续 @Agent」。
 *
 * 入口只导航/预填,不创建任何 Message/Offer/claim/Invocation 事实(未发送前);
 * 按钮可见性不携带 authority——command 提交时 Server 仍完整复验(AC9)。
 */
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
    artifactCollections: async () => ({ ok: true, library: { collections: [{
      id: 'col-1', name: 'ep1.md', currentVersionId: 'ver-1',
      versions: [{ id: 'ver-1', versionNumber: 1 }],
    }] } }),
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

describe('OutputPackageCard 入口(#1065 AC2)', () => {
  test('渲染「打开审核 Task」与「继续 @Agent」入口区', () => {
    render(
      <OutputPackageCard
        packageMeta={packageMeta}
        onOpenTask={vi.fn()}
        onContinueWithAgent={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-smoke="output-package-entries"]')).not.toBeNull();
    expect(document.querySelector('[data-smoke="output-package-open-task"]')).not.toBeNull();
    expect(document.querySelector('[data-smoke="output-package-continue-agent"]')).not.toBeNull();
  });

  test('「打开审核 Task」点击导航到该 Task(回调携带 taskId)', () => {
    const onOpenTask = vi.fn();
    render(
      <OutputPackageCard
        packageMeta={packageMeta}
        onOpenTask={onOpenTask}
        onContinueWithAgent={vi.fn()}
      />,
    );
    fireEvent.click(document.querySelector('[data-smoke="output-package-open-task"]')!);
    expect(onOpenTask).toHaveBeenCalledWith('task-1');
  });

  test('「继续 @Agent」点击预填 composer(回调携带 packageId 与任务名)', () => {
    const onContinueWithAgent = vi.fn();
    render(
      <OutputPackageCard
        packageMeta={packageMeta}
        onContinueWithAgent={onContinueWithAgent}
      />,
    );
    fireEvent.click(document.querySelector('[data-smoke="output-package-continue-agent"]')!);
    expect(onContinueWithAgent).toHaveBeenCalledWith('pkg-1', '写剧本');
  });

  test('无 taskId 时不渲染「打开审核 Task」(纯展示/无导航面)', () => {
    render(
      <OutputPackageCard
        packageMeta={{ ...packageMeta, taskId: undefined }}
        onOpenTask={vi.fn()}
        onContinueWithAgent={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-smoke="output-package-open-task"]')).toBeNull();
    expect(document.querySelector('[data-smoke="output-package-continue-agent"]')).not.toBeNull();
  });

  test('回调未注入时不渲染入口区(卡片纯展示)', () => {
    render(<OutputPackageCard packageMeta={packageMeta} />);
    expect(document.querySelector('[data-smoke="output-package-entries"]')).toBeNull();
  });

  test('AC8:并发查询时旧响应不覆盖新状态(cancelled 守卫,最新请求胜出)', async () => {
    let resolveOld!: (value: { ok: boolean; package?: unknown; availableActions?: unknown[] }) => void;
    const oldResponse = new Promise<{ ok: boolean; package?: unknown; availableActions?: unknown[] }>((resolve) => {
      resolveOld = resolve;
    });
    const newResponse = {
      ok: true,
      package: { taskRevision: 1, taskAttempt: 1, deliveryId: 'del-new' },
      availableActions: [
        { collectionId: 'col-1', versionId: 'ver-1', reviewState: 'approved', actions: [] },
      ],
    };
    mocks.getOutputPackage
      .mockReturnValueOnce(oldResponse) // 旧频道(ch-1)查询:慢
      .mockResolvedValueOnce(newResponse); // 新频道(ch-2)查询:快
    const { rerender } = render(
      <OutputPackageCard packageMeta={packageMeta} channelId="ch-1" onAddReference={vi.fn()} />,
    );
    rerender(
      <OutputPackageCard packageMeta={packageMeta} channelId="ch-2" onAddReference={vi.fn()} />,
    );
    // 新响应先到并应用。
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="package-review-state"]')?.textContent).toContain('通过');
    });
    // 旧响应(慢)后到:被 cancelled 忽略,不覆盖新状态。
    resolveOld({
      ok: true,
      package: { taskRevision: 1, taskAttempt: 1, deliveryId: 'del-old' },
      availableActions: [{ collectionId: 'col-1', versionId: 'ver-1', reviewState: 'pending', actions: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('[data-smoke="package-review-state"]')?.textContent).toContain('通过');
  });
});
