import { describe, expect, test } from 'vitest';

import {
  ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1,
  parseChannelCollaborationTaskTriggerV1,
} from '../src/index.js';

describe('channel collaboration task trigger', () => {
  test('accepts the explicit all-channel-agents trigger', () => {
    expect(parseChannelCollaborationTaskTriggerV1(
      ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1,
    )).toEqual(ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1);
  });

  test.each([
    null,
    {},
    { ...ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1, schemaVersion: 2 },
    { ...ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1, audience: 'mentioned-agents' },
    { ...ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1, authority: 'client' },
  ])('rejects invalid or authority-expanding payloads: %j', (value) => {
    expect(() => parseChannelCollaborationTaskTriggerV1(value)).toThrow(
      'CHANNEL_COLLABORATION_TASK_TRIGGER_INVALID',
    );
  });
});
