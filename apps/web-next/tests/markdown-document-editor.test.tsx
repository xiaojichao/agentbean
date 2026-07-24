// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MarkdownDocumentEditor } from '../components/channel-documents/MarkdownDocumentEditor';
import {
  SafeMarkdownResource,
  collectSafeMarkdownReferenceDefinitions,
} from '../components/channel-documents/SafeMarkdownResource';
import type { ChannelDocumentRevisionDto } from '@agentbean/contracts';

(globalThis as typeof globalThis & { React: typeof React }).React = React;
afterEach(() => document.body.replaceChildren());

describe('MarkdownDocumentEditor', () => {
  test('支持编辑、预览、基础工具栏和保存快捷键', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <MarkdownDocumentEditor
        filename="notes.md"
        initialContent="hello"
        onSave={onSave}
        onClose={() => {}}
        renderPreview={(content) => <div data-testid="preview">{content}</div>}
      />,
    );

    const editor = screen.getAllByRole('textbox')[1]!;
    fireEvent.change(editor, { target: { value: 'hello world' } });
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('hello world', 'notes.md'));
    expect(screen.getByTestId('preview').textContent).toContain('hello world');
    expect(screen.getByRole('button', { name: 'edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'split' })).toBeTruthy();
    expect(screen.getByTitle('粗体')).toBeTruthy();
    expect(screen.getByTitle('斜体')).toBeTruthy();
    expect(screen.getByTitle('链接')).toBeTruthy();
    expect(screen.getByTitle('列表')).toBeTruthy();
    expect(screen.getByTitle('引用')).toBeTruthy();
    expect(screen.getByTitle('代码')).toBeTruthy();
  });

  test('只读模式禁止修改与保存并展示原因', () => {
    const onSave = vi.fn();
    render(
      <MarkdownDocumentEditor
        filename="large.md"
        initialContent="preview"
        readOnly
        readOnlyReason="文件超过 2 MB，仅显示截断预览"
        onSave={onSave}
        renderPreview={(content) => content}
      />,
    );

    expect(screen.getByText('文件超过 2 MB，仅显示截断预览')).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('刷新后提示恢复未过期草稿并可明确丢弃', () => {
    localStorage.setItem(
      'agentbean.channel-document-draft:user-1:team-1:document-1:revision-1',
      JSON.stringify({ content: 'local draft', filename: 'draft.md', updatedAt: Date.now() }),
    );
    render(
      <MarkdownDocumentEditor
        draftIdentity={{
          userId: 'user-1',
          teamId: 'team-1',
          documentId: 'document-1',
          baseRevisionId: 'revision-1',
        }}
        filename="notes.md"
        initialContent="server"
        onSave={vi.fn().mockResolvedValue({ ok: true, revisionId: 'revision-2' })}
        onLoadLatest={vi.fn()}
        renderPreview={(content) => content}
      />,
    );

    expect(screen.getByText('检测到未提交的本地草稿')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复草稿' }));
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('draft.md');
    expect((screen.getAllByRole('textbox')[1] as HTMLTextAreaElement).value).toBe('local draft');

    fireEvent.click(screen.getByRole('button', { name: '丢弃草稿' }));
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('notes.md');
    expect((screen.getAllByRole('textbox')[1] as HTMLTextAreaElement).value).toBe('server');
  });

  test('冲突时保留完整草稿并提供最新版、复制、手工合并和取消操作', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onSave = vi.fn().mockResolvedValue({
      ok: false,
      conflict: true,
      message: '文档已被其他成员更新',
    });
    const onLoadLatest = vi.fn().mockResolvedValue({
      content: 'latest server content',
      filename: 'notes.md',
      revisionId: 'revision-2',
    });
    render(
      <MarkdownDocumentEditor
        draftIdentity={{
          userId: 'user-1',
          teamId: 'team-1',
          documentId: 'document-1',
          baseRevisionId: 'revision-1',
        }}
        filename="notes.md"
        initialContent="server"
        onSave={onSave}
        onLoadLatest={onLoadLatest}
        renderPreview={(content) => content}
      />,
    );

    const titleInput = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    const editor = screen.getAllByRole('textbox')[1]!;
    fireEvent.change(editor, { target: { value: 'complete local draft' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('文档已被其他成员更新')).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe('complete local draft');
    expect(screen.getByRole('button', { name: '查看最新版' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制草稿' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续手工合并' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看最新版' }));
    expect(await screen.findByText('latest server content')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制草稿' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('complete local draft'));
    fireEvent.click(screen.getByRole('button', { name: '继续手工合并' }));
    expect(screen.getByText('latest server content')).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(titleInput, { target: { value: 'renamed-only.md' } });
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(editor, { target: { value: 'latest server content\n\nmanually merged local changes' } });
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(
      'latest server content\n\nmanually merged local changes',
      'renamed-only.md',
      'revision-2',
    ));
  });

  test('保存请求期间锁定编辑，避免成功响应覆盖新的未提交输入', async () => {
    let finishSave!: (result: { ok: true; revisionId: string }) => void;
    const onSave = vi.fn().mockReturnValue(new Promise((resolve) => {
      finishSave = resolve;
    }));
    render(
      <MarkdownDocumentEditor
        draftIdentity={{
          userId: 'user-1',
          teamId: 'team-1',
          documentId: 'document-1',
          baseRevisionId: 'revision-1',
        }}
        filename="notes.md"
        initialContent="server"
        onSave={onSave}
        renderPreview={(content) => content}
      />,
    );

    const editor = screen.getAllByRole('textbox')[1] as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'submitted content' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(editor.disabled).toBe(true));

    finishSave({ ok: true, revisionId: 'revision-2' });
    await waitFor(() => expect(editor.disabled).toBe(false));
    expect(editor.value).toBe('submitted content');
  });

  test('派生提示明确原 Run 不变', () => {
    render(
      <MarkdownDocumentEditor
        filename="derived.md"
        initialContent="preview"
        notice="已从 Run Markdown 创建 Channel document；原 Run Artifact 和运行目录保持不变。"
        onSave={async () => {}}
        renderPreview={(content) => content}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain('原 Run Artifact 和运行目录保持不变');
  });

  test('固定内部图片可加载，外部图片默认只显示链接，缺失资源显示明确状态', () => {
    const resolveInternalUrl = (path: string) => `https://server.test${path}?token=test`;
    render(<div>
      <SafeMarkdownResource label="内部图" target="/api/teams/team-1/artifacts/artifact-1/preview" image resolveInternalUrl={resolveInternalUrl} />
      <SafeMarkdownResource label="外部图" target="https://example.com/image.png" image resolveInternalUrl={resolveInternalUrl} />
      <SafeMarkdownResource label="缺失图" target="artifact-missing:docs%2Fmissing.png" image resolveInternalUrl={resolveInternalUrl} />
      <SafeMarkdownResource label="伪固定" target="/api/teams/team-1/artifacts/artifact-1/preview?x=1" image resolveInternalUrl={resolveInternalUrl} />
    </div>);

    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(1);
    expect((images[0] as HTMLImageElement).src).toContain('/api/teams/team-1/artifacts/artifact-1/preview');
    const external = screen.getByRole('link', { name: /外部图片（默认不加载）/ });
    expect((external as HTMLAnchorElement).target).toBe('_blank');
    expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual([
      '资源缺失：docs/missing.png',
      '不安全或未固定的资源：伪固定',
    ]);
  });

  test('收集固定后的 reference-style 资源定义并从正文移除定义行', () => {
    expect(collectSafeMarkdownReferenceDefinitions([
      '![图][chart]',
      '[下载][file]',
      '~~~~ markdown example',
      '[inside]: /api/teams/team-1/artifacts/inside/preview',
      '~~~~',
      '[chart]: /api/teams/team-1/artifacts/image-1/preview',
      '[file]: </api/teams/team-1/artifacts/file-1/download> "文件"',
    ].join('\n'))).toEqual({
      body: '![图][chart]\n[下载][file]\n~~~~ markdown example\n'
        + '[inside]: /api/teams/team-1/artifacts/inside/preview\n~~~~',
      references: new Map([
        ['chart', '/api/teams/team-1/artifacts/image-1/preview'],
        ['file', '/api/teams/team-1/artifacts/file-1/download'],
      ]),
    });
  });

  test('展示历史版本元数据并支持预览、下载、复制式恢复和显式保存发布', async () => {
    const revisions: ChannelDocumentRevisionDto[] = [
      {
        id: 'revision-2',
        documentId: 'document-1',
        revision: 2,
        createdBy: 'user-2',
        createdAt: 200,
        source: 'edit',
        published: true,
        publication: { id: 'publication-2', messageId: 'message-2', publishedBy: 'user-2', publishedAt: 200 },
        artifact: {
          id: 'artifact-2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-2',
          filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 6, createdAt: 200,
        },
      },
      {
        id: 'revision-1',
        documentId: 'document-1',
        revision: 1,
        createdBy: 'user-1',
        createdAt: 100,
        source: 'attachment',
        published: false,
        artifact: {
          id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1',
          filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 5, createdAt: 100,
        },
      },
    ];
    const onPreviewRevision = vi.fn().mockResolvedValue('# historical');
    const onRestoreRevision = vi.fn().mockResolvedValue({
      ok: true,
      snapshot: { content: '# historical', filename: 'notes.md', revisionId: 'revision-3' },
    });
    const onPublish = vi.fn().mockResolvedValue({ ok: true, revisionId: 'revision-4' });
    render(
      <MarkdownDocumentEditor
        draftIdentity={{
          userId: 'user-1', teamId: 'team-1', documentId: 'document-1', baseRevisionId: 'revision-2',
        }}
        filename="notes.md"
        initialContent="# current"
        revisions={revisions}
        onSave={vi.fn()}
        onPublish={onPublish}
        onPreviewRevision={onPreviewRevision}
        onRestoreRevision={onRestoreRevision}
        getRevisionDownloadUrl={(revision) => `/download/${revision.artifact.id}`}
        renderPreview={(content) => content}
      />,
    );

    expect(screen.getByText('版本 2')).toBeTruthy();
    expect(screen.getByText(/user-2/)).toBeTruthy();
    expect(screen.getByText(/编辑/)).toBeTruthy();
    expect(screen.getByText(/已发布/)).toBeTruthy();
    expect(screen.getByText('版本 1')).toBeTruthy();
    expect(screen.getByText(/消息附件/)).toBeTruthy();
    expect(screen.getByText(/未发布/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载版本 1' }).getAttribute('href')).toBe('/download/artifact-1');

    fireEvent.click(screen.getByRole('button', { name: '预览版本 1' }));
    expect(await screen.findByText('# historical')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复版本 1' }));
    await waitFor(() => expect(onRestoreRevision).toHaveBeenCalledWith(
      'revision-1',
      'revision-2',
      expect.stringMatching(/^restore:/),
    ));
    expect((screen.getAllByRole('textbox')[1] as HTMLTextAreaElement).value).toBe('# historical');

    fireEvent.change(screen.getAllByRole('textbox')[1]!, { target: { value: '# publish me' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并分享到频道' }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith(
      '# publish me',
      'notes.md',
      'revision-3',
      expect.stringMatching(/^publish:/),
    ));
  });

  test('归档只读时仍可预览和下载历史，但不提供恢复与发布', () => {
    const revision: ChannelDocumentRevisionDto = {
      id: 'revision-1', documentId: 'document-1', revision: 1, createdBy: 'user-1', createdAt: 100,
      source: 'attachment', published: false,
      artifact: {
        id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1',
        filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 5, createdAt: 100,
      },
    };
    render(
      <MarkdownDocumentEditor
        filename="notes.md"
        initialContent="# current"
        readOnly
        readOnlyReason="频道已归档，只读"
        revisions={[revision]}
        onSave={vi.fn()}
        onPublish={vi.fn()}
        onPreviewRevision={vi.fn()}
        onRestoreRevision={vi.fn()}
        getRevisionDownloadUrl={() => '/download/artifact-1'}
        renderPreview={(content) => content}
      />,
    );

    expect(screen.getByRole('button', { name: '预览版本 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载版本 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '恢复版本 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存并分享到频道' })).toBeNull();
  });

  test('普通保存后仍可显式保存并分享到频道', async () => {
    const onPublish = vi.fn().mockResolvedValue({ ok: true, revisionId: 'revision-2' });
    render(
      <MarkdownDocumentEditor
        draftIdentity={{
          userId: 'user-1', teamId: 'team-1', documentId: 'document-1', baseRevisionId: 'revision-1',
        }}
        filename="notes.md"
        initialContent="# already saved"
        onSave={vi.fn()}
        onPublish={onPublish}
        renderPreview={(content) => content}
      />,
    );

    const publishButton = screen.getByRole('button', { name: '保存并分享到频道' });
    expect((publishButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(publishButton);

    await waitFor(() => expect(onPublish).toHaveBeenCalledWith(
      '# already saved',
      'notes.md',
      'revision-1',
      expect.stringMatching(/^publish:/),
    ));
  });

  test('恢复遇到基线冲突时先展示历史与最新版，再以同一幂等键明确确认', async () => {
    const revisions: ChannelDocumentRevisionDto[] = [
      {
        id: 'revision-2', documentId: 'document-1', revision: 2, createdBy: 'user-2', createdAt: 200,
        source: 'edit', published: false,
        artifact: {
          id: 'artifact-2', teamId: 'team-1', channelId: 'channel-1',
          filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 7, createdAt: 200,
        },
      },
      {
        id: 'revision-1', documentId: 'document-1', revision: 1, createdBy: 'user-1', createdAt: 100,
        source: 'edit', published: false,
        artifact: {
          id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1',
          filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 5, createdAt: 100,
        },
      },
    ];
    const onRestoreRevision = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        conflict: true,
        message: '文档已被其他成员更新',
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { content: '# restored old', filename: 'notes.md', revisionId: 'revision-4' },
      });
    const onLoadLatest = vi.fn().mockResolvedValue({
      content: '# latest server',
      filename: 'notes.md',
      revisionId: 'revision-3',
    });
    render(
      <MarkdownDocumentEditor
        draftIdentity={{
          userId: 'user-1', teamId: 'team-1', documentId: 'document-1', baseRevisionId: 'revision-2',
        }}
        filename="notes.md"
        initialContent="# current"
        revisions={revisions}
        onSave={vi.fn()}
        onPreviewRevision={vi.fn().mockResolvedValue('# old preview')}
        onRestoreRevision={onRestoreRevision}
        onLoadLatest={onLoadLatest}
        renderPreview={(content) => content}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '恢复版本 1' }));
    expect(await screen.findByText('文档已被其他成员更新')).toBeTruthy();
    expect(await screen.findByText('# old preview')).toBeTruthy();
    expect((screen.getAllByRole('textbox')[1] as HTMLTextAreaElement).value).toBe('# current');

    fireEvent.click(screen.getByRole('button', { name: '查看服务器最新版' }));
    expect(await screen.findByText('# latest server')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认恢复版本 1' }));

    await waitFor(() => expect(onRestoreRevision).toHaveBeenCalledTimes(2));
    const firstIdempotencyKey = onRestoreRevision.mock.calls[0]![2];
    expect(onRestoreRevision).toHaveBeenLastCalledWith(
      'revision-1',
      'revision-3',
      firstIdempotencyKey,
    );
    expect((screen.getAllByRole('textbox')[1] as HTMLTextAreaElement).value).toBe('# restored old');
  });
});
