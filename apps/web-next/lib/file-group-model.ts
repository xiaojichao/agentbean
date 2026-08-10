/**
 * 文件库「逻辑产物」视图的左侧文件组聚合模型(纯函数,无 React 依赖)。
 *
 * 输入 Server 事实(outputPackages + pendingDeliveries + artifactCollections +
 * stages 的轻量子集),输出三类混排的左栏卡片模型:
 * - package:输出包(成员数/聚合审核态/Task rX·attempt;短编号+版本摘要由调用方
 *   经 getOutputPackage projection 懒加载后写入 summaryLines);
 * - collection:文件集合(名称/类型/阶段/当前版/final 指针/审核态);
 * - waiting:等待上游(有阶段但无集合归属且无输出包关联的占位)。
 *
 * 规则:
 * - 排序 = lastActivityAt 倒序(package 用 createdAt / pending 用 committedAt;
 *   collection 用最新版本/审核/finalize 时间 max);waiting 恒排尾。
 * - 集合的阶段归属来自版本的 ProjectArtifactVersionSourceDto.stageId(Server 事实,
 *   客户端不推断);输出包经 taskId 命中阶段的 Task 视为关联该阶段。
 * - 筛选/搜索是纯客户端呈现层,不写入任何 Server 事实;「有 final」对包而言来自
 *   Server 的 final projection(懒加载),摘要阶段恒 false,由 withPackageFinalStates
 *   在投影返回后更新。
 */

import { reviewStateLabel } from '@/lib/delivery-labels';
import type {
  OutputPackagePendingDeliveryDto,
  OutputPackageSummaryDto,
  ProjectArtifactCollectionDto,
  ProjectArtifactLibraryDto,
} from '@agentbean/contracts';

export type FileGroupCardKind = 'package' | 'collection' | 'waiting';

/** 左侧筛选 chip(全部 / 待审核 / 有 final / Agent 输出)。 */
export type FileGroupFilterKind = 'all' | 'pending_review' | 'has_final' | 'agent_output';
export type FileGroupStatusFilterKind = 'all' | 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'final' | 'waiting';

/** 阶段轻量输入(ProjectStageDto 的结构子集;taskId 用于输出包→阶段关联)。 */
export interface FileGroupStageInput {
  id: string;
  name: string;
  goal?: string;
  /** 阶段绑定的 Task id(输出包 taskId 命中时该阶段不算「等待上游」)。 */
  taskId?: string;
}

/** 卡片底层数据引用(UI 渲染明细时取用,不复制事实)。 */
export type FileGroupCardPayload =
  | { readonly kind: 'package'; readonly package: OutputPackageSummaryDto }
  | { readonly kind: 'pending-delivery'; readonly pending: OutputPackagePendingDeliveryDto }
  | { readonly kind: 'collection'; readonly collection: ProjectArtifactCollectionDto }
  | { readonly kind: 'waiting'; readonly stage: FileGroupStageInput };

export interface FileGroupCardModel {
  kind: FileGroupCardKind;
  id: string;
  title: string;
  chips: readonly string[];
  /** 版本摘要行(package 由懒加载投影填充,集合/等待上游构建时即有)。 */
  summaryLines: readonly string[];
  lastActivityAt: number;
  /** Agent 名匹配所需:DTO 无名字段,保留 agentId 由调用方经 agents 映射后 withAgentNames。 */
  agentId?: string;
  pendingReview: boolean;
  hasFinal: boolean;
  agentOutput: boolean;
  /** 搜索文本池(文件组名/文件名/版本号/阶段名等,小写);withAgentNames 追加 Agent 名。 */
  searchText: string;
  payload: FileGroupCardPayload;
}

export function buildFileGroupCards(input: {
  packages: readonly OutputPackageSummaryDto[];
  pendingDeliveries: readonly OutputPackagePendingDeliveryDto[];
  library: ProjectArtifactLibraryDto | null;
  stages: readonly FileGroupStageInput[];
  /** 已属于输出包的集合由包卡统一承载，不能在包外再次生成集合卡。 */
  packageMemberCollectionIds?: ReadonlySet<string>;
  /** 详情已明确失败/缺少 projection 的包；其集合卡必须恢复，避免文件失去入口。 */
  unavailablePackageIds?: ReadonlySet<string>;
}): FileGroupCardModel[] {
  const {
    packages,
    pendingDeliveries,
    library,
    stages,
    packageMemberCollectionIds = new Set<string>(),
    unavailablePackageIds = new Set<string>(),
  } = input;
  const collections = library?.collections ?? [];
  const visiblePackageIds = new Set(packages
    .filter((pkg) => !unavailablePackageIds.has(pkg.packageId))
    .map((pkg) => pkg.packageId));
  const standaloneCollections = collections.filter((collection) =>
    !packageMemberCollectionIds.has(collection.id)
    && !collection.versions.some((version) => version.packageMemberships?.some((membership) =>
      visiblePackageIds.has(membership.packageId))));
  const stageNameById = new Map(stages.map((stage) => [stage.id, stage.name]));

  const cards: FileGroupCardModel[] = [
    ...packages.map((pkg) => packageCard(pkg, stages)),
    ...pendingDeliveries.map(pendingDeliveryCard),
    ...standaloneCollections.map((collection) => collectionCard(collection, stageNameById)),
    ...stages
      .filter((stage) => !collectionCoversStage(collections, stage.id)
        && !packageCoversStage(packages, stage.taskId))
      .map(waitingCard),
  ];

  return cards.sort(compareCards);
}

/** 全部 / 待审核 / 有 final / Agent 输出 + 搜索(作用于已加载数据,纯客户端呈现)。 */
export function filterFileGroupCards(
  cards: readonly FileGroupCardModel[],
  filter: FileGroupFilterKind,
  search: string,
): FileGroupCardModel[] {
  const query = search.trim().toLowerCase();
  return cards.filter((card) => {
    if (filter === 'pending_review' && !card.pendingReview) return false;
    if (filter === 'has_final' && !card.hasFinal) return false;
    if (filter === 'agent_output' && !card.agentOutput) return false;
    if (query && !card.searchText.includes(query)) return false;
    return true;
  });
}

/** 原型工具栏的独立角色/状态下拉；组合搜索时仍只过滤呈现，不修改 Server 事实。 */
export function filterFileGroupCardsByRoleAndStatus(
  cards: readonly FileGroupCardModel[],
  input: { agentId: string; status: FileGroupStatusFilterKind; search: string },
): FileGroupCardModel[] {
  return filterFileGroupCards(cards, 'all', input.search)
    .filter((card) => {
      if (input.agentId === 'all') return true;
      if (card.agentId === input.agentId) return true;
      return card.payload.kind === 'collection'
        && card.payload.collection.versions.some((version) => version.promotedBy === input.agentId);
    })
    .filter((card) => {
      if (input.status === 'all') return true;
      if (input.status === 'waiting') return card.kind === 'waiting';
      if (card.kind === 'waiting' || card.payload.kind === 'pending-delivery') return false;
      if (input.status === 'final') return card.hasFinal;
      if (card.payload.kind === 'package') return card.payload.package.reviewState === input.status;
      if (card.payload.kind === 'collection') {
        const collection = card.payload.collection;
        const current = collection.versions.find((version) =>
          version.id === collection.currentVersionId);
        return current?.reviewState === input.status;
      }
      return false;
    });
}

/** 调用方把 agentId 映射为显示名后追加进搜索池(不新增卡片、不改其它字段)。 */
export function withAgentNames(
  cards: readonly FileGroupCardModel[],
  agentNamesById: ReadonlyMap<string, string>,
): FileGroupCardModel[] {
  return cards.map((card) => {
    if (!card.agentId) return card;
    const name = agentNamesById.get(card.agentId);
    if (!name) return card;
    return { ...card, searchText: `${card.searchText} ${name}`.toLowerCase() };
  });
}

/** 整包 current projection 成员 → 短编号+版本摘要行(F1 v4 / F2 v3),供卡片 summaryLines。 */
export function packageProjectionSummaryLines(
  members: readonly { readonly shortLabel: string; readonly versionNumber: number }[],
): string[] {
  return members.map((member) => `${member.shortLabel} v${member.versionNumber}`);
}

/**
 * 包「有 final」事实来自 Server 的 final projection(懒加载),摘要阶段不可推断。
 * 投影 ready → true;not_ready/未知 → false。仅覆盖 package 卡(pending/集合/等待不受影响)。
 */
export function withPackageFinalStates(
  cards: readonly FileGroupCardModel[],
  finalReadyByPackageId: ReadonlyMap<string, boolean>,
): FileGroupCardModel[] {
  return cards.map((card) => {
    if (card.kind !== 'package' || card.payload.kind !== 'package') return card;
    const hasFinal = finalReadyByPackageId.get(card.payload.package.packageId);
    if (hasFinal === undefined) return card;
    return { ...card, hasFinal };
  });
}

function packageCard(pkg: OutputPackageSummaryDto, stages: readonly FileGroupStageInput[]): FileGroupCardModel {
  const stage = stages.find((candidate) => candidate.taskId !== undefined && candidate.taskId === pkg.taskId);
  const semanticName = stage?.name.replace(/阶段$/, '') ?? '';
  const title = `${semanticName}输出包`;
  const chips = [
    `${pkg.memberCount} 个文件`,
    reviewStateLabel(pkg.reviewState),
    pkg.taskBinding === 'managed' && pkg.taskRevision !== undefined
      ? `Task r${pkg.taskRevision} · attempt ${pkg.taskAttempt}`
      : `attempt ${pkg.taskAttempt}`,
  ];
  return {
    kind: 'package',
    id: pkg.packageId,
    title,
    chips,
    summaryLines: [],
    lastActivityAt: pkg.createdAt,
    agentId: pkg.agentId,
    pendingReview: pkg.reviewState === 'pending',
    hasFinal: false,
    agentOutput: true,
    searchText: [title, pkg.packageId, pkg.taskId ?? '', ...chips].join(' ').toLowerCase(),
    payload: { kind: 'package', package: pkg },
  };
}

/** 「交付处理中」:Workspace revision 已 commit 但 package 暂未形成——只显示处理中,不伪造完整交付。 */
function pendingDeliveryCard(pending: OutputPackagePendingDeliveryDto): FileGroupCardModel {
  return {
    kind: 'package',
    id: `pending:${pending.publishId}`,
    title: '交付处理中',
    chips: [`attempt ${pending.taskAttempt}`],
    summaryLines: [],
    lastActivityAt: pending.committedAt,
    agentId: pending.agentId,
    pendingReview: false,
    hasFinal: false,
    agentOutput: true,
    searchText: ['交付处理中', pending.publishId, pending.taskId].join(' ').toLowerCase(),
    payload: { kind: 'pending-delivery', pending },
  };
}

function collectionCard(
  collection: ProjectArtifactCollectionDto,
  stageNameById: ReadonlyMap<string, string>,
): FileGroupCardModel {
  const current = collection.versions.find((version) => version.id === collection.currentVersionId)
    ?? collection.versions[collection.versions.length - 1];
  const stageNames = Array.from(new Set(
    collection.versions
      .map((version) => version.source.stageId)
      .filter((stageId): stageId is string => Boolean(stageId))
      .map((stageId) => stageNameById.get(stageId) ?? stageId),
  ));
  const chips = [
    `共 ${collection.versions.length} 版`,
    ...stageNames,
    ...(current ? [reviewStateLabel(current.reviewState)] : []),
    ...(collection.finalVersionId ? ['有 final'] : []),
  ];
  const lastActivityAt = Math.max(
    collection.updatedAt,
    ...collection.versions.map((version) => version.createdAt),
    ...collection.versions.flatMap((version) => version.reviews.map((review) => review.createdAt)),
    ...collection.finalizations.map((finalization) => finalization.createdAt),
  );
  const searchParts = [
    collection.name,
    collection.kind,
    ...collection.versions.map((version) => version.artifact.filename),
    ...collection.versions.map((version) => `v${version.versionNumber}`),
    ...chips,
    ...stageNames,
  ];
  return {
    kind: 'collection',
    id: collection.id,
    title: collection.name,
    chips,
    summaryLines: current
      ? [`当前版 v${current.versionNumber} · ${current.artifact.filename}`]
      : [],
    lastActivityAt,
    pendingReview: current?.reviewState === 'pending',
    hasFinal: Boolean(collection.finalVersionId),
    // #1065 AC5:版本作为成员出现在交付包 = Server 投影的「Agent 输出」事实。
    agentOutput: collection.versions.some((version) => (version.packageMemberships?.length ?? 0) > 0),
    searchText: searchParts.join(' ').toLowerCase(),
    payload: { kind: 'collection', collection },
  };
}

function waitingCard(stage: FileGroupStageInput): FileGroupCardModel {
  const title = `${stage.name.replace(/阶段$/, '')}输出包`;
  return {
    kind: 'waiting',
    id: `waiting:${stage.id}`,
    title,
    chips: ['等待上游'],
    summaryLines: stage.goal ? [stage.goal] : ['暂无产物'],
    lastActivityAt: 0,
    pendingReview: false,
    hasFinal: false,
    agentOutput: false,
    searchText: [title, stage.name, '等待上游', stage.goal ?? ''].join(' ').toLowerCase(),
    payload: { kind: 'waiting', stage },
  };
}

/** 集合是否归属该阶段:任一版本的 Server 来源事实 stageId 命中。 */
function collectionCoversStage(collections: readonly ProjectArtifactCollectionDto[], stageId: string): boolean {
  return collections.some((collection) =>
    collection.versions.some((version) => version.source.stageId === stageId));
}

/** 输出包是否关联该阶段:包 taskId 命中阶段绑定的 Task(阶段绑定 Task 由调用方传入)。 */
function packageCoversStage(
  packages: readonly OutputPackageSummaryDto[],
  stageTaskId: string | undefined,
): boolean {
  return Boolean(stageTaskId)
    && packages.some((pkg) => pkg.taskId !== undefined && pkg.taskId === stageTaskId);
}

/** 混排排序:waiting 恒排尾;其余按 lastActivityAt 倒序(stable,同值保持输入序)。 */
function compareCards(left: FileGroupCardModel, right: FileGroupCardModel): number {
  const leftWaiting = left.kind === 'waiting' ? 1 : 0;
  const rightWaiting = right.kind === 'waiting' ? 1 : 0;
  if (leftWaiting !== rightWaiting) return leftWaiting - rightWaiting;
  return right.lastActivityAt - left.lastActivityAt;
}
