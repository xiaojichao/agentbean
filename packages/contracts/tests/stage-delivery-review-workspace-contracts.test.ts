import { describe, expect, test } from 'vitest';

import {
  parseQueryStageDeliveryReviewWorkspaceInputV1,
  STAGE_DELIVERY_REVIEW_WORKSPACE_SCHEMA_VERSION,
} from '../src/stage-delivery-review-workspace.js';

describe('阶段交付审核工作区合同', () => {
  test('接受带最低一致性与显式版本选择的 V1 查询', () => {
    const input = parseQueryStageDeliveryReviewWorkspaceInputV1({
      schemaVersion: STAGE_DELIVERY_REVIEW_WORKSPACE_SCHEMA_VERSION,
      channelId: 'channel-1',
      stageId: 'stage-1',
      taskId: 'task-1',
      minimumConsistency: {
        schemaVersion: 1,
        entries: [{ streamKind: 'output-package', streamId: 'channel-1', revision: 3 }],
      },
      specifiedProjection: {
        packageId: 'package-1',
        versions: [{ collectionId: 'collection-1', versionId: 'version-2' }],
      },
    });

    expect(input.stageId).toBe('stage-1');
    expect(input.specifiedProjection?.versions[0]?.versionId).toBe('version-2');
  });

  test.each([
    { channelId: 'channel-1', stageId: 'stage-1', taskId: 'task-1' },
    { schemaVersion: 2, channelId: 'channel-1', stageId: 'stage-1', taskId: 'task-1' },
    { schemaVersion: 1, channelId: 'channel-1', stageId: '', taskId: 'task-1' },
    { schemaVersion: 1, channelId: 'channel-1', stageId: 'stage-1', taskId: 'task-1', extra: true },
    {
      schemaVersion: 1,
      channelId: 'channel-1',
      stageId: 'stage-1',
      taskId: 'task-1',
      specifiedProjection: { packageId: 'package-1', versions: [{ collectionId: 'collection-1' }] },
    },
  ])('拒绝缺字段、未知字段和不完整稳定身份 %#', (input) => {
    expect(() => parseQueryStageDeliveryReviewWorkspaceInputV1(input)).toThrow(
      'STAGE_DELIVERY_REVIEW_WORKSPACE_PAYLOAD_INVALID',
    );
  });
});
