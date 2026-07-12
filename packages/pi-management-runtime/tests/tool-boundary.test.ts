import { describe, expect, it } from 'vitest';

import {
  MANAGEMENT_TOOL_NAMES,
  createManagementRuntimeFactory,
  type ManagementToolName,
} from '../src/index.js';
import {
  assertExactManagementToolAllowlist,
  getManagementToolMetadata,
} from '../src/management-tool-catalog.js';

describe('management tool boundary', () => {
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

  it('requires write tool idempotency metadata before invoking the executor', async () => {
    const calls: unknown[] = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'tool-call',
        async respond(_request, state) {
          if (state.callCount === 1) {
            return {
              content: [{
                type: 'toolCall',
                id: 'call-1',
                name: 'tasks.assign',
                arguments: { managementRunId: 'run-1', leaseToken: 'lease-1' },
              }],
            };
          }
          return { content: [{ type: 'text', text: 'done' }] };
        },
      },
      toolExecutor: async (call) => {
        calls.push(call);
        return { text: 'assigned' };
      },
    }).createSession({ systemPrompt: { id: 'manager', version: 1, content: 'Manage.' } });

    await session.prompt({ text: 'assign' });
    await session.waitForIdle();
    expect(calls).toHaveLength(0);
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
            return {
              content: [{
                type: 'toolCall',
                id: 'call-2',
                name: 'tasks.assign',
                arguments: {
                  managementRunId: 'run-1',
                  leaseToken: 'lease-1',
                  idempotencyKey: 'assign-1',
                },
              }],
            };
          }
          return { content: [{ type: 'text', text: 'done' }] };
        },
      },
      toolExecutor: async (call) => {
        calls.push({ name: call.name, metadata: call.metadata });
        return { text: 'assigned' };
      },
    }).createSession({ systemPrompt: { id: 'manager', version: 1, content: 'Manage.' } });
    session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'assign' });
    await session.waitForIdle();
    expect(calls).toEqual([{
      name: 'tasks.assign',
      metadata: {
        name: 'tasks.assign',
        effect: 'write',
        phase: 2,
        inputSchemaVersion: 1,
      },
    }]);
    const assignDescriptor = requests[0]?.tools.find((tool) => tool.name === 'tasks.assign');
    expect(assignDescriptor).toMatchObject({
      name: 'tasks.assign',
      metadata: { effect: 'write', phase: 2, inputSchemaVersion: 1 },
      inputSchema: { type: 'object', required: expect.arrayContaining(['managementRunId', 'leaseToken', 'idempotencyKey']) },
    });
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: [expect.objectContaining({ type: 'toolCall', id: 'call-2', name: 'tasks.assign' })],
      }),
      expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'tasks.assign',
        isError: false,
      }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', phase: 'start', toolCallId: 'call-2', name: 'tasks.assign' }),
      expect.objectContaining({ type: 'tool', phase: 'end', toolCallId: 'call-2', name: 'tasks.assign', isError: false }),
    ]));
    await session.dispose();
  });
});
