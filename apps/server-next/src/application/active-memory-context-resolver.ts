import type {
  ActiveMemoryAttributionDto,
  ActiveMemoryContextDto,
  ActiveMemoryProvenanceDto,
  AgentMemoryProjectionConsumptionDto,
  FormalMemoryDto,
  ID,
  MemoryKind,
  MemoryScopeType,
} from '../../../../packages/contracts/src/index.js';
import { formalKindToStorageKind } from '../../../../packages/contracts/src/index.js';
import type { ActiveMemoryCandidate, ExcludedActiveMemory } from '../../../../packages/domain/src/index.js';
import { assembleActiveMemoryContext, renderActiveMemorySection, scoreMemoryRelevance } from '../../../../packages/domain/src/index.js';

import type { AgentMemoryProjectionService } from './agent-memory-projection-service.js';
import { createCollaborativeMemorySearchService } from './collaborative-memory-search-service.js';
import type { FormalMemoryService } from './formal-memory-service.js';
import type { ServerNextRepositories } from './repositories.js';
import { canReadMemoryScope, createServerMemorySearchPermissions } from './server-memory-permissions.js';

/**
 * Active Memory Context 解析器（issue #720，AC#8「同一权限过滤接缝」）。
 *
 * Coordinator 与 ManagementRun 共用本解析器：收集 4 来源候选 → 补 server 权限预判
 * （scopeVisible / allSourcesAvailable）→ 调 domain `assembleActiveMemoryContext` 做硬门禁
 * 复验 + 来源配额截断 + 幂等哈希 → 渲染 prompt 片段。每次 resolve 都重新查询 + 重新判权限
 * （AC#2，无进程级缓存，对齐 `prepareDispatchRuntimeMemory` 注释）。
 *
 * 默认不可见（AC#3）由两层保证：本解析器只查当前 Team/Channel/Task scope + 归档频道跳过；
 * domain `evaluateMemoryInjection` 复验 status/有效期/scope/source。未批准 Candidate、其他
 * 频道/Team/用户、归档 Channel Memory 因查询范围或 status 过滤而天然不进入。
 */

export interface ActiveMemoryContextResolverDeps {
  readonly repositories: ServerNextRepositories;
  readonly formalMemory: FormalMemoryService;
  readonly agentMemoryProjection: AgentMemoryProjectionService;
  readonly clock: { now(): number };
  /** 最小 context 上限（AC#1「少量」）。 */
  readonly limit: number;
}

export interface ResolveActiveMemoryContextInput {
  readonly teamId: ID;
  readonly channelId: ID;
  readonly messageId: ID;
  /** 消息发送者：memory 读取的权限主体（PI 代表发送者读取其有权查看的来源）。 */
  readonly senderUserId: ID;
  /** 当前 Task（线程绑定后传入；无则不注入 task_fact 来源）。 */
  readonly taskId?: ID;
  readonly prompt: string;
  /** agent_request 时的目标 agent；用于按需检索其 projection（AC#4）。 */
  readonly targetAgentId?: ID;
  /** AC#4：默认 false（不全量注入 Agent Memory）；候选选择/调用 Agent 时 true。 */
  readonly includeAgentProjections: boolean;
}

export interface ResolveActiveMemoryContextResult {
  readonly context: ActiveMemoryContextDto;
  readonly attribution: ActiveMemoryAttributionDto;
  /** 渲染好的 prompt 片段；空串表示无 memory（调用方据此跳过拼入）。 */
  readonly renderedSection: string;
  readonly excluded: readonly ExcludedActiveMemory[];
}

/** formal memory 过滤：active + 未过期 + 未被 supersede（AC#3，补 listFormal status 缺口）。 */
function filterActiveFormal(items: readonly FormalMemoryDto[], now: number): readonly FormalMemoryDto[] {
  return items.filter(
    (item) =>
      item.status === 'active'
      && (item.validUntil === undefined || item.validUntil > now)
      && item.supersededById === undefined,
  );
}

function toFormalCandidate(
  item: FormalMemoryDto,
  source: 'team_formal_memory' | 'channel_formal_memory',
  selectionReason: 'current_team_policy' | 'current_channel_context',
  scopeVisible: boolean,
  score: number,
): ActiveMemoryCandidate {
  const provenance: ActiveMemoryProvenanceDto = { source, memoryId: item.id, formalKind: item.kind };
  return {
    id: item.id,
    kind: formalKindToStorageKind(item.kind),
    scopeType: item.scopeType,
    content: item.content,
    status: item.status,
    validUntil: item.validUntil,
    provenance,
    selectionReason,
    scopeVisible,
    // formal memory 来源由 Team Owner/Admin 审批保证（ADR 0046）；task scope 来源由 search 已校验。
    allSourcesAvailable: true,
    relevanceScore: score,
  };
}

function toProjectionCandidate(proj: AgentMemoryProjectionConsumptionDto): ActiveMemoryCandidate {
  const kind: MemoryKind = formalKindToStorageKind(proj.kind);
  return {
    id: proj.projectionId,
    kind,
    scopeType: 'agent' as MemoryScopeType,
    content: proj.content,
    // getConsumableProjections 已校验 active + opt-in + revision fence；注入即有效。
    status: 'active',
    validUntil: proj.validUntil ?? undefined,
    provenance: {
      source: 'agent_projection',
      projectionId: proj.projectionId,
      agentId: proj.agentId,
      agentName: proj.agentName,
    },
    selectionReason: 'enabled_agent_projection',
    scopeVisible: true,
    allSourcesAvailable: true,
    // projection 按需检索、不全量注入（AC#4）；不参与跨来源 ranking，分数固定 0。
    relevanceScore: 0,
  };
}

export function createActiveMemoryContextResolver(deps: ActiveMemoryContextResolverDeps) {
  // 自包含创建 collaborative search service（复用 server 权限）；Coordinator 装配点无需单独注入。
  const collaborativeMemorySearch = createCollaborativeMemorySearchService({
    repositories: deps.repositories.memory,
    permissions: createServerMemorySearchPermissions(deps.repositories),
  });

  async function resolve(input: ResolveActiveMemoryContextInput): Promise<ResolveActiveMemoryContextResult> {
    const now = deps.clock.now();
    const candidates: ActiveMemoryCandidate[] = [];
    // PI 代表发送者读取；targetAgentId 缺省回退发送者（task scope 可见性按发送者判定）。
    const readerAgentId = input.targetAgentId ?? input.senderUserId;
    const rankingContext = {
      teamId: input.teamId,
      targetAgentId: readerAgentId,
      taskId: input.taskId,
      channelId: input.channelId,
      userId: input.senderUserId,
      prompt: input.prompt,
    };

    // ── 1. Team Formal Memory（ADR 0008「少量核心 Team Memory」）──
    const teamScopeVisible = await canReadMemoryScope(deps.repositories, {
      teamId: input.teamId,
      requesterUserId: input.senderUserId,
      scopeType: 'team',
      scopeRef: input.teamId,
    });
    if (teamScopeVisible) {
      const teamFormal = await deps.formalMemory.list({
        teamId: input.teamId,
        scopeType: 'team',
        scopeRef: input.teamId,
      });
      for (const item of filterActiveFormal(teamFormal, now)) {
        const score = scoreMemoryRelevance(
          {
            id: item.id,
            kind: formalKindToStorageKind(item.kind),
            scopeType: item.scopeType,
            scopeRef: item.scopeRef,
            content: item.content,
            summary: item.summary,
            updatedAt: item.updatedAt,
          },
          rankingContext,
        ).score;
        candidates.push(toFormalCandidate(item, 'team_formal_memory', 'current_team_policy', true, score));
      }
    }

    // ── 2. Channel Formal Memory（归档频道跳过，AC#3）──
    const channel = await deps.repositories.channels.getById(input.channelId);
    if (channel && channel.teamId === input.teamId && channel.archivedAt == null) {
      const channelScopeVisible = await canReadMemoryScope(deps.repositories, {
        teamId: input.teamId,
        requesterUserId: input.senderUserId,
        scopeType: 'channel',
        scopeRef: input.channelId,
      });
      if (channelScopeVisible) {
        const channelFormal = await deps.formalMemory.list({
          teamId: input.teamId,
          scopeType: 'channel',
          scopeRef: input.channelId,
        });
        for (const item of filterActiveFormal(channelFormal, now)) {
          const score = scoreMemoryRelevance(
            {
              id: item.id,
              kind: formalKindToStorageKind(item.kind),
              scopeType: item.scopeType,
              scopeRef: item.scopeRef,
              content: item.content,
              summary: item.summary,
              updatedAt: item.updatedAt,
            },
            rankingContext,
          ).score;
          candidates.push(toFormalCandidate(item, 'channel_formal_memory', 'current_channel_context', true, score));
        }
      }
    }

    // ── 3. Task Fact（当前 Task 相关协作记忆；search 已含全套权限+来源+ranking）──
    if (input.taskId) {
      const searchResult = await collaborativeMemorySearch.search({
        teamId: input.teamId,
        requesterUserId: input.senderUserId,
        targetAgentId: readerAgentId,
        taskId: input.taskId,
        channelId: input.channelId,
        userId: input.senderUserId,
        prompt: input.prompt,
        now,
        limit: deps.limit,
      });
      for (const match of searchResult.matches) {
        candidates.push({
          id: match.item.id,
          kind: match.item.kind,
          scopeType: match.item.scopeType,
          content: match.item.content,
          status: match.item.status,
          validUntil: match.item.validUntil,
          provenance: { source: 'task_fact', memoryId: match.item.id, taskId: input.taskId },
          selectionReason: 'current_task_scope',
          // search 已校验 scope 可见性与来源可用性。
          scopeVisible: true,
          allSourcesAvailable: true,
          relevanceScore: match.score,
        });
      }
    }

    // ── 4. Agent Projection（按需检索，AC#4：不全量注入）──
    if (input.includeAgentProjections && input.targetAgentId) {
      const projectionResult = await deps.agentMemoryProjection.getConsumableProjections({
        teamId: input.teamId,
        agentId: input.targetAgentId,
      });
      for (const proj of projectionResult.projections) {
        candidates.push(toProjectionCandidate(proj));
      }
    }

    const assembled = assembleActiveMemoryContext({ candidates, now, limit: deps.limit });
    return {
      context: assembled.context,
      attribution: assembled.attribution,
      renderedSection: renderActiveMemorySection(assembled.context.items),
      excluded: assembled.excluded,
    };
  }

  return { resolve };
}

export type ActiveMemoryContextResolver = ReturnType<typeof createActiveMemoryContextResolver>;
