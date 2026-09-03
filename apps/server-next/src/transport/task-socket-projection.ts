import { WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import type { ServerNextUseCases } from '../application/usecases.js';
import type { SocketLike } from './socket-handlers.js';

interface TaskSubscription {
  readonly userId: string;
  readonly teamId: string;
  readonly currentDeviceId?: string | null;
}

export interface TaskSocketSubscriber {
  readonly socket: SocketLike;
  readonly channels?: TaskSubscription;
  readonly agents?: TaskSubscription;
  readonly devices?: TaskSubscription;
}

export interface TaskSocketProjectionPort extends Pick<ServerNextUseCases, 'listTasks'> {}

export interface TaskSocketProjection {
  handleMutation(result: unknown): Promise<void>;
}

/**
 * Task mutation 的唯一 Socket 投影 owner。
 *
 * 同一 mutation 先按 Task identity 去重，再按 Team 聚合：每个 Task 发送一次增量，
 * 每个 Team 只重读一次 snapshot 并发送一次 Memory invalidation。
 */
export function createTaskSocketProjection(
  subscribers: Iterable<TaskSocketSubscriber>,
  port: TaskSocketProjectionPort,
): TaskSocketProjection {
  return {
    async handleMutation(result) {
      if (!isSuccessAck(result)) return;

      const tasksByTeam = groupTasksByTeam(resultTasks(result));
      for (const [teamId, tasks] of tasksByTeam) {
        for (const task of tasks) {
          emitTaskUpdated(subscribers, teamId, task);
        }
        await refreshTaskSubscribers(subscribers, port, teamId);
        emitMemoryChanged(subscribers, teamId);
      }
    },
  };
}

function groupTasksByTeam(tasks: readonly unknown[]): Map<string, unknown[]> {
  const tasksByTeam = new Map<string, unknown[]>();
  const seenTaskIds = new Set<string>();

  for (const task of tasks) {
    const teamId = taskString(task, 'teamId');
    if (!teamId) continue;
    const taskId = taskString(task, 'id');
    if (taskId && seenTaskIds.has(taskId)) continue;
    if (taskId) seenTaskIds.add(taskId);
    const teamTasks = tasksByTeam.get(teamId) ?? [];
    teamTasks.push(task);
    tasksByTeam.set(teamId, teamTasks);
  }

  return tasksByTeam;
}

function emitTaskUpdated(
  subscribers: Iterable<TaskSocketSubscriber>,
  teamId: string,
  task: unknown,
): void {
  for (const subscriber of subscribers) {
    if (subscriberBelongsToTeam(subscriber, teamId)) {
      subscriber.socket.emit?.(WEB_EVENTS.task.updated, task);
    }
  }
}

async function refreshTaskSubscribers(
  subscribers: Iterable<TaskSocketSubscriber>,
  port: TaskSocketProjectionPort,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.channels?.teamId !== teamId) continue;
    const result = await port.listTasks(subscriber.channels);
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.task.snapshot, result.tasks);
    }
  }
}

function emitMemoryChanged(subscribers: Iterable<TaskSocketSubscriber>, teamId: string): void {
  for (const subscriber of subscribers) {
    if (subscriberBelongsToTeam(subscriber, teamId)) {
      subscriber.socket.emit?.(WEB_EVENTS.memory.changed, { teamId });
    }
  }
}

function subscriberBelongsToTeam(subscriber: TaskSocketSubscriber, teamId: string): boolean {
  return subscriber.channels?.teamId === teamId
    || subscriber.agents?.teamId === teamId
    || subscriber.devices?.teamId === teamId;
}

function resultTasks(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const single = (result as { task?: unknown }).task;
  const many = (result as { tasks?: unknown }).tasks;
  return [
    ...(single ? [single] : []),
    ...(Array.isArray(many) ? many : []),
  ];
}

function taskString(task: unknown, key: 'id' | 'teamId'): string | null {
  if (!task || typeof task !== 'object') return null;
  const value = (task as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function isSuccessAck(result: unknown): result is { ok: true } {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
}
