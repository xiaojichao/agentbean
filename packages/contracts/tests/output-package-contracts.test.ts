import { describe, expect, test } from 'vitest';
import { WEB_EVENTS } from '../src/socket.js';
import {
  OUTPUT_PACKAGE_COMMAND_HASH_VERSION,
  OUTPUT_PACKAGE_COMMAND_NAMES,
  OUTPUT_PACKAGE_QUERY_NAMES,
  OUTPUT_PACKAGE_REJECTION_REASONS,
  canonicalizeOutputPackageCommand,
  parseOutputPackageCommandEnvelopeV1,
  parseOutputPackageCommandResponseV1,
  parseOutputPackageDto,
  parseOutputPackageQueryInputV1,
  parseOutputPackageQueryResponseV1,
  parseOutputPackageReceiptV1,
  parseRecordAgentOutputPackageInputV1,
  type OutputPackageCommandEnvelopeV1,
  type OutputPackageDto,
  type OutputPackageReceiptV1,
} from '../src/output-package.js';

const INVALID = /OUTPUT_PACKAGE_PAYLOAD_INVALID/;

const member = {
  packageId: 'pkg-1',
  sequence: 1,
  shortLabel: 'F1',
  collectionId: 'col-1',
  artifactVersionId: 'ver-1',
  role: 'deliverable',
  requiredForFinal: true,
  sourcePath: 'storyboard/ep1.md',
  filename: 'ep1.md',
  sha256: 'abc',
  sizeBytes: 128,
} as const;

const pkg: OutputPackageDto = {
  schemaVersion: 1,
  packageId: 'pkg-1',
  teamId: 'team-1',
  channelId: 'ch-1',
  revision: 1,
  deliveryId: 'del-1',
  publishId: 'pub-1',
  workspaceRevisionId: 'rev-1',
  agentId: 'agent-1',
  taskId: 'task-1',
  taskBinding: 'managed',
  taskRevision: 3,
  taskAttempt: 2,
  invocationId: 'inv-1',
  workspaceRunId: 'run-1',
  claimLeaseId: 'lease-1',
  deviceId: 'dev-1',
  members: [member],
  memberCount: 1,
  status: 'recorded',
  createdAt: 1000,
};

const recordInput = {
  channelId: 'ch-1',
  publishId: 'pub-1',
  workspaceRevisionId: 'rev-1',
} as const;

const envelope: OutputPackageCommandEnvelopeV1 = {
  schemaVersion: 1,
  commandName: 'record-agent-output-package',
  commandSchemaVersion: 1,
  idempotencyKey: 'record-agent-output-package:ch-1:pub-1',
};

const receipt: OutputPackageReceiptV1 = {
  schemaVersion: 1,
  receiptId: 'rc-1',
  commandName: 'record-agent-output-package',
  commandSchemaVersion: 1,
  idempotencyKey: envelope.idempotencyKey,
  commandHash: 'hash-1',
  outcome: 'applied',
  committedRevisions: [{ streamKind: 'output-package', streamId: 'pkg-1', revision: 1 }],
  eventRefs: [],
  commitTime: 1000,
  resultAvailable: true,
};

describe('output-package capabilities', () => {
  test('freezes the OutputPackage command family (#1060)', () => {
    expect(OUTPUT_PACKAGE_COMMAND_NAMES).toEqual(['record-agent-output-package']);
    expect(OUTPUT_PACKAGE_COMMAND_NAMES).toHaveLength(1);
  });
  test('freezes the OutputPackage query family', () => {
    expect(OUTPUT_PACKAGE_QUERY_NAMES).toEqual(['get-output-package', 'list-channel-output-packages']);
  });
  test('freezes structured rejection reasons', () => {
    expect(OUTPUT_PACKAGE_REJECTION_REASONS).toContain('workspace-revision-not-committed');
    expect(OUTPUT_PACKAGE_REJECTION_REASONS).toContain('task-attempt-superseded');
    expect(OUTPUT_PACKAGE_REJECTION_REASONS).toContain('duplicate-manifest-entry');
  });
  test('exposes the two project socket query events under WEB_EVENTS.project', () => {
    expect(WEB_EVENTS.project.listOutputPackages).toBe('project:list-output-packages');
    expect(WEB_EVENTS.project.getOutputPackage).toBe('project:get-output-package');
  });
});

describe('parseOutputPackageCommandEnvelopeV1', () => {
  test('parses a valid envelope', () => {
    expect(parseOutputPackageCommandEnvelopeV1(envelope)).toEqual(envelope);
  });
  test('rejects authority self-report fields (teamId/requesterId/actor)', () => {
    expect(() => parseOutputPackageCommandEnvelopeV1({ ...envelope, teamId: 'team-1' })).toThrow(INVALID);
    expect(() => parseOutputPackageCommandEnvelopeV1({ ...envelope, requesterId: 'u-1' })).toThrow(INVALID);
  });
  test('rejects unknown command name', () => {
    expect(() => parseOutputPackageCommandEnvelopeV1({ ...envelope, commandName: 'drop-package' })).toThrow(INVALID);
  });
  test('rejects future commandSchemaVersion', () => {
    expect(() => parseOutputPackageCommandEnvelopeV1({ ...envelope, commandSchemaVersion: 2 })).toThrow(INVALID);
  });
  test('accepts provenance refs', () => {
    const withRefs = { ...envelope, causationRef: { kind: 'workspace-run', id: 'run-1' } };
    expect(parseOutputPackageCommandEnvelopeV1(withRefs)).toEqual(withRefs);
  });
});

describe('parseRecordAgentOutputPackageInputV1', () => {
  test('parses a valid input', () => {
    expect(parseRecordAgentOutputPackageInputV1(recordInput)).toEqual(recordInput);
  });
  test('rejects extra fields (provenance must be server-derived)', () => {
    expect(() => parseRecordAgentOutputPackageInputV1({ ...recordInput, agentId: 'agent-9' })).toThrow(INVALID);
    expect(() => parseRecordAgentOutputPackageInputV1({ ...recordInput, taskRevision: 1 })).toThrow(INVALID);
  });
  test('rejects missing target identity', () => {
    expect(() => parseRecordAgentOutputPackageInputV1({ channelId: 'ch-1', publishId: 'pub-1' })).toThrow(INVALID);
  });
});

describe('parseOutputPackageDto', () => {
  test('parses a managed package with frozen members', () => {
    expect(parseOutputPackageDto(pkg)).toEqual(pkg);
  });
  test('parses an unmanaged package (optional lineage absent)', () => {
    const unmanaged = {
      ...pkg, taskBinding: 'unmanaged', members: [member], memberCount: 1,
    };
    delete (unmanaged as Record<string, unknown>).taskRevision;
    delete (unmanaged as Record<string, unknown>).invocationId;
    delete (unmanaged as Record<string, unknown>).workspaceRunId;
    delete (unmanaged as Record<string, unknown>).claimLeaseId;
    delete (unmanaged as Record<string, unknown>).deviceId;
    expect(parseOutputPackageDto(unmanaged)).toEqual(unmanaged);
  });
  test('rejects memberCount/members length mismatch', () => {
    expect(() => parseOutputPackageDto({ ...pkg, memberCount: 2 })).toThrow(INVALID);
  });
  test('rejects unknown member role (closed enum)', () => {
    expect(() => parseOutputPackageDto({ ...pkg, members: [{ ...member, role: 'primary' }] })).toThrow(INVALID);
  });
  test('rejects unknown taskBinding', () => {
    expect(() => parseOutputPackageDto({ ...pkg, taskBinding: 'synthetic' })).toThrow(INVALID);
  });
});

describe('parseOutputPackageReceiptV1 / command response', () => {
  test('parses a valid receipt', () => {
    expect(parseOutputPackageReceiptV1(receipt)).toEqual(receipt);
  });
  test('parses an applied response with result', () => {
    const response = {
      schemaVersion: 1,
      commandName: 'record-agent-output-package',
      outcome: 'applied',
      retryDirective: 'none',
      stableCode: 'OK',
      receipt,
      result: { commandName: 'record-agent-output-package', package: pkg, disposition: 'created' },
    };
    expect(parseOutputPackageCommandResponseV1(response)).toEqual(response);
  });
  test('parses a rejected response with structured reason', () => {
    const response = {
      schemaVersion: 1,
      commandName: 'record-agent-output-package',
      outcome: 'rejected',
      retryDirective: 'none',
      stableCode: 'OUTPUT_PACKAGE_REJECTED',
      rejectedReason: 'task-attempt-superseded',
    };
    expect(parseOutputPackageCommandResponseV1(response)).toEqual(response);
  });
  test('rejects result/commandName mismatch', () => {
    const response = {
      schemaVersion: 1,
      commandName: 'record-agent-output-package',
      outcome: 'applied',
      retryDirective: 'none',
      stableCode: 'OK',
      result: { commandName: 'other-command', package: pkg, disposition: 'created' },
    };
    expect(() => parseOutputPackageCommandResponseV1(response)).toThrow(INVALID);
  });
});

describe('query parsers', () => {
  test('get-output-package input', () => {
    expect(parseOutputPackageQueryInputV1('get-output-package', { channelId: 'ch-1', packageId: 'pkg-1' }))
      .toEqual({ channelId: 'ch-1', packageId: 'pkg-1' });
    // 缺 channelId(目标频道)拒绝。
    expect(() => parseOutputPackageQueryInputV1('get-output-package', { packageId: 'pkg-1' })).toThrow(INVALID);
  });
  test('list input with cursor/limit/taskId/minimumConsistency', () => {
    const input = {
      channelId: 'ch-1',
      taskId: 'task-1',
      cursor: 'abc',
      limit: 20,
      minimumConsistency: { schemaVersion: 1, entries: [{ streamKind: 'output-package', streamId: 'pkg-1', revision: 1 }] },
    };
    expect(parseOutputPackageQueryInputV1('list-channel-output-packages', input)).toEqual(input);
  });
  test('rejects unknown query name', () => {
    expect(() => parseOutputPackageQueryInputV1('drop-package' as never, { packageId: 'x' })).toThrow(INVALID);
  });
  test('list response with pendingDeliveries', () => {
    const response = {
      schemaVersion: 1,
      queryName: 'list-channel-output-packages',
      outcome: 'ready',
      stableCode: 'OK',
      audienceScope: 'team-1:ch-1',
      asOf: 2000,
      result: {
        queryName: 'list-channel-output-packages',
        packages: [{
          schemaVersion: 1, packageId: 'pkg-1', teamId: 'team-1', channelId: 'ch-1', revision: 1,
          deliveryId: 'del-1', publishId: 'pub-1', workspaceRevisionId: 'rev-1',
          agentId: 'agent-1', taskId: 'task-1', taskBinding: 'managed', taskRevision: 3,
          taskAttempt: 2, memberCount: 1, reviewState: 'pending', status: 'recorded', createdAt: 1000,
        }],
        pendingDeliveries: [{
          publishId: 'pub-2', workspaceRevisionId: 'rev-2', agentId: 'agent-1',
          taskId: 'task-1', taskAttempt: 3, committedAt: 1500,
        }],
        nextCursor: 'cursor-2',
      },
    };
    expect(parseOutputPackageQueryResponseV1(response)).toEqual(response);
  });
  test('rejected query response', () => {
    const response = {
      schemaVersion: 1,
      queryName: 'get-output-package',
      outcome: 'rejected',
      stableCode: 'OUTPUT_PACKAGE_NOT_FOUND',
      audienceScope: 'team-1:ch-1',
      asOf: 2000,
      rejectedReason: 'output-package-not-found',
    };
    expect(parseOutputPackageQueryResponseV1(response)).toEqual(response);
  });
});

describe('canonicalizeOutputPackageCommand', () => {
  test('is stable across key order', () => {
    const a = canonicalizeOutputPackageCommand('record-agent-output-package', 1, recordInput);
    const b = canonicalizeOutputPackageCommand('record-agent-output-package', 1, {
      workspaceRevisionId: 'rev-1', publishId: 'pub-1', channelId: 'ch-1',
    });
    expect(a).toBe(b);
    expect(a).toContain(`"v":${OUTPUT_PACKAGE_COMMAND_HASH_VERSION}`);
  });
  test('different payload → different canonical string', () => {
    const a = canonicalizeOutputPackageCommand('record-agent-output-package', 1, recordInput);
    const b = canonicalizeOutputPackageCommand('record-agent-output-package', 1, { ...recordInput, publishId: 'pub-2' });
    expect(a).not.toBe(b);
  });
});
