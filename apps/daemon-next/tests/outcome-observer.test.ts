import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createLocalMemoryStore } from '../src/memory/local-memory-store';
import { observeDispatchOutcome } from '../src/memory/outcome-observer';

describe('observeDispatchOutcome', () => {
  test('无 workspace run 时不写长期 Memory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-outcome-empty-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') });

    await expect(observeDispatchOutcome({ store,
      request: { id: 'dispatch-1', agentId: 'agent-1', customAgent: { cwd } },
      result: {},
    })).resolves.toEqual([]);
    expect(store.list()).toEqual([]);
  });

  test('workspace run 完成后调用确定性学习并只返回脱敏摘要', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-outcome-run-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') });

    const summaries = await observeDispatchOutcome({ store,
      request: { id: 'dispatch-1', agentId: 'agent-1', customAgent: { cwd, adapterKind: 'codex' } },
      result: { workspaceRun: { status: 'failed', command: 'npm test', exitCode: 1,
        logExcerpt: 'vitest failed; cookie=session-secret-must-not-leak' } },
    });

    expect(summaries).toEqual([expect.objectContaining({ action: 'created', sourceKind: 'workspace_run' })]);
    expect(JSON.stringify(summaries)).not.toContain('session-secret-must-not-leak');
    expect(store.list()).toHaveLength(1);
  });
});
