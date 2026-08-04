import { describe, expect, test } from 'vitest';

import type { FrozenProjectInputItemDto } from '@agentbean/contracts';
import { evaluateTaskLinkedRequest } from '../src/task-linked-request-policy.js';

const frozenInput = (over: Partial<FrozenProjectInputItemDto> = {}): FrozenProjectInputItemDto => ({
  collectionId: 'collection-1',
  artifactVersionId: 'version-1',
  versionNumber: 3,
  artifactId: 'artifact-1',
  filename: 'script.ep01.md',
  isFinal: false,
  reviewState: 'pending',
  ...over,
});

function makeInput(over: Partial<Parameters<typeof evaluateTaskLinkedRequest>[0]> = {}) {
  return {
    channelId: 'channel-1',
    senderUserId: 'user-requester',
    channelArchived: false,
    task: {
      id: 'task-1',
      channelId: 'channel-1',
      creatorId: 'user-requester',
      revision: 2,
      status: 'in_progress',
    },
    coordination: {
      attempt: 1,
      humanAcceptanceAuthorityIds: ['user-reviewer'],
      inputBindingsResolved: true,
    },
    expectedTaskRevision: 2,
    expectedTaskAttempt: 1,
    eligibleAgentIds: ['agent-a', 'agent-b'],
    requestedAgentIds: ['agent-a'],
    frozenInputs: [frozenInput()],
    explicitVersionIds: [],
    visibleCollectionIds: ['collection-1'],
    ...over,
  } as const;
}

describe('evaluateTaskLinkedRequest（#1064 AC3 复验链纯函数）', () => {
  test('全部门槛通过 → ok', () => {
    expect(evaluateTaskLinkedRequest(makeInput())).toEqual({ ok: true });
  });

  test('Channel 归档 → CHANNEL_ARCHIVED（fail closed）', () => {
    const result = evaluateTaskLinkedRequest(makeInput({ channelArchived: true }));
    expect(result).toEqual({ ok: false, code: 'CHANNEL_ARCHIVED' });
  });

  test('Task 不属于本频道 → TASK_CHANNEL_MISMATCH', () => {
    const result = evaluateTaskLinkedRequest(makeInput({
      task: { id: 'task-1', channelId: 'channel-9', creatorId: 'user-requester', revision: 2, status: 'in_progress' },
    }));
    expect(result).toEqual({ ok: false, code: 'TASK_CHANNEL_MISMATCH' });
  });

  test('发送者既非 requester 也非预绑定 authority → TASK_AUTHORITY_DENIED', () => {
    const result = evaluateTaskLinkedRequest(makeInput({ senderUserId: 'user-bystander' }));
    expect(result).toEqual({ ok: false, code: 'TASK_AUTHORITY_DENIED' });
  });

  test('预绑定的人类验收 authority 可发送（root=human review authority 语义）', () => {
    expect(evaluateTaskLinkedRequest(makeInput({ senderUserId: 'user-reviewer' }))).toEqual({ ok: true });
  });

  test('Task revision 漂移 → TASK_REVISION_STALE（不静默冻结新版本）', () => {
    const result = evaluateTaskLinkedRequest(makeInput({ expectedTaskRevision: 1 }));
    expect(result).toEqual({ ok: false, code: 'TASK_REVISION_STALE' });
  });

  test('attempt 漂移 → TASK_ATTEMPT_STALE', () => {
    const result = evaluateTaskLinkedRequest(makeInput({ expectedTaskAttempt: 2 }));
    expect(result).toEqual({ ok: false, code: 'TASK_ATTEMPT_STALE' });
  });

  test('input binding 未解析 → INPUT_BINDING_UNRESOLVED（#948-G 同语义 gate）', () => {
    const result = evaluateTaskLinkedRequest(makeInput({
      coordination: {
        attempt: 1,
        humanAcceptanceAuthorityIds: ['user-reviewer'],
        inputBindingsResolved: false,
      },
    }));
    expect(result).toEqual({ ok: false, code: 'INPUT_BINDING_UNRESOLVED' });
  });

  test('终态 Task（done/cancelled/closed）→ TASK_NOT_OPEN', () => {
    for (const status of ['done', 'cancelled', 'closed'] as const) {
      const result = evaluateTaskLinkedRequest(makeInput({
        task: { id: 'task-1', channelId: 'channel-1', creatorId: 'user-requester', revision: 2, status },
      }));
      expect(result).toEqual({ ok: false, code: 'TASK_NOT_OPEN' });
    }
  });

  test('显式 @Agent 目标不合格 → AGENT_NOT_ELIGIBLE，不静默改派（AC5）', () => {
    const result = evaluateTaskLinkedRequest(makeInput({ requestedAgentIds: ['agent-c'] }));
    expect(result).toEqual({ ok: false, code: 'AGENT_NOT_ELIGIBLE' });
  });

  test('冻结输入涉及频道外 collection → ARTIFACT_VISIBILITY_DENIED', () => {
    const result = evaluateTaskLinkedRequest(makeInput({ visibleCollectionIds: ['collection-9'] }));
    expect(result).toEqual({ ok: false, code: 'ARTIFACT_VISIBILITY_DENIED' });
  });

  test('被 rejected/changes_requested 的版本作为默认输入 → REVIEW_BASIS_BLOCKED 并列出版本', () => {
    for (const reviewState of ['rejected', 'changes_requested'] as const) {
      const result = evaluateTaskLinkedRequest(makeInput({
        frozenInputs: [frozenInput({ reviewState })],
      }));
      expect(result).toEqual({
        ok: false,
        code: 'REVIEW_BASIS_BLOCKED',
        blockedVersionIds: ['version-1'],
      });
    }
  });

  test('显式「基于此修改」选择被拒版本 → 放行（specified 显式意图优先）', () => {
    const result = evaluateTaskLinkedRequest(makeInput({
      frozenInputs: [frozenInput({ reviewState: 'rejected' })],
      explicitVersionIds: ['version-1'],
    }));
    expect(result).toEqual({ ok: true });
  });

  test('approved/pending 版本作默认输入 → 放行', () => {
    for (const reviewState of ['approved', 'pending'] as const) {
      expect(evaluateTaskLinkedRequest(makeInput({
        frozenInputs: [frozenInput({ reviewState })],
      }))).toEqual({ ok: true });
    }
  });

  test('非 tracked task（无 coordination）→ 仅限 requester 发送且无 attempt/input binding gate', () => {
    const { coordination: _dropped, ...withoutCoordination } = makeInput();
    expect(evaluateTaskLinkedRequest(withoutCoordination)).toEqual({ ok: true });
    const stranger = evaluateTaskLinkedRequest({ ...withoutCoordination, senderUserId: 'user-bystander' });
    expect(stranger).toEqual({ ok: false, code: 'TASK_AUTHORITY_DENIED' });
  });
});
