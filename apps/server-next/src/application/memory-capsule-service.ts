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
  MemoryCapsuleItemManifestRecord,
  MemoryCapsuleRefRecord,
  MemoryGrantRecord,
  MemorySourceRecord,
} from './memory-repositories.js';
import type { MemoryUnitOfWork } from './memory-unit-of-work.js';
import type {
  CollaborativeMemorySearchMatch,
  SearchCollaborativeMemoriesInput,
} from './collaborative-memory-search-service.js';
import { assertServerMemoryScope } from './memory-repository-validation.js';

/**
 * 最小 Capsule 创建（spec §4.1/§11/§16，P3-06）。把当前 management run 对目标 Agent 有权看到的
 * 最小 Memory 集合打包成可撤销投影（Capsule），逐项冻结脱敏后内容、来源指纹、授权决策与期限，
 * 供后续 inject（P3-07/13）逐字段复验。
 *
 * 普通 scope-policy item 保留完整正文；DM/private item 只有在搜索结果能收敛为一个 active grant
 * 时才进入 Capsule，并冻结该 grant 的版本、授权内容类型、脱敏级别与期限。需要多个 grant 的 item
 * 无法由单一 authorization 完整表达，创建端直接 fail-closed。
 *
 * Capsule 正文不重复持久化；只保存可用于 restart/recovery 重建的无正文 item manifest、权威 ref
 * 与 capsule-created 审计。权限过滤、脱敏与排序复用 CollaborativeMemorySearchService。
 */

const ACTOR_SYSTEM: MemoryAuditActorKind = 'system';
const DEFAULT_CAPSULE_TTL_MS = 15 * 60 * 1000;

export interface CreateCapsuleInput {
  readonly capsuleId?: ID;
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
        // 先完成授权/来源 hard gate 与全量排序，再在可安全表达为单一 authorization 的投影上截断。
        limit: 100,
      });
      const matches = searchResult.matches.filter(isSafeCapsuleMatch).slice(0, normalizeLimit(input.limit));

      const capsuleId = input.capsuleId ?? ids.nextId();
      const issuedAt = input.now;
      const ttlExpiresAt = input.now + (input.ttlMs ?? DEFAULT_CAPSULE_TTL_MS);
      const expiresAt = matches.reduce(
        (earliest, match) => Math.min(
          earliest,
          match.item.validUntil ?? earliest,
          match.grants[0]?.expiresAt ?? earliest,
        ),
        ttlExpiresAt,
      );
      const items = matches.map((match) => match.accessMode === 'explicit-grant'
        ? buildExplicitGrantItem(match, match.grants[0]!, ids.nextId(), input, issuedAt, expiresAt)
        : buildScopePolicyItem(match, ids.nextId(), input, issuedAt, expiresAt));

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
        // 持久化权威 capsuleRef（P3-08）：checkpoint/recovery 据此判 capsule 是否仍有效
        // （存在 + 未过期 + 未 deny），不扫 invocation intent（management-checkpoint.ts:141 注释）。
        await memory.capsuleRefs.create(toCapsuleRefRecord(capsule));
        for (const [position, item] of items.entries()) {
          await memory.capsuleItems.create(toCapsuleItemManifest(
            capsule,
            item,
            input.requesterUserId,
            position,
            capsule.createdAt,
          ));
        }
        const auditRecords = items.length === 0
          ? [emptyCapsuleAudit(ids.nextId(), input, capsuleId, createdAt)]
          : items.map((item) => capsuleItemAudit(ids.nextId(), input, capsuleId, item, createdAt));
        for (const record of auditRecords) await memory.auditEvents.append(record);
      });

      return capsule;
    },
  };
}

function toCapsuleItemManifest(
  capsule: MemoryCapsuleDto,
  item: MemoryCapsuleItemDto,
  requesterUserId: ID,
  position: number,
  createdAt: UnixMs,
): MemoryCapsuleItemManifestRecord {
  const scopeType = item.scopeType;
  const sourceVisibility = item.sourceVisibility;
  assertServerMemoryScope(scopeType, item.scopeRef);
  if (sourceVisibility === 'local-only') {
    throw new Error('server Capsule manifest cannot contain local Memory');
  }
  return {
    capsuleId: capsule.id,
    teamId: capsule.teamId,
    requesterUserId,
    memoryId: item.memoryId,
    position,
    scopeType,
    scopeRef: item.scopeRef,
    sourceVisibility,
    contentKind: item.contentKind,
    redactionLevel: item.redactionLevel,
    contentField: item.redactionLevel === 'summary-only' ? 'summary' : 'content',
    authorization: item.authorization,
    expiresAt: item.expiresAt,
    createdAt,
  };
}

/**
 * 派生冻结的 Capsule ref（进 invocation intent，intentHash 天然冻结）。
 * contentHash=hashCapsuleItems（domain 单一源），与持久化的 MemoryCapsuleRefRecord 同源，
 * 保证 recovery 比对一致。空 capsule 的 authorizationDecisionId 回退 capsule.id。
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

function toCapsuleRefRecord(capsule: MemoryCapsuleDto): MemoryCapsuleRefRecord {
  const ref = toMemoryCapsuleRef(capsule);
  // ref 与 capsule 同生：issuedAt=createdAt=capsule.createdAt（input.now），不引入独立时钟，
  // 避免外部队列的 clock tick 落后于 capsule 创建时间触发 "creation precedes issue time"。
  return {
    id: ref.id,
    teamId: ref.teamId,
    managementRunId: ref.managementRunId,
    taskId: ref.taskId,
    targetAgentId: ref.targetAgentId,
    contentHash: ref.contentHash,
    authorizationDecisionId: ref.authorizationDecisionId,
    issuedAt: capsule.createdAt,
    expiresAt: ref.expiresAt,
    createdAt: capsule.createdAt,
  };
}

function isSafeScopePolicyMatch(match: CollaborativeMemorySearchMatch): boolean {
  return match.accessMode === 'scope-policy'
    && match.item.scopeType !== 'dm'
    && match.sources.every((source) => source.sourceVisibility === 'team');
}

function isSafeCapsuleMatch(match: CollaborativeMemorySearchMatch): boolean {
  if (isSafeScopePolicyMatch(match)) return true;
  return match.accessMode === 'explicit-grant'
    && match.grants.length === 1
    && match.grants[0]?.status === 'active'
    // Server Capsule 绝不携带 DM/private 原文；显式授权也只能交付 summary 投影。
    && (match.grants[0]?.authorizedContentKind === 'summary'
      || match.grants[0]?.authorizedRedactionLevel === 'summary-only');
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

function buildExplicitGrantItem(
  match: CollaborativeMemorySearchMatch,
  grant: MemoryGrantRecord,
  decisionId: ID,
  input: CreateCapsuleInput,
  issuedAt: UnixMs,
  expiresAt: UnixMs,
): MemoryCapsuleItemDto {
  const item = match.item;
  const sourceRefs: MemorySourceRefDto[] = match.sources.map(toSourceRefDto);
  const sourceRefsHash = hashSourceRefs(sourceRefs);
  const contentHash = hashMemoryContent(item.content);
  const contentKind = grant.authorizedContentKind;
  const redactionLevel = grant.authorizedRedactionLevel;
  const authorization: MemoryCapsuleAuthorizationDto = {
    schemaVersion: 1,
    decisionId,
    mode: 'explicit-grant',
    policyVersion: input.currentPolicyVersion,
    grantId: grant.id,
    grantVersion: grant.version,
    targetAgentId: input.targetAgentId,
    sourceScopeType: grant.sourceScopeType,
    sourceScopeRef: grant.sourceScopeRef,
    sourceRefsHash,
    contentHash,
    authorizedContentKind: contentKind,
    authorizedRedactionLevel: redactionLevel,
    issuedAt,
    expiresAt,
  };

  return {
    schemaVersion: 1,
    memoryId: item.id,
    scopeType: item.scopeType,
    scopeRef: item.scopeRef,
    sourceVisibility: grant.sourceScopeType === 'dm' ? 'dm-participants' : 'private',
    contentKind,
    redactionLevel,
    content: item.content,
    sourceRefs,
    authorization,
    expiresAt,
  };
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), 100);
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
