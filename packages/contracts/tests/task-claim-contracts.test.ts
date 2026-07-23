import { describe, expect, test } from 'vitest';
import { AGENT_EVENTS, parseTaskClaimPayload, safeParseTaskClaimPayload } from '../src/index.js';

describe('task claim socket contracts', () => {
  test('事件名与 offer 最小披露字段固定', () => {
    expect(AGENT_EVENTS.taskClaim).toEqual({
      offer: 'task-claim:offer', acquire: 'task-claim:acquire', renew: 'task-claim:renew',
      release: 'task-claim:release', expired: 'task-claim:expired', respond: 'task-claim:respond',
    });
    // #712 切片 C-2a：respond 携带显式四类响应（AC#2），非法 kind 被拒。
    expect(parseTaskClaimPayload('respond', {
      schemaVersion: 1, offerId: 'offer-1', agentId: 'agent-1', kind: 'needs_info', detail: '缺上下文',
    })).toMatchObject({ kind: 'needs_info', detail: '缺上下文' });
    expect(safeParseTaskClaimPayload('respond', {
      schemaVersion: 1, offerId: 'o', agentId: 'a', kind: 'bogus',
    })).toEqual({ ok: false });
    const offer = parseTaskClaimPayload('offer', {
      schemaVersion: 1, offerId: 'offer-1', deviceId: 'device-1', taskId: 'task-1',
      taskRevision: 2, taskAttempt: 1, agentId: 'agent-1',
      requiredCapabilities: ['code-review'], offerExpiresAt: 100,
    });
    expect(offer).not.toHaveProperty('objective');
    expect(offer).not.toHaveProperty('attachmentToken');
    expect(safeParseTaskClaimPayload('offer', { ...offer, objective: '不能提前披露' })).toEqual({ ok: false });
  });

  test('winner ACK 才携带 raw lease token 与最小 execution snapshot', () => {
    const ack = parseTaskClaimPayload('acquire-ack', {
      schemaVersion: 1,
      ok: true,
      lease: {
        schemaVersion: 1, claimLeaseId: 'lease-1', taskId: 'task-1', taskRevision: 2,
        taskAttempt: 1, agentId: 'agent-1', leaseToken: 'raw-token', fencingToken: 3,
        acquiredAt: 20, expiresAt: 120,
      },
      execution: {
        schemaVersion: 1, managementRunId: 'run-1', taskId: 'task-1', taskRevision: 2,
        taskAttempt: 1, title: '实现协议', objective: '完成 claim broker',
        acceptanceCriteria: [{ id: 'criterion-1', description: '并发唯一', evidenceRequired: true }],
        dependencyTaskIds: ['task-0'], channelId: 'channel-1',
      },
    });
    expect(ack).toMatchObject({ ok: true, lease: { leaseToken: 'raw-token', fencingToken: 3 } });
    expect(safeParseTaskClaimPayload('acquire-ack', {
      ...ack,
      execution: { ...(ack.ok ? ack.execution : {}), attachmentToken: 'forbidden' },
    })).toEqual({ ok: false });
  });
});
