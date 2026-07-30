import { describe, expect, test } from 'vitest';

import {
  resolveOutputSlots,
  evaluateInputBindingResolvability,
} from '../src/index.js';
import type { EvidenceRefDto } from '@agentbean/contracts';

// ── 共享 fixture ──

const artifactRef: EvidenceRefDto = {
  kind: 'artifact', id: 'art-1', snapshotHash: 'h-art', snapshotRevision: 2, capturedAt: 100,
};
const runRef: EvidenceRefDto = {
  kind: 'workspace-run', id: 'run-1', snapshotHash: 'h-run', capturedAt: 110,
};
const messageRef: EvidenceRefDto = {
  kind: 'message', id: 'msg-1', snapshotHash: 'h-msg', capturedAt: 120,
};
const allRefs: EvidenceRefDto[] = [artifactRef, runRef, messageRef];

// ── resolveOutputSlots ──

describe('resolveOutputSlots', () => {
  test('无声明 slot 且无 delivery refs → 空 resolved（向后兼容）', () => {
    expect(resolveOutputSlots({ declaredSlots: [], deliveryEvidenceRefs: [] }))
      .toEqual({ kind: 'resolved', slots: [] });
  });

  test('单 slot 无 evidenceKind → 解析为 delivery 全部 evidenceRefs', () => {
    const decision = resolveOutputSlots({
      declaredSlots: [{ name: 'all' }],
      deliveryEvidenceRefs: allRefs,
    });
    expect(decision).toEqual({ kind: 'resolved', slots: [{ name: 'all', evidenceRefs: allRefs }] });
  });

  test('单 slot 带 evidenceKind=artifact → 仅解析 artifact kind 的 ref', () => {
    const decision = resolveOutputSlots({
      declaredSlots: [{ name: 'artifacts', evidenceKind: 'artifact' }],
      deliveryEvidenceRefs: allRefs,
    });
    expect(decision.kind).toBe('resolved');
    if (decision.kind === 'resolved') {
      expect(decision.slots).toEqual([{ name: 'artifacts', evidenceRefs: [artifactRef] }]);
    }
  });

  test('声明 slot 但 delivery 无 refs → resolved 空数组（非 reject）', () => {
    const decision = resolveOutputSlots({
      declaredSlots: [{ name: 'empty' }],
      deliveryEvidenceRefs: [],
    });
    expect(decision).toEqual({ kind: 'resolved', slots: [{ name: 'empty', evidenceRefs: [] }] });
  });

  test('多 slot 混合 kind 过滤 → 各自独立解析', () => {
    const decision = resolveOutputSlots({
      declaredSlots: [
        { name: 'runs', evidenceKind: 'workspace-run' },
        { name: 'everything' },
        { name: 'messages', evidenceKind: 'message' },
      ],
      deliveryEvidenceRefs: allRefs,
    });
    expect(decision.kind).toBe('resolved');
    if (decision.kind === 'resolved') {
      expect(decision.slots).toEqual([
        { name: 'runs', evidenceRefs: [runRef] },
        { name: 'everything', evidenceRefs: allRefs },
        { name: 'messages', evidenceRefs: [messageRef] },
      ]);
    }
  });

  test('重复 slot name → rejected', () => {
    const decision = resolveOutputSlots({
      declaredSlots: [{ name: 'dup' }, { name: 'dup' }],
      deliveryEvidenceRefs: allRefs,
    });
    expect(decision).toEqual({ kind: 'rejected', reason: 'duplicate-slot-name', slotName: 'dup' });
  });
});

// ── evaluateInputBindingResolvability ──

describe('evaluateInputBindingResolvability', () => {
  test('无声明 binding → resolvable', () => {
    expect(evaluateInputBindingResolvability({
      declaredBindings: [],
      resolver: () => null,
    })).toEqual({ kind: 'resolvable' });
  });

  test('单 binding，resolver 返回 refs → resolvable', () => {
    const decision = evaluateInputBindingResolvability({
      declaredBindings: [{ name: 'in', upstreamTaskId: 'task-a', slotName: 'out' }],
      resolver: () => [artifactRef],
    });
    expect(decision).toEqual({ kind: 'resolvable' });
  });

  test('单 binding，resolver 返回 null（上游 snapshot 缺失）→ unresolved', () => {
    const binding = { name: 'in', upstreamTaskId: 'task-a', slotName: 'out' };
    const decision = evaluateInputBindingResolvability({
      declaredBindings: [binding],
      resolver: () => null,
    });
    expect(decision).toEqual({
      kind: 'unresolved',
      bindings: [{ binding, reason: 'upstream-snapshot-missing' }],
    });
  });

  test('两 binding 一可解析一不可 → unresolved 仅含失败项', () => {
    const ok = { name: 'a', upstreamTaskId: 'task-a', slotName: 'out' };
    const missing = { name: 'b', upstreamTaskId: 'task-b', slotName: 'out' };
    const decision = evaluateInputBindingResolvability({
      declaredBindings: [ok, missing],
      resolver: (b) => (b.upstreamTaskId === 'task-a' ? [artifactRef] : null),
    });
    expect(decision.kind).toBe('unresolved');
    if (decision.kind === 'unresolved') {
      expect(decision.bindings).toEqual([
        { binding: missing, reason: 'upstream-snapshot-missing' },
      ]);
    }
  });

  test('重复 binding name → rejected', () => {
    const decision = evaluateInputBindingResolvability({
      declaredBindings: [
        { name: 'dup', upstreamTaskId: 'task-a', slotName: 'out' },
        { name: 'dup', upstreamTaskId: 'task-b', slotName: 'out' },
      ],
      resolver: () => [artifactRef],
    });
    expect(decision).toEqual({ kind: 'rejected', reason: 'duplicate-binding-name', bindingName: 'dup' });
  });
});
