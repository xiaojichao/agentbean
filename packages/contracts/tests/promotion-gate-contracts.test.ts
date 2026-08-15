import { describe, expect, test } from 'vitest';
import {
  PROMOTION_GATE_COMMAND_NAMES,
  PROMOTION_GATE_COMMAND_HASH_VERSION,
  canonicalizePromotionGateCommand,
  parsePromotionCommandReceiptV1,
  parsePromotionGateCommandEnvelopeV1,
  parsePromotionGateCommandResponseV1,
  parsePromotionGateInputV1,
  parsePromotionObjectiveSnapshotV1,
  parsePromotionFreshnessBasisV1,
  parseTaskContinuationPromotionInputV1,
  type PromotionCommandReceiptV1,
  type PromotionGateCommandEnvelopeV1,
  type PromotionGateCommandResponseV1,
} from '../src/promotion-gate.js';

const INVALID = /PROMOTION_GATE_PAYLOAD_INVALID/;

const objectiveSnapshot = {
  schemaVersion: 1,
  objective: '整理 Q3 需求文档',
  scope: 'team-docs 频道只读引用',
  riskLevel: 'low',
} as const;

const freshnessBasis = {
  schemaVersion: 1,
  sourceLineage: { kind: 'message', id: 'msg-1' },
} as const;

const promoteInput = {
  triggerKind: 'human-structured',
  channelId: 'ch-1',
  objectiveSnapshot,
  freshnessBasis,
};

const envelope: PromotionGateCommandEnvelopeV1 = {
  schemaVersion: 1,
  commandName: 'promote-to-task',
  commandSchemaVersion: 1,
  idempotencyKey: 'key-1',
};

const receipt: PromotionCommandReceiptV1 = {
  schemaVersion: 1,
  receiptId: 'rc-1',
  commandName: 'promote-to-task',
  commandSchemaVersion: 1,
  idempotencyKey: 'key-1',
  commandHash: 'hash-1',
  outcome: 'applied',
  committedRevisions: [{ streamKind: 'task', streamId: 'task-1', revision: 1 }],
  eventRefs: [{ streamKind: 'promotion', streamId: 'task-1', sequence: 1 }],
  commitTime: 1000,
  resultAvailable: true,
};

describe('promotion-gate capabilities', () => {
  test('freezes the Promotion command family (human trigger only; #922 scope)', () => {
    expect(PROMOTION_GATE_COMMAND_NAMES).toEqual([
      'promote-to-task',
      'create-task-continuation',
    ]);
    expect(PROMOTION_GATE_COMMAND_NAMES).toHaveLength(2);
  });
});

describe('parsePromotionObjectiveSnapshotV1', () => {
  test('parses a valid snapshot', () => {
    expect(parsePromotionObjectiveSnapshotV1(objectiveSnapshot)).toEqual(objectiveSnapshot);
  });
  test('rejects extra fields', () => {
    expect(() => parsePromotionObjectiveSnapshotV1({ ...objectiveSnapshot, secret: 'x' })).toThrow(INVALID);
  });
  test('rejects empty objective', () => {
    expect(() => parsePromotionObjectiveSnapshotV1({ ...objectiveSnapshot, objective: '' })).toThrow(INVALID);
  });
  test('rejects unknown riskLevel (closed enum)', () => {
    expect(() => parsePromotionObjectiveSnapshotV1({ ...objectiveSnapshot, riskLevel: 'critical' })).toThrow(INVALID);
  });
  test('parses snapshot with dataSnapshot', () => {
    const withData = { ...objectiveSnapshot, dataSnapshot: 'sha:abc' };
    expect(parsePromotionObjectiveSnapshotV1(withData)).toEqual(withData);
  });
});

describe('parsePromotionFreshnessBasisV1', () => {
  test('parses a valid basis', () => {
    expect(parsePromotionFreshnessBasisV1(freshnessBasis)).toEqual(freshnessBasis);
  });
  test('rejects unknown provenance kind', () => {
    expect(() => parsePromotionFreshnessBasisV1({
      ...freshnessBasis, sourceLineage: { kind: 'dm', id: 'msg-1' },
    })).toThrow(INVALID);
  });
  test('rejects missing sourceLineage', () => {
    const { sourceLineage: _s, ...rest } = freshnessBasis;
    expect(() => parsePromotionFreshnessBasisV1(rest)).toThrow(INVALID);
  });
});

describe('parsePromotionGateCommandEnvelopeV1', () => {
  test('parses a valid envelope', () => {
    expect(parsePromotionGateCommandEnvelopeV1(envelope)).toEqual(envelope);
  });
  test('rejects extra fields', () => {
    expect(() => parsePromotionGateCommandEnvelopeV1({ ...envelope, traceId: 't' })).toThrow(INVALID);
  });
  test('rejects unknown command name', () => {
    expect(() => parsePromotionGateCommandEnvelopeV1({ ...envelope, commandName: 'delete-task' })).toThrow(INVALID);
  });
  test('rejects missing idempotencyKey', () => {
    const { idempotencyKey: _k, ...rest } = envelope;
    expect(() => parsePromotionGateCommandEnvelopeV1(rest)).toThrow(INVALID);
  });
  test('rejects client-self-reported authority/scope fields (Server derives them, #900 §1/§18)', () => {
    expect(() => parsePromotionGateCommandEnvelopeV1({ ...envelope, teamId: 'team-1' })).toThrow(INVALID);
    expect(() => parsePromotionGateCommandEnvelopeV1({ ...envelope, requesterId: 'user-1' })).toThrow(INVALID);
    expect(() => parsePromotionGateCommandEnvelopeV1({ ...envelope, actor: 'admin' })).toThrow(INVALID);
  });
});

describe('parsePromotionGateInputV1', () => {
  test('parses promote-to-task input', () => {
    expect(parsePromotionGateInputV1(promoteInput)).toEqual(promoteInput);
  });
  test('parses input with optional rootMessageId + clientMessageId', () => {
    const input = { ...promoteInput, rootMessageId: 'msg-1', clientMessageId: 'trace-1' };
    expect(parsePromotionGateInputV1(input)).toEqual(input);
  });
  test('rejects input without objectiveSnapshot', () => {
    const { objectiveSnapshot: _o, ...rest } = promoteInput as Record<string, unknown>;
    expect(() => parsePromotionGateInputV1(rest)).toThrow(INVALID);
  });
  test('rejects input without freshnessBasis', () => {
    const { freshnessBasis: _f, ...rest } = promoteInput as Record<string, unknown>;
    expect(() => parsePromotionGateInputV1(rest)).toThrow(INVALID);
  });
  test('rejects invalid triggerKind (NL/@Agent/DM/Thread are NOT triggers, #894 §1)', () => {
    expect(() => parsePromotionGateInputV1({ ...promoteInput, triggerKind: 'natural-language' })).toThrow(INVALID);
    expect(() => parsePromotionGateInputV1({ ...promoteInput, triggerKind: 'mention' })).toThrow(INVALID);
  });
});

describe('parseTaskContinuationPromotionInputV1', () => {
  const continuationInput = {
    channelId: 'ch-1',
    rootMessageId: 'root-msg-1',
    sourceMessageId: 'source-msg-1',
    sourceTaskId: 'task-1',
    sourceTaskRevision: 3,
    sourceVersionIds: ['version-1', 'version-2'],
    objectiveSnapshot: {
      schemaVersion: 1,
      objective: '继续完善交付结果',
      scope: 'ch-1',
      riskLevel: 'low',
    },
  };

  test('严格解析终态 Task 的后续任务依据', () => {
    expect(parseTaskContinuationPromotionInputV1(continuationInput)).toEqual(continuationInput);
  });

  test('拒绝非正整数 revision、无序或重复的版本 ID', () => {
    expect(() => parseTaskContinuationPromotionInputV1({
      ...continuationInput,
      sourceTaskRevision: 0,
    })).toThrow(INVALID);
    expect(() => parseTaskContinuationPromotionInputV1({
      ...continuationInput,
      sourceVersionIds: ['version-2', 'version-1'],
    })).toThrow(INVALID);
    expect(() => parseTaskContinuationPromotionInputV1({
      ...continuationInput,
      sourceVersionIds: ['version-1', 'version-1'],
    })).toThrow(INVALID);
  });
});

describe('parsePromotionCommandReceiptV1', () => {
  test('parses a valid applied receipt', () => {
    expect(parsePromotionCommandReceiptV1(receipt)).toEqual(receipt);
  });
  test('parses a no_op receipt', () => {
    expect(parsePromotionCommandReceiptV1({ ...receipt, outcome: 'no_op' })).toEqual({ ...receipt, outcome: 'no_op' });
  });
  test('rejects receipt outcome outside applied/no_op (terminal receipt states only)', () => {
    expect(() => parsePromotionCommandReceiptV1({ ...receipt, outcome: 'freshness_hold' })).toThrow(INVALID);
  });
  test('rejects extra fields', () => {
    expect(() => parsePromotionCommandReceiptV1({ ...receipt, leaked: true })).toThrow(INVALID);
  });
});

describe('parsePromotionGateCommandResponseV1', () => {
  const appliedResponse: PromotionGateCommandResponseV1 = {
    schemaVersion: 1,
    commandName: 'promote-to-task',
    outcome: 'applied',
    retryDirective: 'none',
    stableCode: 'PROMOTION_ROOT_TASK_CREATED',
    receipt,
    result: {
      commandName: 'promote-to-task',
      rootTaskId: 'task-1',
      managementRunId: 'run-1',
      sourceRelationId: 'src-1',
      disposition: 'created',
    },
  };

  test('parses an applied response with result', () => {
    expect(parsePromotionGateCommandResponseV1(appliedResponse)).toEqual(appliedResponse);
  });
  test('parses an existing-disposition response (idempotent convergence, #894 §6)', () => {
    const existing = {
      ...appliedResponse,
      outcome: 'replayed',
      stableCode: 'PROMOTION_RETURNED_EXISTING_TASK',
      result: { ...appliedResponse.result, disposition: 'existing' },
    };
    expect(parsePromotionGateCommandResponseV1(existing)).toEqual(existing);
  });
  test('rejects result whose commandName mismatches the response', () => {
    expect(() => parsePromotionGateCommandResponseV1({
      ...appliedResponse,
      result: { commandName: 'send-message', rootTaskId: 'task-1' },
    })).toThrow(INVALID);
  });
  test('rejects unknown disposition (closed enum)', () => {
    expect(() => parsePromotionGateCommandResponseV1({
      ...appliedResponse,
      result: { ...appliedResponse.result, disposition: 'merged' },
    })).toThrow(INVALID);
  });
  test('parses a freshness_hold response (no Task created)', () => {
    const held: PromotionGateCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'promote-to-task',
      outcome: 'freshness_hold',
      retryDirective: 'same_key',
      stableCode: 'FRESHNESS_SOURCE_CHANGED',
      freshnessReason: 'source-message-edited',
    };
    expect(parsePromotionGateCommandResponseV1(held)).toEqual(held);
  });
  test('parses a conflict response (no side effects, #894 §6)', () => {
    const conflict: PromotionGateCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'promote-to-task',
      outcome: 'conflict',
      retryDirective: 'reread_then_new_command',
      stableCode: 'PROMOTION_CONFLICT',
      conflictReason: 'different-objective-snapshot',
    };
    expect(parsePromotionGateCommandResponseV1(conflict)).toEqual(conflict);
  });
  test('rejects unknown outcome (closed enum)', () => {
    expect(() => parsePromotionGateCommandResponseV1({ ...appliedResponse, outcome: 'partial' })).toThrow(INVALID);
  });
  test('rejects unknown retry directive', () => {
    expect(() => parsePromotionGateCommandResponseV1({ ...appliedResponse, retryDirective: 'retry_fast' })).toThrow(INVALID);
  });
  test('rejects empty stableCode', () => {
    expect(() => parsePromotionGateCommandResponseV1({ ...appliedResponse, stableCode: '' })).toThrow(INVALID);
  });
});

describe('canonicalizePromotionGateCommand', () => {
  test('same input yields same canonical string', () => {
    const a = canonicalizePromotionGateCommand('promote-to-task', 1, promoteInput);
    const b = canonicalizePromotionGateCommand('promote-to-task', 1, promoteInput);
    expect(a).toBe(b);
  });
  test('key insertion order does not affect canonical', () => {
    const ordered = canonicalizePromotionGateCommand('promote-to-task', 1, {
      triggerKind: 'human-structured',
      channelId: 'ch-1',
      objectiveSnapshot,
      freshnessBasis,
    });
    const reordered = canonicalizePromotionGateCommand('promote-to-task', 1, {
      channelId: 'ch-1',
      freshnessBasis,
      objectiveSnapshot,
      triggerKind: 'human-structured',
    });
    expect(ordered).toBe(reordered);
  });
  test('absent vs undefined optional fields are canonical-equivalent', () => {
    const without = canonicalizePromotionGateCommand('promote-to-task', 1, promoteInput);
    const withUndefined = canonicalizePromotionGateCommand('promote-to-task', 1, {
      ...promoteInput,
      rootMessageId: undefined,
      clientMessageId: undefined,
    });
    expect(without).toBe(withUndefined);
  });
  test('different objective yields different canonical', () => {
    const a = canonicalizePromotionGateCommand('promote-to-task', 1, promoteInput);
    const b = canonicalizePromotionGateCommand('promote-to-task', 1, {
      ...promoteInput,
      objectiveSnapshot: { ...objectiveSnapshot, objective: '另一个目标' },
    });
    expect(a).not.toBe(b);
  });
  test('different source lineage yields different canonical (lineage is convergence key, #894 §6)', () => {
    const a = canonicalizePromotionGateCommand('promote-to-task', 1, promoteInput);
    const b = canonicalizePromotionGateCommand('promote-to-task', 1, {
      ...promoteInput,
      freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-2' } },
    });
    expect(a).not.toBe(b);
  });
  test('idempotencyKey is NOT part of canonical (key is lookup, not content fingerprint)', () => {
    const canonical = canonicalizePromotionGateCommand('promote-to-task', 1, promoteInput);
    expect(canonical).not.toContain('idempotencyKey');
    expect(canonical).not.toContain('key-1');
  });
  test('clientMessageId is NOT part of canonical (source-tracking input, not content — #900 §21)', () => {
    const withClient = canonicalizePromotionGateCommand('promote-to-task', 1, { ...promoteInput, clientMessageId: 'trace-1' });
    const withoutClient = canonicalizePromotionGateCommand('promote-to-task', 1, promoteInput);
    expect(withClient).toBe(withoutClient);
    expect(withClient).not.toContain('clientMessageId');
  });
  test('stamps the hash version prefix so algorithm changes do not collide', () => {
    const canonical = canonicalizePromotionGateCommand('promote-to-task', 1, promoteInput);
    expect(canonical).toContain(`"v":${PROMOTION_GATE_COMMAND_HASH_VERSION}`);
  });
});
