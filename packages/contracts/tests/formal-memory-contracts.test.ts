import { describe, expect, test } from 'vitest';

import {
  FORMAL_MEMORY_KINDS,
  FORMAL_MEMORY_SCOPE_TYPES,
  type FormalMemoryDto,
  type FormalMemoryListDto,
  formalKindToStorageKind,
  storageKindToFormalKind,
} from '../src/index.js';
import { MEMORY_KINDS } from '../src/index.js';

describe('Formal Memory contracts (issue #716)', () => {
  test('exposes exactly the four product kinds and two scopes', () => {
    expect(FORMAL_MEMORY_KINDS).toEqual(['fact', 'decision', 'rule', 'preference']);
    expect(FORMAL_MEMORY_SCOPE_TYPES).toEqual(['team', 'channel']);
  });

  test('formalKindToStorageKind maps per §6.5 adaptation layer', () => {
    expect(formalKindToStorageKind('fact')).toBe('semantic');
    expect(formalKindToStorageKind('rule')).toBe('procedural');
    expect(formalKindToStorageKind('decision')).toBe('decision');
    expect(formalKindToStorageKind('preference')).toBe('preference');
  });

  test('storageKindToFormalKind excludes episodic/artifact-summary (AC#7)', () => {
    expect(storageKindToFormalKind('semantic')).toBe('fact');
    expect(storageKindToFormalKind('procedural')).toBe('rule');
    expect(storageKindToFormalKind('decision')).toBe('decision');
    expect(storageKindToFormalKind('preference')).toBe('preference');
    expect(storageKindToFormalKind('episodic')).toBeNull();
    expect(storageKindToFormalKind('artifact-summary')).toBeNull();
  });

  test('formal -> storage -> formal is identity for all four kinds', () => {
    for (const kind of FORMAL_MEMORY_KINDS) {
      const back = storageKindToFormalKind(formalKindToStorageKind(kind));
      expect(back).toBe(kind);
    }
  });

  test('every formal kind maps onto a real storage kind', () => {
    for (const kind of FORMAL_MEMORY_KINDS) {
      expect(MEMORY_KINDS).toContain(formalKindToStorageKind(kind));
    }
  });

  test('a FormalMemoryDto carries version family and change reason (AC#4)', () => {
    const dto: FormalMemoryDto = {
      schemaVersion: 1,
      id: 'memory-1',
      teamId: 'team-1',
      kind: 'decision',
      status: 'active',
      scopeType: 'team',
      scopeRef: 'team-1',
      content: '记忆核心自研',
      tags: [],
      sourceRefs: [],
      changeReason: '初版录入',
      versionFamilyId: 'memory-1',
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    expect(dto.versionFamilyId).toBe('memory-1');
    expect(dto.changeReason).toBe('初版录入');
  });

  test('a FormalMemoryListDto carries manage + correction flags (AC#3/AC#6)', () => {
    const list: FormalMemoryListDto = {
      schemaVersion: 1,
      teamId: 'team-1',
      scopeType: 'channel',
      scopeRef: 'channel-1',
      channelId: 'channel-1',
      canManage: false,
      canProposeCorrection: true,
      items: [],
    };
    expect(list.canManage).toBe(false);
    expect(list.canProposeCorrection).toBe(true);
  });
});
