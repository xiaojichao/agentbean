// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TaskThreadActivitySection } from '../components/TaskSystemActivitySection';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  loadThreadTaskCard: vi.fn(),
  onNotice: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function milestone(taskId: string, summary: string) {
  return {
    projectionId: `projection-${taskId}`,
    eventId: `event-${taskId}`,
    surface: 'thread_card' as const,
    level: 'milestone' as const,
    factKind: 'delivery_accepted',
    taskId,
    summary,
    occurredAt: 10,
    actorKind: 'system' as const,
  };
}

vi.mock('@/lib/system-activity-client', () => ({
  loadThreadTaskCard: mocks.loadThreadTaskCard,
  loadTaskTimeline: vi.fn(),
  loadAttentionInbox: vi.fn(),
  markAttentionSeen: vi.fn(),
  prepareNamedAction: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  systemActivityEvents: () => ({ onNotice: mocks.onNotice }),
  taskEvents: () => ({}),
  taskRemediationEvents: () => ({}),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.onNotice.mockReturnValue(() => {});
});

describe('TaskThreadActivitySection', () => {
  test('Task 关联 Thread 查询并复用现有 thread_card 投影', async () => {
    mocks.loadThreadTaskCard.mockResolvedValue({
      card: {
        taskId: 'task-1',
        currentLevel: 'milestone',
        currentSummary: '交付已进入验收',
        milestones: [{
          projectionId: 'projection-1',
          eventId: 'event-1',
          surface: 'thread_card',
          level: 'milestone',
          factKind: 'delivery_accepted',
          taskId: 'task-1',
          summary: '交付已验收',
          occurredAt: 10,
          actorKind: 'system',
        }],
      },
      projectionNotReady: false,
    });

    render(<TaskThreadActivitySection
      taskId="task-1"
      channelId="channel-1"
      threadId="root-1"
      teamId="team-1"
      userId="user-1"
    />);

    expect(await screen.findByText('交付已进入验收')).toBeTruthy();
    expect(screen.getByText('交付已验收')).toBeTruthy();
    expect(mocks.loadThreadTaskCard).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-1',
      channelId: 'channel-1',
    });
  });

  test('没有里程碑时不渲染空活动卡', async () => {
    mocks.loadThreadTaskCard.mockResolvedValue({
      card: {
        taskId: 'task-1',
        currentLevel: 'info',
        currentSummary: '',
        milestones: [],
      },
      projectionNotReady: false,
    });

    const { container } = render(<TaskThreadActivitySection
      taskId="task-1"
      channelId="channel-1"
      threadId="root-1"
      teamId="team-1"
      userId="user-1"
    />);

    await waitFor(() => expect(mocks.loadThreadTaskCard).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('thread-task-card')).toBeNull();
  });

  test('普通 Thread 不查询也不渲染活动卡', async () => {
    const { container } = render(<TaskThreadActivitySection
      taskId={null}
      channelId="channel-1"
      threadId="root-1"
      teamId="team-1"
      userId="user-1"
    />);

    await waitFor(() => expect(mocks.loadThreadTaskCard).not.toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('thread-task-card')).toBeNull();
  });

  test('切换 Thread 后忽略旧请求的迟到响应并清理旧订阅', async () => {
    const first = deferred<{
      card: { taskId: string; currentLevel: 'milestone'; currentSummary: string; milestones: ReturnType<typeof milestone>[] };
      projectionNotReady: false;
    }>();
    const second = deferred<{
      card: { taskId: string; currentLevel: 'milestone'; currentSummary: string; milestones: ReturnType<typeof milestone>[] };
      projectionNotReady: false;
    }>();
    const firstOff = vi.fn();
    const secondOff = vi.fn();
    mocks.loadThreadTaskCard
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    mocks.onNotice
      .mockReturnValueOnce(firstOff)
      .mockReturnValueOnce(secondOff);

    const { container, rerender, unmount } = render(<TaskThreadActivitySection
      taskId="task-1"
      channelId="channel-1"
      threadId="root-1"
      teamId="team-1"
      userId="user-1"
    />);

    rerender(<TaskThreadActivitySection
      taskId="task-2"
      channelId="channel-1"
      threadId="root-2"
      teamId="team-1"
      userId="user-1"
    />);
    expect(firstOff).toHaveBeenCalledTimes(1);

    await act(async () => {
      second.resolve({
        card: {
          taskId: 'task-2',
          currentLevel: 'milestone',
          currentSummary: '新讨论串里程碑',
          milestones: [milestone('task-2', '新讨论串里程碑')],
        },
        projectionNotReady: false,
      });
    });
    expect((await screen.findAllByText('新讨论串里程碑')).length).toBeGreaterThan(0);

    await act(async () => {
      first.resolve({
        card: {
          taskId: 'task-1',
          currentLevel: 'milestone',
          currentSummary: '旧讨论串里程碑',
          milestones: [milestone('task-1', '旧讨论串里程碑')],
        },
        projectionNotReady: false,
      });
    });
    expect(screen.queryByText('旧讨论串里程碑')).toBeNull();
    expect(screen.getAllByText('新讨论串里程碑').length).toBeGreaterThan(0);

    rerender(<TaskThreadActivitySection
      taskId={null}
      channelId="channel-1"
      threadId="root-3"
      teamId="team-1"
      userId="user-1"
    />);
    expect(secondOff).toHaveBeenCalledTimes(1);
    expect(mocks.loadThreadTaskCard).toHaveBeenCalledTimes(2);
    expect(container.innerHTML).toBe('');

    unmount();
  });
});
