import type { ServerNextUseCases } from '../application/usecases.js';
import type {
  ProjectMutationFailureReason,
  createProjectCollaborationMetrics,
} from '../application/project-collaboration-rollout.js';
import { WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import type { SocketLike } from './socket-handlers.js';

export type ProjectSocketMutationKind = 'overview' | 'artifacts' | 'document-bundles';

export interface ProjectSocketSubscriber {
  readonly socket: SocketLike;
  userId?: string;
  readonly channels?: {
    readonly userId: string;
    readonly teamId: string;
    readonly currentDeviceId?: string | null;
  };
}

export interface ProjectSocketBroadcastPort
  extends Pick<
    ServerNextUseCases,
    'getChannelProjectOverview' | 'listProjectArtifactCollections' | 'listProjectDocumentBundles'
  > {
  resolveSubscriberUserId(subscriber: ProjectSocketSubscriber): Promise<string | null>;
}

export interface ProjectSocketBroadcast {
  handleMutation(
    kind: ProjectSocketMutationKind,
    payload: unknown,
    result: unknown,
  ): Promise<void>;
}

interface ProjectSocketBroadcastOptions {
  readonly metrics?: ReturnType<typeof createProjectCollaborationMetrics>;
}

/**
 * Project mutation 的订阅者投影广播。
 *
 * 每个订阅者都以自己的 Server 身份重新读取投影；mutation 结果不能跨用户复用。
 */
export function createProjectSocketBroadcast(
  subscribers: Iterable<ProjectSocketSubscriber>,
  port: ProjectSocketBroadcastPort,
  options: ProjectSocketBroadcastOptions = {},
): ProjectSocketBroadcast {
  return {
    async handleMutation(kind, payload, result) {
      if (!isSuccessAck(result)) {
        recordProjectSocketMutationFailure(options.metrics, result);
        return;
      }

      const broadcastStartedAt = Date.now();
      const teamId = payloadString(payload, 'teamId');
      const channelId = payloadString(payload, 'channelId');
      if (!teamId || !channelId) return;

      try {
        for (const subscriber of subscribers) {
          if (subscriber.channels?.teamId !== teamId) continue;
          const userId = await port.resolveSubscriberUserId(subscriber);
          if (!userId) continue;
          await emitProjectProjection(kind, subscriber, port, { userId, teamId, channelId });
        }
      } finally {
        options.metrics?.observeEventBroadcastLatency(Date.now() - broadcastStartedAt);
      }
    },
  };
}

/** Project transport 共用的稳定 failure reason 映射。 */
export function recordProjectSocketMutationFailure(
  metrics: ReturnType<typeof createProjectCollaborationMetrics> | undefined,
  result: unknown,
): void {
  const reason = projectMutationFailureReason(result);
  if (reason) metrics?.recordMutationFailure(reason);
}

async function emitProjectProjection(
  kind: ProjectSocketMutationKind,
  subscriber: ProjectSocketSubscriber,
  port: ProjectSocketBroadcastPort,
  input: { userId: string; teamId: string; channelId: string },
): Promise<void> {
  if (kind === 'overview') {
    const overview = await port.getChannelProjectOverview(input);
    if (overview.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.project.updated, {
        channelId: input.channelId,
        overview: overview.overview,
      });
    }
    return;
  }

  if (kind === 'artifacts') {
    const library = await port.listProjectArtifactCollections(input);
    if (library.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.project.artifactsUpdated, {
        channelId: input.channelId,
        library: library.library,
      });
    }
    return;
  }

  const bundles = await port.listProjectDocumentBundles(input);
  if (bundles.ok) {
    subscriber.socket.emit?.(WEB_EVENTS.project.documentBundlesUpdated, {
      channelId: input.channelId,
      bundles: bundles.bundles,
      archived: bundles.archived,
    });
  }
}

function projectMutationFailureReason(result: unknown): ProjectMutationFailureReason | null {
  if (!result || typeof result !== 'object') return 'unknown';
  const failure = result as { error?: unknown; message?: unknown };
  const error = typeof failure.error === 'string' ? failure.error : '';
  const message = typeof failure.message === 'string' ? failure.message.toLowerCase() : '';
  if (message.includes('disabled')) return null;
  if (message.includes('idempotency')) return 'idempotency_conflict';
  if (error === 'CONFLICT' && (message.includes('revision') || message.includes('stale'))) {
    return 'revision_conflict';
  }
  if (message.includes('scope') || message.includes('team and channel')) return 'scope_conflict';
  if (message.includes('archived')) return 'archived';
  if (error === 'FORBIDDEN') return 'permission';
  if (error === 'VALIDATION_ERROR') return 'validation';
  return 'unknown';
}

function payloadString(payload: unknown, key: 'teamId' | 'channelId'): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function isSuccessAck(result: unknown): result is { ok: true } {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
}
