import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createLocalMemoryStore } from '../src/memory/local-memory-store.js';
import { listLocalMemoryGovernanceSummaries } from '../src/memory/local-memory-governance.js';

describe('Device local Memory governance summaries', () => {
  test('returns only an allowed summary and never returns local body or full path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-local-governance-'));
    const baseDir = join(cwd, '.home');
    const store = await createLocalMemoryStore({ profileId: 'profile-a', cwd, baseDir, now: () => 100 });
    await store.upsert({
      teamId: 'team-1', cwd, kind: 'procedural', scopeType: 'local-workspace', sourceKind: 'manual',
      content: 'secret local body that must stay on device', summary: 'Run the matching local verification.',
    });

    const summaries = await listLocalMemoryGovernanceSummaries({
      profileId: 'profile-a', teamId: 'team-1', cwds: [cwd], baseDir,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ summary: 'Run the matching local verification.', workspaceLabel: expect.any(String) });
    expect(JSON.stringify(summaries)).not.toContain('secret local body');
    expect(JSON.stringify(summaries)).not.toContain(cwd);
  });

  test('filters summaries explicitly bound to another Team', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-local-governance-team-'));
    const baseDir = join(cwd, '.home');
    const store = await createLocalMemoryStore({ profileId: 'profile-a', cwd, baseDir, now: () => 100 });
    await store.upsert({
      teamId: 'team-other', cwd, kind: 'decision', scopeType: 'local-workspace', sourceKind: 'manual',
      content: 'other team', summary: 'Other Team summary',
    });
    await expect(listLocalMemoryGovernanceSummaries({
      profileId: 'profile-a', teamId: 'team-1', cwds: [cwd], baseDir,
    })).resolves.toEqual([]);
  });
});
