import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync(
  new URL('../app/[teamPath]/tasks/page.tsx', import.meta.url),
  'utf8',
);

describe('standalone task governance surface', () => {
  test('批量读取频道治理投影，不在卡片内逐项请求', () => {
    expect(source).toContain('taskEvents().channelWorkspace(channelId)');
    expect(source).toContain('workspaceEntriesByTaskId');
    expect(source).toContain('events.onArtifactsUpdated(channelId, refresh)');
    expect(source).not.toMatch(/function TaskCard[\s\S]*?taskEvents\(\)\.channelWorkspace/);
  });

  test('受管任务禁用拖拽、排序和删除，只暴露具名 lifecycle 路径', () => {
    expect(source).toContain("data-governance={managed ? 'managed' : directMutationAllowed ? 'plain' : 'loading'}");
    expect(source).toContain('draggable={directMutationAllowed}');
    expect(source).toContain('allowsDirectTaskMutation(task, workspaceEntriesByTaskId[task.id])');
    expect(source).toContain('allowsDirectTaskMutation(task, workspaceEntriesByTaskId[taskId])');
    expect(source).toContain("workspaceEntry?.governance.mode === 'plain'");
    expect(source).toContain("status === 'cancelled'");
    expect(source).toContain('taskEvents().acceptRootDelivery');
    expect(source).toContain('taskEvents().rejectRootDelivery');
  });

  test('新建任务不再直接选择负责人', () => {
    expect(source).not.toContain('createAssigneeId');
    expect(source).not.toContain('assigneeId: createAssigneeId');
  });
});
