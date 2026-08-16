// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OutputPackagePreviewModal } from '../components/OutputPackagePreviewModal';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  artifactCollections: vi.fn(),
  getOutputPackage: vi.fn(),
  saveArtifactVersionRevision: vi.fn(),
  submitPackageArtifactReview: vi.fn(),
  submitPackageArtifactReviews: vi.fn(),
  submitPackageReviewAndFinalize: vi.fn(),
  submitPackageReviewAndRejectDelivery: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  getResolvedServerUrl: () => 'https://server.test',
  getStoredAuthToken: () => 'token',
  projectEvents: () => ({
    artifactCollections: mocks.artifactCollections,
    getOutputPackage: mocks.getOutputPackage,
    saveArtifactVersionRevision: mocks.saveArtifactVersionRevision,
    submitPackageArtifactReview: mocks.submitPackageArtifactReview,
    submitPackageArtifactReviews: mocks.submitPackageArtifactReviews,
    submitPackageReviewAndFinalize: mocks.submitPackageReviewAndFinalize,
    submitPackageReviewAndRejectDelivery: mocks.submitPackageReviewAndRejectDelivery,
  }),
}));

vi.mock('@/lib/chat-artifact-url', () => ({
  chatArtifactUrl: (artifact: { id: string }, action: string) => `/artifacts/${artifact.id}/${action}`,
}));

const packageMeta = {
  kind: 'output-package' as const,
  packageId: '04200000-package',
  threadRootMessageId: 'thread-root-1',
  taskId: 'task-1',
  taskTitle: '第 1 集剧本',
  agentId: 'agent-1',
  agentName: '剧本创作',
  memberCount: 2,
  members: [
    { shortLabel: 'F1', filename: '第1集剧本.md', artifactVersionId: 'version-1', collectionId: 'collection-1' },
    { shortLabel: 'F2', filename: '角色表.md', artifactVersionId: 'version-2', collectionId: 'collection-2' },
  ],
  workspaceRevisionId: 'workspace-revision-1',
  publishId: 'publish-1',
};

function version(id: string, collectionId: string, filename: string, versionNumber: number, reviewState: 'pending' | 'approved' = 'pending') {
  return {
    id,
    teamId: 'team-1',
    channelId: 'channel-1',
    collectionId,
    versionNumber,
    artifact: {
      id: `artifact-${id}`,
      teamId: 'team-1',
      channelId: 'channel-1',
      uploaderId: 'user-1',
      filename,
      mimeType: 'text/markdown',
      sizeBytes: 20,
      pathKind: 'generated',
      createdAt: 100,
    },
    source: {},
    lineage: [],
    promotedBy: 'agent-1',
    createdAt: 100,
    reviews: [],
    reviewState,
  };
}

function library(
  firstVersion = version('version-1', 'collection-1', '第1集剧本.md', 4),
  firstVersions = [firstVersion],
) {
  return {
    archived: false,
    collections: [
      {
        id: 'collection-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        name: 'script.ep01',
        kind: 'deliverable',
        revision: firstVersion.versionNumber,
        currentVersionId: firstVersion.id,
        versions: firstVersions,
        finalizations: [],
        createdBy: 'user-1',
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: 'collection-2',
        teamId: 'team-1',
        channelId: 'channel-1',
        name: 'character.sheet',
        kind: 'deliverable',
        revision: 3,
        currentVersionId: 'version-2',
        finalVersionId: 'version-2',
        versions: [version('version-2', 'collection-2', '角色表.md', 3, 'approved')],
        finalizations: [],
        createdBy: 'user-1',
        createdAt: 100,
        updatedAt: 100,
      },
    ],
  };
}

function renderModal(options: {
  initialVersionId?: string;
  readOnly?: boolean;
  onClose?: () => void;
  onSaved?: () => void;
  prepareReturnThread?: (threadRootMessageId: string) => Promise<boolean>;
  onReturnToThread?: () => void;
} = {}) {
  return render(
    <OutputPackagePreviewModal
      packageMeta={packageMeta}
      channelId="channel-1"
      {...(options.initialVersionId ? { initialVersionId: options.initialVersionId } : {})}
      {...(options.readOnly ? { readOnly: true } : {})}
      renderPreview={(content) => <div data-testid="rendered-markdown">{content}</div>}
      onClose={options.onClose ?? vi.fn()}
      onSaved={options.onSaved ?? vi.fn()}
      prepareReturnThread={options.prepareReturnThread ?? vi.fn().mockResolvedValue(true)}
      onReturnToThread={options.onReturnToThread ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.artifactCollections.mockResolvedValue({ ok: true, library: library() });
  mocks.getOutputPackage.mockResolvedValue({
    ok: true,
    threadRootMessageId: 'thread-root-1',
    package: {
      schemaVersion: 1,
      packageId: packageMeta.packageId,
      teamId: 'team-1',
      channelId: 'channel-1',
      revision: 1,
      deliveryId: 'delivery-1',
      publishId: 'publish-1',
      workspaceRevisionId: 'workspace-revision-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskBinding: 'managed',
      taskRevision: 7,
      taskAttempt: 2,
      members: [],
      memberCount: 2,
      status: 'recorded',
      createdAt: 100,
    },
    availableActions: [
      {
        collectionId: 'collection-1',
        versionId: 'version-1',
        reviewState: 'pending',
        isFinalVersion: false,
        collectionRevision: 4,
        actions: ['review-approved', 'review-changes-requested', 'review-rejected', 'review-and-finalize', 'review-and-reject-delivery'],
      },
      {
        collectionId: 'collection-2',
        versionId: 'version-2',
        reviewState: 'approved',
        isFinalVersion: true,
        collectionRevision: 3,
        actions: ['review-approved', 'review-changes-requested'],
      },
    ],
  });
  mocks.saveArtifactVersionRevision.mockResolvedValue({
    ok: true,
    revision: {
      commandName: 'save-artifact-version-revision',
      versionId: 'server-version-5',
      collectionId: 'collection-1',
      versionNumber: 5,
      artifactId: 'artifact-server-version-5',
      baseVersionId: 'version-1',
      sourceVersionId: 'version-1',
      collectionRevision: 5,
      currentVersionId: 'server-version-5',
      createdAt: 200,
    },
  });
  mocks.submitPackageArtifactReview.mockImplementation(async (input) => ({
    ok: true,
    review: {
      id: 'review-new',
      versionId: input.saveRevision ? 'server-version-5' : input.versionId,
      decision: input.decision,
    },
    ...(input.saveRevision ? {
      revision: {
        commandName: 'save-artifact-version-revision',
        versionId: 'server-version-5',
        collectionId: 'collection-1',
        versionNumber: 5,
        artifactId: 'artifact-server-version-5',
        baseVersionId: 'version-1',
        sourceVersionId: 'version-1',
        collectionRevision: 5,
        currentVersionId: 'server-version-5',
        createdAt: 200,
      },
    } : {}),
  }));
  mocks.submitPackageArtifactReviews.mockImplementation(async (input) => ({
    ok: true,
    reviews: input.targets.map((target: { artifactVersionId: string }, index: number) => ({
      id: `batch-review-${index + 1}`,
      versionId: target.artifactVersionId,
      decision: input.decision,
    })),
    replayed: false,
  }));
  mocks.submitPackageReviewAndFinalize.mockImplementation(async (input) => ({
    ok: true,
    review: { id: 'review-final', versionId: input.saveRevision ? 'server-version-5' : input.versionId, decision: 'approved' },
    finalization: { id: 'final-1', versionId: input.saveRevision ? 'server-version-5' : input.versionId },
    collection: { id: 'collection-1', finalVersionId: input.saveRevision ? 'server-version-5' : input.versionId },
    ...(input.saveRevision ? {
      revision: {
        commandName: 'save-artifact-version-revision',
        versionId: 'server-version-5',
        collectionId: 'collection-1',
        versionNumber: 5,
        artifactId: 'artifact-server-version-5',
        baseVersionId: 'version-1',
        sourceVersionId: 'version-1',
        collectionRevision: 5,
        currentVersionId: 'server-version-5',
        finalVersionId: 'server-version-5',
        createdAt: 200,
      },
    } : {}),
  }));
  mocks.submitPackageReviewAndRejectDelivery.mockImplementation(async (input) => ({
    ok: true,
    review: { id: 'review-return', versionId: input.versionId, decision: input.decision },
    task: { taskId: 'task-1', taskRevision: 7, taskAttempt: 3, status: 'todo' },
  }));
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => url.includes('version-2') ? '# 角色表' : '# 温暖的一步',
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OutputPackagePreviewModal 原型收敛', () => {
  test('使用三栏布局并按 Server availableActions 渲染逐文件审核入口', async () => {
    renderModal();

    expect(await screen.findByText('预览 / 编辑：PKG-04200000 · 第1集剧本.md')).toBeTruthy();
    expect(screen.getByText('F1 第1集剧本.md')).toBeTruthy();
    expect(screen.getByText('F2 角色表.md')).toBeTruthy();
    expect(await screen.findByText('Markdown 源文')).toBeTruthy();
    expect(screen.getByText('Markdown 预览')).toBeTruthy();
    expect((await screen.findByTestId('rendered-markdown')).textContent).toBe('# 温暖的一步');
    expect(document.querySelector('[data-smoke="package-preview-save"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: '模拟冲突' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看版本历史' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存新版本' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '退回修改…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '通过' })).toBeTruthy();
    expect(document.querySelector('[data-smoke="package-preview-actions"]')?.className).toContain('overflow-x-auto');
    // 微调对齐原型：默认态不再渲染 Server source of truth 标签（错误/成功提示保留）。
    expect(screen.queryByText('Server source of truth')).toBeNull();
    expect(screen.queryByRole('button', { name: 'edit' })).toBeNull();
    expect(screen.queryByText('可直接改一句话')).toBeNull();
    expect(screen.queryByText('实时预览')).toBeNull();
    expect(screen.queryByText(/保存后直接更新该文档的最新 Server 修订/)).toBeNull();
    expect(screen.queryByText(/保存会生成 v/)).toBeNull();
  });

  test('成员行打开时聚焦指定版本，并可在左栏切换文件', async () => {
    renderModal({ initialVersionId: 'version-2' });

    expect(await screen.findByText('预览 / 编辑：PKG-04200000 · 角色表.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /F1 第1集剧本\.md/ }));
    expect(await screen.findByText('预览 / 编辑：PKG-04200000 · 第1集剧本.md')).toBeTruthy();
  });









  test('非 Markdown 成员仍可查看版本历史，但不显示编辑和保存动作', async () => {
    const imageVersion = version('version-1', 'collection-1', '分镜.png', 4);
    mocks.artifactCollections.mockResolvedValue({ ok: true, library: library(imageVersion) });
    renderModal();

    expect(await screen.findByText('预览 / 编辑：PKG-04200000 · 分镜.png')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看版本历史' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '模拟冲突' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存新版本' })).toBeNull();
    expect(screen.getByRole('button', { name: '通过' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '退回修改…' })).toBeTruthy();
  });

  test('关闭脏草稿前确认，并让页脚保存按钮跟随编辑器状态', async () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderModal({ onClose });

    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' });
    const saveButton = document.querySelector<HTMLButtonElement>('[data-smoke="package-preview-save"]')!;
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(editor, { target: { value: '# 尚未保存' } });
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTitle('关闭'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('切换成员前确认未保存修改，取消时保留当前编辑器', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderModal();

    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.change(editor, { target: { value: '# 尚未保存' } });
    const secondMember = screen.getByRole('button', { name: /F2 角色表\.md/ });
    fireEvent.click(secondMember);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText('预览 / 编辑：PKG-04200000 · 第1集剧本.md')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Markdown 源文' }) as HTMLTextAreaElement).value).toBe('# 尚未保存');

    confirm.mockReturnValue(true);
    fireEvent.click(secondMember);
    expect(await screen.findByText('预览 / 编辑：PKG-04200000 · 角色表.md')).toBeTruthy();
  });

  test('模拟冲突只进入本地冲突处理，不写入 Server', async () => {
    renderModal();

    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.change(editor, { target: { value: '# 保留的本地草稿' } });
    const simulateButton = screen.getByRole('button', { name: '模拟冲突' });
    await waitFor(() => expect((simulateButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(simulateButton);

    expect((await screen.findByRole('alert')).textContent).toContain('模拟冲突：假设 Server 已有 script.ep01 v5');
    expect(screen.getByRole('button', { name: '查看最新版' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制草稿' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续手工合并' })).toBeTruthy();
    expect(mocks.saveArtifactVersionRevision).not.toHaveBeenCalled();
  });

  test('版本历史读取真实集合版本，并提供只读预览和下载', async () => {
    const current = version('version-1', 'collection-1', '第1集剧本.md', 4);
    const previous = {
      ...version('version-previous', 'collection-1', '第1集剧本.md', 3, 'approved'),
      revisionBasis: { sourceVersionId: 'version-2-before' },
    };
    mocks.artifactCollections.mockResolvedValue({
      ok: true,
      library: library(current, [current, previous]),
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      text: async () => String(url).includes('version-previous') ? '# 历史版本正文' : '# 温暖的一步',
    } as Response));
    renderModal();

    await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.click(screen.getByRole('button', { name: '查看版本历史' }));
    expect(await screen.findByRole('dialog', { name: 'script.ep01 版本历史' })).toBeTruthy();
    expect(screen.getByText('v4')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
    expect(screen.getByText('current')).toBeTruthy();
    expect(screen.getByText('手动修改', { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载 v3' }).getAttribute('href')).toBe('/artifacts/artifact-version-previous/download');

    fireEvent.click(screen.getByRole('button', { name: '预览 v3' }));
    expect(await screen.findByText('# 历史版本正文')).toBeTruthy();
  });

  test('底部保存按钮沿用 revision fence，成功后显示 Server 新版本状态', async () => {
    const onSaved = vi.fn();
    const next = version('server-version-9', 'collection-1', '第1集剧本.md', 9);
    const savedResult = {
      ok: true,
      revision: {
        commandName: 'save-artifact-version-revision',
        versionId: 'server-version-9',
        collectionId: 'collection-1',
        versionNumber: 9,
        artifactId: 'artifact-server-version-9',
        baseVersionId: 'version-1',
        sourceVersionId: 'version-1',
        collectionRevision: 9,
        currentVersionId: 'server-version-9',
        createdAt: 200,
      },
    };
    let resolveSave!: (result: typeof savedResult) => void;
    mocks.saveArtifactVersionRevision.mockReturnValue(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    mocks.artifactCollections
      .mockResolvedValueOnce({ ok: true, library: library() })
      .mockResolvedValue({ ok: true, library: library(next) });
    renderModal({ onSaved });

    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.change(editor, { target: { value: '# 修改后的结尾' } });
    const saveButton = document.querySelector<HTMLButtonElement>('[data-smoke="package-preview-save"]')!;
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(saveButton.disabled).toBe(true);
      expect(saveButton.textContent).toBe('保存中…');
    });
    resolveSave(savedResult);

    await waitFor(() => expect(mocks.saveArtifactVersionRevision).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel-1',
      collectionId: 'collection-1',
      baseVersionId: 'version-1',
      content: '# 修改后的结尾',
      filename: '第1集剧本.md',
      expectedCollectionRevision: 4,
      revisionBasis: { sourceVersionId: 'version-1' },
    })));
    expect(await screen.findByText(/已保存：Server 生成 script\.ep01 v9/)).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test('脏编辑稿默认保存新版本后通过，单次调用绑定新 version 的组合命令', async () => {
    renderModal();

    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.change(editor, { target: { value: '# 通过的新版本' } });
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    expect(await screen.findByRole('region', { name: '通过审核' })).toBeTruthy();
    const saveThenApprove = screen.getByRole('radio', { name: '保存编辑稿为新版本，然后通过新版本' }) as HTMLInputElement;
    expect(saveThenApprove.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }));

    await waitFor(() => expect(mocks.submitPackageArtifactReview).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel-1',
      packageId: packageMeta.packageId,
      collectionId: 'collection-1',
      versionId: 'version-1',
      decision: 'approved',
      expectedCollectionRevision: 4,
      saveRevision: {
        content: '# 通过的新版本',
        filename: '第1集剧本.md',
        revisionBasis: {
          sourceVersionId: 'version-1',
          packageId: packageMeta.packageId,
          deliveryId: 'delivery-1',
        },
      },
    })));
    expect(mocks.saveArtifactVersionRevision).not.toHaveBeenCalled();
    const notice = await waitFor(() => document.querySelector<HTMLElement>('[data-smoke="package-preview-saved"]'));
    expect(notice?.textContent).toContain('已保存并通过：审核记录绑定 Server v5');
  });

  test('干净编辑器明确审核当前已保存 version，不创建新版本', async () => {
    renderModal();
    await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    const current = await screen.findByRole('radio', { name: '通过当前已保存的 Server v4' }) as HTMLInputElement;
    expect(current.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }));

    await waitFor(() => expect(mocks.submitPackageArtifactReview).toHaveBeenCalledWith(expect.objectContaining({
      versionId: 'version-1',
      decision: 'approved',
    })));
    expect(mocks.submitPackageArtifactReview.mock.calls[0]?.[0]).not.toHaveProperty('saveRevision');
    expect(mocks.saveArtifactVersionRevision).not.toHaveBeenCalled();
  });

  test('要求修改原子退回 delivery，并把原智能体、稳定版本与新 attempt 上抛给讨论串预填', async () => {
    const onReturnToThread = vi.fn();
    const prepareReturnThread = vi.fn().mockResolvedValue(true);
    renderModal({ onReturnToThread, prepareReturnThread });
    await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.click(screen.getByRole('button', { name: '退回修改…' }));
    expect((await screen.findByRole('radio', { name: /要求修改/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /让原智能体修改/ }) as HTMLInputElement).checked).toBe(true);
    const comment = await screen.findByRole('textbox', { name: '审核意见（必填）' });
    expect((screen.getByRole('button', { name: '回讨论串继续' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(comment, { target: { value: '请补充风险说明' } });
    fireEvent.click(screen.getByRole('button', { name: '回讨论串继续' }));

    await waitFor(() => expect(mocks.submitPackageReviewAndRejectDelivery).toHaveBeenCalledWith(expect.objectContaining({
      versionId: 'version-1',
      decision: 'changes_requested',
      comment: '请补充风险说明',
      rejectReason: '请补充风险说明',
      expectedTaskRevision: 7,
      expectedTaskAttempt: 2,
    })));
    expect(prepareReturnThread).toHaveBeenCalledWith('thread-root-1');
    expect(prepareReturnThread.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.submitPackageReviewAndRejectDelivery.mock.invocationCallOrder[0]!,
    );
    expect(onReturnToThread).toHaveBeenCalledWith(expect.objectContaining({
      packageId: packageMeta.packageId,
      threadRootMessageId: 'thread-root-1',
      taskId: 'task-1',
      originalAgentId: 'agent-1',
      originalAgentName: '剧本创作',
      collectionId: 'collection-1',
      versionId: 'version-1',
      decision: 'changes_requested',
      comment: '请补充风险说明',
      agentChoice: 'original',
      taskRevision: 7,
      taskAttempt: 3,
    }));
    expect(mocks.submitPackageArtifactReview).not.toHaveBeenCalled();
    expect(mocks.submitPackageReviewAndFinalize).not.toHaveBeenCalled();
  });

  test('拒绝并换智能体时不预选具体 Agent，仍原子退回当前 delivery', async () => {
    const onReturnToThread = vi.fn();
    renderModal({ onReturnToThread });
    await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.click(screen.getByRole('button', { name: '退回修改…' }));
    fireEvent.click(await screen.findByRole('radio', { name: /拒绝/ }));
    fireEvent.click(screen.getByRole('radio', { name: /换一个智能体处理/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '审核意见（必填）' }), {
      target: { value: '方向错误，请重做' },
    });
    fireEvent.click(screen.getByRole('button', { name: '回讨论串继续' }));

    await waitFor(() => expect(mocks.submitPackageReviewAndRejectDelivery).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'rejected',
      comment: '方向错误，请重做',
    })));
    expect(onReturnToThread).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'rejected',
      agentChoice: 'select',
    }));
  });

  test('原讨论串上下文加载失败时不提交不可逆的 delivery 退回', async () => {
    const prepareReturnThread = vi.fn().mockResolvedValue(false);
    renderModal({ prepareReturnThread });
    await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.click(screen.getByRole('button', { name: '退回修改…' }));
    fireEvent.change(screen.getByRole('textbox', { name: '审核意见（必填）' }), {
      target: { value: '需要补充依据' },
    });
    fireEvent.click(screen.getByRole('button', { name: '回讨论串继续' }));

    expect((await screen.findByRole('alert')).textContent).toContain('原讨论串上下文加载失败，尚未退回 Task delivery');
    expect(mocks.submitPackageReviewAndRejectDelivery).not.toHaveBeenCalled();
  });

  test('没有 delivery 退回动作时保留负面文件审核入口，且不改变 Task', async () => {
    const packageResult = await mocks.getOutputPackage();
    mocks.getOutputPackage.mockResolvedValue({
      ...packageResult,
      availableActions: [{
        collectionId: 'collection-1',
        versionId: 'version-1',
        reviewState: 'pending',
        isFinalVersion: false,
        collectionRevision: 4,
        actions: ['review-changes-requested', 'review-rejected'],
      }],
    });
    const prepareReturnThread = vi.fn().mockResolvedValue(true);
    const onReturnToThread = vi.fn();
    renderModal({ prepareReturnThread, onReturnToThread });

    await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.click(screen.getByRole('button', { name: '退回修改…' }));
    // 原型对齐：agent 选择无条件展示（文件级退回也回讨论串预填）。
    fireEvent.click(screen.getByRole('radio', { name: /拒绝/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '审核意见（必填）' }), {
      target: { value: '当前版本不可用' },
    });
    fireEvent.click(screen.getByRole('button', { name: '回讨论串继续' }));

    await waitFor(() => expect(mocks.submitPackageArtifactReview).toHaveBeenCalledWith(expect.objectContaining({
      packageId: packageMeta.packageId,
      collectionId: 'collection-1',
      versionId: 'version-1',
      decision: 'rejected',
      comment: '当前版本不可用',
    })));
    expect(mocks.submitPackageReviewAndRejectDelivery).not.toHaveBeenCalled();
    // 原型对齐：文件级退回成功后同样回讨论串继续（预填被退回版本与智能体选择）。
    expect(prepareReturnThread).toHaveBeenCalledTimes(1);
    expect(onReturnToThread).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'rejected',
      comment: '当前版本不可用',
    }));
    expect(await screen.findByText(/Task delivery 未变更/)).toBeTruthy();
  });

  test('保存新版本、通过与设为 final 走一个 finalize 组合请求', async () => {
    renderModal();
    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.change(editor, { target: { value: '# 最终稿' } });
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '同时设为当前文档的最终版（不验收 Task）' }));
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }));

    await waitFor(() => expect(mocks.submitPackageReviewAndFinalize).toHaveBeenCalledWith(expect.objectContaining({
      versionId: 'version-1',
      expectedCollectionRevision: 4,
      saveRevision: expect.objectContaining({
        content: '# 最终稿',
        revisionBasis: {
          sourceVersionId: 'version-1',
          packageId: packageMeta.packageId,
          deliveryId: 'delivery-1',
        },
      }),
    })));
    expect(mocks.submitPackageArtifactReview).not.toHaveBeenCalled();
  });

  test('Server 仅开放原子通过并最终化时仍可从统一预览完成动作', async () => {
    const detail = await mocks.getOutputPackage();
    detail.availableActions[0].actions = ['review-and-finalize'];
    mocks.getOutputPackage.mockResolvedValue(detail);
    renderModal();
    await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '同时设为当前文档的最终版（不验收 Task）' }));
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }));

    await waitFor(() => expect(mocks.submitPackageReviewAndFinalize).toHaveBeenCalledWith(expect.objectContaining({
      versionId: 'version-1',
      expectedCollectionRevision: 4,
    })));
    expect(mocks.submitPackageArtifactReview).not.toHaveBeenCalled();
    expect(await screen.findByText(/已设为 final/)).toBeTruthy();
  });

  test('没有 Server 审核动作时不显示审核按钮，并明确提示动作不可用', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: { packageId: packageMeta.packageId, deliveryId: 'delivery-1' },
      availableActions: [{
        collectionId: 'collection-1',
        versionId: 'version-1',
        reviewState: 'pending',
        isFinalVersion: false,
        collectionRevision: 4,
        actions: [],
      }],
    });
    renderModal();
    await screen.findByRole('textbox', { name: 'Markdown 源文' });
    expect(screen.queryByRole('button', { name: '通过' })).toBeNull();
    expect(screen.queryByRole('button', { name: '退回修改…' })).toBeNull();
    expect(screen.getByText('当前版本没有可执行的审核动作')).toBeTruthy();
  });

  test('归档频道统一预览保持只读，不暴露编辑、审核或最终化动作', async () => {
    renderModal({ readOnly: true });
    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' }) as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    expect(screen.getByText('归档频道只读，仅可预览历史版本')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '通过' })).toBeNull();
    expect(screen.queryByRole('button', { name: '退回修改…' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /参与批量审核/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /批量审核/ })).toBeNull();
    expect((screen.getByRole('button', { name: '保存新版本' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('组合保存遇到 stale fence 时保留脏稿并提示查看最新版', async () => {
    mocks.submitPackageArtifactReview.mockResolvedValue({
      ok: false,
      error: 'CONFLICT',
      message: 'Package review conflict: base-version-stale',
      revisionConflict: {
        code: 'base-version-stale',
        baseVersionId: 'version-1',
        serverCurrentVersionId: 'server-version-6',
        serverCurrentVersionNumber: 6,
        collectionRevision: 6,
        draftPreserved: true,
      },
    });
    renderModal();
    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '# 仍需保留的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认通过' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Server 已有 script.ep01 v6');
    expect(editor.value).toBe('# 仍需保留的草稿');
    expect(screen.getByRole('button', { name: '查看最新版' })).toBeTruthy();
  });
});
