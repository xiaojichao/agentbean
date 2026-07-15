import { describe, expect, it } from 'vitest';

import {
  MANAGEMENT_TOOL_NAMES,
  PHASE_1_MANAGEMENT_TOOL_NAMES,
  PHASE_2_MANAGEMENT_TOOL_NAMES,
  PHASE_3_MANAGEMENT_TOOL_NAMES,
  createManagementRuntimeFactory,
  type ManagementModelRequest,
  type ManagementToolName,
} from '../src/index.js';
import {
  assertExactManagementToolAllowlist,
  createManagementToolCatalog,
  getManagementToolMetadata,
} from '../src/management-tool-catalog.js';
import { PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES } from '../../contracts/src/index.js';

function modelResponse(
  content: import('../src/index.js').ManagementModelResponse['content'],
  finishReason: 'stop' | 'tool_use' = 'stop',
) {
  return {
    content,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    finishReason,
    responseModel: 'tool-boundary-model',
  };
}

function managedSessionInput(id = 'manager') {
  return {
    systemPrompt: { id, version: 1, content: 'Manage.' },
    mode: 'managed' as const,
    context: {
      schemaVersion: 1 as const,
      scope: {
        kind: 'managed' as const,
        managementRunId: `run-${id}`,
        teamId: 'team-1',
        channelId: 'channel-1',
        rootMessageId: `message-${id}`,
      },
      frozenTarget: { agentId: 'agent-1', kind: 'custom' as const },
      visibleThread: { revision: 1, messages: [] },
    },
  };
}

function shadowSessionInput(id = 'shadow') {
  return {
    systemPrompt: { id, version: 1, content: 'Evaluate without executing.' },
    mode: 'shadow' as const,
    context: {
      schemaVersion: 1 as const,
      scope: {
        kind: 'shadow' as const,
        shadowRequestKey: `shadow:${id}`,
        teamId: 'team-1',
        channelId: 'channel-1',
        rootMessageId: `message-${id}`,
      },
      frozenTarget: { agentId: 'agent-1', kind: 'custom' as const },
      visibleThread: { revision: 1, messages: [] },
    },
  };
}

function phase2SessionInput(id = 'phase-2') {
  return {
    systemPrompt: { id, version: 1, content: 'Coordinate tasks.' },
    mode: 'managed' as const,
    context: {
      schemaVersion: 2 as const,
      managementPhase: 2 as const,
      scope: {
        kind: 'managed' as const,
        managementRunId: `run-${id}`,
        teamId: 'team-1',
        channelId: 'channel-1',
        rootMessageId: `message-${id}`,
        rootTaskId: 'task-root',
      },
      visibleThread: { revision: 1, messages: [] },
    },
  };
}

describe('management tool boundary', () => {
  it('keeps the runtime tool surface identical to the Worker wire contract', () => {
    expect(PHASE_1_MANAGEMENT_TOOL_NAMES).toEqual(PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES);
  });

  it('exposes only the eleven Phase 1 management tools to managed sessions', async () => {
    const requests: ManagementModelRequest[] = [];
    const factory = createManagementRuntimeFactory({
      model: {
        id: 'phase-1-tool-surface',
        async respond(request) {
          requests.push(request);
          return modelResponse([{ type: 'text', text: 'done' }]);
        },
      },
      toolExecutor: async () => ({ text: 'unused' }),
    });
    const session = await factory.createSession({
      systemPrompt: { id: 'manager', version: 1, content: 'Manage this run.' },
      mode: 'managed',
      context: {
        schemaVersion: 1,
        scope: {
          kind: 'managed',
          managementRunId: 'run-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          rootMessageId: 'message-1',
        },
        frozenTarget: { agentId: 'agent-1', kind: 'custom' },
        visibleThread: { revision: 1, messages: [] },
      },
    });

    await session.prompt({ text: 'invoke the target' });
    await session.waitForIdle();

    expect(PHASE_1_MANAGEMENT_TOOL_NAMES).toHaveLength(11);
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([...PHASE_1_MANAGEMENT_TOOL_NAMES]);
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain('tasks.create_subtasks');
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain('memory.search');
    await session.dispose();
  });

  it('exposes Phase 1 plus eight Task tools only for an explicit Phase 2 context', async () => {
    const requests: ManagementModelRequest[] = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'phase-2-tool-surface',
        async respond(request) {
          requests.push(request);
          return modelResponse([{ type: 'text', text: 'done' }]);
        },
      },
      toolExecutor: async () => ({ text: 'unused' }),
    }).createSession({
      systemPrompt: { id: 'phase-2', version: 1, content: 'Coordinate tasks.' },
      mode: 'managed',
      context: {
        schemaVersion: 2,
        managementPhase: 2,
        scope: {
          kind: 'managed',
          managementRunId: 'run-phase-2',
          teamId: 'team-1',
          channelId: 'channel-1',
          rootMessageId: 'message-1',
          rootTaskId: 'task-root',
        },
        visibleThread: { revision: 1, messages: [] },
      },
    });

    await session.prompt({ text: 'decompose' });
    await session.waitForIdle();

    expect(PHASE_2_MANAGEMENT_TOOL_NAMES).toHaveLength(22);
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([...PHASE_2_MANAGEMENT_TOOL_NAMES]);
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain('memory.search');
    expect(requests[0]?.tools.find((tool) => tool.name === 'tasks.assign')?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'agentId', 'expectedTaskRevision'],
    });
    expect(requests[0]?.tools.find((tool) => tool.name === 'agents.invoke')?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'expectedTaskRevision', 'taskAttempt', 'claimLeaseId', 'objective', 'attachmentIds'],
      properties: {
        memoryCapsuleRef: {
          type: 'object', additionalProperties: false,
          required: ['schemaVersion', 'id', 'teamId', 'managementRunId', 'targetAgentId',
            'contentHash', 'authorizationDecisionId', 'expiresAt'],
        },
      },
    });
    expect(requests[0]?.sessionContext).toMatchObject({ schemaVersion: 2, managementPhase: 2 });
    await session.dispose();
  });

  it('rejects Phase 2 context in shadow mode', async () => {
    await expect(createManagementRuntimeFactory({
      model: { id: 'phase-2-shadow', async respond() { return modelResponse([]); } },
      toolExecutor: async () => ({ text: 'unused' }),
    }).createSession({
      systemPrompt: { id: 'phase-2-shadow', version: 1, content: 'No.' },
      mode: 'shadow',
      context: {
        schemaVersion: 2,
        managementPhase: 2,
        scope: {
          kind: 'managed',
          managementRunId: 'run-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          rootMessageId: 'message-1',
          rootTaskId: 'task-1',
        },
        visibleThread: { revision: 1, messages: [] },
      },
    })).rejects.toThrow(/P1_SESSION_CONTEXT_INVALID/);
  });

  it('rejects an invalid frozen target when Phase 2 provides one', async () => {
    const input = phase2SessionInput('invalid-target');
    await expect(createManagementRuntimeFactory({
      model: { id: 'invalid-target', async respond() { return modelResponse([]); } },
      toolExecutor: async () => ({ text: 'unused' }),
    }).createSession({
      ...input,
      context: { ...input.context, frozenTarget: { agentId: '', kind: 'unknown' as 'custom' } },
    })).rejects.toThrow(/P1_SESSION_CONTEXT_INVALID/);
  });

  it('keeps managed and shadow descriptors identical without model-supplied authority fields', async () => {
    const managedRequests: ManagementModelRequest[] = [];
    const shadowRequests: ManagementModelRequest[] = [];
    const createFactory = (requests: ManagementModelRequest[]) => createManagementRuntimeFactory({
      model: {
        id: 'descriptor-model',
        async respond(request) {
          requests.push(request);
          return modelResponse([{ type: 'text', text: 'done' }]);
        },
      },
      toolExecutor: async () => ({ text: 'unused' }),
    });
    const managed = await createFactory(managedRequests).createSession(managedSessionInput('descriptor-managed'));
    const shadow = await createFactory(shadowRequests).createSession(shadowSessionInput('descriptor-shadow'));

    await managed.prompt({ text: 'plan' });
    await shadow.prompt({ text: 'plan' });
    await Promise.all([managed.waitForIdle(), shadow.waitForIdle()]);

    expect(shadowRequests[0]?.tools).toEqual(managedRequests[0]?.tools);
    const schemas = JSON.stringify(managedRequests[0]?.tools.map((tool) => tool.inputSchema));
    expect(schemas).not.toMatch(/managementRunId|leaseToken|idempotencyKey/);
    await Promise.all([managed.dispose(), shadow.dispose()]);
  });

  it('records shadow write intent hashes without calling the real executor or exposing arguments', async () => {
    const executorCalls: unknown[] = [];
    const events: import('../src/index.js').ManagementRuntimeEvent[] = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'shadow-write-model',
        async respond(_request, state) {
          if (state.callCount === 1) {
            return modelResponse([{
              type: 'toolCall',
              id: 'shadow-invoke-1',
              name: 'agents.invoke',
              arguments: { targetAgentId: 'agent-1', objective: 'SENSITIVE_SHADOW_OBJECTIVE' },
            }], 'tool_use');
          }
          return modelResponse([{ type: 'text', text: 'done' }]);
        },
      },
      toolExecutor: async (call) => {
        executorCalls.push(call);
        return { text: 'must-not-run' };
      },
    }).createSession(shadowSessionInput('write-intent'));
    session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'evaluate' });
    await session.waitForIdle();

    expect(executorCalls).toHaveLength(0);
    const shadowEvent = events.find((event) => event.type === 'shadow-tool-intent');
    expect(shadowEvent).toMatchObject({
      type: 'shadow-tool-intent',
      schemaVersion: 1,
      toolCallId: 'shadow-invoke-1',
      name: 'agents.invoke',
      argumentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(shadowEvent)).not.toContain('SENSITIVE_SHADOW_OBJECTIVE');
    await session.dispose();
  });

  it('freezes the complete management tool allowlist', () => {
    expect(MANAGEMENT_TOOL_NAMES).toEqual([
      'context.get_root_message',
      'context.get_root_task',
      'context.get_visible_thread',
      'context.get_management_state',
      'agents.list_capabilities',
      'agents.get_status',
      'agents.invoke',
      'agents.cancel_invocation',
      'tasks.create_subtasks',
      'tasks.add_dependency',
      'tasks.publish_for_claim',
      'tasks.assign',
      'tasks.wait',
      'tasks.retry',
      'tasks.accept_subtask',
      'tasks.report_blocked',
      'agents.list_available',
      'handoffs.request',
      'handoffs.await_result',
      'memory.search',
      'memory.create_capsule',
      'memory.propose_candidate',
      'memory.link_sources',
      'channel.post_management_status',
      'user.request_input',
      'review.submit_root_delivery',
    ]);
  });

  for (const forbidden of ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'unknown.tool']) {
    it(`rejects unregistered tool ${forbidden}`, () => {
      expect(() => assertExactManagementToolAllowlist([
        ...MANAGEMENT_TOOL_NAMES,
        forbidden as ManagementToolName,
      ])).toThrow(/P0_TOOL_ALLOWLIST_MISMATCH/);
    });
  }

  it('fails closed when one declared management tool is missing', () => {
    expect(() => assertExactManagementToolAllowlist(MANAGEMENT_TOOL_NAMES.slice(1)))
      .toThrow(/P0_TOOL_ALLOWLIST_MISMATCH/);
  });

  it('treats allowlist order as irrelevant but rejects duplicates', () => {
    expect(() => assertExactManagementToolAllowlist([...MANAGEMENT_TOOL_NAMES].reverse())).not.toThrow();
    expect(() => assertExactManagementToolAllowlist([
      ...MANAGEMENT_TOOL_NAMES.slice(0, -1),
      MANAGEMENT_TOOL_NAMES[0],
    ])).toThrow(/duplicates=true/);
  });

  it('freezes effect, earliest phase, and schema version for every tool', () => {
    expect(MANAGEMENT_TOOL_NAMES.map(getManagementToolMetadata)).toMatchSnapshot();
  });

  it('rejects Phase 2 tool calls before invoking the executor', async () => {
    const calls: unknown[] = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'tool-call',
        async respond(_request, state) {
          if (state.callCount === 1) {
            return modelResponse([{
                type: 'toolCall',
                id: 'call-1',
                name: 'tasks.assign',
                arguments: {},
              }], 'tool_use');
          }
          return modelResponse([{ type: 'text', text: 'done' }]);
        },
      },
      toolExecutor: async (call) => {
        calls.push(call);
        return { text: 'assigned' };
      },
    }).createSession(managedSessionInput());

    await session.prompt({ text: 'assign' });
    await session.waitForIdle();
    expect(calls).toHaveLength(0);
    await session.dispose();
  });

  it('validates Phase 2 Task input before invoking the executor', async () => {
    const calls: unknown[] = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'invalid-phase-2-tool-input',
        async respond(_request, state) {
          if (state.callCount === 1) {
            return modelResponse([{
              type: 'toolCall',
              id: 'call-phase-2-invalid',
              name: 'tasks.assign',
              arguments: { taskId: 'task-1', agentId: 'agent-1', prompt: 'forbidden' },
            }], 'tool_use');
          }
          return modelResponse([{ type: 'text', text: 'done' }]);
        },
      },
      toolExecutor: async (call) => {
        calls.push(call);
        return { text: 'assigned' };
      },
    }).createSession(phase2SessionInput('invalid-input'));

    await session.prompt({ text: 'assign' });
    await session.waitForIdle();
    expect(calls).toHaveLength(0);
    await session.dispose();
  });

  it('passes a valid cloned Phase 2 Task input to the executor', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'valid-phase-2-tool-input',
        async respond(_request, state) {
          if (state.callCount === 1) {
            return modelResponse([{
              type: 'toolCall',
              id: 'call-phase-2-valid',
              name: 'tasks.assign',
              arguments: { taskId: 'task-1', agentId: 'agent-1', expectedTaskRevision: 2 },
            }], 'tool_use');
          }
          return modelResponse([{ type: 'text', text: 'done' }]);
        },
      },
      toolExecutor: async (call) => {
        calls.push({ name: call.name, input: call.input });
        return { text: 'assigned' };
      },
    }).createSession(phase2SessionInput('valid-input'));

    await session.prompt({ text: 'assign' });
    await session.waitForIdle();
    expect(calls).toEqual([{
      name: 'tasks.assign',
      input: { taskId: 'task-1', agentId: 'agent-1', expectedTaskRevision: 2 },
    }]);
    await session.dispose();
  });

  it('passes versioned effect and phase metadata to the injected executor', async () => {
    const calls: Array<{ name: string; metadata: unknown }> = [];
    const requests: import('../src/index.js').ManagementModelRequest[] = [];
    const events: import('../src/index.js').ManagementRuntimeEvent[] = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'valid-tool-call',
        async respond(request, state) {
          requests.push(request);
          if (state.callCount === 1) {
            return modelResponse([{
                type: 'toolCall',
                id: 'call-2',
                name: 'agents.invoke',
                arguments: {
                  targetAgentId: 'agent-1',
                  objective: 'Handle the request',
                },
              }], 'tool_use');
          }
          return modelResponse([{ type: 'text', text: 'done' }]);
        },
      },
      toolExecutor: async (call) => {
        calls.push({ name: call.name, metadata: call.metadata });
        return { text: 'assigned' };
      },
    }).createSession(managedSessionInput());
    session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'assign' });
    await session.waitForIdle();
    expect(calls).toEqual([{
      name: 'agents.invoke',
      metadata: {
        name: 'agents.invoke',
        effect: 'write',
        phase: 1,
        inputSchemaVersion: 1,
      },
    }]);
    const assignDescriptor = requests[0]?.tools.find((tool) => tool.name === 'agents.invoke');
    expect(assignDescriptor).toMatchObject({
      name: 'agents.invoke',
      metadata: { effect: 'write', phase: 1, inputSchemaVersion: 1 },
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    });
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: [expect.objectContaining({ type: 'toolCall', id: 'call-2', name: 'agents.invoke' })],
      }),
      expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'agents.invoke',
        isError: false,
      }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', phase: 'start', toolCallId: 'call-2', name: 'agents.invoke' }),
      expect.objectContaining({ type: 'tool', phase: 'end', toolCallId: 'call-2', name: 'agents.invoke', isError: false }),
    ]));
    await session.dispose();
  });
});

describe('Phase 3 Memory tool definitions', () => {
  const MEMORY_TOOLS = ['memory.search', 'memory.create_capsule', 'memory.propose_candidate', 'memory.link_sources'] as const;

  it('PHASE_3 extends PHASE_2 with the four Memory tools and keeps them out of Phase 1/2', () => {
    expect(PHASE_3_MANAGEMENT_TOOL_NAMES).toHaveLength(PHASE_2_MANAGEMENT_TOOL_NAMES.length + MEMORY_TOOLS.length);
    expect(PHASE_3_MANAGEMENT_TOOL_NAMES.slice(0, PHASE_2_MANAGEMENT_TOOL_NAMES.length))
      .toEqual([...PHASE_2_MANAGEMENT_TOOL_NAMES]);
    for (const tool of MEMORY_TOOLS) {
      expect(PHASE_3_MANAGEMENT_TOOL_NAMES).toContain(tool);
      expect(PHASE_2_MANAGEMENT_TOOL_NAMES).not.toContain(tool);
      expect(PHASE_1_MANAGEMENT_TOOL_NAMES).not.toContain(tool);
      expect(getManagementToolMetadata(tool).phase).toBe(3);
    }
  });

  it('every Memory tool is part of the full MANAGEMENT_TOOL_NAMES surface', () => {
    for (const tool of MEMORY_TOOLS) {
      expect(MANAGEMENT_TOOL_NAMES).toContain(tool);
    }
  });

  it('publishes exact schemas for every Phase 3 Memory tool', () => {
    const definitions = createManagementToolCatalog({
      executor: async () => ({ text: 'unused' }),
      toolNames: MEMORY_TOOLS,
      mode: 'managed',
      sessionContext: phase2SessionInput('phase-3-schema').context,
    });
    const schemas = new Map(definitions.map((definition) => [definition.name,
      JSON.parse(JSON.stringify(definition.parameters)) as {
        additionalProperties: boolean;
        properties: Record<string, unknown>;
        required: string[];
      }]));
    const expectedKeys = new Map([
      ['memory.search', ['query', 'limit', 'taskId', 'channelId', 'userId']],
      ['memory.create_capsule', ['targetAgentId', 'prompt', 'limit', 'taskId', 'channelId', 'userId']],
      ['memory.propose_candidate', ['contentKind', 'proposedContent', 'sourceRefs', 'taskId']],
      ['memory.link_sources', ['memoryId', 'sourceRefs']],
    ]);
    const expectedRequired = new Map([
      ['memory.search', ['query', 'limit']],
      ['memory.create_capsule', ['targetAgentId', 'prompt', 'limit']],
      ['memory.propose_candidate', ['contentKind', 'proposedContent', 'sourceRefs']],
      ['memory.link_sources', ['memoryId', 'sourceRefs']],
    ]);
    for (const name of MEMORY_TOOLS) {
      const schema = schemas.get(name);
      expect(schema?.additionalProperties).toBe(false);
      expect(Object.keys(schema?.properties ?? {})).toEqual(expectedKeys.get(name));
      expect(schema?.required).toEqual(expectedRequired.get(name));
    }
  });

  it('applies the exact-key parser before invoking the Phase 3 executor', async () => {
    const executorCalls: unknown[] = [];
    const [search] = createManagementToolCatalog({
      executor: async (call) => {
        executorCalls.push(call);
        return { text: 'must-not-run' };
      },
      toolNames: ['memory.search'],
      mode: 'managed',
      sessionContext: phase2SessionInput('phase-3-parser').context,
    });
    expect(search).toBeDefined();
    await expect(search!.execute('call-1', {
      query: 'q', limit: 1, providerSecret: 'forbidden',
    }, undefined, undefined, undefined as never)).rejects.toThrow('MEMORY_TOOL_INPUT_INVALID');
    expect(executorCalls).toHaveLength(0);
  });
});
