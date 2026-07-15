import { describe, expect, test } from 'vitest';

import {
  AGENT_EVENTS,
  MANAGEMENT_WORKER_PAYLOAD_KINDS,
  PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES,
  parseManagementWorkerPayload,
  safeParseManagementWorkerPayload,
  type ManagementWorkerPayloadMapV1,
} from '../src/index.js';

const authority = {
  managementRunId: 'run-1',
  workerId: 'worker-1',
  leaseToken: 'lease-token-current',
  fencingToken: 3,
  idempotencyKey: 'command-key-1',
};

const context = {
  schemaVersion: 1 as const,
  teamId: 'team-1',
  channelId: 'channel-1',
  rootMessageId: 'message-1',
  frozenTarget: { agentId: 'agent-1', kind: 'custom' as const },
  visibleThread: {
    revision: 2,
    messages: [{
      id: 'message-1',
      senderKind: 'human' as const,
      senderId: 'user-1',
      body: 'Please handle this request.',
      createdAt: 100,
    }],
  },
};

const validPayloads: { [K in keyof ManagementWorkerPayloadMapV1]: ManagementWorkerPayloadMapV1[K] } = {
  register: {
    schemaVersion: 1,
    workerInstanceId: 'instance-1',
    profileId: 'profile-1',
    runtimeVersion: '0.1.0',
    supportedProtocolVersions: [1],
    supportedPhases: [1],
    credentialStatus: 'production_ready',
    providerId: 'anthropic',
    modelId: 'claude-sonnet',
    capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
  },
  'register-ack': {
    schemaVersion: 1,
    ok: true,
    workerId: 'worker-1',
    protocolVersion: 1,
  },
  'lease-offer': {
    schemaVersion: 1,
    offerId: 'offer-1',
    managementRunId: 'run-1',
    workerId: 'worker-1',
    offerExpiresAt: 200,
  },
  'lease-acquire': {
    schemaVersion: 1,
    offerId: 'offer-1',
    workerInstanceId: 'instance-1',
  },
  'lease-acquire-ack': {
    schemaVersion: 1,
    ok: true,
    managementRunId: 'run-1',
    workerId: 'worker-1',
    leaseToken: 'lease-token-current',
    fencingToken: 3,
    acquiredAt: 110,
    expiresAt: 170,
  },
  'lease-renew': {
    schemaVersion: 1,
    ...authority,
  },
  'lease-renew-ack': {
    schemaVersion: 1,
    ok: true,
    managementRunId: 'run-1',
    workerId: 'worker-1',
    fencingToken: 3,
    expiresAt: 230,
  },
  'lease-release': {
    schemaVersion: 1,
    ...authority,
    reasonCode: 'worker_shutdown',
  },
  'lease-release-ack': {
    schemaVersion: 1,
    ok: true,
    managementRunId: 'run-1',
    workerId: 'worker-1',
    fencingToken: 3,
    releasedAt: 150,
  },
  abort: {
    schemaVersion: 1,
    managementRunId: 'run-1',
    workerId: 'worker-1',
    leaseToken: 'lease-token-current',
    fencingToken: 3,
    idempotencyKey: 'abort-key-1',
    reasonCode: 'user_cancelled',
  },
  'tool-request': {
    schemaVersion: 1,
    commandId: 'command-1',
    ...authority,
    toolCallId: 'tool-call-1',
    toolName: 'agents.invoke',
    input: {
      objective: 'Handle the explicit target request.',
      attachmentIds: ['artifact-1'],
      deadlineAt: 500,
    },
  },
  'tool-result': {
    schemaVersion: 1,
    commandId: 'command-1',
    managementRunId: 'run-1',
    workerId: 'worker-1',
    toolCallId: 'tool-call-1',
    toolName: 'agents.invoke',
    ok: true,
    output: { invocationId: 'invocation-1', status: 'pending' },
  },
  'checkpoint-fetch': {
    schemaVersion: 1,
    managementRunId: 'run-1',
    workerId: 'worker-1',
    leaseToken: 'lease-token-current',
    fencingToken: 3,
    knownCheckpointRevision: 2,
  },
  'checkpoint-result': {
    schemaVersion: 1,
    managementRunId: 'run-1',
    workerId: 'worker-1',
    context,
    checkpoint: {
      schemaVersion: 1,
      managementRunId: 'run-1',
      revision: 2,
      authoritative: {
        lastEventSequence: 8,
        taskGraphRevision: 0,
        openTaskIds: [],
        waitingInvocationIds: ['invocation-1'],
        completedInvocationIds: [],
        memoryCapsuleIds: [],
      },
      contextHints: {
        objective: 'Handle the explicit target request.',
        planSummary: 'Wait for the invocation.',
        completedInvocationSummaries: [],
        unresolvedQuestions: [],
        nextAction: 'Wait',
      },
      updatedAt: 120,
    },
  },
  'outbox-replay': {
    schemaVersion: 1,
    commandId: 'command-1',
    requestHash: 'sha256:request-1',
    ...authority,
  },
  'outbox-replay-ack': {
    schemaVersion: 1,
    commandId: 'command-1',
    managementRunId: 'run-1',
    idempotencyKey: 'command-key-1',
    disposition: 'existing',
    resultReferenceId: 'invocation-1',
  },
  'shadow-evaluate': {
    schemaVersion: 1,
    shadowRequestKey: 'shadow:request-1',
    workerId: 'worker-1',
    inputHash: 'sha256:shadow-input',
    objective: 'Evaluate the direct request without side effects.',
    context,
  },
  'shadow-result': {
    schemaVersion: 1,
    shadowRequestKey: 'shadow:request-1',
    workerId: 'worker-1',
    inputHash: 'sha256:shadow-input',
    objectiveHash: 'sha256:shadow-objective',
    frozenTarget: { agentId: 'agent-1', kind: 'custom' },
    proposedTools: [{ sequence: 1, name: 'agents.invoke', argumentHash: 'sha256:args' }],
    diagnosticCodes: [],
    completedAt: 160,
  },
};

describe('Phase 1 management Worker contracts', () => {
  test('freezes management-worker socket events outside the Team Agent namespace', () => {
    expect(AGENT_EVENTS.managementWorker).toEqual({
      register: 'management-worker:register',
      leaseOffer: 'management-worker:lease-offer',
      leaseAcquire: 'management-worker:lease-acquire',
      leaseRenew: 'management-worker:lease-renew',
      leaseRelease: 'management-worker:lease-release',
      abort: 'management-worker:abort',
      toolRequest: 'management-worker:tool-request',
      checkpointFetch: 'management-worker:checkpoint-fetch',
      outboxReplay: 'management-worker:outbox-replay',
      shadowEvaluate: 'management-worker:shadow-evaluate',
      shadowResult: 'management-worker:shadow-result',
    });
    expect(AGENT_EVENTS.agent).not.toHaveProperty('manager');
  });

  test('parses every closed payload kind through the public runtime seam', () => {
    expect(MANAGEMENT_WORKER_PAYLOAD_KINDS).toEqual(Object.keys(validPayloads));
    for (const kind of MANAGEMENT_WORKER_PAYLOAD_KINDS) {
      expect(parseManagementWorkerPayload(kind, validPayloads[kind])).toEqual(validPayloads[kind]);
    }
  });

  test('freezes the eleven Phase 1 tools and rejects later-phase tools', () => {
    expect(PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES).toEqual([
      'context.get_root_message',
      'context.get_root_task',
      'context.get_visible_thread',
      'context.get_management_state',
      'agents.list_capabilities',
      'agents.get_status',
      'agents.invoke',
      'agents.cancel_invocation',
      'channel.post_management_status',
      'user.request_input',
      'review.submit_root_delivery',
    ]);
    const candidate = structuredClone(validPayloads['tool-request']) as Record<string, unknown>;
    candidate.toolName = 'tasks.create_subtasks';
    expect(safeParseManagementWorkerPayload('tool-request', candidate)).toEqual({
      ok: false,
      error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: '$.toolName' },
    });
  });

  test('parses the optional Phase 2 collaboration state on the shared management-state read', () => {
    const result = structuredClone(validPayloads['tool-result']) as Record<string, unknown>;
    result.toolName = 'context.get_management_state';
    result.output = {
      status: 'running', checkpointRevision: 1, lastEventSequence: 4,
      mainAgentId: 'agent-a', activeAgentId: 'agent-b', collaborationMode: 'handoff',
      collaborationProposals: [{ proposalId: 'proposal-1', sourceInvocationId: 'invocation-a',
        sourceAgentId: 'agent-a', toAgentId: 'agent-b', kind: 'continuation',
        objective: '继续收尾', reason: 'B 更适合', contextRefIds: ['message-1'],
        dependencyInvocationIds: [], attachmentIds: [], acceptanceCriteria: [],
        returnMode: 'deliver_to_root' }],
      handoffs: [{ handoffId: 'handoff-1', invocationId: 'invocation-b', fromAgentId: 'agent-a',
        toAgentId: 'agent-b', kind: 'continuation', status: 'accepted' }],
    };
    expect(parseManagementWorkerPayload('tool-result', result)).toEqual(result);
  });

  test('parses every Phase 1 tool shape and rejects nested argument drift', () => {
    for (const toolName of PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES) {
      const request = validToolRequest(toolName);
      expect(safeParseManagementWorkerPayload('tool-request', request)).toEqual({
        ok: true,
        value: request,
      });
      const candidate = structuredClone(request) as Record<string, unknown>;
      candidate.input = { ...(candidate.input as Record<string, unknown>), unexpected: true };
      expect(safeParseManagementWorkerPayload('tool-request', candidate)).toEqual({
        ok: false,
        error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: '$.input.unexpected' },
      });
    }
  });

  test('distinguishes production credentials from test-only or unavailable capability', () => {
    const productionMissingProvider = structuredClone(validPayloads.register) as Record<string, unknown>;
    delete productionMissingProvider.providerId;
    expect(safeParseManagementWorkerPayload('register', productionMissingProvider)).toEqual({
      ok: false,
      error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: '$.providerId' },
    });

    const unavailableWithProvider = {
      ...validPayloads.register,
      credentialStatus: 'unavailable',
    };
    expect(safeParseManagementWorkerPayload('register', unavailableWithProvider)).toEqual({
      ok: false,
      error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: '$.providerId' },
    });

    const noProtocol = { ...validPayloads.register, supportedProtocolVersions: [] };
    expect(safeParseManagementWorkerPayload('register', noProtocol)).toEqual({
      ok: false,
      error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: '$.supportedProtocolVersions' },
    });

    const overCapacity = {
      ...validPayloads.register,
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 2 },
    };
    expect(safeParseManagementWorkerPayload('register', overCapacity)).toEqual({
      ok: false,
      error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: '$.capacity.activeLeaseCount' },
    });
  });

  test('rejects extra or sensitive keys recursively without echoing their values', () => {
    const canary = 'provider-secret-canary-must-not-leak';
    const candidate = structuredClone(validPayloads['shadow-evaluate']) as Record<string, unknown>;
    const candidateContext = candidate.context as Record<string, unknown>;
    const target = candidateContext.frozenTarget as Record<string, unknown>;
    target.providerSecret = canary;

    const result = safeParseManagementWorkerPayload('shadow-evaluate', candidate);
    expect(result).toEqual({
      ok: false,
      error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: '$.context.frozenTarget.providerSecret' },
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  test('never puts raw lease authority in offers, shadow payloads, or persisted replay identity', () => {
    for (const kind of ['lease-offer', 'shadow-evaluate', 'shadow-result', 'outbox-replay-ack'] as const) {
      const candidate = { ...validPayloads[kind], leaseToken: 'must-not-be-accepted' };
      expect(safeParseManagementWorkerPayload(kind, candidate)).toMatchObject({ ok: false });
    }
    expect(JSON.stringify(validPayloads['lease-offer'])).not.toContain('leaseToken');
  });

  test('requires the complete authority envelope for every write tool request', () => {
    const writeToolNames = [
      'agents.invoke',
      'agents.cancel_invocation',
      'channel.post_management_status',
      'user.request_input',
      'review.submit_root_delivery',
    ] as const;
    for (const toolName of writeToolNames) {
      const base = validToolRequest(toolName) as Record<string, unknown>;
      for (const key of ['managementRunId', 'workerId', 'leaseToken', 'fencingToken', 'idempotencyKey']) {
        const candidate = structuredClone(base);
        delete candidate[key];
        expect(safeParseManagementWorkerPayload('tool-request', candidate)).toEqual({
          ok: false,
          error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: `$.${key}` },
        });
      }
    }
  });

  test('requires current lease proof for checkpoint reads and terminal abort commands', () => {
    const requiredFields = {
      'checkpoint-fetch': ['managementRunId', 'workerId', 'leaseToken', 'fencingToken'],
      abort: ['managementRunId', 'workerId', 'leaseToken', 'fencingToken', 'idempotencyKey'],
    } as const;
    for (const kind of ['checkpoint-fetch', 'abort'] as const) {
      for (const key of requiredFields[kind]) {
        const candidate = structuredClone(validPayloads[kind]) as Record<string, unknown>;
        delete candidate[key];
        expect(safeParseManagementWorkerPayload(kind, candidate)).toEqual({
          ok: false,
          error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: `$.${key}` },
        });
      }
    }
  });

  test('does not let a Worker override the frozen target through invoke arguments', () => {
    const candidate = structuredClone(validPayloads['tool-request']) as Record<string, unknown>;
    candidate.input = {
      ...(candidate.input as Record<string, unknown>),
      targetAgentId: 'other-agent',
    };
    expect(safeParseManagementWorkerPayload('tool-request', candidate)).toEqual({
      ok: false,
      error: { code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID', path: '$.input.targetAgentId' },
    });
  });
});

function validToolRequest(
  toolName: typeof PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES[number],
): ManagementWorkerPayloadMapV1['tool-request'] {
  const inputs = {
    'context.get_root_message': {},
    'context.get_root_task': {},
    'context.get_visible_thread': {},
    'context.get_management_state': {},
    'agents.list_capabilities': {},
    'agents.get_status': {},
    'agents.invoke': { objective: 'Handle the request.', attachmentIds: [] },
    'agents.cancel_invocation': { invocationId: 'invocation-1', reasonCode: 'user_cancelled' },
    'channel.post_management_status': { statusCode: 'waiting_for_agent' },
    'user.request_input': { question: 'Which option should be used?' },
    'review.submit_root_delivery': { body: 'Delivery ready.', contributingInvocationIds: ['invocation-1'] },
  } as const;
  const write = [
    'agents.invoke',
    'agents.cancel_invocation',
    'channel.post_management_status',
    'user.request_input',
    'review.submit_root_delivery',
  ].includes(toolName);
  return {
    schemaVersion: 1,
    commandId: `command-${toolName}`,
    managementRunId: 'run-1',
    workerId: 'worker-1',
    ...(write ? {
      leaseToken: 'lease-token-current',
      fencingToken: 3,
      idempotencyKey: `key-${toolName}`,
    } : {}),
    toolCallId: `call-${toolName}`,
    toolName,
    input: inputs[toolName],
  } as ManagementWorkerPayloadMapV1['tool-request'];
}
