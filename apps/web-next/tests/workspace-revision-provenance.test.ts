import { describe, expect, test } from 'vitest';

import { describeWorkspaceRevisionProvenance } from '../lib/workspace-revision-provenance';
import type { WorkspaceRevisionProvenanceDto } from '@agentbean/contracts';

describe('describeWorkspaceRevisionProvenance (#966 来源展示)', () => {
  test('undefined → unknown', () => {
    expect(describeWorkspaceRevisionProvenance(undefined))
      .toEqual({ kind: 'unknown', label: '来源未知' });
  });

  test('legacy import provenance（#964 无 kind 判别字段）→ 仍按 import 渲染，不误判为 publish', () => {
    const legacy = { sourceDeviceId: 'device-1', importedAt: 100 } as unknown as WorkspaceRevisionProvenanceDto;
    expect(describeWorkspaceRevisionProvenance(legacy))
      .toEqual({ kind: 'import', label: '由设备导入' });
  });

  test('设备导入 provenance → import 视图', () => {
    expect(describeWorkspaceRevisionProvenance({ kind: 'import', sourceDeviceId: 'device-1', importedAt: 100 }))
      .toEqual({ kind: 'import', label: '由设备导入' });
  });

  test('Agent 发布 provenance → publish 视图，携带 Agent/Task/baseline', () => {
    const view = describeWorkspaceRevisionProvenance({
      kind: 'publish', agentId: 'agent-1', taskId: 'task-1', taskAttempt: 2,
      baselineRevisionId: 'rev-1', publishedAt: 200,
    });
    expect(view).toEqual({
      kind: 'publish', label: '由 Agent 发布',
      agentId: 'agent-1', taskId: 'task-1', taskAttempt: 2, baselineRevisionId: 'rev-1',
    });
  });

  test('publish 视图不泄露 device 路径等导入专属字段', () => {
    const view = describeWorkspaceRevisionProvenance({
      kind: 'publish', agentId: 'agent-1', taskId: 'task-1', taskAttempt: 1,
      baselineRevisionId: 'rev-1', publishedAt: 1,
    });
    expect(view).not.toHaveProperty('sourceDeviceId');
    expect(view).not.toHaveProperty('importedAt');
  });
});
