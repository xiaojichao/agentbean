export interface ManagementPrompt {
  text: string;
}

export interface ManagementSteer {
  text: string;
}

export interface ManagementFollowUp {
  text: string;
}

export interface ManagementCompactionRequest {
  instructions?: string;
}

export type ManagementCompactionResult =
  | {
      compacted: true;
      summary: string;
      tokensBefore: number;
      estimatedTokensAfter?: number;
    }
  | {
      compacted: false;
      reason: 'not_needed';
    };

export type ManagementRuntimeEvent =
  | {
      type: 'lifecycle';
      phase: 'agent_start' | 'agent_end' | 'agent_settled' | 'compaction_start' | 'compaction_end';
    }
  | {
      type: 'message';
      role: 'user' | 'toolResult';
    }
  | {
      type: 'message';
      role: 'assistant';
      telemetry: ManagementModelTelemetry;
    }
  | {
      type: 'queue';
      steeringCount: number;
      followUpCount: number;
    }
  | {
      type: 'tool';
      phase: 'start' | 'end';
      toolCallId: string;
      name: ManagementToolName;
      isError?: boolean;
    }
  | {
      type: 'shadow-tool-intent';
      schemaVersion: 1;
      toolCallId: string;
      name: ManagementToolName;
      argumentHash: string;
    }
  | {
      type: 'unsupported';
      eventType: string;
    };

export interface ManagementSession {
  prompt(input: ManagementPrompt): Promise<void>;
  steer(input: ManagementSteer): Promise<void>;
  followUp(input: ManagementFollowUp): Promise<void>;
  compact(input?: ManagementCompactionRequest): Promise<ManagementCompactionResult>;
  abort(reason: string): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: ManagementRuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface VersionedManagementPrompt {
  id: string;
  version: number;
  content: string;
}

export type ManagementSessionMode = 'managed' | 'shadow';

export interface ManagementVisibleMessageV1 {
  readonly id: string;
  readonly senderKind: 'human' | 'agent' | 'system';
  readonly senderId: string;
  readonly body: string;
  readonly createdAt: number;
}

export type ManagementSessionScopeV1 =
  | {
      readonly kind: 'managed';
      readonly managementRunId: string;
      readonly teamId: string;
      readonly channelId: string;
      readonly rootMessageId: string;
      readonly rootTaskId?: string;
    }
  | {
      readonly kind: 'shadow';
      readonly shadowRequestKey: string;
      readonly teamId: string;
      readonly channelId: string;
      readonly rootMessageId: string;
      readonly rootTaskId?: string;
    };

export interface ManagementVisibleCheckpointV1 {
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly objective: string;
  readonly planSummary: string;
  readonly nextAction?: string;
}

export interface ManagementVisibleCheckpointV2 extends ManagementVisibleCheckpointV1 {
  readonly taskGraphRevision: number;
  readonly openTaskIds: readonly string[];
  readonly waitingInvocationIds: readonly string[];
  readonly completedInvocationIds: readonly string[];
  readonly taskSnapshots: readonly {
    readonly taskId: string;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';
    readonly claimLeaseId?: string;
  }[];
  readonly activeClaimLeaseIds: readonly string[];
  /** Present for restored Phase 3 sessions; omitted for Phase 2 compatibility. */
  readonly memoryCapsuleIds?: readonly string[];
}

export interface ManagementSessionContextV1 {
  readonly schemaVersion: 1;
  readonly scope: ManagementSessionScopeV1;
  readonly frozenTarget: {
    readonly agentId: string;
    readonly kind: 'custom' | 'agentos-hosted';
  };
  readonly visibleThread: {
    readonly revision: number;
    readonly messages: readonly ManagementVisibleMessageV1[];
  };
  readonly checkpoint?: ManagementVisibleCheckpointV1;
}

export interface ManagementSessionContextV2 {
  readonly schemaVersion: 2;
  readonly managementPhase: 2 | 3;
  readonly scope: Omit<Extract<ManagementSessionScopeV1, { kind: 'managed' }>, 'rootTaskId'> & {
    readonly rootTaskId: string;
  };
  readonly frozenTarget?: ManagementSessionContextV1['frozenTarget'];
  readonly visibleThread: ManagementSessionContextV1['visibleThread'];
  readonly checkpoint?: ManagementVisibleCheckpointV2;
}

export type ManagementSessionContext = ManagementSessionContextV1 | ManagementSessionContextV2;

export interface CreateManagementSessionInput {
  systemPrompt: VersionedManagementPrompt;
  mode: ManagementSessionMode;
  context: ManagementSessionContext;
}

export interface ManagementRuntimeFactory {
  createSession(input: CreateManagementSessionInput): Promise<ManagementSession>;
}

export type ManagementModelMessage =
  | {
      role: 'user';
      content: readonly ManagementModelTextContent[];
    }
  | {
      role: 'assistant';
      content: readonly ManagementModelContent[];
    }
  | {
      role: 'toolResult';
      toolCallId: string;
      toolName: ManagementToolName;
      content: readonly ManagementModelTextContent[];
      isError: boolean;
    };

export interface ManagementModelTextContent {
  type: 'text';
  text: string;
}

export interface ManagementModelToolDescriptor {
  name: ManagementToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  metadata: ManagementToolMetadata;
}

export interface ManagementModelRequest {
  systemPrompt: string;
  sessionContext: ManagementSessionContext;
  messages: readonly ManagementModelMessage[];
  tools: readonly ManagementModelToolDescriptor[];
  signal?: AbortSignal;
}

export type ManagementModelContent =
  | { type: 'text'; text: string }
  | {
      type: 'toolCall';
      id: string;
      name: ManagementToolName;
      arguments: Record<string, unknown>;
    };

export interface ManagementModelResponse {
  content: readonly ManagementModelContent[];
  usage: ManagementModelUsage;
  finishReason: ManagementFinishReason;
  responseModel: string;
}

export interface ManagementModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
}

export type ManagementFinishReason =
  | 'stop'
  | 'tool_use'
  | 'length'
  | 'content_filter'
  | 'aborted'
  | 'error'
  | 'unknown';

export interface ManagementModelTelemetry {
  readonly usage: ManagementModelUsage;
  readonly finishReason: ManagementFinishReason;
  readonly responseModel: string;
}

export interface ManagementModelState {
  callCount: number;
}

export interface ManagementModelAdapter {
  id: string;
  respond(request: ManagementModelRequest, state: ManagementModelState): Promise<ManagementModelResponse>;
}

export const MANAGEMENT_TOOL_NAMES = [
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
] as const;

export const PHASE_1_MANAGEMENT_TOOL_NAMES = [
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
] as const satisfies readonly ManagementToolName[];

export const PHASE_2_MANAGEMENT_TOOL_NAMES = [
  ...PHASE_1_MANAGEMENT_TOOL_NAMES,
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
] as const satisfies readonly ManagementToolName[];

/**
 * Phase 3 在 Phase 2 之上叠加四个 Memory 工具（P3-09）。仅 maxManagementPhase>=3 的 Team 开放，
 * 且需 V3 capability/preflight 接线（slice 2）才真正注入 Agent；本常量只定义工具面。
 */
export const PHASE_3_MANAGEMENT_TOOL_NAMES = [
  ...PHASE_2_MANAGEMENT_TOOL_NAMES,
  'memory.search',
  'memory.create_capsule',
  'memory.propose_candidate',
  'memory.link_sources',
] as const satisfies readonly ManagementToolName[];

export type ManagementToolName = (typeof MANAGEMENT_TOOL_NAMES)[number];
export type ManagementToolEffect = 'read' | 'write';
export type ManagementToolPhase = 1 | 2 | 3 | 4;

export interface ManagementToolMetadata {
  name: ManagementToolName;
  effect: ManagementToolEffect;
  phase: ManagementToolPhase;
  inputSchemaVersion: 1;
}

export interface ManagementToolCall {
  toolCallId: string;
  name: ManagementToolName;
  scope: ManagementSessionScopeV1;
  input: Record<string, unknown>;
  metadata: ManagementToolMetadata;
  signal?: AbortSignal;
}

export interface ManagementToolResult {
  text: string;
  isError?: boolean;
}

export type ManagementToolExecutor = (call: ManagementToolCall) => Promise<ManagementToolResult>;

export interface CreateManagementRuntimeFactoryInput {
  model: ManagementModelAdapter;
  toolExecutor: ManagementToolExecutor;
}
