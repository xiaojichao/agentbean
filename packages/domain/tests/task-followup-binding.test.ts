import { describe, expect, test } from 'vitest';
import { resolveTaskFollowupBinding, TASK_FOLLOWUP_BINDING_REASON } from '../src/task-followup-binding.js';

describe('resolveTaskFollowupBinding', () => {
  test('strong: thread taskId present → direct binding (AC1)', () => {
    const result = resolveTaskFollowupBinding({
      threadTaskIds: ['task-1'],
      channelActiveTasks: [],
      followupObjective: '补充一些信息',
    });
    expect(result).toEqual({
      kind: 'strong',
      taskId: 'task-1',
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.STRONG_THREAD_TASK,
    });
  });

  test('strong: multiple thread taskIds → picks the most recent (AC1)', () => {
    const result = resolveTaskFollowupBinding({
      threadTaskIds: ['task-old', 'task-new'],
      channelActiveTasks: [],
      followupObjective: '跟进',
    });
    expect(result).toEqual({
      kind: 'strong',
      taskId: 'task-new',
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.STRONG_THREAD_TASK,
    });
  });

  test('strong takes precedence over major change (用户明确在 Task 上下文中)', () => {
    const result = resolveTaskFollowupBinding({
      threadTaskIds: ['task-1'],
      channelActiveTasks: [],
      followupObjective: '扩大作用域到生产数据库',
    });
    expect(result).toEqual({
      kind: 'strong',
      taskId: 'task-1',
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.STRONG_THREAD_TASK,
    });
  });

  test('suggested: no thread taskId + single candidate + minor change (AC2)', () => {
    const result = resolveTaskFollowupBinding({
      threadTaskIds: [],
      channelActiveTasks: [{ taskId: 'task-1', objective: '原目标' }],
      followupObjective: '补充一个实现细节',
    });
    expect(result).toEqual({
      kind: 'suggested',
      taskId: 'task-1',
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.SUGGESTED_UNIQUE_MATCH,
    });
  });

  test('needs_confirmation: multiple candidates (AC3)', () => {
    const result = resolveTaskFollowupBinding({
      threadTaskIds: [],
      channelActiveTasks: [
        { taskId: 'task-1', objective: '目标 a' },
        { taskId: 'task-2', objective: '目标 b' },
      ],
      followupObjective: '更新进度',
    });
    expect(result).toMatchObject({
      kind: 'needs_confirmation',
      candidates: ['task-1', 'task-2'],
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.NEEDS_CONFIRMATION_MULTIPLE_CANDIDATES,
    });
  });

  test('needs_confirmation: major change (scope expansion) overrides single candidate (AC3)', () => {
    const result = resolveTaskFollowupBinding({
      threadTaskIds: [],
      channelActiveTasks: [{ taskId: 'task-1', objective: '原目标' }],
      followupObjective: '扩大作用域到所有团队',
    });
    expect(result).toMatchObject({
      kind: 'needs_confirmation',
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.NEEDS_CONFIRMATION_MAJOR_CHANGE,
    });
    if (result.kind === 'needs_confirmation') {
      expect(result.candidates).toEqual(['task-1']);
    }
  });

  test('needs_confirmation: major change with no candidates still requires confirmation (AC3)', () => {
    const result = resolveTaskFollowupBinding({
      threadTaskIds: [],
      channelActiveTasks: [],
      followupObjective: '删除生产数据库的全部记录',
    });
    expect(result).toMatchObject({
      kind: 'needs_confirmation',
      candidates: [],
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.NEEDS_CONFIRMATION_MAJOR_CHANGE,
    });
  });

  test('none: no thread taskId + no candidates + no major change', () => {
    const result = resolveTaskFollowupBinding({
      threadTaskIds: [],
      channelActiveTasks: [],
      followupObjective: '随意聊聊',
    });
    expect(result).toEqual({ kind: 'none', reasonCode: TASK_FOLLOWUP_BINDING_REASON.NO_CANDIDATES });
  });
});
