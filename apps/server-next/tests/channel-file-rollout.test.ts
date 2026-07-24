import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index.js';

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
      indexShadowMissing: 0,
      indexShadowUnexpected: 0,
      indexShadowChanged: 0,
      rangeResponses: 1,
    });
    expect(JSON.stringify(metrics.snapshot())).not.toContain('same.md');
  });

  test('blocks Markdown mutations when the editing rollout is disabled', async () => {
    const repositories = createInMemoryRepositories();
    const ids = ['user-1', 'team-1', 'channel-1'];
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1 },
      ids: { nextId: () => ids.shift() ?? 'unexpected-id' },
      channelFileRollout: parseChannelFileRolloutConfig({
        AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING: 'off',
      }),
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });

    await expect(app.saveChannelDocument({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      documentId: 'document-1',
      baseRevisionId: 'revision-1',
      idempotencyKey: 'save-1',
      content: '# blocked',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
      message: 'Channel document editing is disabled',
    });
  });

  test('does not create Markdown documents implicitly when editing rollout is disabled', async () => {
    const repositories = createInMemoryRepositories();
    const ids = ['user-1', 'team-1', 'channel-1', 'artifact-1', 'message-1'];
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1 },
      ids: { nextId: () => ids.shift() ?? 'unexpected-id' },
      channelFileRollout: parseChannelFileRolloutConfig({
        AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING: 'off',
      }),
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await app.uploadArtifact({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 5,
      storagePath: 'artifacts/team-1/artifact-1/notes.md',
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'attachment',
      artifactIds: ['artifact-1'],
    });

    await expect(app.listChannelDocuments({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: true, documents: [] });
    await expect(app.getChannelDocument({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      documentId: 'channel-document:artifact-1',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(repositories.channelDocuments.listByChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual([]);
  });
});
