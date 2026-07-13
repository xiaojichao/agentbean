import type { ManagementRunV2Dto } from '../../src/index.js';

const invalidPhase2Run: ManagementRunV2Dto = {
  schemaVersion: 2,
  managementPhase: 2,
  id: 'run-2',
  teamId: 'team-1',
  channelId: 'channel-1',
  rootMessageId: 'message-1',
  mode: 'managed',
  status: 'queued',
  placementPolicy: { placement: 'managed', allowServerContext: true, requireLocalModelCredentials: false },
  checkpointRevision: 0,
  budget: { maxSubtasks: 8, maxDepth: 2, maxExternalInvocations: 8 },
  createdAt: 1,
  updatedAt: 1,
};

void invalidPhase2Run;
