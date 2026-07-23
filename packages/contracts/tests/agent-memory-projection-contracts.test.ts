import { describe, expect, test } from 'vitest';

import {
  type AgentMemoryProjectionConsumptionDto,
  type AgentMemoryProjectionDto,
  type AgentMemoryProjectionStatus,
  type TeamAgentMemoryOptInDto,
} from '../src/index.js';

describe('Agent Memory Projection contracts (issue #718)', () => {
  test('a projection dto carries lifecycle and audit fields (AC#1/AC#2)', () => {
    const dto: AgentMemoryProjectionDto = {
      schemaVersion: 1,
      id: 'p1',
      teamId: 't1',
      agentId: 'a1',
      revision: 1,
      status: 'active',
      kind: 'fact',
      content: 'c',
      tags: [],
      sourceRefs: [],
      validFrom: 100,
      validUntil: null,
      publishedBy: 'u1',
      publishedAt: 100,
      supersededById: null,
      createdBy: 'u1',
      createdAt: 100,
      updatedAt: 100,
    };
    expect(dto.schemaVersion).toBe(1);
    expect(dto.revision).toBe(1);
  });

  test('withdrawn projection carries withdraw audit (AC#2/AC#7)', () => {
    const dto: AgentMemoryProjectionDto = {
      schemaVersion: 1,
      id: 'p1',
      teamId: 't1',
      agentId: 'a1',
      revision: 1,
      status: 'withdrawn',
      kind: 'fact',
      content: 'c',
      tags: [],
      sourceRefs: [],
      validFrom: 100,
      validUntil: null,
      publishedBy: 'u1',
      publishedAt: 100,
      supersededById: null,
      withdrawnBy: 'u1',
      withdrawnAt: 200,
      createdBy: 'u1',
      createdAt: 100,
      updatedAt: 200,
    };
    expect(dto.withdrawnBy).toBe('u1');
  });

  test('consumption dto omits owner/audit/sourceRefs (AC#6: PI 只消费公开字段)', () => {
    const dto: AgentMemoryProjectionConsumptionDto = {
      projectionId: 'p1',
      agentId: 'a1',
      agentName: 'Agent',
      revision: 1,
      kind: 'fact',
      content: 'c',
      tags: [],
      validUntil: null,
    };
    expect(dto.projectionId).toBe('p1');
    // 消费视图刻意不含 publishedBy/createdBy/sourceRefs 等内部字段（编译期类型保证）
  });

  test('opt-in dto carries revision fence projectionId (AC#3/AC#7)', () => {
    const dto: TeamAgentMemoryOptInDto = {
      id: 'o1',
      teamId: 't1',
      agentId: 'a1',
      projectionId: 'p1',
      enabled: true,
      updatedBy: 'u1',
      updatedAt: 100,
    };
    expect(dto.projectionId).toBe('p1');
  });

  test('status covers full lifecycle (draft/active/superseded/expired/withdrawn)', () => {
    const statuses: AgentMemoryProjectionStatus[] = [
      'draft', 'active', 'superseded', 'expired', 'withdrawn',
    ];
    expect(statuses).toHaveLength(5);
  });
});
