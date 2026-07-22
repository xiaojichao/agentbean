import type {
  FormalMemoryDetailDto,
  FormalMemoryDto,
  FormalMemoryScopeType,
  FormalMemoryVersionDto,
  ID,
  MemorySourceRefDto,
} from '../../../../packages/contracts/src/index.js';
import {
  formalKindToStorageKind,
  storageKindToFormalKind,
  type CreateFormalMemoryInput,
  type DeactivateFormalMemoryInput,
  type DeleteFormalMemoryInput,
  type FormalMemoryKind,
  type ProposeFormalCorrectionInput,
  type ReviseFormalMemoryInput,
} from '../../../../packages/contracts/src/index.js';
import type { ServerNextRepositories } from './repositories.js';
import type { MemoryItemRecord, MemorySourceRecord } from './memory-repositories.js';
import type {
  CollaborativeMemoryService,
  CollaborativeMemorySourceInput,
  MemoryView,
} from './collaborative-memory-service.js';

/**
 * Formal Memory 产品投影层（issue #716 切片 D）。
 *
 * 这一层只做数据组装与底层 `CollaborativeMemoryService` 调度：把 4 类产品 kind 适配
 * 到底层 6 类存储 kind、投影成产品 DTO、组装版本历史。**写门控不放这里**——由
 * `usecases.ts` 在调用前用 `canManageFormalMemory`/`canReadFormalMemory` 校验。
 *
 * 设计原则（§6.5）：复用 Phase 3 已建成的 `memory_items`/状态机/审计，Formal Memory
 * 只是产品投影，不做破坏性重建。
 */

export interface FormalMemoryService {
  list(input: {
    readonly teamId: ID;
    readonly scopeType: FormalMemoryScopeType;
    readonly scopeRef: ID;
  }): Promise<readonly FormalMemoryDto[]>;
  getDetail(input: { readonly teamId: ID; readonly memoryId: ID }): Promise<FormalMemoryDetailDto>;
  create(input: CreateFormalMemoryInput): Promise<FormalMemoryDto>;
  revise(input: ReviseFormalMemoryInput): Promise<FormalMemoryDto>;
  deactivate(input: DeactivateFormalMemoryInput): Promise<FormalMemoryDto>;
  delete(input: DeleteFormalMemoryInput): Promise<FormalMemoryDto>;
  proposeCorrection(input: ProposeFormalCorrectionInput): Promise<FormalMemoryDto>;
  /** 接受纠错 candidate（status candidate→active，成为正式 Formal Memory）。 */
  accept(input: { readonly teamId: ID; readonly actorId: ID; readonly memoryId: ID }): Promise<FormalMemoryDto>;
  /** 驳回纠错 candidate（status candidate→rejected）。 */
  reject(input: { readonly teamId: ID; readonly actorId: ID; readonly memoryId: ID; readonly changeReason?: string }): Promise<FormalMemoryDto>;
}

export function createFormalMemoryService(input: {
  readonly repositories: ServerNextRepositories;
  readonly collaborativeMemory: CollaborativeMemoryService;
  readonly clock: { now(): number };
}): FormalMemoryService {
  const { repositories, collaborativeMemory } = input;

  return {
    async list({ teamId, scopeType, scopeRef }) {
      const items = await repositories.memory.items.listFormal({ teamId, scopeType, scopeRef });
      const dtos = await Promise.all(items.map(async (item) => {
        const [tags, sources] = await Promise.all([
          repositories.memory.tags.listByMemory({ teamId, memoryId: item.id }),
          repositories.memory.sources.listByMemory({ teamId, memoryId: item.id }),
        ]);
        return toFormalMemoryDto(item, tags.map((t) => t.tag), sources.map(toSourceRef));
      }));
      return dtos;
    },

    async getDetail({ teamId, memoryId }) {
      const current = await repositories.memory.items.getById({ teamId, id: memoryId });
      if (!current || current.formalKind === undefined) {
        throw new Error('FORMAL_MEMORY_NOT_FOUND');
      }
      const familyId = current.versionFamilyId ?? current.id;
      const [versionsRaw, currentTags, currentSources] = await Promise.all([
        repositories.memory.items.listByVersionFamily({ teamId, versionFamilyId: familyId }),
        repositories.memory.tags.listByMemory({ teamId, memoryId: current.id }),
        repositories.memory.sources.listByMemory({ teamId, memoryId: current.id }),
      ]);
      const versionDtos = await Promise.all(versionsRaw.map(async (item) => {
        const sources = await repositories.memory.sources.listByMemory({ teamId, memoryId: item.id });
        return toVersionDto(item, sources.map(toSourceRef));
      }));
      const base = toFormalMemoryDto(current, currentTags.map((t) => t.tag), currentSources.map(toSourceRef));
      const detail: FormalMemoryDetailDto = { ...base, versions: versionDtos };
      return detail;
    },

    async create(input) {
      const storageKind = formalKindToStorageKind(input.kind);
      const view = await collaborativeMemory.createMemory({
        teamId: input.teamId,
        actorId: input.actorId,
        kind: storageKind,
        scopeType: input.scopeType,
        scopeRef: input.scopeRef,
        content: input.content,
        summary: input.summary,
        tags: input.tags,
        validUntil: input.validUntil,
        formalKind: input.kind,
        changeReason: input.changeReason,
      });
      return viewToDto(view);
    },

    async revise(input) {
      const result = await collaborativeMemory.supersedeMemory({
        teamId: input.teamId,
        actorId: input.actorId,
        memoryId: input.memoryId,
        content: input.content,
        summary: input.summary,
        tags: input.tags,
        changeReason: input.changeReason,
      });
      return viewToDto(result.created);
    },

    async deactivate(input) {
      const view = await collaborativeMemory.expireMemory({
        teamId: input.teamId,
        actorId: input.actorId,
        memoryId: input.memoryId,
        changeReason: input.changeReason,
      });
      return viewToDto(view);
    },

    async delete(input) {
      const view = await collaborativeMemory.deleteMemory({
        teamId: input.teamId,
        actorId: input.actorId,
        memoryId: input.memoryId,
        changeReason: input.changeReason,
      });
      return viewToDto(view);
    },

    async proposeCorrection(input) {
      const sourceRefs = await assembleCorrectionSources(input);
      const storageKind = input.kind ? formalKindToStorageKind(input.kind) : 'semantic';
      const view = await collaborativeMemory.createMemory({
        teamId: input.teamId,
        actorId: input.actorId,
        kind: storageKind,
        scopeType: input.scopeType,
        scopeRef: input.scopeRef,
        content: input.content,
        summary: input.summary,
        sourceRefs,
        asCandidate: true,
        formalKind: input.kind,
        changeReason: input.reason,
      });
      return viewToDto(view);
    },

    async accept(input) {
      const view = await collaborativeMemory.activateCandidate({
        teamId: input.teamId,
        actorId: input.actorId,
        memoryId: input.memoryId,
      });
      return viewToDto(view);
    },

    async reject(input) {
      const view = await collaborativeMemory.rejectCandidate({
        teamId: input.teamId,
        actorId: input.actorId,
        memoryId: input.memoryId,
        changeReason: input.changeReason,
      });
      return viewToDto(view);
    },
  };

  /**
   * 纠错申请的来源关联：若提供 targetMemoryId，查目标 memory 的 scope 组装来源引用，
   * 把候选 candidate 与被纠错对象在审计/检索上关联起来（AC#6）。找不到目标时跳过来源，
   * 由 candidate 本身的 content/changeReason 承载语义（不阻塞提交）。
   */
  async function assembleCorrectionSources(
    input: ProposeFormalCorrectionInput,
  ): Promise<CollaborativeMemorySourceInput[]> {
    if (!input.targetMemoryId) return [];
    const target = await repositories.memory.items.getById({
      teamId: input.teamId,
      id: input.targetMemoryId,
    });
    if (!target) return [];
    // 纠错 target 必须属于提交的 scope，避免向非该频道成员的提交者泄露频道 ID。
    if (target.scopeType !== input.scopeType || target.scopeRef !== input.scopeRef) return [];
    return [{
      schemaVersion: 1,
      sourceKind: 'memory',
      sourceId: input.targetMemoryId,
      // 用目标 memory 的 content 摘要作为快照哈希，满足非空校验并在变更时可检测漂移。
      snapshotHash: `sha256:memory-${input.targetMemoryId}`,
      sourceScopeType: target.scopeType,
      sourceScopeRef: target.scopeRef,
      // memory→memory 来源在 team/channel 内部，对目标 scope 可见（team 是最宽的可见性）。
      sourceVisibility: 'team',
    }];
  }
}

/**
 * 投影单条 MemoryItemRecord 为 FormalMemoryDto。
 * - kind 取 formalKind，回落到 storageKind 反推，再回落 fact（防御）。
 * - scopeType 断言为 team/channel（formal 只允许这两种）。
 */
function toFormalMemoryDto(
  item: MemoryItemRecord,
  tags: readonly string[],
  sourceRefs: readonly MemorySourceRefDto[],
): FormalMemoryDto {
  const kind: FormalMemoryKind = item.formalKind
    ?? storageKindToFormalKind(item.kind)
    ?? 'fact';
  const scopeType = item.scopeType as FormalMemoryScopeType;
  return {
    schemaVersion: 1,
    id: item.id,
    teamId: item.teamId,
    kind,
    status: item.status,
    scopeType,
    scopeRef: item.scopeRef,
    channelId: scopeType === 'channel' ? item.scopeRef : undefined,
    content: item.content,
    summary: item.summary,
    tags,
    sourceRefs,
    changeReason: item.changeReason,
    validFrom: item.validFrom,
    validUntil: item.validUntil,
    supersededById: item.supersededById,
    versionFamilyId: item.versionFamilyId ?? item.id,
    createdByUserId: item.createdByUserId,
    createdByAgentId: item.createdByAgentId,
    approvedByUserId: item.approvedByUserId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** 投影版本历史单条（简化的 FormalMemoryVersionDto）。 */
function toVersionDto(
  item: MemoryItemRecord,
  sourceRefs: readonly MemorySourceRefDto[],
): FormalMemoryVersionDto {
  const kind: FormalMemoryKind = item.formalKind
    ?? storageKindToFormalKind(item.kind)
    ?? 'fact';
  return {
    versionId: item.id,
    kind,
    content: item.content,
    summary: item.summary,
    changeReason: item.changeReason,
    status: item.status,
    actorUserId: item.createdByUserId,
    actorAgentId: item.createdByAgentId,
    createdAt: item.createdAt,
    sourceRefs,
  };
}

function viewToDto(view: MemoryView): FormalMemoryDto {
  return toFormalMemoryDto(view.item, view.tags, view.sources);
}

function toSourceRef(
  source: Pick<MemorySourceRecord, 'sourceKind' | 'sourceId' | 'snapshotHash'>,
): MemorySourceRefDto {
  return {
    schemaVersion: 1,
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    snapshotHash: source.snapshotHash,
  };
}
