import { describe, expect, test } from 'vitest';
import {
  MESSAGE_TRACER_COMMAND_NAMES,
  MESSAGE_TRACER_COMMAND_HASH_VERSION,
  canonicalizeMessageTracerCommand,
  parseCommandReceiptV1,
  parseMessageTargetRefV1,
  parseMessageTracerCommandEnvelopeV1,
  parseMessageTracerCommandResponseV1,
  parseMessageTracerInputV1,
  parseReadCandidateTokenV1,
  type CommandReceiptV1,
  type MessageTracerCommandEnvelopeV1,
  type MessageTracerCommandResponseV1,
  type ReadCandidateTokenV1,
} from '../src/message-tracer.js';

const INVALID = /MESSAGE_TRACER_PAYLOAD_INVALID/;

const mainlineTarget = { schemaVersion: 1, kind: 'channel-mainline', channelId: 'ch-1' } as const;
const threadTarget = { schemaVersion: 1, kind: 'thread', channelId: 'ch-1', threadId: 'msg-root' } as const;
const dmTarget = { schemaVersion: 1, kind: 'dm', channelId: 'dm-1' } as const;
const dmThreadTarget = { schemaVersion: 1, kind: 'dm-thread', channelId: 'dm-1', threadId: 'msg-root' } as const;

const token: ReadCandidateTokenV1 = {
  schemaVersion: 1,
  recipientId: 'user-1',
  target: dmTarget,
  targetSeq: 3,
  issuedAt: 1000,
  proof: 'hmac-proof',
};

const sendMessageInput = {
  channelId: 'ch-1',
  senderKind: 'human',
  body: 'hello',
  freshnessBasis: { schemaVersion: 1, target: mainlineTarget },
};

const envelope: MessageTracerCommandEnvelopeV1 = {
  schemaVersion: 1,
  commandName: 'send-message',
  commandSchemaVersion: 1,
  idempotencyKey: 'key-1',
};

const receipt: CommandReceiptV1 = {
  schemaVersion: 1,
  receiptId: 'rc-1',
  commandName: 'send-message',
  commandSchemaVersion: 1,
  idempotencyKey: 'key-1',
  commandHash: 'hash-1',
  outcome: 'applied',
  committedRevisions: [{ streamKind: 'message', streamId: 'msg-1', revision: 1 }],
  eventRefs: [{ streamKind: 'message', streamId: 'msg-1', sequence: 1 }],
  commitTime: 1000,
  resultAvailable: true,
};

describe('message-tracer capabilities', () => {
  test('freezes the Message/Read/attention command family', () => {
    expect(MESSAGE_TRACER_COMMAND_NAMES).toEqual(['send-message', 'check-inbox', 'ack-read-candidate']);
    expect(MESSAGE_TRACER_COMMAND_NAMES).toHaveLength(3);
  });
});

describe('parseMessageTargetRefV1', () => {
  test('parses a valid mainline target', () => {
    expect(parseMessageTargetRefV1(mainlineTarget)).toEqual(mainlineTarget);
  });
  test('rejects extra fields', () => {
    expect(() => parseMessageTargetRefV1({ ...mainlineTarget, secret: 'x' })).toThrow(INVALID);
  });
  test('rejects missing channelId', () => {
    const { channelId: _channelId, ...rest } = mainlineTarget;
    expect(() => parseMessageTargetRefV1(rest)).toThrow(INVALID);
  });
  test('thread requires threadId', () => {
    expect(() => parseMessageTargetRefV1({ schemaVersion: 1, kind: 'thread', channelId: 'ch-1' })).toThrow(INVALID);
  });
  test('dm-thread requires threadId', () => {
    expect(() => parseMessageTargetRefV1({ schemaVersion: 1, kind: 'dm-thread', channelId: 'dm-1' })).toThrow(INVALID);
  });
  test('mainline forbids threadId', () => {
    expect(() => parseMessageTargetRefV1({ ...mainlineTarget, threadId: 'msg-root' })).toThrow(INVALID);
  });
  test('dm forbids threadId', () => {
    expect(() => parseMessageTargetRefV1({ ...dmTarget, threadId: 'msg-root' })).toThrow(INVALID);
  });
  test('parses all four target kinds when correctly paired', () => {
    expect(parseMessageTargetRefV1(threadTarget)).toEqual(threadTarget);
    expect(parseMessageTargetRefV1(dmTarget)).toEqual(dmTarget);
    expect(parseMessageTargetRefV1(dmThreadTarget)).toEqual(dmThreadTarget);
  });
});

describe('parseReadCandidateTokenV1', () => {
  test('parses a valid token', () => {
    expect(parseReadCandidateTokenV1(token)).toEqual(token);
  });
  test('rejects empty proof', () => {
    expect(() => parseReadCandidateTokenV1({ ...token, proof: '' })).toThrow(INVALID);
  });
  test('rejects missing target', () => {
    const { target: _target, ...rest } = token;
    expect(() => parseReadCandidateTokenV1(rest)).toThrow(INVALID);
  });
});

describe('parseMessageTracerCommandEnvelopeV1', () => {
  test('parses a valid envelope', () => {
    expect(parseMessageTracerCommandEnvelopeV1(envelope)).toEqual(envelope);
  });
  test('rejects extra fields', () => {
    expect(() => parseMessageTracerCommandEnvelopeV1({ ...envelope, traceId: 't' })).toThrow(INVALID);
  });
  test('rejects unknown command name', () => {
    expect(() => parseMessageTracerCommandEnvelopeV1({ ...envelope, commandName: 'delete-message' })).toThrow(INVALID);
  });
  test('rejects missing idempotencyKey', () => {
    const { idempotencyKey: _k, ...rest } = envelope;
    expect(() => parseMessageTracerCommandEnvelopeV1(rest)).toThrow(INVALID);
  });
  test('rejects client-self-reported authority/scope fields (Server derives them, #900 §1/§18)', () => {
    expect(() => parseMessageTracerCommandEnvelopeV1({ ...envelope, teamId: 'team-1' })).toThrow(INVALID);
    expect(() => parseMessageTracerCommandEnvelopeV1({ ...envelope, authoritySubject: 'user-1' })).toThrow(INVALID);
    expect(() => parseMessageTracerCommandEnvelopeV1({ ...envelope, actor: 'admin' })).toThrow(INVALID);
  });
});

describe('parseMessageTracerInputV1', () => {
  test('parses send-message input', () => {
    expect(parseMessageTracerInputV1('send-message', sendMessageInput)).toEqual(sendMessageInput);
  });
  test('parses an exact task continuation source marker', () => {
    const input = {
      ...sendMessageInput,
      taskContinuationSource: {
        schemaVersion: 1,
        sourceTaskId: 'task-1',
        sourceTaskRevision: 2,
      },
    } as const;
    expect(parseMessageTracerInputV1('send-message', input)).toEqual(input);
  });
  test('rejects an invalid task continuation source marker', () => {
    expect(() => parseMessageTracerInputV1('send-message', {
      ...sendMessageInput,
      taskContinuationSource: { schemaVersion: 1, sourceTaskId: 'task-1', sourceTaskRevision: 0 },
    })).toThrow(INVALID);
    expect(() => parseMessageTracerInputV1('send-message', {
      ...sendMessageInput,
      taskContinuationSource: { schemaVersion: 1, sourceTaskId: 'task-1', sourceTaskRevision: 2, trusted: true },
    })).toThrow(INVALID);
  });
  test('rejects send-message without freshnessBasis', () => {
    const { freshnessBasis: _f, ...rest } = sendMessageInput as Record<string, unknown>;
    expect(() => parseMessageTracerInputV1('send-message', rest)).toThrow(INVALID);
  });
  test('rejects send-message with empty body', () => {
    expect(() => parseMessageTracerInputV1('send-message', { ...sendMessageInput, body: '' })).toThrow(INVALID);
  });
  test('rejects send-message with invalid senderKind', () => {
    expect(() => parseMessageTracerInputV1('send-message', { ...sendMessageInput, senderKind: 'bot' })).toThrow(INVALID);
  });
  test('parses check-inbox input', () => {
    const input = { recipientId: 'user-1', target: mainlineTarget, limit: 20 };
    expect(parseMessageTracerInputV1('check-inbox', input)).toEqual(input);
  });
  test('rejects check-inbox with limit < 1', () => {
    expect(() => parseMessageTracerInputV1('check-inbox', { recipientId: 'user-1', target: mainlineTarget, limit: 0 })).toThrow(INVALID);
  });
  test('parses ack-read-candidate input', () => {
    const input = { readCandidate: token };
    expect(parseMessageTracerInputV1('ack-read-candidate', input)).toEqual(input);
  });
  test('rejects ack-read-candidate without token', () => {
    expect(() => parseMessageTracerInputV1('ack-read-candidate', {})).toThrow(INVALID);
  });
});

describe('parseCommandReceiptV1', () => {
  test('parses a valid applied receipt', () => {
    expect(parseCommandReceiptV1(receipt)).toEqual(receipt);
  });
  test('parses a no_op receipt', () => {
    expect(parseCommandReceiptV1({ ...receipt, outcome: 'no_op' })).toEqual({ ...receipt, outcome: 'no_op' });
  });
  test('rejects receipt outcome outside applied/no_op (terminal receipt states only)', () => {
    expect(() => parseCommandReceiptV1({ ...receipt, outcome: 'freshness_hold' })).toThrow(INVALID);
  });
  test('rejects extra fields', () => {
    expect(() => parseCommandReceiptV1({ ...receipt, leaked: true })).toThrow(INVALID);
  });
});

describe('parseMessageTracerCommandResponseV1', () => {
  const appliedResponse: MessageTracerCommandResponseV1 = {
    schemaVersion: 1,
    commandName: 'send-message',
    outcome: 'applied',
    retryDirective: 'none',
    stableCode: 'MESSAGE_DELIVERED',
    receipt,
    result: { commandName: 'send-message', messageId: 'msg-1', targetSeq: 5, inboxItemRecipientIds: ['user-2'] },
  };

  test('parses an applied response with result', () => {
    expect(parseMessageTracerCommandResponseV1(appliedResponse)).toEqual(appliedResponse);
  });
  test('parses a check-inbox response carrying audienceScope + asOf query metadata (#900 §11)', () => {
    const check: MessageTracerCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'check-inbox',
      outcome: 'applied',
      retryDirective: 'none',
      stableCode: 'INBOX_PREFIX_RETURNED',
      result: {
        commandName: 'check-inbox', recipientId: 'user-1', target: mainlineTarget, items: [],
        readCandidate: token, audienceScope: 'team-1', asOf: 1000,
      },
    };
    expect(parseMessageTracerCommandResponseV1(check)).toEqual(check);
  });
  test('rejects result whose commandName mismatches the response', () => {
    expect(() => parseMessageTracerCommandResponseV1({
      ...appliedResponse,
      result: { commandName: 'check-inbox', recipientId: 'user-1', target: mainlineTarget, items: [], readCandidate: token, audienceScope: 'team-1', asOf: 1000 },
    })).toThrow(INVALID);
  });
  test('parses a freshness_hold response (no Message produced)', () => {
    const held: MessageTracerCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'send-message',
      outcome: 'freshness_hold',
      retryDirective: 'same_key',
      stableCode: 'FRESHNESS_RELEVANT_CHANGE',
      heldTarget: mainlineTarget,
      heldReason: 'new-relevant-message',
      newReadCandidate: token,
    };
    expect(parseMessageTracerCommandResponseV1(held)).toEqual(held);
  });
  test('parses a conflict response', () => {
    const conflict: MessageTracerCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'send-message',
      outcome: 'conflict',
      retryDirective: 'reread_then_new_command',
      stableCode: 'IDEMPOTENCY_CONFLICT',
      conflictReason: 'different-canonical-hash',
    };
    expect(parseMessageTracerCommandResponseV1(conflict)).toEqual(conflict);
  });
  test('rejects unknown outcome (closed enum)', () => {
    expect(() => parseMessageTracerCommandResponseV1({ ...appliedResponse, outcome: 'partial' })).toThrow(INVALID);
  });
  test('rejects unknown retry directive', () => {
    expect(() => parseMessageTracerCommandResponseV1({ ...appliedResponse, retryDirective: 'retry_fast' })).toThrow(INVALID);
  });
  test('rejects empty stableCode', () => {
    expect(() => parseMessageTracerCommandResponseV1({ ...appliedResponse, stableCode: '' })).toThrow(INVALID);
  });
});

describe('canonicalizeMessageTracerCommand', () => {
  test('same input yields same canonical string', () => {
    const a = canonicalizeMessageTracerCommand('send-message', 1, sendMessageInput);
    const b = canonicalizeMessageTracerCommand('send-message', 1, sendMessageInput);
    expect(a).toBe(b);
  });
  test('key insertion order does not affect canonical', () => {
    const ordered = canonicalizeMessageTracerCommand('send-message', 1, {
      channelId: 'ch-1',
      senderKind: 'human',
      body: 'hello',
      freshnessBasis: { schemaVersion: 1, target: mainlineTarget },
    });
    const reordered = canonicalizeMessageTracerCommand('send-message', 1, {
      body: 'hello',
      freshnessBasis: { schemaVersion: 1, target: mainlineTarget },
      channelId: 'ch-1',
      senderKind: 'human',
    });
    expect(ordered).toBe(reordered);
  });
  test('absent vs undefined optional fields are canonical-equivalent', () => {
    const without = canonicalizeMessageTracerCommand('send-message', 1, sendMessageInput);
    const withUndefined = canonicalizeMessageTracerCommand('send-message', 1, {
      ...sendMessageInput,
      threadId: undefined,
      mentions: undefined,
    });
    expect(without).toBe(withUndefined);
  });
  test('different body yields different canonical', () => {
    const a = canonicalizeMessageTracerCommand('send-message', 1, sendMessageInput);
    const b = canonicalizeMessageTracerCommand('send-message', 1, { ...sendMessageInput, body: 'goodbye' });
    expect(a).not.toBe(b);
  });
  test('idempotencyKey is NOT part of canonical (key is lookup, not content fingerprint)', () => {
    // canonicalize only takes (commandName, schemaVersion, input) — key is structurally excluded
    const canonical = canonicalizeMessageTracerCommand('send-message', 1, sendMessageInput);
    expect(canonical).not.toContain('idempotencyKey');
    expect(canonical).not.toContain('key-1');
  });
  test('clientMessageId is NOT part of canonical (source-tracking input, not content — #900 §21)', () => {
    const withClient = canonicalizeMessageTracerCommand('send-message', 1, { ...sendMessageInput, clientMessageId: 'trace-1' });
    const withoutClient = canonicalizeMessageTracerCommand('send-message', 1, sendMessageInput);
    expect(withClient).toBe(withoutClient);
    expect(withClient).not.toContain('clientMessageId');
  });
  test('stamps the hash version prefix so algorithm changes do not collide', () => {
    const canonical = canonicalizeMessageTracerCommand('send-message', 1, sendMessageInput);
    expect(canonical).toContain(`"v":${MESSAGE_TRACER_COMMAND_HASH_VERSION}`);
  });
  test('different commandName yields different canonical', () => {
    const a = canonicalizeMessageTracerCommand('send-message', 1, sendMessageInput);
    const b = canonicalizeMessageTracerCommand('check-inbox', 1, { recipientId: 'user-1', target: mainlineTarget, limit: 20 });
    expect(a).not.toBe(b);
  });
});
