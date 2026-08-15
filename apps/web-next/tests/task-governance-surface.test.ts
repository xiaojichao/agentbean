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

  test('受管任务禁用拖拽、排序、删除和状态菜单', () => {
    expect(source).toContain("data-governance={managed ? 'managed' : directMutationAllowed ? 'plain' : 'loading'}");
    expect(source).toContain('draggable={directMutationAllowed}');
    expect(source).toContain('allowsDirectTaskMutation(task, workspaceEntriesByTaskId[task.id])');
    expect(source).toContain('allowsDirectTaskMutation(task, workspaceEntriesByTaskId[taskId])');
    expect(source).toContain("workspaceEntry?.governance.mode === 'plain'");
    expect(source).toMatch(/: managed\s+\? \[\]/);
  });

  test('不再提供常驻新建任务入口，提示从频道讨论串形成执行事实', () => {
    expect(source).not.toContain('tasks-create-open');
    expect(source).not.toContain('tasks-create-form');
    expect(source).toContain('通过频道讨论串发送 @Agent、指令与文件引用来创建执行事实');
  });
});
