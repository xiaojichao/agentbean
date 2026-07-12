import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import {
  MANAGEMENT_TOOL_NAMES,
  type ManagementToolEffect,
  type ManagementToolExecutor,
  type ManagementToolMetadata,
  type ManagementToolName,
  type ManagementToolPhase,
} from './types.js';

const toolPolicy: Record<ManagementToolName, {
  effect: ManagementToolEffect;
  phase: ManagementToolPhase;
}> = {
  'context.get_root_message': { effect: 'read', phase: 1 },
  'context.get_root_task': { effect: 'read', phase: 1 },
  'context.get_visible_thread': { effect: 'read', phase: 1 },
  'context.get_management_state': { effect: 'read', phase: 1 },
  'agents.list_capabilities': { effect: 'read', phase: 1 },
  'agents.get_status': { effect: 'read', phase: 1 },
  'agents.invoke': { effect: 'write', phase: 1 },
  'agents.cancel_invocation': { effect: 'write', phase: 1 },
  'tasks.create_subtasks': { effect: 'write', phase: 2 },
  'tasks.add_dependency': { effect: 'write', phase: 2 },
  'tasks.publish_for_claim': { effect: 'write', phase: 2 },
  'tasks.assign': { effect: 'write', phase: 2 },
  'tasks.wait': { effect: 'read', phase: 2 },
  'tasks.retry': { effect: 'write', phase: 2 },
  'tasks.accept_subtask': { effect: 'write', phase: 2 },
  'tasks.report_blocked': { effect: 'write', phase: 2 },
  'memory.search': { effect: 'read', phase: 3 },
  'memory.create_capsule': { effect: 'write', phase: 3 },
  'memory.propose_candidate': { effect: 'write', phase: 3 },
  'memory.link_sources': { effect: 'write', phase: 3 },
  'channel.post_management_status': { effect: 'write', phase: 1 },
  'user.request_input': { effect: 'write', phase: 1 },
  'review.submit_root_delivery': { effect: 'write', phase: 1 },
};

export function getManagementToolMetadata(name: ManagementToolName): ManagementToolMetadata {
  const policy = toolPolicy[name];
  return {
    name,
    effect: policy.effect,
    phase: policy.phase,
    inputSchemaVersion: 1,
  };
}

export function assertExactManagementToolAllowlist(toolNames: readonly ManagementToolName[]): void {
  const expected = new Set<ManagementToolName>(MANAGEMENT_TOOL_NAMES);
  const actual = new Set<ManagementToolName>(toolNames);
  const missing = MANAGEMENT_TOOL_NAMES.filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (actual.size !== toolNames.length || missing.length > 0 || extra.length > 0) {
    throw new Error(`P0_TOOL_ALLOWLIST_MISMATCH: missing=${missing.join(',')}; extra=${extra.join(',')}; duplicates=${actual.size !== toolNames.length}`);
  }
}

function schemaFor(effect: ManagementToolEffect) {
  const common = {
    managementRunId: Type.String({ minLength: 1 }),
    leaseToken: Type.String({ minLength: 1 }),
  };
  return effect === 'write'
    ? Type.Object({ ...common, idempotencyKey: Type.String({ minLength: 1 }) }, { additionalProperties: true })
    : Type.Object(common, { additionalProperties: true });
}

export function createManagementToolCatalog(executor: ManagementToolExecutor): ToolDefinition[] {
  return MANAGEMENT_TOOL_NAMES.map((name) => {
    const metadata = getManagementToolMetadata(name);
    return defineTool({
      name,
      label: name,
      description: `AgentBean management operation ${name}`,
      parameters: schemaFor(metadata.effect),
      executionMode: metadata.effect === 'write' ? 'sequential' : 'parallel',
      async execute(toolCallId, input, signal) {
        const result = await executor({
          toolCallId,
          name,
          input: input as Parameters<ManagementToolExecutor>[0]['input'],
          metadata,
          signal,
        });
        return {
          content: [{ type: 'text', text: result.text }],
          details: { schemaVersion: 1, effect: metadata.effect, phase: metadata.phase },
          isError: result.isError ?? false,
        };
      },
    });
  });
}
