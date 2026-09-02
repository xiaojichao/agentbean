import { describe, expect, test } from 'vitest';
import { createChannelProjectWorkspaceRequestFence } from '../lib/channel-project-workspace-request-fence';

describe('createChannelProjectWorkspaceRequestFence', () => {
  test('newer request only supersedes the same projection kind', () => {
    const fence = createChannelProjectWorkspaceRequestFence();
    fence.reset('channel-1');
    const firstProject = fence.begin('project-facts', 'channel-1');
    const artifact = fence.begin('artifact-library', 'channel-1');
    const secondProject = fence.begin('project-facts', 'channel-1');

    expect(fence.isCurrent(firstProject, 'channel-1')).toBe(false);
    expect(fence.isCurrent(secondProject, 'channel-1')).toBe(true);
    expect(fence.isCurrent(artifact, 'channel-1')).toBe(true);
  });

  test('invalidate fences an in-flight request without affecting another kind', () => {
    const fence = createChannelProjectWorkspaceRequestFence();
    fence.reset('channel-1');
    const tasks = fence.begin('tasks', 'channel-1');
    const packages = fence.begin('output-packages', 'channel-1');

    fence.invalidate('tasks');

    expect(fence.isCurrent(tasks, 'channel-1')).toBe(false);
    expect(fence.isCurrent(packages, 'channel-1')).toBe(true);
  });

  test('channel reset invalidates every request while same-channel reset is stable', () => {
    const fence = createChannelProjectWorkspaceRequestFence();
    fence.reset('channel-1');
    const project = fence.begin('project-facts', 'channel-1');
    const tasks = fence.begin('tasks', 'channel-1');

    fence.reset('channel-1');
    expect(fence.isCurrent(project, 'channel-1')).toBe(true);
    expect(fence.isCurrent(tasks, 'channel-1')).toBe(true);

    fence.reset('channel-2');
    expect(fence.isCurrent(project, 'channel-1')).toBe(false);
    expect(fence.isCurrent(tasks, 'channel-1')).toBe(false);
  });

  test('rendered channel guard closes the window before React effects reset the coordinator', () => {
    const fence = createChannelProjectWorkspaceRequestFence();
    fence.reset('channel-1');
    const ticket = fence.begin('document-bundles', 'channel-1');

    expect(fence.isCurrent(ticket, 'channel-2')).toBe(false);
    expect(fence.isCurrent(ticket, null)).toBe(false);
  });

  test('stale-channel begin cannot steal ownership or invalidate current-channel requests', () => {
    const fence = createChannelProjectWorkspaceRequestFence();
    fence.reset('channel-2');
    const currentProject = fence.begin('project-facts', 'channel-2');
    const currentTasks = fence.begin('tasks', 'channel-2');

    const staleTasks = fence.begin('tasks', 'channel-1');

    expect(fence.isCurrent(staleTasks, 'channel-1')).toBe(false);
    expect(fence.isCurrent(currentProject, 'channel-2')).toBe(true);
    expect(fence.isCurrent(currentTasks, 'channel-2')).toBe(true);
  });
});
