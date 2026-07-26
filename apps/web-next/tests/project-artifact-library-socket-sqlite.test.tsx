// @vitest-environment jsdom

import { createRequire } from 'node:module';
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { WEB_EVENTS, type ChannelProjectOverviewDto, type ProjectArtifactLibraryDto } from '@agentbean/contracts';

import { ProjectArtifactLibrary, type PromoteArtifactDraft } from '../components/ProjectArtifactLibrary';
import { createServerNextUseCases } from '../../server-next/src/application/usecases';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../../server-next/src/infra/sqlite/repositories';
import {
  registerWebSocketHandlers,
  type SocketHandler,
  type SocketLike,
} from '../../server-next/src/transport/socket-handlers';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;
const databases: DatabaseWithClose[] = [];

afterEach(() => {
  cleanup();
  while (databases.length > 0) databases.pop()?.close();
});

describe('频道文件库逻辑产物视图到 SQLite', () => {
  test('从文件库提升可见 Artifact，经 authenticated Socket 写入并回显当前版、来源与 lineage', async () => {
    const harness = await createHarness();

    render(<ArtifactLibraryPage harness={harness} />);
    fireEvent.click(screen.getByRole('button', { name: '提升为逻辑产物版本' }));
    fireEvent.change(screen.getByLabelText('逻辑产物名称'), { target: { value: '分镜脚本' } });
    fireEvent.change(screen.getByLabelText('逻辑产物类型'), { target: { value: 'storyboard' } });
    fireEvent.click(screen.getByRole('button', { name: '提升为版本' }));

    expect(await screen.findByText('分镜脚本')).toBeTruthy();
    expect(screen.getByText('当前版')).toBeTruthy();
    expect(screen.getByText('类型：storyboard')).toBeTruthy();
    // 来源事实来自 Server 投影：所属 Stage、Task revision 与来源消息。
    expect(screen.getAllByText('message-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/revision 1/).length).toBeGreaterThan(0);

    await waitFor(async () => {
      await expect(harness.repositories.channelProjects.listArtifactCollections({
        teamId: 'team-1',
        channelId: 'channel-1',
      })).resolves.toEqual([
        expect.objectContaining({ name: '分镜脚本', kind: 'storyboard', revision: 1, versionCount: 1 }),
      ]);
      await expect(harness.repositories.channelProjects.listArtifactVersions({
        teamId: 'team-1',
        channelId: 'channel-1',
      })).resolves.toEqual([
        expect.objectContaining({
          versionNumber: 1,
          artifactId: 'artifact-1',
          sourceMessageId: 'message-1',
          taskRevision: 1,
        }),
      ]);
    });

    // 追加第二版：页面选择既有集合，Server 前移 current 指针并记录 lineage。
    fireEvent.click(screen.getByRole('button', { name: '提升为逻辑产物版本' }));
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { value: 'artifact-2' } });
    fireEvent.change(screen.getByLabelText('目标产物集合'), { target: { value: collectionIdFromDom() } });
    fireEvent.click(screen.getByRole('button', { name: '提升为版本' }));

    await waitFor(() => {
      expect(screen.getByText('共 2 版')).toBeTruthy();
    });
    const currentVersion = document.querySelector('[data-smoke="project-artifact-current-version"]');
    expect(currentVersion?.textContent).toContain('v2');
    expect(document.querySelector('[data-smoke="project-artifact-lineage"]')?.textContent).toContain('版本:');
  });

  test('归档频道展示逻辑产物只读投影，不提供提升入口', async () => {
    const harness = await createHarness();
    const promoted = await harness.socket.trigger(WEB_EVENTS.project.promoteArtifact, {
      channelId: 'channel-1',
      idempotencyKey: 'promote-archived-1',
      artifactId: 'artifact-1',
      stageId: harness.stageId,
      collection: { name: '分镜脚本', kind: 'storyboard' },
    }) as { ok: boolean; library?: ProjectArtifactLibraryDto };
    expect(promoted.ok).toBe(true);
    await harness.repositories.channels.archive({ channelId: 'channel-1', timestamp: 900 });

    const library = await harness.socket.trigger(WEB_EVENTS.project.artifactCollections, {
      channelId: 'channel-1',
    }) as { ok: boolean; library?: ProjectArtifactLibraryDto };
    expect(library).toMatchObject({ ok: true, library: { archived: true } });

    render(
      <ProjectArtifactLibrary
        library={library.library ?? null}
        stages={[{ id: harness.stageId, name: '分镜' }]}
        promotableArtifacts={[{ id: 'artifact-2', filename: 'artifact-2.md' }]}
        canPromote
        onPromote={async () => '不应被调用'}
      />,
    );
    expect(screen.getByText('已归档 · 只读')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '提升为逻辑产物版本' })).toBeNull();
    expect(screen.getByText('分镜脚本')).toBeTruthy();

    // 归档后 Socket 写入被拒绝，集合与版本保持不变。
    await expect(harness.socket.trigger(WEB_EVENTS.project.promoteArtifact, {
      channelId: 'channel-1',
      idempotencyKey: 'promote-archived-2',
      artifactId: 'artifact-2',
      stageId: harness.stageId,
      collection: { name: '服装设定', kind: 'costume' },
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(harness.repositories.channelProjects.listArtifactCollections({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toHaveLength(1);
  });
});

function collectionIdFromDom(): string {
  const node = document.querySelector('[data-smoke="project-artifact-collection"]');
  const collectionId = node?.getAttribute('data-collection-id');
  if (!collectionId) throw new Error('Expected a rendered logical artifact collection');
  return collectionId;
}

function ArtifactLibraryPage({ harness }: { harness: Harness }) {
  const [library, setLibrary] = useState<ProjectArtifactLibraryDto | null>(null);
  const onPromote = async (draft: PromoteArtifactDraft) => {
    const result = await harness.socket.trigger(WEB_EVENTS.project.promoteArtifact, {
      channelId: 'channel-1',
      idempotencyKey: `promote-${draft.artifactId}`,
      ...draft,
    }) as { ok: boolean; library?: ProjectArtifactLibraryDto; message?: string };
    if (!result.ok || !result.library) return result.message ?? '提升失败';
    setLibrary(result.library);
    return null;
  };
  return (
    <ProjectArtifactLibrary
      library={library}
      stages={[{ id: harness.stageId, name: '分镜' }]}
      promotableArtifacts={[
        { id: 'artifact-1', filename: 'artifact-1.md' },
        { id: 'artifact-2', filename: 'artifact-2.md' },
      ]}
      canPromote
      onPromote={onPromote}
    />
  );
}

interface Harness {
  repositories: ReturnType<typeof createSqliteRepositories>;
  socket: FakeSocket;
  stageId: string;
}

async function createHarness(): Promise<Harness> {
  const globalDb = new Database(':memory:');
  const teamDb = new Database(':memory:');
  databases.push(globalDb, teamDb);
  globalDb.exec('PRAGMA foreign_keys = ON;');
  teamDb.exec('PRAGMA foreign_keys = ON;');
  applyGlobalMigrations(globalDb);
  applyTeamMigrations(teamDb);
  const repositories = createSqliteRepositories({ globalDb, teamDb });
  let now = 100;
  let id = 0;

  await repositories.users.create({
    id: 'owner-1',
    username: 'owner',
    passwordHash: 'hash',
    role: 'user',
    createdAt: now,
    updatedAt: now,
  });
  await repositories.users.create({
    id: 'reviewer-1',
    username: 'reviewer',
    passwordHash: 'hash',
    role: 'user',
    createdAt: now,
    updatedAt: now,
  });
  await repositories.teams.create({
    id: 'team-1',
    name: '项目团队',
    path: 'project-team',
    visibility: 'private',
    ownerId: 'owner-1',
    createdAt: now,
  });
  await repositories.teams.addMember({
    teamId: 'team-1',
    userId: 'owner-1',
    username: 'owner',
    role: 'owner',
    joinedAt: now,
  });
  await repositories.teams.addMember({
    teamId: 'team-1',
    userId: 'reviewer-1',
    username: 'reviewer',
    role: 'member',
    joinedAt: now,
  });
  await repositories.channels.create({
    id: 'channel-1',
    teamId: 'team-1',
    kind: 'channel',
    name: 'launch',
    visibility: 'private',
    createdBy: 'owner-1',
    humanMemberIds: ['owner-1', 'reviewer-1'],
    agentMemberIds: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    revision: 1,
  });
  await repositories.tasks.create({
    id: 'task-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    title: '完成分镜脚本',
    status: 'todo',
    creatorId: 'owner-1',
    assigneeId: 'owner-1',
    tags: [],
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  });
  await repositories.messages.append({
    id: 'message-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    senderKind: 'human',
    senderId: 'owner-1',
    body: '交付分镜',
    createdAt: now,
  });
  for (const artifactId of ['artifact-1', 'artifact-2']) {
    await repositories.artifacts.create({
      id: artifactId,
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      uploaderId: 'owner-1',
      filename: `${artifactId}.md`,
      mimeType: 'text/markdown',
      sizeBytes: 128,
      relativePath: `deliverables/${artifactId}.md`,
      pathKind: 'upload',
      role: 'attachment',
      createdAt: now,
    });
  }

  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => ++now },
    ids: { nextId: () => `project-id-${++id}` },
    messageIngestionMode: 'legacy',
  });
  const socket = new FakeSocket();
  registerWebSocketHandlers(socket, app, {
    authenticatedUser: async () => ({
      hasToken: true,
      userId: 'owner-1',
      currentTeamId: 'team-1',
      currentDeviceId: null,
    }),
  });
  const stage = await socket.trigger(WEB_EVENTS.project.createInitialStage, {
    channelId: 'channel-1',
    expectedRevision: 0,
    idempotencyKey: 'initial-stage-1',
    projectLeadId: 'owner-1',
    defaultReviewerIds: ['reviewer-1'],
    stage: {
      name: '分镜',
      goal: '形成可审核分镜',
      ownerId: 'owner-1',
      reviewerIds: ['reviewer-1'],
      acceptanceCriteria: ['镜头完整'],
      taskId: 'task-1',
    },
  }) as { ok: boolean; overview?: ChannelProjectOverviewDto };
  const stageId = stage.overview?.stages[0]?.id;
  if (!stage.ok || !stageId) throw new Error('Failed to seed the project stage');
  return { repositories, socket, stageId };
}

class FakeSocket implements SocketLike {
  private readonly handlers = new Map<string, SocketHandler>();

  on(event: string, handler: SocketHandler): void {
    this.handlers.set(event, handler);
  }

  async trigger(event: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler for ${event}`);
    let result: unknown;
    await handler(payload, (ack) => {
      result = ack;
    });
    return result;
  }
}
