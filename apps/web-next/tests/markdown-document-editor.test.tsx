// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MarkdownDocumentEditor } from '../components/channel-documents/MarkdownDocumentEditor';

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

    fireEvent.change(editor, { target: { value: 'latest server content\n\nmanually merged local changes' } });
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(
      'latest server content\n\nmanually merged local changes',
      'notes.md',
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
});
