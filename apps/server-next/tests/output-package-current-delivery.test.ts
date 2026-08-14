import { describe, expect, test } from 'vitest';
import type {
  OutputPackageRecord,
  OutputPackageRepository,
} from '../src/application/output-package-repositories.js';
import { findCurrentManagedOutputPackage } from '../src/application/output-package-current-delivery.js';

function record(index: number, overrides?: Partial<OutputPackageRecord>): OutputPackageRecord {
  return {
    teamId: 'team-1',
    packageId: `package-${index}`,
    channelId: 'channel-1',
    deliveryId: `delivery-${index}`,
    publishId: `publish-${index}`,
    workspaceRevisionId: `workspace-revision-${index}`,
    agentId: 'agent-1',
    taskId: 'task-1',
    taskBinding: 'managed',
    taskRevision: 1,
    taskAttempt: 1,
    memberCount: 1,
    status: 'recorded',
    createdAt: 1_000 - index,
    ...overrides,
  };
}

function repository(records: readonly OutputPackageRecord[]): OutputPackageRepository {
  return {
    async listPackagesByChannel(input) {
      const offset = input.cursor
        ? records.findIndex((candidate) => candidate.packageId === input.cursor!.packageId) + 1
        : 0;
      return records.slice(offset, offset + input.limit);
    },
  } as OutputPackageRepository;
}

describe('findCurrentManagedOutputPackage', () => {
  test('分页越过前 50 条历史包后仍能找到当前 revision/attempt', async () => {
    const records = Array.from({ length: 55 }, (_, index) => record(index, {
      taskRevision: index === 52 ? 3 : 1,
      taskAttempt: index === 52 ? 2 : 1,
      deliveryId: index === 52 ? 'delivery-current' : `delivery-${index}`,
    }));
    await expect(findCurrentManagedOutputPackage(repository(records), {
      teamId: 'team-1',
      channelId: 'channel-1',
      taskId: 'task-1',
      taskRevision: 3,
      taskAttempt: 2,
    })).resolves.toMatchObject({ record: { packageId: 'package-52' }, hasManagedHistory: true });
  });

  test('只有旧受管包时返回 hasManagedHistory，供验收路径 fail closed', async () => {
    await expect(findCurrentManagedOutputPackage(repository([record(1)]), {
      teamId: 'team-1',
      channelId: 'channel-1',
      taskId: 'task-1',
      taskRevision: 2,
      taskAttempt: 1,
    })).resolves.toEqual({ record: null, hasManagedHistory: true });
  });
});
