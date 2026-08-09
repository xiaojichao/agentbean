// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

afterEach(cleanup);
import { OutputPackageCard } from '../components/OutputPackageCard';
import { OutputPackageList } from '../components/project/OutputPackageList';
import { outputPackageFromMeta } from '../lib/output-package';

describe('outputPackageFromMeta (#1060)', () => {
  test('parses an output-package system message meta with frozen members', () => {
    const meta = outputPackageFromMeta({
      kind: 'output-package',
      packageId: 'pkg-1',
      taskId: 'task-1',
      taskTitle: '写剧本',
      agentId: 'agent-1',
      agentName: 'Agent-A',
      memberCount: 2,
      members: [
        { shortLabel: 'F1', filename: 'ep1.md', artifactVersionId: 'ver-1', collectionId: 'col-1' },
        { shortLabel: 'F2', filename: 'ep2.md', artifactVersionId: 'ver-2', collectionId: 'col-2' },
      ],
      workspaceRevisionId: 'rev-1',
      publishId: 'pub-1',
      createdAt: 1000,
    });
    expect(meta).not.toBeNull();
    expect(meta?.packageId).toBe('pkg-1');
    expect(meta?.taskTitle).toBe('写剧本');
    expect(meta?.members).toHaveLength(2);
    expect(meta?.members[0]).toEqual({ shortLabel: 'F1', filename: 'ep1.md', artifactVersionId: 'ver-1', collectionId: 'col-1' });
  });

  test('returns null for non-package meta (documents/set and task-status kinds)', () => {
    expect(outputPackageFromMeta({ kind: 'project-document-input-set-result' })).toBeNull();
    expect(outputPackageFromMeta({ kind: 'task-status-updated', status: 'in_review' })).toBeNull();
    expect(outputPackageFromMeta(null)).toBeNull();
    expect(outputPackageFromMeta(undefined)).toBeNull();
  });

  test('drops members without filename and falls back memberCount to parsed members', () => {
    const meta = outputPackageFromMeta({
      kind: 'output-package',
      packageId: 'pkg-1',
      memberCount: 99,
      members: [
        { shortLabel: 'F1', filename: 'a.md', artifactVersionId: 'v1', collectionId: 'c1' },
        { shortLabel: 'F2', filename: '', artifactVersionId: 'v2', collectionId: 'c2' },
      ],
      workspaceRevisionId: 'rev-1',
      publishId: 'pub-1',
    });
    expect(meta?.memberCount).toBe(99); // 快照值优先(与 Server 一致),成员展示只列有效项
    expect(meta?.members).toHaveLength(1);
    expect(meta?.members[0]?.filename).toBe('a.md');
  });
});

describe('OutputPackageCard (#1060)', () => {
  test('renders package title, member short labels and filenames, and agent attribution', () => {
    render(<OutputPackageCard
      packageMeta={{
        kind: 'output-package',
        packageId: 'pkg-1',
        taskTitle: '写剧本',
        agentName: 'Agent-A',
        memberCount: 2,
        members: [
          { shortLabel: 'F1', filename: 'ep1.md', artifactVersionId: 'ver-1', collectionId: 'col-1' },
          { shortLabel: 'F2', filename: 'ep2.md', artifactVersionId: 'ver-2', collectionId: 'col-2' },
        ],
        workspaceRevisionId: 'rev-1',
        publishId: 'pub-1',
      }}
    />);
    expect(screen.getByText('Agent 交付文件包')).not.toBeNull();
    expect(screen.getByText('写剧本')).not.toBeNull();
    expect(screen.getByText('2 个文件')).not.toBeNull();
    expect(screen.getByText('F1')).not.toBeNull();
    expect(screen.getByText('ep1.md')).not.toBeNull();
    expect(screen.getByText('F2')).not.toBeNull();
    expect(screen.getByText('交付 Agent：Agent-A')).not.toBeNull();
  });

  test('renders minimal card without task/agent details', () => {
    render(<OutputPackageCard
      packageMeta={{
        kind: 'output-package',
        packageId: 'pkg-2',
        memberCount: 1,
        members: [{ shortLabel: 'F1', filename: 'out.txt', artifactVersionId: 'ver-1', collectionId: 'col-1' }],
        workspaceRevisionId: 'rev-1',
        publishId: 'pub-1',
      }}
    />);
    expect(screen.getByText('Agent 交付文件包')).not.toBeNull();
    expect(screen.getByText('out.txt')).not.toBeNull();
  });
});

describe('OutputPackageList (#1060)', () => {
  test('shows formed packages and pending deliveries without faking completion', () => {
    render(<OutputPackageList
      packages={[{
        schemaVersion: 1,
        packageId: 'pkg-1',
        teamId: 'team-1',
        channelId: 'ch-1',
        revision: 1,
        deliveryId: 'del-1',
        publishId: 'pub-1',
        workspaceRevisionId: 'rev-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        taskBinding: 'managed',
        taskRevision: 3,
        taskAttempt: 2,
        memberCount: 2,
        reviewState: 'pending',
        status: 'recorded',
        createdAt: 1000,
      }]}
      pendingDeliveries={[{
        publishId: 'pub-2',
        workspaceRevisionId: 'rev-2',
        agentId: 'agent-1',
        taskId: 'task-1',
        taskAttempt: 3,
        committedAt: 1500,
      }]}
    />);
    // 完整交付与「交付处理中」分开呈现,不混同。
    expect(screen.getByText('2 个文件')).not.toBeNull();
    expect(screen.getByText('Task r3 · attempt 2')).not.toBeNull();
    expect(screen.getByText('交付处理中')).not.toBeNull();
  });

  test('shows empty state when nothing formed', () => {
    render(<OutputPackageList packages={[]} pendingDeliveries={[]} />);
    expect(screen.getByText('暂无交付文件包')).not.toBeNull();
  });
});
