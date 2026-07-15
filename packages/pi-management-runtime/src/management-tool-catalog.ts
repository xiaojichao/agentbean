import { createHash } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { parsePhase2TaskToolInputV1, type Phase2ManagementWorkerToolInputMapV1 } from '@agentbean/contracts';

import {
  MANAGEMENT_TOOL_NAMES,
  type ManagementToolEffect,
  type ManagementToolExecutor,
  type ManagementToolMetadata,
  type ManagementToolName,
  type ManagementToolPhase,
  type ManagementRuntimeEvent,
  type ManagementSessionContext,
  type ManagementSessionMode,
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
  'agents.list_available': { effect: 'read', phase: 2 },
  'handoffs.request': { effect: 'write', phase: 2 },
  'handoffs.await_result': { effect: 'read', phase: 2 },
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

export function assertExactManagementToolAllowlist(
  toolNames: readonly ManagementToolName[],
  expectedToolNames: readonly ManagementToolName[] = MANAGEMENT_TOOL_NAMES,
): void {
  const expected = new Set<ManagementToolName>(expectedToolNames);
  const actual = new Set<ManagementToolName>(toolNames);
  const missing = expectedToolNames.filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (actual.size !== toolNames.length || missing.length > 0 || extra.length > 0) {
    throw new Error(`P0_TOOL_ALLOWLIST_MISMATCH: missing=${missing.join(',')}; extra=${extra.join(',')}; duplicates=${actual.size !== toolNames.length}`);
  }
}

type Phase2TaskToolName = keyof Phase2ManagementWorkerToolInputMapV1;

function phase2TaskSchemaFor(name: Phase2TaskToolName) {
  const id = () => Type.String({ minLength: 1 });
  const revision = () => Type.Integer({ minimum: 1 });
  const criterion = Type.Object({
    id: id(), description: id(), evidenceRequired: Type.Boolean(),
    allowedEvidenceKinds: Type.Optional(Type.Array(Type.Union([
      Type.Literal('message'), Type.Literal('artifact'), Type.Literal('workspace-run'),
      Type.Literal('invocation'), Type.Literal('task'),
    ]))),
  }, { additionalProperties: false });
  if (name === 'agents.list_available') return Type.Object({
    capabilityQuery: Type.Optional(id()), includeBusy: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false });
  if (name === 'handoffs.await_result') return Type.Object({
    handoffId: id(), timeoutAt: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false });
  if (name === 'handoffs.request') return Type.Object({
    sourceProposalId: Type.Optional(id()), sourceInvocationId: Type.Optional(id()),
    toAgentId: id(),
    kind: Type.Union([Type.Literal('consult'), Type.Literal('template_request'), Type.Literal('continuation')]),
    objective: id(), reason: id(), contextRefIds: Type.Array(id()),
    dependencyInvocationIds: Type.Array(id()), attachmentIds: Type.Array(id()),
    acceptanceCriteria: Type.Array(criterion),
    returnMode: Type.Union([Type.Literal('return_to_manager'),
      Type.Literal('return_to_source_agent'), Type.Literal('deliver_to_root')]),
    deadlineAt: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false });
  if (name === 'tasks.create_subtasks') {
    return Type.Object({
      parentTaskId: id(),
      subtasks: Type.Array(Type.Object({
        clientKey: id(),
        title: id(),
        description: Type.Optional(id()),
        claimPolicy: Type.Union([Type.Literal('open'), Type.Literal('targeted')]),
        targetAgentId: Type.Optional(id()),
        requiredCapabilities: Type.Array(id()),
        acceptanceCriteria: Type.Array(criterion),
        maxAttempts: Type.Integer({ minimum: 1 }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
    }, { additionalProperties: false });
  }
  if (name === 'tasks.add_dependency') return Type.Object({ taskId: id(), dependencyTaskId: id(), expectedTaskRevision: revision() }, { additionalProperties: false });
  if (name === 'tasks.publish_for_claim') return Type.Object({ taskId: id(), expectedTaskRevision: revision() }, { additionalProperties: false });
  if (name === 'tasks.assign') return Type.Object({ taskId: id(), agentId: id(), expectedTaskRevision: revision() }, { additionalProperties: false });
  if (name === 'tasks.wait') return Type.Object({ taskIds: Type.Array(id()) }, { additionalProperties: false });
  if (name === 'tasks.retry' || name === 'tasks.report_blocked') {
    return Type.Object({ taskId: id(), expectedTaskRevision: revision(), reasonCode: id() }, { additionalProperties: false });
  }
  const evidenceRef = Type.Object({
    kind: Type.Union([Type.Literal('message'), Type.Literal('artifact'), Type.Literal('workspace-run'), Type.Literal('invocation'), Type.Literal('task')]),
    id: id(),
    snapshotHash: id(),
    snapshotRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    capturedAt: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false });
  return Type.Object({
    acceptance: Type.Object({
      schemaVersion: Type.Literal(1),
      taskId: id(),
      deliveryId: id(),
      expectedTaskRevision: revision(),
      taskAttempt: revision(),
      claimLeaseId: id(),
      decision: Type.Union([Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('needs_human')]),
      criteriaResults: Type.Array(Type.Object({ criterionId: id(), passed: Type.Boolean(), evidenceRefs: Type.Array(evidenceRef) }, { additionalProperties: false })),
      reason: id(),
      decidedBy: Type.Union([Type.Literal('manager'), Type.Literal('human')]),
      decidedAt: Type.Integer({ minimum: 0 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false });
}

function schemaFor(name: ManagementToolName, context: ManagementSessionContext) {
  if (context.schemaVersion === 2 && getManagementToolMetadata(name).phase === 2) {
    return phase2TaskSchemaFor(name as Phase2TaskToolName);
  }
  return Type.Object({}, { additionalProperties: true });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export interface CreateManagementToolCatalogInput {
  executor: ManagementToolExecutor;
  toolNames?: readonly ManagementToolName[];
  mode: ManagementSessionMode;
  sessionContext: ManagementSessionContext;
  emitRuntimeEvent?: (event: ManagementRuntimeEvent) => void;
}

export function createManagementToolCatalog(options: CreateManagementToolCatalogInput): ToolDefinition[] {
  const toolNames = options.toolNames ?? MANAGEMENT_TOOL_NAMES;
  return toolNames.map((name) => {
    const metadata = getManagementToolMetadata(name);
    return defineTool({
      name,
      label: name,
      description: `AgentBean management operation ${name}`,
      parameters: schemaFor(name, options.sessionContext),
      executionMode: metadata.effect === 'write' ? 'sequential' : 'parallel',
      async execute(toolCallId, toolInput, signal) {
        if (options.mode === 'shadow' && metadata.effect === 'write') {
          options.emitRuntimeEvent?.({
            type: 'shadow-tool-intent',
            schemaVersion: 1,
            toolCallId,
            name,
            argumentHash: createHash('sha256').update(canonicalJson(toolInput)).digest('hex'),
          });
          return {
            content: [{ type: 'text', text: 'dry_run_recorded' }],
            details: { schemaVersion: 1, effect: metadata.effect, phase: metadata.phase },
            isError: false,
          };
        }
        const validatedInput = options.sessionContext.schemaVersion === 2 && metadata.phase === 2
          ? parsePhase2TaskToolInputV1(name as Phase2TaskToolName, toolInput)
          : toolInput;
        const result = await options.executor({
          toolCallId,
          name,
          scope: options.sessionContext.scope,
          input: validatedInput as Parameters<ManagementToolExecutor>[0]['input'],
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
