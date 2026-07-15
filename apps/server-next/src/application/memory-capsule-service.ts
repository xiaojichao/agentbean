import { createHash } from 'node:crypto';

import type {
  ID,
  MemoryCapsuleAuthorizationDto,
  MemoryCapsuleDto,
  MemoryCapsuleItemDto,
  MemoryContentKind,
  MemoryKind,
  MemorySourceRefDto,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import type { MemoryAuditActorKind, MemorySourceRecord } from './memory-repositories.js';
import type { MemoryUnitOfWork } from './memory-unit-of-work.js';
import type {
  CollaborativeMemorySearchMatch,
  SearchCollaborativeMemoriesInput,
} from './collaborative-memory-search-service.js';

/**
 * 最小 Capsule 创建（spec §4.1/§11/§16，P3-06）。把当前 management run 对目标 Agent 有权看到的
 * 最小 Memory 集合打包成可撤销投影（Capsule），逐项冻结脱敏后内容、来源指纹、授权决策与期限，
 * 供后续 inject（P3-07/13）逐字段复验。
 *
 * 本片范围（「最小」）：仅打包 **scope-policy** match（team/channel/task/agent/user 可见、无需
 * explicit-grant 的记忆），脱敏级别 none。explicit-grant（dm/private 经 grant 共享）的 item 需要
 * 把多个 grant 映射成单一 authorization，留待与 P3-07 复验协同的后续切片。
 *
 * Capsule 是投影不持久化（spec §4.1「记忆是投影，不是事实源」）；只持久化 capsule-created 审计。
 * 权限过滤、脱敏与排序复用 #591 的 CollaborativeMemorySearchService，本层只做「打包 + 冻结 + 审计」。
 */

const ACTOR_SYSTEM: MemoryAuditActorKind = 'system';
const DEFAULT_CAPSULE_TTL_MS = 15 * 60 * 1000;

export interface CreateCapsuleInput {
  readonly teamId: ID;
  readonly requesterUserId: ID;
  readonly managementRunId: ID;
  readonly targetAgentId: ID;
  readonly taskId?: ID;
  readonly channelId?: ID;
  readonly userId?: ID;
  readonly prompt: string;
  readonly limit: number;
  readonly now: UnixMs;
  /** 当前 management policy 版本，注入复验会逐字段比对。 */
  readonly currentPolicyVersion: number;
  readonly ttlMs?: number;
}

export interface MemoryCapsuleServiceDeps {
  readonly searchService: {
    search(input: SearchCollaborativeMemoriesInput): Promise<{
      readonly matches: readonly CollaborativeMemorySearchMatch[];
    }>;
  };
  readonly unitOfWork: MemoryUnitOfWork;
  readonly clock: { now(): UnixMs };
  readonly ids: { nextId(): ID };
}

export interface MemoryCapsuleService {
  createCapsule(input: CreateCapsuleInput): Promise<MemoryCapsuleDto>;
}

export function createMemoryCapsuleService(deps: MemoryCapsuleServiceDeps): MemoryCapsuleService {
  const { searchService, unitOfWork, clock, ids } = deps;

  return {
    async createCapsule(input) {
      const searchResult = await searchService.search({
        teamId: input.teamId,
        requesterUserId: input.requesterUserId,
        targetAgentId: input.targetAgentId,
        taskId: input.taskId,
        channelId: input.channelId,
        userId: input.userId,
        prompt: input.prompt,
        now: input.now,
        limit: input.limit,
      });
      // 最小 Capsule：只冻结 scope-policy 决策的 item。
      const scopePolicyMatches = searchResult.matches.filter((match) => match.accessMode === 'scope-policy');

      const capsuleId = ids.nextId();
      const issuedAt = input.now;
      const expiresAt = input.now + (input.ttlMs ?? DEFAULT_CAPSULE_TTL_MS);
      const items = scopePolicyMatches.map((match) => buildScopePolicyItem(
        match, ids.nextId(), input, issuedAt, expiresAt,
      ));

      const capsule: MemoryCapsuleDto = {
        schemaVersion: 1,
        id: capsuleId,
        teamId: input.teamId,
        managementRunId: input.managementRunId,
        taskId: input.taskId,
        targetAgentId: input.targetAgentId,
        items,
        createdAt: issuedAt,
        expiresAt,
      };

      await unitOfWork.run(async (memory) => {
        await memory.auditEvents.append({
          id: ids.nextId(),
          teamId: input.teamId,
          subjectKind: 'capsule',
          subjectId: capsuleId,
          eventType: 'capsule-created',
          actorKind: ACTOR_SYSTEM,
          actorId: input.requesterUserId,
          targetAgentId: input.targetAgentId,
          sourceRefs: [],
          createdAt: clock.now(),
        });
      });

      return capsule;
    },
  };
}

function buildScopePolicyItem(
  match: CollaborativeMemorySearchMatch,
  decisionId: ID,
  input: CreateCapsuleInput,
  issuedAt: UnixMs,
  expiresAt: UnixMs,
): MemoryCapsuleItemDto {
  const item = match.item;
  const sourceRefs: MemorySourceRefDto[] = match.sources.map(toSourceRefDto);
  const sourceRefsHash = hashSourceRefs(sourceRefs);
  const contentHash = hashMemoryContent(item.content);
  const contentKind = memoryContentKind(item.kind);

  const authorization: MemoryCapsuleAuthorizationDto = {
    schemaVersion: 1,
    decisionId,
    mode: 'scope-policy',
    policyVersion: input.currentPolicyVersion,
    targetAgentId: input.targetAgentId,
    sourceScopeType: item.scopeType,
    sourceScopeRef: item.scopeRef,
    sourceRefsHash,
    contentHash,
    authorizedContentKind: contentKind,
    authorizedRedactionLevel: 'none',
    issuedAt,
    expiresAt,
  };

  return {
    schemaVersion: 1,
    memoryId: item.id,
    scopeType: item.scopeType,
    scopeRef: item.scopeRef,
    // scope-policy = 目标 Agent 经 scope 可见，等价 team 可见性。
    sourceVisibility: 'team',
    contentKind,
    redactionLevel: 'none',
    content: item.content,
    sourceRefs,
    authorization,
    expiresAt,
  };
}

function memoryContentKind(kind: MemoryKind): MemoryContentKind {
  if (kind === 'decision') return 'decision';
  if (kind === 'preference') return 'preference';
  if (kind === 'procedural') return 'procedure';
  if (kind === 'artifact-summary') return 'summary';
  return 'fact';
}

function toSourceRefDto(record: Pick<MemorySourceRecord, 'sourceKind' | 'sourceId' | 'snapshotHash'>): MemorySourceRefDto {
  return {
    schemaVersion: 1,
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    snapshotHash: record.snapshotHash,
  };
}

function hashMemoryContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function hashSourceRefs(refs: readonly MemorySourceRefDto[]): string {
  const canonical = [...refs]
    .map((ref) => `${ref.sourceKind}:${ref.sourceId}:${ref.snapshotHash}`)
    .sort()
    .join('|');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
