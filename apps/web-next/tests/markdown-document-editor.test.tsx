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
});
