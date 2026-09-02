import {
  createOpenAiCompatibleManagementModelAdapter,
  ManagementModelAdapterError,
  type ManagementModelRequest,
  type ManagementModelResponse,
} from '@agentbean/pi-management-runtime';
import type { AgentCapabilityDirectoryDto } from '../../../../packages/contracts/src/index.js';
import type { MessageRouteAnalysisRecord } from './message-tracer-repositories.js';
import type { MessageRoutePiProposal } from './message-route-analysis-service.js';

export interface MessageRoutePiAnalyzerDependencies {
  readonly resolveActiveTarget: () => Promise<
    | { readonly kind: 'available'; readonly config: { baseUrl: string; modelId: string; timeoutMs: number; maxOutputTokens: number }; readonly apiKey: string }
    | { readonly kind: 'unavailable'; readonly diagnosticCode: string }
  >;
  readonly resolveCapabilityDirectory: (input: {
    readonly teamId: string;
    readonly channelId: string;
  }) => Promise<AgentCapabilityDirectoryDto | null>;
  readonly fetch?: typeof fetch;
}

const SYSTEM_PROMPT = [
  'You are AgentBean PI Manager. Classify one unassigned channel message and propose a route.',
  'You are advisory only. Use only agentId and capabilityId values from the supplied capability directory.',
  'Choose exactly one routeKind: chat_only, direct_agent, collaboration, complex_task, clarification.',
  'direct_agent is one simple bounded task for one agent.',
  'collaboration is multiple independent contributions. complex_task requires 2 or more vertical subtasks and may declare dependencies by zero-based indexes of earlier subtasks.',
  'High-risk or ambiguous requests must use clarification and riskLevel high.',
  'Return exactly one JSON object, no markdown or prose, with keys:',
  '{"routeKind":"...","riskLevel":"low|high","targetAgentIds":[],"requiredCapabilityIds":[],"subtasks":[{"title":"...","objective":"...","targetAgentId":"...","requiredCapabilityIds":[],"acceptanceCriteria":[],"dependsOnSubtaskIndexes":[]}]}',
].join('\n');

const EMPTY_SESSION_CONTEXT = {
  schemaVersion: 1 as const,
  mode: 'managed' as const,
  scope: { kind: 'managed' as const, managementRunId: 'message-route', teamId: 'system', channelId: 'system', rootMessageId: 'route' },
  visibleMessages: [],
  visibleCheckpoint: { revision: 0, lastEventSequence: 0, objective: 'route', planSummary: 'route' },
};

export function createMessageRoutePiAnalyzer(deps: MessageRoutePiAnalyzerDependencies) {
  return async (input: {
    readonly analysis: MessageRouteAnalysisRecord;
    readonly body: string;
    readonly channelAgentIds: readonly string[];
  }): Promise<MessageRoutePiProposal | { readonly unavailable: true; readonly diagnosticCode: string }> => {
    const [target, directory] = await Promise.all([
      deps.resolveActiveTarget(),
      deps.resolveCapabilityDirectory({ teamId: input.analysis.teamId, channelId: input.analysis.channelId }),
    ]);
    if (target.kind === 'unavailable') return { unavailable: true, diagnosticCode: target.diagnosticCode };
    if (!directory) return { unavailable: true, diagnosticCode: 'PI_CAPABILITY_DIRECTORY_UNAVAILABLE' };
    const safeDirectory = directory.entries.map((entry) => ({
      agentId: entry.agentId,
      agentName: entry.agentName,
      available: entry.available,
      capabilities: entry.capabilities.map((capability) => ({
        capabilityId: capability.registry.capabilityId,
        name: capability.name,
        description: capability.description,
      })),
      skills: entry.skills.map((skill) => ({ name: skill.name, description: skill.description })),
      constraints: entry.constraints,
    }));
    let response: ManagementModelResponse;
    try {
      const adapter = createOpenAiCompatibleManagementModelAdapter({
        id: `message-route:${input.analysis.id}`,
        apiKey: target.apiKey,
        baseUrl: target.config.baseUrl,
        modelId: target.config.modelId,
        timeoutMs: target.config.timeoutMs,
        maxOutputTokens: target.config.maxOutputTokens,
        fetch: deps.fetch,
      });
      const request: ManagementModelRequest = {
        systemPrompt: SYSTEM_PROMPT,
        sessionContext: EMPTY_SESSION_CONTEXT as never,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({
          message: input.body,
          capabilityDirectory: safeDirectory,
        }) }] }],
        tools: [],
      };
      response = await adapter.respond(request, { callCount: 1 });
    } catch (error) {
      return {
        unavailable: true,
        diagnosticCode: error instanceof ManagementModelAdapterError
          ? error.code
          : 'PI_ROUTE_MODEL_FAILED',
      };
    }
    const proposal = parseProposal(response);
    if (!proposal) return { unavailable: true, diagnosticCode: 'PI_ROUTE_OUTPUT_INVALID' };
    if (!validateAgainstDirectory(proposal, directory, input.channelAgentIds)) {
      return { unavailable: true, diagnosticCode: 'PI_ROUTE_CAPABILITY_UNAUTHORIZED' };
    }
    return proposal;
  };
}

function parseProposal(response: ManagementModelResponse): MessageRoutePiProposal | null {
  if (response.finishReason !== 'stop') return null;
  const texts = response.content.filter((item): item is { type: 'text'; text: string } => item.type === 'text');
  if (texts.length !== 1) return null;
  let value: unknown;
  try {
    value = JSON.parse(texts[0]!.text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
  } catch {
    return null;
  }
  if (!isObject(value) || !exactKeys(value, ['routeKind', 'riskLevel', 'targetAgentIds', 'requiredCapabilityIds', 'subtasks'])) return null;
  const routeKinds = ['chat_only', 'direct_agent', 'collaboration', 'complex_task', 'clarification'] as const;
  if (!routeKinds.includes(value.routeKind as typeof routeKinds[number])) return null;
  if (value.riskLevel !== 'low' && value.riskLevel !== 'high') return null;
  if (!stringArray(value.targetAgentIds) || !stringArray(value.requiredCapabilityIds) || !Array.isArray(value.subtasks)) return null;
  const subtasks = [];
  for (const [index, item] of value.subtasks.entries()) {
    if (!isObject(item) || !exactKeys(item, [
      'title', 'objective', 'targetAgentId', 'requiredCapabilityIds', 'acceptanceCriteria',
      'dependsOnSubtaskIndexes',
    ])) return null;
    if (!nonEmpty(item.title) || !nonEmpty(item.objective) || !nonEmpty(item.targetAgentId)
      || !stringArray(item.requiredCapabilityIds) || !stringArray(item.acceptanceCriteria)
      || item.acceptanceCriteria.length === 0 || !integerArray(item.dependsOnSubtaskIndexes)) return null;
    const dependencyIndexes = item.dependsOnSubtaskIndexes;
    if (new Set(dependencyIndexes).size !== dependencyIndexes.length
      || dependencyIndexes.some((dependencyIndex) => dependencyIndex < 0 || dependencyIndex >= index)) return null;
    subtasks.push({
      title: item.title.trim(), objective: item.objective.trim(), targetAgentId: item.targetAgentId,
      requiredCapabilityIds: [...item.requiredCapabilityIds], acceptanceCriteria: [...item.acceptanceCriteria],
      dependsOnSubtaskIndexes: [...dependencyIndexes],
    });
  }
  if (value.routeKind === 'direct_agent' && (value.targetAgentIds.length !== 1 || subtasks.length !== 1)) return null;
  if ((value.routeKind === 'collaboration' || value.routeKind === 'complex_task') && subtasks.length < 2) return null;
  if ((value.routeKind === 'direct_agent' || value.routeKind === 'collaboration')
    && subtasks.some((subtask) => (subtask.dependsOnSubtaskIndexes?.length ?? 0) > 0)) return null;
  if ((value.routeKind === 'chat_only' || value.routeKind === 'clarification')
    && (value.targetAgentIds.length > 0 || subtasks.length > 0)) return null;
  return {
    routeKind: value.routeKind as MessageRoutePiProposal['routeKind'],
    riskLevel: value.riskLevel,
    targetAgentIds: [...value.targetAgentIds],
    requiredCapabilityIds: [...value.requiredCapabilityIds],
    subtasks,
  };
}

function validateAgainstDirectory(
  proposal: MessageRoutePiProposal,
  directory: AgentCapabilityDirectoryDto,
  channelAgentIds: readonly string[],
): boolean {
  const byAgent = new Map(directory.entries.filter((entry) => entry.available).map((entry) => [entry.agentId, entry]));
  const channelAgents = new Set(channelAgentIds);
  if (proposal.targetAgentIds.some((agentId) => !channelAgents.has(agentId) || !byAgent.has(agentId))) return false;
  const targetCapabilityIds = new Set(proposal.targetAgentIds.flatMap((agentId) =>
    byAgent.get(agentId)?.capabilities.map((capability) => capability.registry.capabilityId) ?? []));
  if (proposal.requiredCapabilityIds.some((capabilityId) => !targetCapabilityIds.has(capabilityId))) return false;
  return (proposal.subtasks ?? []).every((subtask) => {
    const entry = byAgent.get(subtask.targetAgentId);
    if (!entry || !proposal.targetAgentIds.includes(subtask.targetAgentId)) return false;
    const capabilities = new Set(entry.capabilities.map((capability) => capability.registry.capabilityId));
    return subtask.requiredCapabilityIds.every((capabilityId) => capabilities.has(capabilityId));
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty);
}
function integerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item));
}
