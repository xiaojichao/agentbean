import { describe, expect, test } from 'vitest';
import type { MemoryCapsuleItemDto, MemorySourceRefDto } from '@agentbean/contracts';

import { hashCapsuleItems, hashMemoryContent, hashSourceRefs } from '../src/index.js';

const sourceRef = (id: string): MemorySourceRefDto => ({
  schemaVersion: 1,
  sourceKind: 'message',
  sourceId: id,
  snapshotHash: 'snap',
});

const capsuleItem = (contentHash: string, sourceRefsHash: string): MemoryCapsuleItemDto => ({
  schemaVersion: 1,
  memoryId: 'm-1',
  scopeType: 'team',
  scopeRef: 'team-1',
  sourceVisibility: 'team',
  contentKind: 'fact',
  redactionLevel: 'none',
  content: '',
  sourceRefs: [],
  authorization: {
    schemaVersion: 1,
    decisionId: 'd-1',
    mode: 'scope-policy',
    policyVersion: 1,
    targetAgentId: 'a-1',
    sourceScopeType: 'team',
    sourceScopeRef: 'team-1',
    sourceRefsHash,
    contentHash,
    authorizedContentKind: 'fact',
    authorizedRedactionLevel: 'none',
    issuedAt: 0,
    expiresAt: 1_000,
  },
});

describe('Phase 3 Memory hashing', () => {
  test('hashMemoryContent is deterministic with sha256 prefix', () => {
    expect(hashMemoryContent('x')).toBe(hashMemoryContent('x'));
    expect(hashMemoryContent('x')).toMatch(/^sha256:[0-9a-f]+$/);
    expect(hashMemoryContent('x')).not.toBe(hashMemoryContent('y'));
  });

  test('hashSourceRefs is order-independent', () => {
    expect(hashSourceRefs([sourceRef('a'), sourceRef('b')])).toBe(hashSourceRefs([sourceRef('b'), sourceRef('a')]));
    expect(hashSourceRefs([sourceRef('a')])).not.toBe(hashSourceRefs([sourceRef('a'), sourceRef('b')]));
  });

  test('hashCapsuleItems is order-independent and reflects content/source drift', () => {
    const a = capsuleItem('sha256:aaa', 'sha256:sss');
    const b = capsuleItem('sha256:bbb', 'sha256:ttt');
    // 与 item 顺序无关——同一组 item 无论排列都产生同一胶囊级哈希
    expect(hashCapsuleItems([a, b])).toBe(hashCapsuleItems([b, a]));
    // 任一 item 的 contentHash 漂移 → 胶囊级哈希变
    expect(hashCapsuleItems([a])).not.toBe(hashCapsuleItems([capsuleItem('sha256:different', 'sha256:sss')]));
    // 任一 item 的 sourceRefsHash 漂移 → 胶囊级哈希变
    expect(hashCapsuleItems([a])).not.toBe(hashCapsuleItems([capsuleItem('sha256:aaa', 'sha256:different')]));
    // sha256 前缀
    expect(hashCapsuleItems([a, b])).toMatch(/^sha256:[0-9a-f]+$/);
  });
});
