import type {
  ID,
  MemoryCapsuleAuthorizationDto,
  MemoryCapsuleDto,
  MemoryCapsuleItemDto,
  MemoryCapsuleRefDto,
  MemoryContentKind,
  MemoryKind,
  MemorySourceRefDto,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import { hashCapsuleItems, hashMemoryContent, hashSourceRefs } from '../../../../packages/domain/src/index.js';
import type {
  MemoryAuditActorKind,
  MemoryAuditEventRecord,
  MemorySourceRecord,
} from './memory-repositories.js';
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
        accessMode: 'scope-policy',
      });
      // 最小 Capsule：只冻结普通 team-visible 的 scope-policy 决策；DM/private 来源必须显式授权。
      const scopePolicyMatches = searchResult.matches.filter(isSafeScopePolicyMatch);

      const capsuleId = ids.nextId();
      const issuedAt = input.now;
      const ttlExpiresAt = input.now + (input.ttlMs ?? DEFAULT_CAPSULE_TTL_MS);
      const expiresAt = scopePolicyMatches.reduce(
        (earliest, match) => Math.min(earliest, match.item.validUntil ?? earliest),
        ttlExpiresAt,
      );
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
        const createdAt = clock.now();
        const auditRecords = items.length === 0
          ? [emptyCapsuleAudit(ids.nextId(), input, capsuleId, createdAt)]
          : items.map((item) => capsuleItemAudit(ids.nextId(), input, capsuleId, item, createdAt));
        for (const record of auditRecords) await memory.auditEvents.append(record);
      });

      return capsule;
    },
  };
}

function isSafeScopePolicyMatch(match: CollaborativeMemorySearchMatch): boolean {
  return match.accessMode === 'scope-policy'
    && match.item.scopeType !== 'dm'
    && match.sources.every((source) => source.sourceVisibility === 'team');
}

function emptyCapsuleAudit(
  id: ID,
  input: CreateCapsuleInput,
  capsuleId: ID,
  createdAt: UnixMs,
): MemoryAuditEventRecord {
  return {
    id,
    teamId: input.teamId,
    subjectKind: 'capsule',
    subjectId: capsuleId,
    eventType: 'capsule-created',
    actorKind: ACTOR_SYSTEM,
    actorId: input.requesterUserId,
    targetAgentId: input.targetAgentId,
    sourceRefs: [],
    createdAt,
  };
}

function capsuleItemAudit(
  id: ID,
  input: CreateCapsuleInput,
  capsuleId: ID,
  item: MemoryCapsuleItemDto,
  createdAt: UnixMs,
): MemoryAuditEventRecord {
  return {
    id,
    teamId: input.teamId,
    subjectKind: 'capsule',
    subjectId: capsuleId,
    eventType: 'capsule-created',
    actorKind: ACTOR_SYSTEM,
    actorId: input.requesterUserId,
    decisionId: item.authorization.decisionId,
    targetAgentId: input.targetAgentId,
    scopeType: item.authorization.sourceScopeType,
    scopeRef: item.authorization.sourceScopeRef,
    sourceRefs: item.sourceRefs,
    sourceRefsHash: item.authorization.sourceRefsHash,
    contentHash: item.authorization.contentHash,
    redactionLevel: item.redactionLevel,
    createdAt,
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

/**
 * 从 Capsule 投影派生冻结引用 `MemoryCapsuleRefDto`,供固化进 immutable Invocation intent（Task 6）。
 *
 * `contentHash` 用 `hashCapsuleItems` 聚合全部 item 的内容+来源指纹（单一哈希源,与创建侧共享,
 * 任一 item 漂移即变);`authorizationDecisionId` 取首项 decision 作代表（空 Capsule 回退 capsule id）。
 * Recovery（Task 6）只用 `expiresAt` 判有效性,这两个字段作冻结指纹防篡改。Capsule 本身不持久化,
 * Ref 嵌入 intent 后由 intentHash 保护,recovery 从 invocation intent 取回此 Ref。
 */
export function toMemoryCapsuleRef(capsule: MemoryCapsuleDto): MemoryCapsuleRefDto {
  return {
    schemaVersion: 1,
    id: capsule.id,
    teamId: capsule.teamId,
    managementRunId: capsule.managementRunId,
    taskId: capsule.taskId,
    targetAgentId: capsule.targetAgentId,
    contentHash: hashCapsuleItems(capsule.items),
    authorizationDecisionId: capsule.items[0]?.authorization.decisionId ?? capsule.id,
    expiresAt: capsule.expiresAt,
  };
}
