// @vitest-environment jsdom

import { createRequire } from 'node:module';
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { WEB_EVENTS, type ChannelProjectOverviewDto } from '@agentbean/contracts';

import {
  ChannelProjectOverview,
  type InitialProjectStageDraft,
  type ProjectStageDraft,
} from '../components/ChannelProjectOverview';
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

describe('频道项目页面到 SQLite', () => {
  test('从页面提交首个 Stage，经 authenticated Socket 写入并回显聚合总览', async () => {
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
      title: '完成发布方案',
      status: 'todo',
      creatorId: 'owner-1',
      assigneeId: 'owner-1',
      tags: [],
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
    await repositories.tasks.create({
      id: 'task-2',
      teamId: 'team-1',
      channelId: 'channel-1',
      title: '完成分镜',
      status: 'todo',
      creatorId: 'owner-1',
      assigneeId: 'owner-1',
      tags: [],
      sortOrder: 2,
      createdAt: now,
      updatedAt: now,
    });

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

    function ChannelTaskPage() {
      const [overview, setOverview] = useState<ChannelProjectOverviewDto | null>(null);
      const onCreate = async (draft: InitialProjectStageDraft) => {
        const result = await socket.trigger(WEB_EVENTS.project.createInitialStage, {
          channelId: 'channel-1',
          expectedRevision: 0,
          idempotencyKey: 'page-stage-1',
          ...draft,
        }) as { ok: boolean; overview?: ChannelProjectOverviewDto; message?: string };
        if (!result.ok || !result.overview) return result.message ?? '创建失败';
        setOverview(result.overview);
        return null;
      };
      const onCreateStage = async (draft: ProjectStageDraft) => {
        if (!overview) return '缺少项目画像';
        const result = await socket.trigger(WEB_EVENTS.project.createStage, {
          channelId: 'channel-1',
          expectedRevision: overview.profile.revision,
          idempotencyKey: 'page-stage-2',
          stage: draft,
        }) as { ok: boolean; overview?: ChannelProjectOverviewDto; message?: string };
        if (!result.ok || !result.overview) return result.message ?? '创建失败';
        setOverview(result.overview);
        return null;
      };
      return (
        <ChannelProjectOverview
          overview={overview}
          tasks={[
            { id: 'task-1', title: '完成发布方案' },
            { id: 'task-2', title: '完成分镜' },
          ]}
          participants={[
            { id: 'owner-1', name: '项目负责人', kind: 'human' },
            { id: 'reviewer-1', name: '审核人', kind: 'human' },
          ]}
          currentUserId="owner-1"
          onCreate={onCreate}
          onCreateStage={onCreateStage}
        />
      );
    }

    render(<ChannelTaskPage />);
    fireEvent.click(screen.getByRole('button', { name: '创建首个项目阶段' }));
    fireEvent.change(screen.getByLabelText('阶段名称'), { target: { value: '发布准备' } });
    fireEvent.change(screen.getByLabelText('阶段目标'), { target: { value: '形成可审核发布方案' } });
    fireEvent.change(screen.getByLabelText('验收标准（每行一条）'), { target: { value: '发布步骤完整' } });
    fireEvent.click(screen.getByRole('button', { name: '创建项目阶段' }));

    expect(await screen.findByText('形成可审核发布方案')).toBeTruthy();
    expect(screen.getByText('待开始')).toBeTruthy();
    await waitFor(async () => {
      await expect(repositories.channelProjects.getProfile({
        teamId: 'team-1',
        channelId: 'channel-1',
      })).resolves.toMatchObject({ projectLeadId: 'owner-1', revision: 1 });
      await expect(repositories.channelProjects.listStages({
        teamId: 'team-1',
        channelId: 'channel-1',
      })).resolves.toEqual([
        expect.objectContaining({ taskId: 'task-1', name: '发布准备' }),
      ]);
    });

    fireEvent.click(screen.getByRole('button', { name: '添加阶段' }));
    fireEvent.change(screen.getByLabelText('阶段名称'), { target: { value: '分镜' } });
    fireEvent.change(screen.getByLabelText('阶段目标'), { target: { value: '完成分镜稿' } });
    fireEvent.change(screen.getByLabelText('绑定任务'), { target: { value: 'task-2' } });
    fireEvent.change(screen.getByLabelText('验收标准（每行一条）'), { target: { value: '分镜完整' } });
    fireEvent.click(screen.getByRole('button', { name: '创建阶段' }));

    expect(await screen.findByText('完成分镜稿')).toBeTruthy();
    await waitFor(async () => {
      await expect(repositories.channelProjects.getProfile({
        teamId: 'team-1',
        channelId: 'channel-1',
      })).resolves.toMatchObject({ revision: 2 });
      await expect(repositories.channelProjects.listStages({
        teamId: 'team-1',
        channelId: 'channel-1',
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: 'task-1', name: '发布准备' }),
        expect.objectContaining({ taskId: 'task-2', name: '分镜' }),
      ]));
    });
  });
});

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
