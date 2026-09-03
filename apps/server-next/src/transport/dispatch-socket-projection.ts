import { WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import type { ServerNextUseCases } from '../application/usecases.js';

export type DispatchSocketMutationSource = 'message-send' | 'web-command' | 'agent-report';

interface DispatchProjectionSocket {
  emit?(event: string, payload: unknown): void;
}

interface DispatchSubscription {
  readonly userId: string;
  readonly teamId: string;
  readonly currentDeviceId?: string | null;
}

export interface DispatchSocketSubscriber {
  readonly socket: DispatchProjectionSocket;
  channels?: DispatchSubscription;
  agents?: DispatchSubscription;
  devices?: DispatchSubscription;
}

export interface DispatchSocketProjectionPort extends Pick<
  ServerNextUseCases,
  'listChannels' | 'listDirectMessages' | 'listVisibleAgents'
> {}

export interface DispatchSocketProjection {
  handleMutation(source: DispatchSocketMutationSource, payload: unknown, result: unknown): Promise<void>;
  emitStatus(dispatch: unknown): Promise<void>;
}

interface AuthorizedDispatchSubscriber {
  readonly subscriber: DispatchSocketSubscriber;
  readonly visibleChannelIds: ReadonlySet<string>;
}

/**
 * Dispatch mutation 的唯一 Socket 投影 owner。
 *
 * 已提交结果依次投影 Dispatch 状态、受众可见 Message、Agent snapshot/status，
 * 最后在没有 Task 投影时发送一次 Team Memory invalidation。
 */
export function createDispatchSocketProjection(
  subscribers: Iterable<DispatchSocketSubscriber>,
  port: DispatchSocketProjectionPort,
): DispatchSocketProjection {
  const emitStatus = async (dispatch: unknown): Promise<void> => {
    const teamId = objectString(dispatch, 'teamId');
    if (!teamId) return;
    const audience = await authorizeTeamAudience(subscribers, port, teamId);
    emitStatusToAudience(audience, dispatch);
  };

  return {
    async handleMutation(source, payload, result) {
      if (!isSuccessAck(result)) return;

      const dispatches = resultItems(result, 'dispatch', 'dispatches');
      // message.send 的原消息已由 Message adapter 投影；只有 Agent 回报路径
      // 会把 Dispatch 产生的回复 Message 交给本 module。
      const messages = source === 'agent-report'
        ? resultItems(result, 'message', 'messages')
        : [];
      const teamIds = uniqueStrings([
        objectString(payload, 'teamId'),
        objectString(payload, 'targetTeamId'),
        ...resultAgentVisibleTeamIds(result),
        ...dispatches.map((dispatch) => objectString(dispatch, 'teamId')),
        ...messages.map((message) => objectString(message, 'teamId')),
      ]);
      const audienceByTeam = new Map<string, AuthorizedDispatchSubscriber[]>();
      for (const teamId of teamIds) {
        audienceByTeam.set(teamId, await authorizeTeamAudience(subscribers, port, teamId));
      }

      for (const dispatch of dispatches) {
        const teamId = objectString(dispatch, 'teamId');
        if (teamId) {
          emitStatusToAudience(audienceByTeam.get(teamId) ?? [], dispatch);
        }
      }
      for (const message of messages) {
        const teamId = objectString(message, 'teamId') ?? firstTeamId(dispatches) ?? objectString(payload, 'teamId');
        if (teamId) {
          await emitVisibleMessage(audienceByTeam.get(teamId) ?? [], port, teamId, message);
        }
      }

      for (const teamId of teamIds) {
        const audience = audienceByTeam.get(teamId) ?? [];
        await refreshAgentSubscribers(audience, port, teamId);
        if (!resultHasTaskProjection(result)) {
          emitMemoryChanged(audience, teamId);
        }
      }
    },
    emitStatus,
  };
}

async function authorizeTeamAudience(
  subscribers: Iterable<DispatchSocketSubscriber>,
  port: DispatchSocketProjectionPort,
  teamId: string,
): Promise<AuthorizedDispatchSubscriber[]> {
  const audience: AuthorizedDispatchSubscriber[] = [];
  for (const subscriber of subscribers) {
    const subscription = teamSubscription(subscriber, teamId);
    if (!subscription) continue;
    const access = await port.listChannels(subscription);
    if (!access.ok) {
      clearTeamSubscriptions(subscriber, teamId);
      continue;
    }
    audience.push({
      subscriber,
      visibleChannelIds: new Set(access.channels.map((channel) => channel.id)),
    });
  }
  return audience;
}

function emitStatusToAudience(audience: readonly AuthorizedDispatchSubscriber[], dispatch: unknown): void {
  for (const { subscriber } of audience) {
    subscriber.socket.emit?.(WEB_EVENTS.message.dispatchStatus, dispatch);
  }
}

async function emitVisibleMessage(
  audience: readonly AuthorizedDispatchSubscriber[],
  port: DispatchSocketProjectionPort,
  teamId: string,
  message: unknown,
): Promise<void> {
  const channelId = objectString(message, 'channelId');
  if (!channelId) return;
  for (const { subscriber, visibleChannelIds } of audience) {
    if (subscriber.channels?.teamId !== teamId) continue;
    if (visibleChannelIds.has(channelId)) {
      subscriber.socket.emit?.(WEB_EVENTS.channel.message, message);
      continue;
    }
    const dms = await port.listDirectMessages(subscriber.channels);
    if (dms.ok && dms.dms.some((dm) => dm.channel.id === channelId)) {
      subscriber.socket.emit?.(WEB_EVENTS.channel.message, message);
    }
  }
}

async function refreshAgentSubscribers(
  audience: readonly AuthorizedDispatchSubscriber[],
  port: DispatchSocketProjectionPort,
  teamId: string,
): Promise<void> {
  const eligibleSubscribers = audience
    .map(({ subscriber }) => subscriber)
    .filter((subscriber) => subscriber.agents?.teamId === teamId);
  if (eligibleSubscribers.length === 0) return;

  const result = await port.listVisibleAgents({ teamId });
  if (!result.ok) return;
  for (const subscriber of eligibleSubscribers) {
    subscriber.socket.emit?.(WEB_EVENTS.agent.snapshot, result.agents);
    for (const agent of result.agents) {
      subscriber.socket.emit?.(WEB_EVENTS.agent.status, agent);
    }
  }
}

function emitMemoryChanged(audience: readonly AuthorizedDispatchSubscriber[], teamId: string): void {
  for (const { subscriber } of audience) {
    subscriber.socket.emit?.(WEB_EVENTS.memory.changed, { teamId });
  }
}

function teamSubscription(subscriber: DispatchSocketSubscriber, teamId: string): DispatchSubscription | null {
  if (subscriber.channels?.teamId === teamId) return subscriber.channels;
  if (subscriber.agents?.teamId === teamId) return subscriber.agents;
  if (subscriber.devices?.teamId === teamId) return subscriber.devices;
  return null;
}

function clearTeamSubscriptions(subscriber: DispatchSocketSubscriber, teamId: string): void {
  if (subscriber.channels?.teamId === teamId) subscriber.channels = undefined;
  if (subscriber.agents?.teamId === teamId) subscriber.agents = undefined;
  if (subscriber.devices?.teamId === teamId) subscriber.devices = undefined;
}

function resultItems(result: unknown, singleKey: 'dispatch' | 'message', manyKey: 'dispatches' | 'messages'): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  const items = [
    ...(record[singleKey] ? [record[singleKey]] : []),
    ...(Array.isArray(record[manyKey]) ? record[manyKey] : []),
  ];
  const seenIds = new Set<string>();
  return items.filter((item) => {
    const id = objectString(item, 'id');
    if (!id) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
}

function resultAgentVisibleTeamIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const agent = (result as { agent?: { visibleTeamIds?: unknown } }).agent;
  return Array.isArray(agent?.visibleTeamIds)
    ? uniqueStrings(agent.visibleTeamIds)
    : [];
}

function resultHasTaskProjection(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const record = result as { task?: unknown; tasks?: unknown };
  return Boolean(record.task) || (Array.isArray(record.tasks) && record.tasks.length > 0);
}

function firstTeamId(items: readonly unknown[]): string | null {
  for (const item of items) {
    const teamId = objectString(item, 'teamId');
    if (teamId) return teamId;
  }
  return null;
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' && item.length > 0 ? item : null;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

function isSuccessAck(result: unknown): result is { ok: true } {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
}
