import type { ID, MemoryCapsuleDto, MemoryCapsuleItemDto, UnixMs } from '../../../../packages/contracts/src/index.js';
import {
  evaluateMemoryCapsuleAuthorization,
  evaluateMemoryInjection,
  hashMemoryContent,
  hashSourceRefs,
  type MemoryCapsuleAuthorizationDenialReason,
  type MemoryInjectionDenialReason,
} from '../../../../packages/domain/src/index.js';
import type { MemoryAuditActorKind, MemoryRepositories, MemorySourceRecord } from './memory-repositories.js';
import type { MemoryUnitOfWork } from './memory-unit-of-work.js';
import type { MemorySearchPermissions } from './collaborative-memory-search-service.js';

/**
 * Capsule 注入复验（spec §4.2/§16，P3-07）。每次把 Capsule 注入目标 Agent 前，用**当前**状态
 * 逐项复验，fail-closed：任何字段漂移、状态过期、来源失效或授权失效都拒绝该 item。
 *
 * 复验 = 两个检查的合取（缺一即漏洞）：
 *  1. `evaluateMemoryInjection`：fresh memory 状态（active / 未 validUntil 过期）+ scope 仍可见 +
 *     全部来源仍可用。
 *  2. `evaluateMemoryCapsuleAuthorization`：冻结字段一致性（target / scope / contentHash /
 *     sourceRefsHash / contentKind / redaction / policyVersion / grant / expiry）。hash 用 domain
 *     单一源从当前内容/来源重算，与创建时冻结值比对，防篡改与漂移。
 *
 * fresh sourceVisibility 不信 Capsule 里硬编码的 'team'：scope 若变为需 explicit-grant，scope-policy
 * item 立即被 CAPSULE_EXPLICIT_GRANT_REQUIRED 拒（私有 channel 内容不会借旧 capsule 泄漏）。
 *
 * 本服务只复验并审计拒绝/过期；允许的 item 由实际注入路径（P3-13）消费并写 capsule-injected 审计。
 */

const ACTOR_SYSTEM: MemoryAuditActorKind = 'system';

export type CapsuleInjectionDenialReason =
  | 'CAPSULE_EXPIRED'
  | 'MEMORY_NOT_FOUND'
  | MemoryInjectionDenialReason
  | MemoryCapsuleAuthorizationDenialReason;

export interface CapsuleItemInjectionDecision {
  readonly memoryId: ID;
  readonly allowed: boolean;
  readonly reason?: CapsuleInjectionDenialReason;
  readonly item?: MemoryCapsuleItemDto;
}

export interface CapsuleInjectionResult {
  readonly capsuleExpired: boolean;
  readonly decisions: readonly CapsuleItemInjectionDecision[];
}

export interface ValidateCapsuleInjectionInput {
  readonly capsule: MemoryCapsuleDto;
  /** 发起本次 management run 的用户；scope 可见性复检沿用创建时的请求者视角。 */
  readonly requesterUserId: ID;
  readonly now: UnixMs;
  readonly currentPolicyVersion: number;
}

export interface CapsuleInjectionValidatorDeps {
  readonly unitOfWork: MemoryUnitOfWork;
  readonly permissions: MemorySearchPermissions;
  readonly ids: { nextId(): ID };
}

export interface CapsuleInjectionValidator {
  validateCapsuleForInjection(input: ValidateCapsuleInjectionInput): Promise<CapsuleInjectionResult>;
}

export function createCapsuleInjectionValidator(
  deps: CapsuleInjectionValidatorDeps,
): CapsuleInjectionValidator {
  const { unitOfWork, permissions, ids } = deps;

  return {
    async validateCapsuleForInjection(input) {
      return unitOfWork.run(async (memory) => {
        const { capsule, now } = input;

        if (capsule.expiresAt <= now) {
          await memory.auditEvents.append(capsuleLevelAudit(ids.nextId(), capsule, 'capsule-expired', input));
          return {
            capsuleExpired: true,
            decisions: capsule.items.map((item) => deny(item, 'CAPSULE_EXPIRED')),
          };
        }

        const decisions: CapsuleItemInjectionDecision[] = [];
        for (const item of capsule.items) {
          const decision = await validateItem(memory, capsule, item, input);
          decisions.push(decision);
          if (!decision.allowed) {
            await memory.auditEvents.append(itemDenialAudit(ids.nextId(), capsule, item, input));
          }
        }
        return { capsuleExpired: false, decisions };
      });
    },
  };

  async function validateItem(
    memory: MemoryRepositories,
    capsule: MemoryCapsuleDto,
    item: MemoryCapsuleItemDto,
    input: ValidateCapsuleInjectionInput,
  ): Promise<CapsuleItemInjectionDecision> {
    const { requesterUserId, now, currentPolicyVersion } = input;
    const teamId = capsule.teamId;
    const targetAgentId = capsule.targetAgentId;

    // server-hosted Capsule 绝不允许 local-workspace item（既是 fail-closed 守卫，也把
    // MemoryCapsuleScopeType 缩窄成 MemoryScopeType，免去下游 cast）。
    if (item.scopeType === 'local-workspace') return deny(item, 'CAPSULE_LOCAL_ONLY_SERVER_FORBIDDEN');

    // 1. fresh memory 仍存在。
    const memoryItem = await memory.items.getById({ teamId, id: item.memoryId });
    if (!memoryItem) return deny(item, 'MEMORY_NOT_FOUND');

    // 2. fresh scope 可见性：不信冻结的 'team'，重新查。hidden→不可见；explicit-grant→scope-policy item 失效。
    const visibility = await permissions.evaluateScopeVisibility({
      teamId, requesterUserId, targetAgentId,
      memoryId: item.memoryId, scopeType: item.scopeType, scopeRef: item.scopeRef,
    });
    if (visibility === 'hidden') return deny(item, 'MEMORY_SCOPE_NOT_VISIBLE');
    if (visibility === 'explicit-grant') return deny(item, 'CAPSULE_EXPLICIT_GRANT_REQUIRED');

    // 3. fresh 来源可用性 + fresh 状态（active / 未 validUntil 过期）。
    const sources = await memory.sources.listByMemory({ teamId, memoryId: item.memoryId });
    const allSourcesAvailable = await everySourceAvailable(permissions, teamId, requesterUserId, targetAgentId, sources);
    const injection = evaluateMemoryInjection({
      status: memoryItem.status,
      validUntil: memoryItem.validUntil,
      now,
      scopeVisible: true,
      allSourcesAvailable,
    });
    if (!injection.allowed) return deny(item, injection.reason);

    // 4. 冻结字段一致性：用 domain 单一源从当前内容/来源重算 hash，与冻结值比对。
    const sourceRefs = sources.map(toSourceRefDto);
    const currentGrant = item.authorization.mode === 'explicit-grant' && item.authorization.grantId
      ? await loadCurrentGrant(memory, teamId, item.authorization.grantId)
      : undefined;
    const authorization = evaluateMemoryCapsuleAuthorization({
      authorization: item.authorization,
      targetAgentId,
      sourceScopeType: item.scopeType,
      sourceScopeRef: item.scopeRef,
      sourceVisibility: 'team',
      sourceRefsHash: hashSourceRefs(sourceRefs),
      contentHash: hashMemoryContent(memoryItem.content),
      contentKind: item.contentKind,
      redactionLevel: item.redactionLevel,
      currentPolicyVersion,
      currentGrant,
      delivery: 'server-hosted',
      now,
    });
    if (!authorization.allowed) return deny(item, authorization.reason);

    return { memoryId: item.memoryId, allowed: true, item };
  }
}

function deny(item: MemoryCapsuleItemDto, reason: CapsuleInjectionDenialReason): CapsuleItemInjectionDecision {
  return { memoryId: item.memoryId, allowed: false, reason };
}

async function everySourceAvailable(
  permissions: MemorySearchPermissions,
  teamId: ID,
  requesterUserId: ID,
  targetAgentId: ID,
  sources: readonly MemorySourceRecord[],
): Promise<boolean> {
  for (const source of sources) {
    const available = await permissions.isSourceAvailable({ teamId, requesterUserId, targetAgentId, source });
    if (!available) return false;
  }
  return true;
}

async function loadCurrentGrant(
  memory: MemoryRepositories,
  teamId: ID,
  grantId: ID,
) {
  const grant = await memory.grants.getCurrent({ teamId, id: grantId });
  if (!grant) return undefined;
  return {
    id: grant.id,
    version: grant.version,
    revoked: grant.status === 'revoked',
    expiresAt: grant.expiresAt,
  };
}

function toSourceRefDto(record: Pick<MemorySourceRecord, 'sourceKind' | 'sourceId' | 'snapshotHash'>) {
  return { schemaVersion: 1 as const, sourceKind: record.sourceKind, sourceId: record.sourceId, snapshotHash: record.snapshotHash };
}

function capsuleLevelAudit(
  id: ID,
  capsule: MemoryCapsuleDto,
  eventType: 'capsule-expired',
  input: ValidateCapsuleInjectionInput,
) {
  return {
    id,
    teamId: capsule.teamId,
    subjectKind: 'capsule' as const,
    subjectId: capsule.id,
    eventType,
    actorKind: ACTOR_SYSTEM,
    actorId: input.requesterUserId,
    targetAgentId: capsule.targetAgentId,
    sourceRefs: [],
    createdAt: input.now,
  };
}

function itemDenialAudit(
  id: ID,
  capsule: MemoryCapsuleDto,
  item: MemoryCapsuleItemDto,
  input: ValidateCapsuleInjectionInput,
) {
  // 拒绝原因不进审计正文（无 reason 列），仅记录「该 item 注入被拒」事件，原因由返回的 decision 承载。
  return {
    id,
    teamId: capsule.teamId,
    subjectKind: 'capsule' as const,
    subjectId: capsule.id,
    eventType: 'capsule-denied' as const,
    actorKind: ACTOR_SYSTEM,
    actorId: input.requesterUserId,
    decisionId: item.authorization.decisionId,
    targetAgentId: capsule.targetAgentId,
    scopeType: item.authorization.sourceScopeType,
    scopeRef: item.authorization.sourceScopeRef,
    sourceRefs: item.sourceRefs,
    sourceRefsHash: item.authorization.sourceRefsHash,
    contentHash: item.authorization.contentHash,
    redactionLevel: item.redactionLevel,
    createdAt: input.now,
  };
}
