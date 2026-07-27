import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { parseServerNextDevConfig, startServerNextDevServer } from '../src/dev-server.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  createProjectCollaborationMetrics,
  parseProjectCollaborationRolloutConfig,
} from '../src/application/project-collaboration-rollout.js';

describe('project collaboration rollout protection', () => {
  test('defaults every project phase off and enables the ordered stack explicitly', () => {
    expect(parseProjectCollaborationRolloutConfig({})).toEqual({
      projectStage: false,
      reviewFinalization: false,
      bundleSelection: false,
      inputSetOutput: false,
      managerAutoAdvance: false,
    });
    expect(parseProjectCollaborationRolloutConfig({
      AGENTBEAN_PROJECT_STAGE: 'on',
      AGENTBEAN_PROJECT_REVIEW_FINALIZATION: 'on',
      AGENTBEAN_PROJECT_BUNDLE_SELECTION: 'on',
      AGENTBEAN_PROJECT_INPUT_SET_OUTPUT: 'on',
      AGENTBEAN_PROJECT_MANAGER_AUTO_ADVANCE: 'on',
    })).toEqual({
      projectStage: true,
      reviewFinalization: true,
      bundleSelection: true,
      inputSetOutput: true,
      managerAutoAdvance: true,
    });
  });

  test('rejects an enabled phase when its prerequisite phase is disabled', () => {
    expect(() => parseProjectCollaborationRolloutConfig({
      AGENTBEAN_PROJECT_STAGE: 'off',
      AGENTBEAN_PROJECT_REVIEW_FINALIZATION: 'on',
    })).toThrow(
      'AGENTBEAN_PROJECT_REVIEW_FINALIZATION requires AGENTBEAN_PROJECT_STAGE',
    );
  });

  test('rejects an invalid rollout during Server startup config parsing', () => {
    expect(() => parseServerNextDevConfig({
      argv: [],
      env: {
        AGENTBEAN_PROJECT_STAGE: 'on',
        AGENTBEAN_PROJECT_REVIEW_FINALIZATION: 'on',
        AGENTBEAN_PROJECT_BUNDLE_SELECTION: 'off',
        AGENTBEAN_PROJECT_INPUT_SET_OUTPUT: 'on',
      },
    })).toThrow(
      'AGENTBEAN_PROJECT_INPUT_SET_OUTPUT requires AGENTBEAN_PROJECT_BUNDLE_SELECTION',
    );
  });

  test('rejects an invalid programmatic rollout before opening the Server', async () => {
    await expect(startServerNextDevServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        storage: 'memory',
        dataDir: '.agentbean-next-test',
        sessionSecret: 'test-secret',
        projectCollaborationRollout: {
          projectStage: false,
          reviewFinalization: true,
          bundleSelection: false,
          inputSetOutput: false,
          managerAutoAdvance: false,
        },
      },
    })).rejects.toThrow(
      'AGENTBEAN_PROJECT_REVIEW_FINALIZATION requires AGENTBEAN_PROJECT_STAGE',
    );
  });

  test('hides project stages while preserving the existing Channel file read path', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.users.create({
      id: 'owner-1',
      username: 'owner',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1,
      updatedAt: 1,
    });
    await repositories.teams.create({
      id: 'team-1',
      name: 'Team',
      path: 'team',
      visibility: 'private',
      ownerId: 'owner-1',
      createdAt: 1,
    });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'owner-1',
      username: 'owner',
      role: 'owner',
      joinedAt: 1,
    });
    await repositories.channels.create({
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel',
      name: 'Project',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1'],
      agentMemberIds: [],
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      revision: 1,
    });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1 },
      ids: { nextId: () => 'unused' },
      projectCollaborationRollout: parseProjectCollaborationRolloutConfig({}),
    });

    await expect(app.getChannelProjectOverview({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
      message: 'Channel project stages are disabled',
    });
    await expect(app.listChannelFiles({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: true, files: [] });
  });

  test('publishes aggregate operational metrics without sensitive project content', () => {
    const metrics = createProjectCollaborationMetrics();
    metrics.recordMutationFailure('revision_conflict');
    metrics.recordInputSetResult('conflict');
    metrics.recordInputSetFailure('materialization');
    metrics.observeEventBroadcastLatency(42);

    expect(metrics.snapshot()).toEqual({
      mutationFailures: {
        total: 1,
        byReason: { revision_conflict: 1 },
      },
      occConflicts: 2,
      inputSet: {
        failures: 1,
        failuresByReason: { materialization: 1 },
        items: {
          unchanged: 0,
          committed: 0,
          conflict: 1,
          failed: 0,
        },
      },
      eventBroadcastLatencyMs: {
        count: 1,
        total: 42,
        max: 42,
      },
    });
    expect(JSON.stringify(metrics.snapshot())).not.toContain('document.md');
    expect(JSON.stringify(metrics.snapshot())).not.toContain('/Users/');
    expect(JSON.stringify(metrics.snapshot())).not.toContain('Invocation');
  });
});
