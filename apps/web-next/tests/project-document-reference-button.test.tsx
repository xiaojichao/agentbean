// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ProjectDocumentReferenceButton } from '../components/project/ProjectDocumentReferenceButton';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

afterEach(cleanup);

describe('#826 单文档引用', () => {
  test('把当前 revision 作为 OCC fence 加入 composer', () => {
    const onChange = vi.fn();
    render(
      <ProjectDocumentReferenceButton
        documentId="document-1"
        revisionId="revision-3"
        selected={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('引用文档'));

    expect(onChange).toHaveBeenCalledWith({
      kind: 'document',
      documentId: 'document-1',
      expectedRevisionId: 'revision-3',
    });
  });

  test('再次点击移除已选文档，归档时禁止修改', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ProjectDocumentReferenceButton
        documentId="document-1"
        revisionId="revision-3"
        selected
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('已引用'));
    expect(onChange).toHaveBeenCalledWith(null);

    rerender(
      <ProjectDocumentReferenceButton
        documentId="document-1"
        revisionId="revision-3"
        selected={false}
        disabled
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('引用文档'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
