// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ProjectDocumentInputSetResultSummary } from '../components/channel-documents/ProjectDocumentInputSetResultSummary';

describe('ProjectDocumentInputSetResultSummary', () => {
  test('shows per-document outcomes, committed revisions, and a conflict recovery entry', () => {
    render(<ProjectDocumentInputSetResultSummary
      teamId="team-1"
      result={{
        contractVersion: 1,
        inputSetId: 'input-set-1',
        invocationId: 'invocation-1',
        source: { agentId: 'agent-1', workspaceRunId: 'run-1' },
        items: [
          { documentId: 'document-1', baseRevisionId: 'revision-1', status: 'unchanged', createdAt: 1 },
          { documentId: 'document-2', baseRevisionId: 'revision-2', status: 'committed', artifactId: 'artifact-2', revisionId: 'revision-3', createdAt: 1 },
          { documentId: 'document-3', baseRevisionId: 'revision-3', status: 'conflict', artifactId: 'artifact-conflict', error: 'PROJECT_DOCUMENT_RESULT_BASE_REVISION_STALE', createdAt: 1 },
          { documentId: 'document-4', baseRevisionId: 'revision-4', status: 'failed', error: 'AGENT_RESULT_MISSING', createdAt: 1 },
        ],
      }}
    />);

    expect(screen.getByRole('region', { name: '项目文档处理结果' }).textContent).toContain('4 项');
    expect(screen.getByText(/来源 Agent agent-1 · 运行 run-1/)).not.toBeNull();
    expect(screen.getByText('未变化')).not.toBeNull();
    expect(screen.getByText('已提交')).not.toBeNull();
    expect(screen.getByText('新修订')).not.toBeNull();
    expect(screen.getByText('失败')).not.toBeNull();
    expect(screen.getByRole<HTMLAnchorElement>('link', { name: '查看冲突输出' }).href)
      .toContain('/api/teams/team-1/artifacts/artifact-conflict/download');
  });
});
