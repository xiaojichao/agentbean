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
      role: 'user' | 'assistant' | 'toolResult';
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

export interface CreateManagementSessionInput {
  systemPrompt: VersionedManagementPrompt;
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
  'memory.search',
  'memory.create_capsule',
  'memory.propose_candidate',
  'memory.link_sources',
  'channel.post_management_status',
  'user.request_input',
  'review.submit_root_delivery',
] as const;

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
  input: Record<string, unknown> & {
    managementRunId: string;
    leaseToken: string;
    idempotencyKey?: string;
  };
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
