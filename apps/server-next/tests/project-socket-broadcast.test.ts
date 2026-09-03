import { describe, expect, test, vi } from 'vitest';
import { makeSuccess, WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import { createProjectCollaborationMetrics } from '../src/application/project-collaboration-rollout.js';
import {
  createProjectSocketBroadcast,
  type ProjectSocketBroadcastPort,
  type ProjectSocketSubscriber,
} from '../src/transport/project-socket-broadcast.js';

describe('ProjectSocketBroadcast', () => {
  test('re-reads overview for each visible subscriber and keeps teams isolated', async () => {
    const first = makeSubscriber('team-1', 'user-1');
    const second = makeSubscriber('team-1', 'user-2');
    const otherTeam = makeSubscriber('team-2', 'user-3');
    const unauthenticated = makeSubscriber('team-1');
    const getChannelProjectOverview = vi.fn(async (input: { userId: string }) =>
      makeSuccess({ overview: { viewerId: input.userId } }));
    const resolveSubscriberUserId = vi.fn(async (subscriber: ProjectSocketSubscriber) =>
      subscriber.userId ?? null);
    const broadcaster = createProjectSocketBroadcast(
      [first.subscriber, second.subscriber, otherTeam.subscriber, unauthenticated.subscriber],
      makePort({ resolveSubscriberUserId, getChannelProjectOverview }),
    );

    await broadcaster.handleMutation(
      'overview',
      { teamId: 'team-1', channelId: 'channel-1' },
      { ok: true },
    );

    expect(resolveSubscriberUserId).toHaveBeenCalledTimes(3);
    expect(getChannelProjectOverview).toHaveBeenCalledTimes(2);
    expect(getChannelProjectOverview).toHaveBeenNthCalledWith(1, {
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
    });
    expect(getChannelProjectOverview).toHaveBeenNthCalledWith(2, {
      userId: 'user-2', teamId: 'team-1', channelId: 'channel-1',
    });
    expect(first.emit).toHaveBeenCalledWith(WEB_EVENTS.project.updated, {
      channelId: 'channel-1', overview: { viewerId: 'user-1' },
    });
    expect(second.emit).toHaveBeenCalledWith(WEB_EVENTS.project.updated, {
      channelId: 'channel-1', overview: { viewerId: 'user-2' },
    });
    expect(otherTeam.emit).not.toHaveBeenCalled();
    expect(unauthenticated.emit).not.toHaveBeenCalled();
  });

  test('maps artifact and document bundle projections to their distinct events', async () => {
    const target = makeSubscriber('team-1', 'user-1');
    const listProjectArtifactCollections = vi.fn(async () =>
      makeSuccess({ library: { collections: ['artifact-1'] } }));
    const listProjectDocumentBundles = vi.fn(async () =>
      makeSuccess({ bundles: [{ id: 'bundle-1' }], archived: [{ id: 'bundle-0' }] }));
    const broadcaster = createProjectSocketBroadcast(
      [target.subscriber],
      makePort({ listProjectArtifactCollections, listProjectDocumentBundles }),
    );
    const payload = { teamId: 'team-1', channelId: 'channel-1' };

    await broadcaster.handleMutation('artifacts', payload, { ok: true });
    await broadcaster.handleMutation('document-bundles', payload, { ok: true });

    expect(target.emit).toHaveBeenNthCalledWith(1, WEB_EVENTS.project.artifactsUpdated, {
      channelId: 'channel-1', library: { collections: ['artifact-1'] },
    });
    expect(target.emit).toHaveBeenNthCalledWith(2, WEB_EVENTS.project.documentBundlesUpdated, {
      channelId: 'channel-1',
      bundles: [{ id: 'bundle-1' }],
      archived: [{ id: 'bundle-0' }],
    });
  });

  test('records stable mutation failure reasons without reading or broadcasting', async () => {
    const target = makeSubscriber('team-1', 'user-1');
    const metrics = createProjectCollaborationMetrics();
    const resolveSubscriberUserId = vi.fn();
    const broadcaster = createProjectSocketBroadcast(
      [target.subscriber],
      makePort({ resolveSubscriberUserId }),
      { metrics },
    );
    const payload = { teamId: 'team-1', channelId: 'channel-1' };

    for (const result of [
      { ok: false, error: 'CONFLICT', message: 'Idempotency key conflict' },
      { ok: false, error: 'CONFLICT', message: 'Stale revision' },
      { ok: false, error: 'CONFLICT', message: 'Team and channel scope mismatch' },
      { ok: false, error: 'CONFLICT', message: 'Project is archived' },
      { ok: false, error: 'FORBIDDEN', message: 'No access' },
      { ok: false, error: 'VALIDATION_ERROR', message: 'Bad input' },
      { ok: false, error: 'INTERNAL_ERROR', message: 'Unexpected' },
      null,
      { ok: false, error: 'NOT_FOUND', message: 'Feature disabled' },
    ]) {
      await broadcaster.handleMutation('overview', payload, result);
    }

    expect(metrics.snapshot().mutationFailures).toEqual({
      total: 8,
      byReason: {
        idempotency_conflict: 1,
        revision_conflict: 1,
        scope_conflict: 1,
        archived: 1,
        permission: 1,
        validation: 1,
        unknown: 2,
      },
    });
    expect(metrics.snapshot().eventBroadcastLatencyMs.count).toBe(0);
    expect(resolveSubscriberUserId).not.toHaveBeenCalled();
    expect(target.emit).not.toHaveBeenCalled();
  });

  test('preserves fail-fast projection errors and observes latency in finally', async () => {
    const first = makeSubscriber('team-1', 'user-1');
    const second = makeSubscriber('team-1', 'user-2');
    const metrics = createProjectCollaborationMetrics();
    const getChannelProjectOverview = vi.fn(async () => {
      throw new Error('projection read failed');
    });
    const broadcaster = createProjectSocketBroadcast(
      [first.subscriber, second.subscriber],
      makePort({ getChannelProjectOverview }),
      { metrics },
    );

    await expect(broadcaster.handleMutation(
      'overview',
      { teamId: 'team-1', channelId: 'channel-1' },
      { ok: true },
    )).rejects.toThrow('projection read failed');

    expect(getChannelProjectOverview).toHaveBeenCalledTimes(1);
    expect(first.emit).not.toHaveBeenCalled();
    expect(second.emit).not.toHaveBeenCalled();
    expect(metrics.snapshot().eventBroadcastLatencyMs.count).toBe(1);
  });

  test('does not observe latency when the mutation payload has no project scope', async () => {
    const metrics = createProjectCollaborationMetrics();
    const resolveSubscriberUserId = vi.fn();
    const broadcaster = createProjectSocketBroadcast(
      [makeSubscriber('team-1', 'user-1').subscriber],
      makePort({ resolveSubscriberUserId }),
      { metrics },
    );

    await broadcaster.handleMutation('overview', { teamId: 'team-1' }, { ok: true });

    expect(resolveSubscriberUserId).not.toHaveBeenCalled();
    expect(metrics.snapshot().eventBroadcastLatencyMs.count).toBe(0);
  });
});

function makeSubscriber(teamId: string, userId?: string) {
  const emit = vi.fn();
  return {
    emit,
    subscriber: {
      socket: { on: vi.fn(), emit },
      userId,
      channels: { userId: userId ?? 'pending-user', teamId },
    } satisfies ProjectSocketSubscriber,
  };
}

function makePort(overrides: Record<string, unknown> = {}): ProjectSocketBroadcastPort {
  return {
    resolveSubscriberUserId: vi.fn(async (subscriber: ProjectSocketSubscriber) => subscriber.userId ?? null),
    getChannelProjectOverview: vi.fn(async () => makeSuccess({ overview: {} })),
    listProjectArtifactCollections: vi.fn(async () => makeSuccess({ library: {} })),
    listProjectDocumentBundles: vi.fn(async () => makeSuccess({ bundles: [], archived: [] })),
    ...overrides,
  } as unknown as ProjectSocketBroadcastPort;
}
