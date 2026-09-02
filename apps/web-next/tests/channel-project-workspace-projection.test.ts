import { describe, expect, test } from 'vitest';
import {
  reduceChannelProjectWorkspaceProjection,
  type ChannelProjectTask,
} from '../lib/channel-project-workspace-projection';

const activeContext = {
  channelId: 'channel-1',
  projectFactsActive: true,
  fileFactsActive: true,
};

describe('reduceChannelProjectWorkspaceProjection', () => {
  test('task event applies the Server task and invalidates every active dependent projection', () => {
    const task = taskFixture('channel-1');

    expect(reduceChannelProjectWorkspaceProjection(
      { kind: 'task-updated', task },
      activeContext,
    )).toEqual({
      apply: [{ kind: 'task', task }],
      invalidateRequests: [],
      refresh: ['tasks', 'project-facts', 'output-packages'],
    });
  });

  test('task event ignores another channel and honors inactive expensive projections', () => {
    expect(reduceChannelProjectWorkspaceProjection(
      { kind: 'task-updated', task: taskFixture('channel-other') },
      activeContext,
    )).toEqual({ apply: [], invalidateRequests: [], refresh: [] });

    const task = taskFixture('channel-1');
    expect(reduceChannelProjectWorkspaceProjection(
      { kind: 'task-updated', task },
      { ...activeContext, projectFactsActive: false, fileFactsActive: false },
    )).toEqual({
      apply: [{ kind: 'task', task }],
      invalidateRequests: [],
      refresh: ['tasks'],
    });
  });

  test('project and artifact events preserve their cross-surface invalidation matrix', () => {
    const overview = { profile: { channelId: 'channel-1' } } as never;
    expect(reduceChannelProjectWorkspaceProjection(
      { kind: 'project-updated', overview },
      activeContext,
    )).toEqual({
      apply: [{ kind: 'overview', overview }],
      invalidateRequests: [],
      refresh: ['tasks'],
    });

    const library = { channelId: 'channel-1', collections: [] } as never;
    expect(reduceChannelProjectWorkspaceProjection(
      { kind: 'artifacts-updated', library },
      activeContext,
    )).toEqual({
      apply: [{ kind: 'artifact-library', library }],
      invalidateRequests: ['artifact-library'],
      refresh: ['output-packages', 'tasks'],
    });
    expect(reduceChannelProjectWorkspaceProjection(
      { kind: 'artifacts-updated', library },
      { ...activeContext, fileFactsActive: false },
    ).refresh).toEqual(['tasks']);
  });

  test('document bundle event fences the in-flight read without unrelated refreshes', () => {
    const bundles = [{ id: 'bundle-1' }] as never;
    expect(reduceChannelProjectWorkspaceProjection(
      { kind: 'document-bundles-updated', bundles },
      activeContext,
    )).toEqual({
      apply: [{ kind: 'document-bundles', bundles }],
      invalidateRequests: ['document-bundles'],
      refresh: [],
    });
  });
});

function taskFixture(channelId: string): ChannelProjectTask {
  return {
    id: `task-${channelId}`,
    title: 'Task',
    description: null,
    status: 'pending',
    creatorId: 'user-1',
    assigneeId: null,
    channelId,
    tags: [],
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}
