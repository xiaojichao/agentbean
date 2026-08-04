import type {
  FrozenProjectInputItemDto,
  ID,
  ProjectReferenceSelectionPreviewDto,
  ProjectReferenceSelectionRequestDto,
} from '../../../../packages/contracts/src/index.js';
import {
  evaluateTaskLinkedRequest,
  type TaskLinkedRequestFailureCode,
} from '../../../../packages/domain/src/index.js';
import type {
  ServerNextRepositories,
  TaskRecord,
} from './repositories.js';
import type {
  TaskCoordinationRecord,
} from './task-coordination-repositories.js';
import type { ProjectArtifactReviewRecord } from './project-repositories.js';

/**
 * #1064：Task-linked @Agent 请求（在既有 task 讨论串里 `@Agent + @文件/@文件包 + 指令`）。
 *
 * 调用方（sendMessage 成功路径）在消息提交后调用本 handler：
 *
 * 1. 复验链（AC3）：Channel membership/archive、Task authority、Task revision/attempt、
 *    Agent eligibility（复用 `resolveCandidates`——含 operation restriction / Team
 *    visibility / 渠道门禁）、Artifact visibility、review/final basis、input binding；
 * 2. 通过后按既有 allocation 合同为每个显式 `@Agent` 目标发布 targeted Offer（AC4）：
 *    Offer 冻结发送时刻解析的具体 `artifactVersionId`（frozenInputs），只披露最小
 *    preview（objective.inputs = 文件名摘要），不建立 claim、不创建 Invocation；
 * 3. 失败 fail closed（AC8）：返回结构化原因，消息调用方保留草稿与引用，不留部分事实。
 *
 * 幂等（AC12）：本 handler 只挂在消息**新创建**路径——同 `clientMessageId` 的 replay
 * 直接返回原消息，不会重复发布 Offer（消息级幂等即 offer 级幂等）。
 *
 * 已知边界（与既有 dispatch 创建同款模式）：消息提交后、offer 发布前进程崩溃会留下
 * 「消息存在、offer 缺失」的窗口；同 key 重试走 replay 不补发。offer 创建是单条 INSERT，
 * 失败率极低，且 acceptance 前的 TTL 过期/复验均 fail closed，不产生部分 claim。
 */
export interface TaskLinkedRequestHandlerDeps {
  readonly repositories: ServerNextRepositories;
  readonly ids: { nextId(): string };
  readonly clock: { now(): number };
  /**
   * Agent eligibility 解析（复用既有 `resolveCandidates`——含 operation restriction /
   * Team visibility / 渠道门禁）。由调用方注入（dev-server 接 broker；测试可 mock）。
   */
  readonly resolveEligibleAgentIds: (taskId: ID) => Promise<readonly ID[]>;
}

export interface TaskLinkedRequestContext {
  readonly teamId: ID;
  readonly channelId: ID;
  readonly senderUserId: ID;
  readonly channelArchived: boolean;
  readonly task: TaskRecord;
  readonly coordination: TaskCoordinationRecord | null;
  readonly expectedTaskRevision: number;
  readonly expectedTaskAttempt?: number;
  /** 用户显式 `@Agent` 的目标（主执行者约束，不替代 acceptance）。 */
  readonly requestedAgentIds: readonly ID[];
  /** 发送时刻冻结的 reference selections 预览（含 artifact_version items）。 */
  readonly previews: readonly ProjectReferenceSelectionPreviewDto[];
  /** 原始 selection 请求（用于提取显式「基于此修改」的版本——不过 review 闸）。 */
  readonly selectionRequests: readonly ProjectReferenceSelectionRequestDto[];
  /** 来源消息（provenance）。 */
  readonly sourceMessageId: ID;
}

/**
 * 第一步（只读，可在 sendMessage 事务内调用）：复验链（AC3）。
 * 不创建任何事实——失败时消息尚未提交，客户端保留草稿与引用（§11）。
 */
export type TaskLinkedRequestEvaluation =
  | { readonly kind: 'not_task_linked' }
  | {
    readonly kind: 'rejected';
    readonly code: TaskLinkedRequestFailureCode;
    readonly blockedVersionIds?: readonly ID[];
  }
  | {
    readonly kind: 'ready';
    readonly coordination: TaskCoordinationRecord;
    readonly frozenInputs: readonly FrozenProjectInputItemDto[];
    readonly explicitVersionIds: readonly ID[];
  };

export async function evaluateTaskLinkedRequestContext(
  deps: TaskLinkedRequestHandlerDeps,
  input: TaskLinkedRequestContext,
): Promise<TaskLinkedRequestEvaluation> {
  // 非 tracked task 不发布 Offer——保持既有 simple agent request 路径（AC9）。
  if (!input.coordination) {
    return { kind: 'not_task_linked' };
  }

  // 复验链数据装配。
  const eligibleAgentIds = await deps.resolveEligibleAgentIds(input.task.id);
  const { frozenInputs, explicitVersionIds } = await buildFrozenInputs(
    deps,
    input,
    input.previews,
    input.selectionRequests,
  );
  const visibleCollectionIds = await resolveVisibleCollectionIds(
    deps,
    input.teamId,
    input.channelId,
    frozenInputs,
  );

  const verdict = evaluateTaskLinkedRequest({
    channelId: input.channelId,
    senderUserId: input.senderUserId,
    channelArchived: input.channelArchived,
    task: {
      id: input.task.id,
      // 无 channelId 的 Task 视为不属于本频道（domain 判定 TASK_CHANNEL_MISMATCH，fail closed）。
      channelId: input.task.channelId ?? '',
      creatorId: input.task.creatorId,
      revision: input.task.revision,
      status: input.task.status,
    },
    coordination: {
      attempt: input.coordination.attempt,
      humanAcceptanceAuthorityIds: input.coordination.humanAcceptanceAuthorityIds ?? [],
      inputBindingsResolved: await areInputBindingsResolved(deps, input.coordination),
    },
    expectedTaskRevision: input.expectedTaskRevision,
    ...(input.expectedTaskAttempt !== undefined ? { expectedTaskAttempt: input.expectedTaskAttempt } : {}),
    eligibleAgentIds,
    requestedAgentIds: input.requestedAgentIds,
    frozenInputs,
    ...(explicitVersionIds.length > 0 ? { explicitVersionIds } : {}),
    visibleCollectionIds,
  });
  if (!verdict.ok) {
    return {
      kind: 'rejected',
      code: verdict.code,
      ...(verdict.blockedVersionIds ? { blockedVersionIds: verdict.blockedVersionIds } : {}),
    };
  }
  return { kind: 'ready', coordination: input.coordination, frozenInputs, explicitVersionIds };
}

/**
 * 第二步（事务外，消息提交后）：发布 targeted Offer。
 * 每个显式 @Agent 目标一个 Offer（hardSpecified=优先询问语义，绝不强迫接受）；
 * Offer 冻结输入但不授予访问——acceptance 才建立 claim/grant（AC4/AC6）。
 * 幂等：本函数只挂在消息**新创建**路径，同 clientMessageId 的 replay 不会重复调用（AC12）。
 */
export async function publishTaskLinkedOffers(
  deps: TaskLinkedRequestHandlerDeps,
  input: TaskLinkedRequestContext,
  evaluation: Extract<TaskLinkedRequestEvaluation, { kind: 'ready' }>,
): Promise<{ readonly kind: 'offers_published'; readonly offerIds: readonly ID[] }> {
  const now = deps.clock.now();
  const offerTtlMs = 15_000;
  const objectives = await deriveOfferObjectives(deps, input);
  // 幂等防线（AC12）：同一 task+agent+revision 的 open Offer 已存在（如并发/重试竞态）→ 跳过，
  // 不重复发布；同 clientMessageId 的 message replay 本身不会走到本函数。
  const existingOpenByAgent = new Map<string, boolean>();
  for (const existing of await deps.repositories.taskCoordination.offers.listByTask(input.task.id)) {
    if (existing.status === 'open'
      && existing.taskRevision === input.task.revision
      && existing.frozenInputs
      && JSON.stringify(existing.frozenInputs) === JSON.stringify(evaluation.frozenInputs)) {
      existingOpenByAgent.set(existing.agentId, true);
    }
  }
  const published = await deps.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
    const created: ID[] = [];
    for (const [index, agentId] of input.requestedAgentIds.entries()) {
      if (existingOpenByAgent.get(agentId)) continue;
      const record = {
        id: deps.ids.nextId(),
        teamId: input.teamId,
        taskId: input.task.id,
        agentId,
        taskRevision: input.task.revision,
        taskAttempt: input.coordination!.attempt,
        manifestRevision: await resolveManifestRevision(deps, input.teamId, agentId),
        objective: objectives[index]!,
        offerTtlMs,
        offerExpiresAt: now + offerTtlMs,
        hardSpecified: true,
        requirementConfirmation: false,
        ...(evaluation.frozenInputs.length > 0 ? { frozenInputs: evaluation.frozenInputs } : {}),
        status: 'open',
        response: null,
        createdAt: now,
        updatedAt: now,
      } as const;
      await repositories.coordination.offers.create(record);
      created.push(record.id);
    }
    return created;
  });
  return { kind: 'offers_published', offerIds: published };
}

async function resolveVisibleCollectionIds(
  deps: TaskLinkedRequestHandlerDeps,
  teamId: ID,
  channelId: ID,
  frozenInputs: readonly FrozenProjectInputItemDto[],
): Promise<readonly ID[]> {
  const visible = new Set<ID>();
  for (const item of frozenInputs) {
    const collection = await deps.repositories.channelProjects.getArtifactCollection({
      teamId,
      channelId,
      collectionId: item.collectionId,
    });
    if (collection) visible.add(item.collectionId);
  }
  return [...visible];
}

/**
 * 从冻结预览构建 frozen inputs：把 artifact_version items 解析为具体版本事实，
 * 并补上解析当刻的 review/final basis（AC3「review/final basis」复验 + AC7 冻结 basis）。
 */
async function buildFrozenInputs(
  deps: TaskLinkedRequestHandlerDeps,
  input: TaskLinkedRequestContext,
  previews: readonly ProjectReferenceSelectionPreviewDto[],
  selectionRequests: readonly ProjectReferenceSelectionRequestDto[],
): Promise<{ frozenInputs: readonly FrozenProjectInputItemDto[]; explicitVersionIds: readonly ID[] }> {
  // 显式「基于此修改」/单选多选：package_members / artifact_version 的版本不过 review 闸。
  const explicitVersionIds: ID[] = [];
  for (const request of selectionRequests) {
    if (request.kind === 'package_members') {
      explicitVersionIds.push(...request.members.map((member) => member.versionId));
    } else if (request.kind === 'artifact_version') {
      explicitVersionIds.push(request.versionId);
    }
  }

  const versionIds = previews
    .flatMap((preview) => preview.items)
    .filter((item): item is Extract<typeof item, { kind: 'artifact_version' }> => item.kind === 'artifact_version')
    .map((item) => item.versionId);
  if (versionIds.length === 0) return { frozenInputs: [], explicitVersionIds };

  const [versions, collections, reviews] = await Promise.all([
    deps.repositories.channelProjects.listArtifactVersions({ teamId: input.teamId, channelId: input.channelId }),
    deps.repositories.channelProjects.listArtifactCollections({ teamId: input.teamId, channelId: input.channelId }),
    deps.repositories.channelProjects.listArtifactReviews({ teamId: input.teamId, channelId: input.channelId }),
  ]);
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  // 同一 version 可能有多条 review（append-only 历史）；按 created_at 取最新一条的决策。
  const latestReviewByVersion = new Map<ID, ProjectArtifactReviewRecord>();
  for (const review of reviews) {
    const existing = latestReviewByVersion.get(review.versionId);
    if (!existing || review.createdAt > existing.createdAt) {
      latestReviewByVersion.set(review.versionId, review);
    }
  }

  const frozenInputs: FrozenProjectInputItemDto[] = [];
  for (const item of previews.flatMap((preview) => preview.items)) {
    if (item.kind !== 'artifact_version') continue;
    const version = versionById.get(item.versionId);
    if (!version) continue;
    const collection = collectionById.get(item.collectionId);
    frozenInputs.push({
      collectionId: item.collectionId,
      artifactVersionId: item.versionId,
      versionNumber: item.versionNumber,
      artifactId: item.artifactId,
      filename: item.filename,
      isFinal: collection?.finalVersionId === item.versionId,
      reviewState: latestReviewByVersion.get(item.versionId)?.decision ?? 'pending',
    });
  }
  return { frozenInputs, explicitVersionIds };
}

async function areInputBindingsResolved(
  deps: TaskLinkedRequestHandlerDeps,
  coordination: TaskCoordinationRecord,
): Promise<boolean> {
  if (!coordination.inputBindings || coordination.inputBindings.length === 0) return true;
  // 逐 binding 校验：上游 task 当前 revision/attempt 的 output snapshot 存在（与 publish gate 同语义）。
  for (const binding of coordination.inputBindings) {
    const upstream = await deps.repositories.tasks.getById(binding.upstreamTaskId);
    if (!upstream) return false;
    const upstreamCoordination = await deps.repositories.taskCoordination.coordinations.getByTaskId(binding.upstreamTaskId);
    if (!upstreamCoordination) return false;
    const snapshot = await deps.repositories.taskCoordination.outputSnapshots.getByTaskSlot({
      taskId: binding.upstreamTaskId,
      taskRevision: upstream.revision,
      taskAttempt: upstreamCoordination.attempt,
      slotName: binding.slotName,
    });
    if (!snapshot) return false;
  }
  return true;
}

async function deriveOfferObjectives(
  deps: TaskLinkedRequestHandlerDeps,
  input: TaskLinkedRequestContext,
): Promise<ReturnType<typeof makeObjective>[]> {
  const criteria = await deps.repositories.taskCoordination.criteria.list(input.task.id);
  const active = criteria.filter((criterion) => criterion.retiredRevision === undefined);
  return input.requestedAgentIds.map((_agentId) => makeObjective(input, active.map((criterion) => criterion.description)));
}

function makeObjective(
  input: TaskLinkedRequestContext,
  deliverableDescriptions: readonly string[],
) {
  // 最小 preview（AC4）：objective.inputs 只披露冻结文件的展示摘要，不附版本细节；
  // 完整 version basis 在 frozenInputs（acceptance 复验与 Invocation intent 使用）。
  return {
    objective: input.task.description ?? input.task.title,
    inputs: input.previews.flatMap((preview) => preview.items).map((item) => item.filename),
    deliverables: deliverableDescriptions,
    constraints: [],
    riskLevel: 'low' as const,
    requiredCapabilities: [...input.coordination!.requiredCapabilities],
    requiredSkills: [...(input.coordination!.requiredSkills ?? [])],
    preferredSkills: [...(input.coordination!.preferredSkills ?? [])],
  };
}

async function resolveManifestRevision(
  deps: TaskLinkedRequestHandlerDeps,
  teamId: ID,
  agentId: ID,
): Promise<number> {
  const active = await deps.repositories.agentExposure.manifests.getActiveByTeamAgent(teamId, agentId);
  return active?.revision ?? 0;
}
