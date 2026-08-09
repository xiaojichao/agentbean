// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OutputPackagePreviewModal } from '../components/OutputPackagePreviewModal';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  artifactCollections: vi.fn(),
  saveArtifactVersionRevision: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  getResolvedServerUrl: () => 'https://server.test',
  getStoredAuthToken: () => 'token',
  projectEvents: () => ({
    artifactCollections: mocks.artifactCollections,
    saveArtifactVersionRevision: mocks.saveArtifactVersionRevision,
  }),
}));

vi.mock('@/lib/chat-artifact-url', () => ({
  chatArtifactUrl: (artifact: { id: string }, action: string) => `/artifacts/${artifact.id}/${action}`,
}));

const packageMeta = {
  kind: 'output-package' as const,
  packageId: '04200000-package',
  taskTitle: '第 1 集剧本',
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

function renderModal(options: { initialVersionId?: string; onClose?: () => void; onSaved?: () => void } = {}) {
  return render(
    <OutputPackagePreviewModal
      packageMeta={packageMeta}
      channelId="channel-1"
      {...(options.initialVersionId ? { initialVersionId: options.initialVersionId } : {})}
      renderPreview={(content) => <div data-testid="rendered-markdown">{content}</div>}
      onClose={options.onClose ?? vi.fn()}
      onSaved={options.onSaved ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.artifactCollections.mockResolvedValue({ ok: true, library: library() });
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
  test('使用三栏布局并渲染四个页脚动作，同时移除原型说明性备注', async () => {
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
    expect(screen.getByRole('button', { name: '保存为 Server 新版本' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存并提交审核' })).toBeTruthy();
    expect(document.querySelector('[data-smoke="package-preview-actions"]')?.className).toContain('overflow-x-auto');
    expect(screen.getByText('Server source of truth')).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: '保存为 Server 新版本' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存并提交审核' })).toBeNull();
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

  test('保存并提交审核生成新版本并进入待审核，不代替审核人记录决定', async () => {
    renderModal();

    const editor = await screen.findByRole('textbox', { name: 'Markdown 源文' });
    fireEvent.change(editor, { target: { value: '# 待审核的新版本' } });
    const reviewButton = document.querySelector<HTMLButtonElement>('[data-smoke="package-preview-save-review"]')!;
    await waitFor(() => expect(reviewButton.disabled).toBe(false));
    fireEvent.click(reviewButton);

    await waitFor(() => expect(mocks.saveArtifactVersionRevision).toHaveBeenCalledTimes(1));
    const notice = await waitFor(() => document.querySelector<HTMLElement>('[data-smoke="package-preview-saved"]'));
    expect(notice?.textContent).toContain('已保存并提交审核：Server 生成 script.ep01 v5');
    expect(notice?.textContent).toContain('新版本已进入待审核');
  });
});
