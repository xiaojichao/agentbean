import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

import { createManagementResourceLoader } from './management-resource-loader.js';
import {
  assertExactManagementToolAllowlist,
  createManagementToolCatalog,
  getManagementToolMetadata,
} from './management-tool-catalog.js';
import {
  MANAGEMENT_TOOL_NAMES,
  type CreateManagementRuntimeFactoryInput,
  type CreateManagementSessionInput,
  type ManagementCompactionRequest,
  type ManagementCompactionResult,
  type ManagementModelAdapter,
  type ManagementModelContent,
  type ManagementModelMessage,
  type ManagementRuntimeEvent,
  type ManagementRuntimeFactory,
  type ManagementSession,
  type ManagementToolName,
} from './types.js';

let runtimeSequence = 0;

function textItems(content: unknown) {
  if (typeof content === 'string') return [{ type: 'text' as const, text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    if ('text' in item && typeof item.text === 'string') return [{ type: 'text' as const, text: item.text }];
    return [];
  });
}

function messagesFromContext(context: Context): ManagementModelMessage[] {
  return context.messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: textItems(message.content) };
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content.flatMap<ManagementModelContent>((item) => {
          if (item.type === 'text') return [{ type: 'text' as const, text: item.text }];
          if (item.type === 'toolCall') {
            return [{
              type: 'toolCall' as const,
              id: item.id,
              name: item.name as ManagementToolName,
              arguments: structuredClone(item.arguments) as Record<string, unknown>,
            }];
          }
          return [];
        }),
      };
    }
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName: message.toolName as ManagementToolName,
      content: textItems(message.content),
      isError: message.isError,
    };
  });
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createStreamSimple(
  adapter: ManagementModelAdapter,
  providerId: string,
  apiId: string,
  systemPrompt: string,
) {
  let callCount = 0;
  return (_model: Model<string>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        callCount += 1;
        const effectiveToolNames = (context.tools ?? []).map((tool) => tool.name as ManagementToolName);
        assertExactManagementToolAllowlist(effectiveToolNames);
        const tools = (context.tools ?? []).map((tool) => ({
          name: tool.name as ManagementToolName,
          description: tool.description,
          inputSchema: structuredClone(tool.parameters) as Record<string, unknown>,
          metadata: getManagementToolMetadata(tool.name as ManagementToolName),
        }));
        const response = await adapter.respond({
          systemPrompt,
          messages: messagesFromContext(context),
          tools,
          signal: options?.signal,
        }, { callCount });
        for (const item of response.content) {
          if (item.type === 'toolCall' && !MANAGEMENT_TOOL_NAMES.includes(item.name)) {
            throw new Error(`P0_MODEL_TOOL_REJECTED: ${String(item.name)}`);
          }
        }
        const content = response.content.map((item) => item.type === 'text'
          ? { type: 'text' as const, text: item.text }
          : {
              type: 'toolCall' as const,
              id: item.id,
              name: item.name,
              arguments: item.arguments,
            });
        const hasToolCall = content.some((item) => item.type === 'toolCall');
        const message: AssistantMessage = {
          role: 'assistant',
          content,
          api: apiId,
          provider: providerId,
          model: adapter.id,
          usage: emptyUsage(),
          stopReason: hasToolCall ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        };
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: hasToolCall ? 'toolUse' : 'stop', message });
      } catch (error) {
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: apiId,
          provider: providerId,
          model: adapter.id,
          usage: emptyUsage(),
          stopReason: options?.signal?.aborted ? 'aborted' : 'error',
          errorMessage: error instanceof Error ? error.message : 'management model failure',
          timestamp: Date.now(),
        };
        stream.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message });
      }
    })();
    return stream;
  };
}

function normalizeEvent(event: AgentSessionEvent): ManagementRuntimeEvent {
  if (event.type === 'agent_start' || event.type === 'agent_end' || event.type === 'agent_settled'
    || event.type === 'compaction_start' || event.type === 'compaction_end') {
    return { type: 'lifecycle', phase: event.type };
  }
  if (event.type === 'message_end') {
    if (event.message.role === 'user' || event.message.role === 'assistant' || event.message.role === 'toolResult') {
      return { type: 'message', role: event.message.role };
    }
    return { type: 'unsupported', eventType: `message_end:${event.message.role}` };
  }
  if (event.type === 'queue_update') {
    return { type: 'queue', steeringCount: event.steering.length, followUpCount: event.followUp.length };
  }
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    if (!MANAGEMENT_TOOL_NAMES.includes(event.toolName as ManagementToolName)) {
      return { type: 'unsupported', eventType: `${event.type}:unregistered_tool` };
    }
    return {
      type: 'tool',
      phase: event.type === 'tool_execution_start' ? 'start' : 'end',
      toolCallId: event.toolCallId,
      name: event.toolName as ManagementToolName,
      ...(event.type === 'tool_execution_end' ? { isError: event.isError } : {}),
    };
  }
  return { type: 'unsupported', eventType: event.type };
}

export function isNoopCompactionError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'Already compacted'
    || error.message === 'Nothing to compact (session too small)');
}

interface FailedSessionCleanupTarget {
  abort(): Promise<void>;
  dispose(): void;
}

export async function cleanupFailedSession(
  session: FailedSessionCleanupTarget | undefined,
  unregisterProvider: () => void,
): Promise<void> {
  if (session) {
    try {
      await session.abort();
    } catch {
      // Preserve the primary Session creation/validation error.
    }
    try {
      session.dispose();
    } catch {
      // Preserve the primary Session creation/validation error.
    }
  }
  try {
    unregisterProvider();
  } catch {
    // Preserve the primary Session creation/validation error.
  }
}

class PiManagementSession implements ManagementSession {
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly session: AgentSession,
    private readonly cleanup: () => void,
  ) {}

  prompt(input: { text: string }): Promise<void> {
    return this.session.prompt(input.text, { expandPromptTemplates: false });
  }

  steer(input: { text: string }): Promise<void> {
    return this.session.steer(input.text);
  }

  followUp(input: { text: string }): Promise<void> {
    return this.session.followUp(input.text);
  }

  async compact(input?: ManagementCompactionRequest): Promise<ManagementCompactionResult> {
    try {
      const result = await this.session.compact(input?.instructions);
      return {
        compacted: true,
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        ...(result.estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter: result.estimatedTokensAfter }),
      };
    } catch (error) {
      if (isNoopCompactionError(error)) {
        return { compacted: false, reason: 'not_needed' };
      }
      throw error;
    }
  }

  async abort(_reason: string): Promise<void> {
    await this.session.abort();
  }

  waitForIdle(): Promise<void> {
    return this.session.waitForIdle();
  }

  subscribe(listener: (event: ManagementRuntimeEvent) => void): () => void {
    return this.session.subscribe((event) => listener(normalizeEvent(event)));
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      try {
        await this.session.abort();
      } finally {
        try {
          this.session.dispose();
        } finally {
          this.cleanup();
        }
      }
    })();
    return this.disposePromise;
  }
}

class PiManagementRuntimeFactory implements ManagementRuntimeFactory {
  constructor(private readonly input: CreateManagementRuntimeFactoryInput) {}

  async createSession(input: CreateManagementSessionInput): Promise<ManagementSession> {
    if (!input.systemPrompt.id.trim() || !Number.isInteger(input.systemPrompt.version)
      || input.systemPrompt.version < 1 || !input.systemPrompt.content.trim()) {
      throw new Error('P0_SYSTEM_PROMPT_INVALID');
    }
    runtimeSequence += 1;
    const providerId = `agentbean-management-runtime-${runtimeSequence}`;
    const apiId = providerId;
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(providerId, 'agentbean-in-memory-provider');
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider(providerId, {
      name: 'AgentBean Management Runtime',
      baseUrl: 'http://agentbean.invalid',
      api: apiId,
      apiKey: 'agentbean-in-memory-provider',
      streamSimple: createStreamSimple(this.input.model, providerId, apiId, input.systemPrompt.content),
      models: [{
        id: this.input.model.id,
        name: this.input.model.id,
        api: apiId,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 4_096,
      }],
    });
    let createdSession: AgentSession | undefined;
    try {
      const model = modelRegistry.find(providerId, this.input.model.id);
      if (!model) throw new Error('P0_MODEL_REGISTRATION_FAILED');

      const customTools = createManagementToolCatalog(this.input.toolExecutor);
      const { session } = await createAgentSession({
        cwd: '/',
        agentDir: '/',
        authStorage,
        modelRegistry,
        model,
        noTools: 'builtin',
        tools: [...MANAGEMENT_TOOL_NAMES],
        customTools,
        resourceLoader: createManagementResourceLoader(input.systemPrompt.content),
        sessionManager: SessionManager.inMemory('/'),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      });
      createdSession = session;
      const effectiveTools = session.getActiveToolNames();
      assertExactManagementToolAllowlist(effectiveTools as ManagementToolName[]);
      return new PiManagementSession(session, () => modelRegistry.unregisterProvider(providerId));
    } catch (error) {
      await cleanupFailedSession(createdSession, () => modelRegistry.unregisterProvider(providerId));
      throw error;
    }
  }
}

export function createManagementRuntimeFactory(input: CreateManagementRuntimeFactoryInput): ManagementRuntimeFactory {
  if (!input.model.id.trim() || typeof input.model.respond !== 'function'
    || typeof input.toolExecutor !== 'function') {
    throw new Error('P0_RUNTIME_FACTORY_INVALID');
  }
  return new PiManagementRuntimeFactory(input);
}
