// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  ProjectDocumentBundleDetailDto,
  ProjectDocumentBundleDto,
} from '@agentbean/contracts';

import { ProjectDocumentBundleList } from '../components/channel-documents/ProjectDocumentBundleList';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

afterEach(cleanup);

const BUNDLE: ProjectDocumentBundleDto = {
  id: 'bundle-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  name: '发布文档包',
  source: {
    kind: 'workspace_run',
    workspaceRunId: 'run-1',
    agentId: 'agent-1',
    invocationId: 'invocation-1',
    taskId: 'task-1',
    runCreatedAt: 1_000,
  },
  memberCount: 2,
  createdBy: 'owner-1',
  createdAt: 1_700_000_000_000,
};

const DETAIL: ProjectDocumentBundleDetailDto = {
  ...BUNDLE,
  members: [
    {
      documentId: 'document-plan',
      position: 0,
      initialRevisionId: 'revision-plan-1',
      initialRevisionNumber: 1,
      initialFilename: 'plan.md',
      current: {
        revisionId: 'revision-plan-2',
        revisionNumber: 2,
        filename: 'plan.md',
        source: 'edit',
        createdBy: 'member-1',
        createdAt: 1_700_000_500_000,
        changedSinceJoin: true,
      },
    },
    {
      documentId: 'document-spec',
      position: 1,
      initialRevisionId: 'revision-spec-1',
      initialRevisionNumber: 1,
      initialFilename: 'spec.md',
      current: {
        revisionId: 'revision-spec-1',
        revisionNumber: 1,
        filename: 'spec.md',
        source: 'run',
        createdBy: 'agent-1',
        createdAt: 1_700_000_000_000,
        changedSinceJoin: false,
      },
    },
  ],
};

describe('#825 文件库文档包区块', () => {
  test('没有文档包时不渲染任何区块', () => {
    const { container } = render(
      <ProjectDocumentBundleList bundles={[]} archived={false} onLoadDetail={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  test('列出文档包并展示来源与成员数量', () => {
    render(
      <ProjectDocumentBundleList bundles={[BUNDLE]} archived={false} onLoadDetail={vi.fn()} />,
    );
    expect(screen.getByText('发布文档包')).toBeTruthy();
    const summary = screen.getByText(/2 个文档/);
    expect(summary.textContent).toContain('run-1');
    expect(summary.textContent).toContain('invocation-1');
    expect(summary.textContent).toContain('task-1');
  });

  test('展开时向 Server 取详情，展示固定成员、当前版本、修改来源与时间', async () => {
    const onLoadDetail = vi.fn().mockResolvedValue(DETAIL);
    render(
      <ProjectDocumentBundleList bundles={[BUNDLE]} archived={false} onLoadDetail={onLoadDetail} />,
    );

    fireEvent.click(screen.getByText('发布文档包'));
    await waitFor(() => expect(onLoadDetail).toHaveBeenCalledWith('bundle-1'));

    const planMember = await screen.findByText(/加入时版本 v1 · 当前版本 v2 · 人工编辑/);
    expect(planMember).toBeTruthy();
    expect(screen.getByText('加入后已修改')).toBeTruthy();
    expect(screen.getByText(/加入时版本 v1 · 当前版本 v1 · Agent 运行/)).toBeTruthy();
    // 未变更成员不带「加入后已修改」标记。
    expect(screen.getAllByText('加入后已修改')).toHaveLength(1);
  });

  test('详情读取失败时给出明确反馈而不是静默空白', async () => {
    const onLoadDetail = vi.fn().mockResolvedValue(null);
    render(
      <ProjectDocumentBundleList bundles={[BUNDLE]} archived={false} onLoadDetail={onLoadDetail} />,
    );

    fireEvent.click(screen.getByText('发布文档包'));
    expect(await screen.findByText('无法读取文档包内容，请稍后重试。')).toBeTruthy();
  });

  test('归档频道标注只读', () => {
    render(
      <ProjectDocumentBundleList bundles={[BUNDLE]} archived onLoadDetail={vi.fn()} />,
    );
    expect(screen.getByText('频道已归档，只读')).toBeTruthy();
  });

  test('再次点击可折叠，且不重复请求详情', async () => {
    const onLoadDetail = vi.fn().mockResolvedValue(DETAIL);
    render(
      <ProjectDocumentBundleList bundles={[BUNDLE]} archived={false} onLoadDetail={onLoadDetail} />,
    );

    fireEvent.click(screen.getByText('发布文档包'));
    await screen.findByText(/加入时版本 v1 · 当前版本 v2/);
    fireEvent.click(screen.getByText('发布文档包'));
    await waitFor(() => expect(screen.queryByText(/加入时版本 v1 · 当前版本 v2/)).toBeNull());
    expect(onLoadDetail).toHaveBeenCalledTimes(1);
  });
});
