import { describe, expect, test } from 'vitest';

import {
  compareChannelFileSnapshots,
  createChannelFileMetrics,
  parseChannelFileRolloutConfig,
} from '../src/application/channel-file-rollout.js';

describe('channel file rollout protection', () => {
  test('defaults to the existing read path and keeps risky writes disabled', () => {
    expect(parseChannelFileRolloutConfig({})).toEqual({
      fileBrowser: true,
      streaming: false,
      previewWorker: true,
      markdownEditing: false,
      historyBackfill: false,
      indexShadowCompare: false,
    });
  });

  test('parses each rollout switch independently and rejects invalid values', () => {
    expect(parseChannelFileRolloutConfig({
      AGENTBEAN_CHANNEL_FILES_BROWSER: 'off',
      AGENTBEAN_CHANNEL_FILES_STREAMING: '1',
      AGENTBEAN_CHANNEL_FILES_PREVIEW_WORKER: 'false',
      AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING: 'on',
      AGENTBEAN_CHANNEL_FILES_HISTORY_BACKFILL: 'true',
      AGENTBEAN_CHANNEL_FILES_INDEX_SHADOW_COMPARE: 'yes',
    })).toEqual({
      fileBrowser: false,
      streaming: true,
      previewWorker: false,
      markdownEditing: true,
      historyBackfill: true,
      indexShadowCompare: true,
    });
    expect(() => parseChannelFileRolloutConfig({ AGENTBEAN_CHANNEL_FILES_STREAMING: 'maybe' }))
      .toThrow('AGENTBEAN_CHANNEL_FILES_STREAMING');
  });

  test('compares public legacy attachment summary with the indexed projection', () => {
    expect(compareChannelFileSnapshots(
      [
        { id: 'a', logicalPath: 'same.md', role: 'attachment' },
        { id: 'b', logicalPath: 'old.txt', role: 'attachment' },
      ],
      [
        { id: 'a', logicalPath: 'renamed.md', role: 'attachment' },
        { id: 'c', logicalPath: 'run/out.txt', role: 'run_output' },
      ],
    )).toEqual({
      missingFromIndex: ['b'],
      unexpectedInIndex: ['c'],
      changed: ['a'],
      equal: false,
    });
  });

  test('records counters without exposing file names or paths', () => {
    const metrics = createChannelFileMetrics();
    metrics.increment('indexShadowComparisons');
    metrics.increment('indexShadowMismatches', 2);
    metrics.increment('rangeResponses');

    expect(metrics.snapshot()).toEqual({
      indexShadowComparisons: 1,
      indexShadowMismatches: 2,
      rangeResponses: 1,
    });
    expect(JSON.stringify(metrics.snapshot())).not.toContain('same.md');
  });
});
