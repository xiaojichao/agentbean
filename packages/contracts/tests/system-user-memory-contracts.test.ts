import { describe, expect, test } from 'vitest';

import {
  FORMAL_MEMORY_KINDS,
  SYSTEM_USER_MEMORY_SCOPES,
  SYSTEM_USER_MEMORY_STATUSES,
  WEB_EVENTS,
  type SystemKnowledgeDetailDto,
  type SystemKnowledgeDto,
  type SystemKnowledgeListDto,
  type UserMemoryDetailDto,
  type UserMemoryDto,
  type UserMemoryListDto,
} from '../src/index.js';

describe('System/User Memory contracts (issue #717)', () => {
  test('exposes exactly the three manual-maintenance statuses (no candidate flow, AC#2)', () => {
    expect(SYSTEM_USER_MEMORY_STATUSES).toEqual(['active', 'expired', 'superseded']);
  });

  test('exposes exactly the two isolation scopes (AC#7)', () => {
    expect(SYSTEM_USER_MEMORY_SCOPES).toEqual(['system', 'user']);
  });

  test('reuses the four Formal Memory kinds (ADR 0047)', () => {
    expect(FORMAL_MEMORY_KINDS).toEqual(['fact', 'decision', 'rule', 'preference']);
  });

  test('a SystemKnowledgeDto is scope=system and has no ownerUserId', () => {
    const dto: SystemKnowledgeDto = {
      schemaVersion: 1,
      id: 'sk-1',
      scope: 'system',
      kind: 'rule',
      status: 'active',
      content: '所有 dispatch 必须先持久化 Message',
      changeReason: '初版录入',
      versionFamilyId: 'sk-1',
      createdByUserId: 'admin-1',
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    expect(dto.scope).toBe('system');
    expect(dto.versionFamilyId).toBe('sk-1');
    // System Knowledge 无 ownerUserId（全局，非按用户分片）。
    expect('ownerUserId' in dto).toBe(false);
  });

  test('a UserMemoryDto carries the ownerUserId isolation key (AC#3/AC#6)', () => {
    const dto: UserMemoryDto = {
      schemaVersion: 1,
      id: 'um-1',
      scope: 'user',
      kind: 'preference',
      status: 'active',
      content: '回复尽量简洁',
      versionFamilyId: 'um-1',
      ownerUserId: 'user-1',
      createdByUserId: 'user-1',
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    expect(dto.scope).toBe('user');
    expect(dto.ownerUserId).toBe('user-1');
  });

  test('detail DTOs carry version history (ADR 0046)', () => {
    const detail: SystemKnowledgeDetailDto = {
      schemaVersion: 1,
      id: 'sk-1',
      scope: 'system',
      kind: 'rule',
      status: 'active',
      content: 'v2',
      versionFamilyId: 'sk-1',
      createdByUserId: 'admin-1',
      createdAt: 2_000,
      updatedAt: 2_000,
      versions: [
        { versionId: 'sk-1', kind: 'rule', content: 'v1', status: 'superseded', actorUserId: 'admin-1', createdAt: 1_000, changeReason: '初版' },
        { versionId: 'sk-2', kind: 'rule', content: 'v2', status: 'active', actorUserId: 'admin-1', createdAt: 2_000, changeReason: '补充例外' },
      ],
    };
    expect(detail.versions).toHaveLength(2);
    expect(detail.versions[0]!.status).toBe('superseded');
  });

  test('list DTOs are scope-tagged (AC#7)', () => {
    const systemList: SystemKnowledgeListDto = { schemaVersion: 1, scope: 'system', items: [] };
    const userList: UserMemoryListDto = { schemaVersion: 1, scope: 'user', ownerUserId: 'user-1', items: [] };
    expect(systemList.scope).toBe('system');
    expect(userList.scope).toBe('user');
    expect(userList.ownerUserId).toBe('user-1');
  });

  test('socket events use distinct system-knowledge/user-memory prefixes (AC#7)', () => {
    expect(WEB_EVENTS.systemKnowledge).toEqual({
      list: 'system-knowledge:list',
      detail: 'system-knowledge:detail',
      create: 'system-knowledge:create',
      revise: 'system-knowledge:revise',
      deactivate: 'system-knowledge:deactivate',
      delete: 'system-knowledge:delete',
    });
    expect(WEB_EVENTS.userMemory).toEqual({
      list: 'user-memory:list',
      detail: 'user-memory:detail',
      create: 'user-memory:create',
      revise: 'user-memory:revise',
      deactivate: 'user-memory:deactivate',
      delete: 'user-memory:delete',
    });
    // detail DTO 仅用于类型可赋值性断言，运行时不直接构造。
    expect(typeof SYSTEM_USER_MEMORY_STATUSES).toBe('object');
    void (null as unknown as UserMemoryDetailDto);
  });
});
