import { describe, expect, test } from 'vitest';

import { buildPackageReturnComposerDraft, type PackageReturnHandoff } from '../lib/output-package-return-handoff';

function handoff(overrides: Partial<PackageReturnHandoff> = {}): PackageReturnHandoff {
  return {
    packageId: 'package-1',
    threadRootMessageId: 'message-root-1',
    taskId: 'task-1',
    taskTitle: '完善第一集剧本',
    originalAgentId: 'agent-1',
    originalAgentName: '剧本创作',
    collectionId: 'collection-1',
    versionId: 'version-rejected-1',
    filename: '第1集剧本.md',
    versionNumber: 4,
    decision: 'changes_requested',
    comment: '减少说教感',
    agentChoice: 'original',
    taskRevision: 3,
    taskAttempt: 2,
    ...overrides,
  };
}

describe('文件审核退回后的讨论串预填', () => {
  test('原智能体路径预填目标 Agent，并显式冻结被退回版本', () => {
    const draft = buildPackageReturnComposerDraft(handoff(), '剧本创作');
    expect(draft.text).toContain('@剧本创作');
    expect(draft.text).toContain('审核结论：要求修改');
    expect(draft.text).toContain('审核意见：减少说教感');
    expect(draft.text).toContain('原任务：完善第一集剧本');
    expect(draft.selection).toEqual({
      kind: 'package_members',
      packageId: 'package-1',
      members: [{ collectionId: 'collection-1', versionId: 'version-rejected-1' }],
    });
  });

  test('换智能体路径不填原 Agent，只在草稿末尾保留选择入口', () => {
    const draft = buildPackageReturnComposerDraft(handoff({
      decision: 'rejected',
      agentChoice: 'select',
    }), '剧本创作');
    expect(draft.text).not.toContain('@剧本创作');
    expect(draft.text).toContain('审核结论：拒绝');
    expect(draft.text.endsWith('处理智能体：@')).toBe(true);
    expect(draft.selection.kind).toBe('package_members');
  });
});
