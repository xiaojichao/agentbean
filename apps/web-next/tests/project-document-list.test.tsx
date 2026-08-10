// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProjectDocumentList } from '../components/channel-documents/ProjectDocumentList';
import type { ChannelDocumentDto, ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

afterEach(cleanup);

const document: ChannelDocumentDto = {
  id: 'document-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  filename: '独立文档.md',
  currentRevisionId: 'revision-2',
  currentRevision: {
    id: 'revision-2',
    documentId: 'document-1',
    revision: 2,
    artifact: {
      id: 'artifact-2',
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: '独立文档.md',
      mimeType: 'text/markdown',
      sizeBytes: 12,
      createdAt: 200,
    },
    createdBy: 'user-1',
    createdAt: 200,
    source: 'edit',
    published: false,
  },
  createdAt: 100,
  updatedAt: 200,
};

describe('ProjectDocumentList', () => {
  test('展示 current revision，并以 documentId + expectedRevisionId 建立稳定引用', () => {
    const changes: Array<{ selection: ProjectReferenceSelectionRequestDto | null; documentId: string }> = [];
    const onOpenDocument = vi.fn();
    render(<ProjectDocumentList
      documents={[document]}
      archived={false}
      onOpenDocument={onOpenDocument}
      onSelectionChange={(selection, documentId) => changes.push({ selection, documentId })}
    />);

    expect(screen.getByText('独立文档.md')).toBeTruthy();
    expect(screen.getByText(/document: document-1 · 当前版本 v2 · 人工编辑/)).toBeTruthy();
    fireEvent.click(screen.getByText('独立文档.md'));
    expect(onOpenDocument).toHaveBeenCalledWith('document-1');

    fireEvent.click(screen.getByText('引用文档'));
    expect(changes).toEqual([{
      documentId: 'document-1',
      selection: { kind: 'document', documentId: 'document-1', expectedRevisionId: 'revision-2' },
    }]);
  });
});
