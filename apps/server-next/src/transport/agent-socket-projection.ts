import { WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import { normalizeAdapterKind } from '../../../../packages/domain/src/index.js';
import type { ServerNextUseCases } from '../application/usecases.js';
import type { SocketLike } from './socket-handlers.js';

export type AgentSocketMutationSource = 'web-command' | 'agent-report';

interface AgentProjectionSubscription {
  readonly userId: string;
  readonly teamId: string;
  readonly currentDeviceId?: string | null;
}

export interface AgentSocketSubscriber {
  readonly socket: SocketLike;
  agents?: AgentProjectionSubscription;
  readonly devices?: AgentProjectionSubscription;
}

export interface AgentSocketProjectionPort extends Pick<
  ServerNextUseCases,
  'listChannels' | 'listVisibleAgents' | 'getDevice'
> {}

export interface AgentSocketProjectionOptions {
  readonly emitMemoryChanged?: (teamId: string) => void;
  readonly refreshChannels?: (teamId: string) => Promise<void>;
  readonly onAgentAvailabilityChanged?: (teamId: string) => Promise<void>;
}

export interface AgentSocketProjection {
  handleMutation(source: AgentSocketMutationSource, payload: unknown, result: unknown): Promise<void>;
  refresh(teamId: string): Promise<void>;
}

interface DiscoveredAgentReport {
  readonly name: string;
  readonly adapterKind: string;
  readonly category: string;
  readonly command?: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly discoverySource?: 'runtime' | 'gateway' | 'filesystem';
  readonly gatewayInstanceKey?: string;
  readonly projectDocumentInputSetVersions?: number[];
}

/** Agent mutation 与显式 refresh 的唯一 Socket snapshot/status 投影 owner。 */
export function createAgentSocketProjection(
  subscribers: Iterable<AgentSocketSubscriber>,
  port: AgentSocketProjectionPort,
  options: AgentSocketProjectionOptions = {},
): AgentSocketProjection {
  const refresh = (teamId: string) => refreshAgentSubscribers(subscribers, port, teamId);

  return {
    async handleMutation(source, payload, result) {
      if (!isSuccessAck(result)) return;

      if (source === 'web-command') {
        const teamIds = uniqueStrings([
          objectString(payload, 'teamId'),
          objectString(payload, 'targetTeamId'),
          ...objectStringArray(payload, 'affectedTeamIds'),
          ...resultAgentVisibleTeamIds(result),
          resultDispatchTeamId(result),
        ]);
        for (const teamId of teamIds) {
          await refresh(teamId);
          options.emitMemoryChanged?.(teamId);
        }
        for (const teamId of uniqueStrings(objectStringArray(payload, 'channelTeamIds'))) {
          await options.refreshChannels?.(teamId);
        }
        return;
      }

      const teamId = objectString(payload, 'teamId') ?? resultDispatchTeamId(result);
      if (!teamId) return;
      const teamIds = uniqueStrings([
        teamId,
        objectString(payload, 'targetTeamId'),
        ...resultAgentVisibleTeamIds(result),
      ]);
      for (const refreshTeamId of teamIds) {
        await refresh(refreshTeamId);
        await options.onAgentAvailabilityChanged?.(refreshTeamId).catch(() => undefined);
      }
      await emitDiscoveredAgents(subscribers, port, payload);
    },
    refresh,
  };
}

async function refreshAgentSubscribers(
  subscribers: Iterable<AgentSocketSubscriber>,
  port: AgentSocketProjectionPort,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    const subscription = subscriber.agents;
    if (subscription?.teamId !== teamId) continue;
    const access = await port.listChannels(subscription);
    if (!access.ok) {
      subscriber.agents = undefined;
      continue;
    }
    const result = await port.listVisibleAgents({ teamId: subscription.teamId });
    if (!result.ok) continue;
    subscriber.socket.emit?.(WEB_EVENTS.agent.snapshot, result.agents);
    for (const agent of result.agents) {
      subscriber.socket.emit?.(WEB_EVENTS.agent.status, agent);
    }
  }
}

async function emitDiscoveredAgents(
  subscribers: Iterable<AgentSocketSubscriber>,
  port: AgentSocketProjectionPort,
  payload: unknown,
): Promise<void> {
  const teamId = objectString(payload, 'teamId');
  const deviceId = objectString(payload, 'deviceId');
  const agents = payloadDiscoveredAgents(payload);
  if (!teamId || !deviceId || agents.length === 0) return;

  for (const subscriber of subscribers) {
    if (subscriber.devices?.teamId !== teamId) continue;
    const result = await port.getDevice({ userId: subscriber.devices.userId, deviceId });
    if (!result.ok) continue;
    const runtimes = result.device.runtimes ?? [];
    const runtimesByAdapter = new Map(
      runtimes.map((runtime) => [normalizeAdapterKind(runtime.adapterKind), runtime]),
    );
    subscriber.socket.emit?.(WEB_EVENTS.agent.discovered, {
      runtimes,
      agents: agents.map((agent) => {
        const adapterKind = normalizeAdapterKind(agent.adapterKind);
        const runtime = runtimesByAdapter.get(adapterKind);
        return {
          name: agent.name,
          adapterKind,
          category: agent.category,
          source: discoveredAgentSource(agent, runtime),
          command: agent.command ?? runtime?.command ?? '',
          args: agent.args,
          cwd: agent.cwd ?? runtime?.cwd,
          projectDocumentInputSetVersions: agent.projectDocumentInputSetVersions,
        };
      }),
    });
  }
}

function payloadDiscoveredAgents(payload: unknown): DiscoveredAgentReport[] {
  if (!payload || typeof payload !== 'object') return [];
  const agents = (payload as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((agent) => {
    if (!agent || typeof agent !== 'object') return [];
    const candidate = agent as Record<string, unknown>;
    if (
      typeof candidate.name !== 'string'
      || typeof candidate.adapterKind !== 'string'
      || typeof candidate.category !== 'string'
    ) return [];
    return [{
      name: candidate.name,
      adapterKind: candidate.adapterKind,
      category: candidate.category,
      command: typeof candidate.command === 'string' ? candidate.command : undefined,
      args: Array.isArray(candidate.args) ? candidate.args.map(String) : undefined,
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : undefined,
      discoverySource: readDiscoverySource(candidate.discoverySource),
      gatewayInstanceKey: typeof candidate.gatewayInstanceKey === 'string'
        ? candidate.gatewayInstanceKey
        : undefined,
      projectDocumentInputSetVersions: Array.isArray(candidate.projectDocumentInputSetVersions)
        ? candidate.projectDocumentInputSetVersions.filter(
            (version): version is number => Number.isInteger(version) && version > 0,
          )
        : undefined,
    }];
  });
}

function discoveredAgentSource(
  agent: DiscoveredAgentReport,
  runtime?: { readonly command?: string; readonly cwd?: string },
): 'runtime' | 'gateway' | 'filesystem' {
  if (agent.discoverySource) return agent.discoverySource;
  if (agent.gatewayInstanceKey) return 'gateway';
  if (!agent.command && !agent.cwd && !agent.args && runtime) return 'runtime';
  return 'filesystem';
}

function readDiscoverySource(value: unknown): DiscoveredAgentReport['discoverySource'] {
  return value === 'runtime' || value === 'gateway' || value === 'filesystem' ? value : undefined;
}

function resultAgentVisibleTeamIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const agent = (result as { agent?: { visibleTeamIds?: unknown } }).agent;
  return Array.isArray(agent?.visibleTeamIds)
    ? uniqueStrings(agent.visibleTeamIds)
    : [];
}

function resultDispatchTeamId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  return objectString((result as { dispatch?: unknown }).dispatch, 'teamId');
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : null;
}

function objectStringArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return Array.from(new Set(values.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )));
}

function isSuccessAck(result: unknown): result is { readonly ok: true } {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
}
