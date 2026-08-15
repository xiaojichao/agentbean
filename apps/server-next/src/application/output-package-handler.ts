import { createHash } from 'node:crypto';
// server-next 惯例:workspace 包一律用相对路径 import 源码(vitest 无 alias、CI 不构建 dist;
// 包名 import 会解析 node_modules 软链的 dist,CI 下失败——见 usecases.ts 同款写法)。
import type { ID, UnixMs } from '../../../../packages/contracts/src/index.js';
import {
  OUTPUT_PACKAGE_COMMAND_NAMES,
  OUTPUT_PACKAGE_COMMAND_SCHEMA_VERSION,
  canonicalizeOutputPackageCommand,
} from '../../../../packages/contracts/src/index.js';
import {
  evaluateOutputPackageFormation,
  type OutputPackageFormationDecision,
} from '../../../../packages/domain/src/index.js';
import type { ChannelRecord, ServerNextRepositories } from './repositories.js';
import { bumpOutputPackageWatermark } from './output-package-consistency.js';
import type {
  OutputPackageMemberWrite,
  OutputPackageRecord,
  OutputPackageReceiptRecord,
  OutputPackageTombstoneRecord,
} from './output-package-repositories.js';

/**
 * #1060 记录 Agent delivery 与 OutputPackage 的 application handler。
 *
 * 由 commit 成功路径与 commit 幂等重入路径内部触发(Server system initiator),不对 client
 * transport 暴露 command 绑定。authority 一律由 Server 从已持久化 staging/revision/task/
 * coordination/claim/invocation 事实推导;幂等键确定性派生自 (channelId, publishId)。
 *
 * handler 只加载事实 → 调 domain 纯函数 evaluateOutputPackageFormation → 组装 record/write →
 * 调 OutputPackageRepository.recordPackageFormation(单事务原子提交)。package 出现本身不推进
 * Task;拒绝不写业务事实,committed Workspace revision 保持可恢复。
 */

export interface OutputPackageHandlerDeps {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): UnixMs };
  readonly ids: { nextId(): ID };
}

export interface AttemptOutputPackageFormationInput {
  readonly teamId: ID;
  readonly channelId: ID;
  readonly publishId: ID;
  /** commit 出的 Workspace revision(staging.committedRevisionId,等价 expectedWorkspaceRevisionId)。 */
  readonly workspaceRevisionId: ID;
}

export type AttemptOutputPackageFormationResult =
  | {
    readonly kind: 'applied';
    readonly packageId: ID;
    readonly disposition: 'created' | 'existing';
    readonly receipt: OutputPackageReceiptRecord;
  }
  | {
    readonly kind: 'replayed';
    readonly packageId: ID;
    readonly receipt: OutputPackageReceiptRecord;
  }
  | {
    readonly kind: 'rejected';
    readonly reasonCode: string;
  }
  | {
    readonly kind: 'conflict';
    readonly reasonCode: string;
  };

export interface OutputPackageProjection {
  readonly package: OutputPackageRecord;
  readonly members: readonly OutputPackageMemberProjection[];
}

export interface OutputPackageMemberProjection {
  readonly sequence: number;
  readonly shortLabel: string;
  readonly collectionId: ID;
  readonly artifactVersionId: ID;
  readonly sourcePath: string;
  readonly filename: string;
  readonly sha256?: string;
  readonly sizeBytes: number;
}

/**
 * 主入口:在 commit 成功后(与 commit 幂等重入路径)调用。try/catch 不抛——失败只返回
 * rejected/conflict,绝不影响已成功的 commit 结果。
 */
export async function attemptOutputPackageFormation(
  deps: OutputPackageHandlerDeps,
  input: AttemptOutputPackageFormationInput,
): Promise<AttemptOutputPackageFormationResult> {
  const { repositories, clock, ids } = deps;
  const teamId = input.teamId;
  const idempotencyKey = `record-agent-output-package:${input.channelId}:${input.publishId}`;
  const commandHash = sha256(canonicalizeOutputPackageCommand(
    OUTPUT_PACKAGE_COMMAND_NAMES[0],
    OUTPUT_PACKAGE_COMMAND_SCHEMA_VERSION,
    { channelId: input.channelId, publishId: input.publishId, workspaceRevisionId: input.workspaceRevisionId },
  ));

  // 既有 receipt → ADR-0067:同 scope/key/hash 返回首次 receipt(replay);不同 hash 无副作用 conflict。
  const existingReceipt = await repositories.outputPackages.receipts.getByIdempotencyKey({
    teamId,
    idempotencyKey,
  });
  if (existingReceipt) {
    if (existingReceipt.commandHash !== commandHash) {
      return { kind: 'conflict', reasonCode: 'idempotency-key-hash-mismatch' };
    }
    const byPublish = await repositories.outputPackages.getPackageByPublishId({
      teamId,
      publishId: input.publishId,
    });
    if (byPublish) {
      // 讨论串消息可经重入路径补齐(按 clientMessageId 幂等),不早退。
      // #1111:补齐路径同样解析讨论串归属,保证晚到的卡片也落讨论串。
      const replayStaging = await repositories.workspacePublishStagings.getByPublishId({
        teamId,
        publishId: input.publishId,
      });
      const replayThreadId = await resolveOriginThreadId(
        repositories,
        teamId,
        replayStaging?.provenance?.workspaceRunId,
      );
      await appendOutputPackageSystemMessage(repositories, ids, {
        teamId,
        channelId: input.channelId,
        packageId: byPublish.package.packageId,
        plan: {
          agentId: byPublish.package.agentId,
          taskId: byPublish.package.taskId,
          members: byPublish.members.map((member) => ({ filename: member.filename, sourcePath: member.sourcePath })),
        },
        memberFacts: byPublish.members.map((member) => ({
          shortLabel: member.shortLabel,
          filename: member.filename,
          artifactVersionId: member.artifactVersionId,
          collectionId: member.collectionId,
        })),
        workspaceRevisionId: input.workspaceRevisionId,
        publishId: input.publishId,
        createdAt: byPublish.package.createdAt,
        ...(replayThreadId ? { threadId: replayThreadId } : {}),
      });
      return { kind: 'replayed', packageId: byPublish.package.packageId, receipt: existingReceipt };
    }
    // receipt 在但 package 不可读(tombstone 收敛):按原 outcome 不重跑业务。
    return { kind: 'replayed', packageId: '', receipt: existingReceipt };
  }

  // 加载事实(全部 Server 读取,客户端不可伪造)。
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== teamId) {
    return { kind: 'rejected', reasonCode: 'channel-not-found' };
  }
  if (channel.archivedAt != null) {
    return { kind: 'rejected', reasonCode: 'channel-archived' };
  }
  const staging = await repositories.workspacePublishStagings.getByPublishId({
    teamId,
    publishId: input.publishId,
  });
  const revision = staging?.committedRevisionId
    ? await repositories.projectChannelWorkspaces.getRevision({
      teamId,
      channelId: input.channelId,
      revisionId: staging.committedRevisionId,
    })
    : null;

  const authority = await ensurePublishAgentAuthority(repositories, teamId, channel, staging?.provenance);
  const workspaceRunId = staging?.provenance?.workspaceRunId;
  const workspaceRunById = workspaceRunId
    ? await repositories.workspaceRuns.getForTeam({ teamId, runId: workspaceRunId })
    : null;
  // Device 在 commit 时可能还没有 Server workspace_runs 行，并且生产 daemon
  // 上报的 workspaceRunId 是 dispatchId。沿 dispatch → invocation 解析 managed
  // lineage，让 commit 后的首次/重试成形都能通过同一 authority fence。
  const workspaceDispatch = workspaceRunId
    ? await repositories.dispatches.getById(workspaceRunId)
    : null;
  const workspaceRunByDispatch = !workspaceRunById && workspaceDispatch?.teamId === teamId
    ? (await repositories.workspaceRuns.listByDispatch(workspaceDispatch.id)).at(-1) ?? null
    : null;
  const workspaceRun = workspaceRunById ?? workspaceRunByDispatch;
  // #1219：旧 Direct Agent daemon 在没有 workspace snapshot 时把 dispatchId 同时写入
  // taskId/workspaceRunId。只接受这一精确 fallback 形态，并从该 Dispatch 的 Server-owned
  // origin Message 恢复真实 Task；普通合成 taskId 与 managed lineage 均保持原语义。
  const rawTaskId = staging?.provenance?.taskId;
  const directOriginMessage = rawTaskId
    && workspaceDispatch
    && rawTaskId === workspaceDispatch.id
    && workspaceRunId === workspaceDispatch.id
    && workspaceDispatch.teamId === teamId
    && workspaceDispatch.channelId === input.channelId
    ? await repositories.messages.getById(workspaceDispatch.messageId)
    : null;
  const linkedDirectTaskId = directOriginMessage?.teamId === teamId
    && directOriginMessage.channelId === input.channelId
    && typeof directOriginMessage.meta?.taskId === 'string'
    ? directOriginMessage.meta.taskId
    : undefined;
  const linkedDirectTaskCandidate = linkedDirectTaskId
    ? await repositories.tasks.getById(linkedDirectTaskId)
    : null;
  const linkedDirectTask = linkedDirectTaskCandidate
    && linkedDirectTaskCandidate.teamId === teamId
    && (!linkedDirectTaskCandidate.channelId || linkedDirectTaskCandidate.channelId === input.channelId)
    ? linkedDirectTaskCandidate
    : null;
  const effectiveTaskId = linkedDirectTask?.id ?? rawTaskId;
  const task = linkedDirectTask ?? (rawTaskId ? await repositories.tasks.getById(rawTaskId) : null);
  const coordination = task
    ? await repositories.taskCoordination.coordinations.getByTaskId(task.id)
    : null;
  const dispatchAttempt = workspaceDispatch
    ? await repositories.management.dispatchAttempts.getByDispatchId(workspaceDispatch.id)
    : null;
  const invocationId = workspaceRun?.managementInvocationId ?? dispatchAttempt?.invocationId;
  const invocation = invocationId
    ? await repositories.management.invocations.getById(invocationId)
    : null;
  const claimLeaseId = invocation?.intent.taskContext?.claimLeaseId;
  const claim = claimLeaseId
    ? await repositories.taskCoordination.claimLeases.getById(claimLeaseId)
    : null;

  const revisionFiles = revision?.files ?? [];

  const decision: OutputPackageFormationDecision = evaluateOutputPackageFormation({
    teamId,
    channelId: input.channelId,
    expectedWorkspaceRevisionId: input.workspaceRevisionId,
    channel: { exists: Boolean(channel && channel.teamId === teamId), archived: channel.archivedAt != null },
    staging: staging
      ? {
        status: staging.status,
        channelId: staging.channelId,
        ...(staging.committedRevisionId ? { committedRevisionId: staging.committedRevisionId } : {}),
        ...(staging.provenance
          ? {
            provenance: {
              agentId: staging.provenance.agentId,
              taskId: effectiveTaskId ?? staging.provenance.taskId,
              taskAttempt: staging.provenance.taskAttempt,
              ...(staging.provenance.deviceId ? { deviceId: staging.provenance.deviceId } : {}),
              ...(staging.provenance.workspaceRunId ? { workspaceRunId: staging.provenance.workspaceRunId } : {}),
            },
          }
          : {}),
      }
      : null,
    revision: revision
      ? {
        id: revision.id,
        files: revisionFiles.map((file) => ({
          path: file.path,
          artifactId: file.artifactId,
          filename: file.filename,
          sizeBytes: file.sizeBytes,
          ...(file.sha256 ? { sha256: file.sha256 } : {}),
        })),
      }
      : null,
    agentAuthorityOk: authority.ok,
    task: task ? { id: task.id, teamId: task.teamId, channelId: task.channelId ?? undefined, revision: task.revision } : null,
    coordination: coordination ? { attempt: coordination.attempt } : null,
    workspaceRun: workspaceRun
      ? {
        // lineage 匹配可使用 production daemon 的 dispatchId alias，但最终
        // 冻结到 OutputPackage/version 的 workspaceRunId 必须是真实 Server run id。
        id: workspaceRun.id,
        ...(workspaceRunById ? {} : { provenanceWorkspaceRunId: workspaceRunId! }),
        ...(invocationId ? { managementInvocationId: invocationId } : {}),
      }
      : null,
    invocation: invocation
      ? {
        id: invocation.id,
        targetAgentId: invocation.intent.targetAgentId,
        ...(invocation.intent.taskContext
          ? {
            taskContext: {
              taskId: invocation.intent.taskContext.taskId,
              taskRevision: invocation.intent.taskContext.taskRevision,
              taskAttempt: invocation.intent.taskContext.taskAttempt,
              claimLeaseId: invocation.intent.taskContext.claimLeaseId,
            },
          }
          : {}),
      }
      : null,
    claim: claim ? { id: claim.id, taskRevision: claim.taskRevision, taskAttempt: claim.taskAttempt, status: claim.status } : null,
  });

  if (decision.kind === 'rejected') {
    return { kind: 'rejected', reasonCode: decision.reasonCode };
  }

  // 组装 record / member writes / receipt / tombstone。
  const plan = decision.plan;
  const now = clock.now();
  const packageId = ids.nextId();
  const deliveryId = ids.nextId();
  const receiptId = ids.nextId();

  const record: OutputPackageRecord = {
    teamId,
    packageId,
    channelId: input.channelId,
    deliveryId,
    publishId: input.publishId,
    workspaceRevisionId: input.workspaceRevisionId,
    agentId: plan.agentId,
    taskId: plan.taskId,
    taskBinding: plan.taskBinding,
    ...(plan.taskRevision !== undefined ? { taskRevision: plan.taskRevision } : {}),
    taskAttempt: plan.taskAttempt,
    ...(plan.invocationId ? { invocationId: plan.invocationId } : {}),
    ...(plan.workspaceRunId ? { workspaceRunId: plan.workspaceRunId } : {}),
    ...(plan.claimLeaseId ? { claimLeaseId: plan.claimLeaseId } : {}),
    ...(plan.deviceId ? { deviceId: plan.deviceId } : {}),
    memberCount: plan.members.length,
    status: 'recorded',
    createdAt: now,
  };

  // 预读既有 collection(为 member.collection 决定 create vs append + revision fence)。
  const members: OutputPackageMemberWrite[] = [];
  for (const member of plan.members) {
    const existingVersion = await repositories.channelProjects.getArtifactVersionByArtifact({
      teamId,
      channelId: input.channelId,
      artifactId: member.artifactId,
    });
    // 既有 artifact version(人工 promote 或先前交付):复用既有 version 与 collection,
    // 不写新 collection/version(reuse 模式由持久层校验 artifact 自然键)。
    if (existingVersion) {
      members.push({
        sequence: member.sequence,
        shortLabel: member.shortLabel,
        role: 'deliverable',
        requiredForFinal: true,
        sourcePath: member.sourcePath,
        filename: member.filename,
        ...(member.sha256 ? { sha256: member.sha256 } : {}),
        sizeBytes: member.sizeBytes,
        collection: { mode: 'reuse', collectionId: existingVersion.collectionId, expectedVersionId: existingVersion.id },
        version: {
          id: existingVersion.id,
          artifactId: member.artifactId,
          taskId: plan.taskId,
          taskRevision: plan.taskRevision ?? 1,
          ...(plan.workspaceRunId ? { sourceWorkspaceRunId: plan.workspaceRunId } : {}),
          ...(plan.invocationId ? { sourceInvocationId: plan.invocationId } : {}),
        },
      });
      continue;
    }
    const existingCollection = await repositories.channelProjects.listArtifactCollections({
      teamId,
      channelId: input.channelId,
    });
    const match = existingCollection.find((collection) => collection.name === member.collectionKey);
    const stageId = await resolveStageIdForTask(repositories, teamId, input.channelId, plan.taskId);
    if (match) {
      members.push({
        sequence: member.sequence,
        shortLabel: member.shortLabel,
        role: 'deliverable',
        requiredForFinal: true,
        sourcePath: member.sourcePath,
        filename: member.filename,
        ...(member.sha256 ? { sha256: member.sha256 } : {}),
        sizeBytes: member.sizeBytes,
        collection: {
          mode: 'append',
          collectionId: match.id,
          expectedRevision: match.revision,
          expectedVersionCount: match.versionCount,
        },
        version: {
          id: ids.nextId(),
          artifactId: member.artifactId,
          ...(stageId ? { stageId } : {}),
          taskId: plan.taskId,
          taskRevision: plan.taskRevision ?? 1,
          ...(plan.workspaceRunId ? { sourceWorkspaceRunId: plan.workspaceRunId } : {}),
          ...(plan.invocationId ? { sourceInvocationId: plan.invocationId } : {}),
        },
      });
    } else {
      members.push({
        sequence: member.sequence,
        shortLabel: member.shortLabel,
        role: 'deliverable',
        requiredForFinal: true,
        sourcePath: member.sourcePath,
        filename: member.filename,
        ...(member.sha256 ? { sha256: member.sha256 } : {}),
        sizeBytes: member.sizeBytes,
        collection: {
          mode: 'create',
          collectionId: ids.nextId(),
          name: member.collectionKey,
          kind: 'deliverable',
        },
        version: {
          id: ids.nextId(),
          artifactId: member.artifactId,
          ...(stageId ? { stageId } : {}),
          taskId: plan.taskId,
          taskRevision: plan.taskRevision ?? 1,
          ...(plan.workspaceRunId ? { sourceWorkspaceRunId: plan.workspaceRunId } : {}),
          ...(plan.invocationId ? { sourceInvocationId: plan.invocationId } : {}),
        },
      });
    }
  }

  const committedRevisions = [{ streamKind: 'output-package', streamId: packageId, revision: 1 }];
  const resultJson = JSON.stringify({ package: record });
  const receipt: OutputPackageReceiptRecord = {
    receiptId,
    teamId,
    commandName: 'record-agent-output-package',
    commandSchemaVersion: OUTPUT_PACKAGE_COMMAND_SCHEMA_VERSION,
    idempotencyKey,
    commandHash,
    outcome: 'applied',
    committedRevisions,
    eventRefs: [],
    commitTime: now,
    resultAvailable: true,
    resultJson,
    createdAt: now,
  };
  const tombstone: OutputPackageTombstoneRecord = {
    id: ids.nextId(),
    teamId,
    commandName: 'record-agent-output-package',
    idempotencyKey,
    commandHash,
    receiptId,
    outcome: 'applied',
    resultAvailable: true,
    createdAt: now,
  };

  const formation = await repositories.outputPackages.recordPackageFormation({
    record,
    members,
    receipt,
    tombstone,
  });
  if (formation.kind === 'conflict') {
    return { kind: 'conflict', reasonCode: formation.reason };
  }
  // #1065 AC7：仅首次成形(created)推进水位——replayed(幂等重入,同 publishId
  // 包已存在、无新事实)不得虚增 revision,否则持旧 token 的客户端被误报
  // PROJECTION_NOT_READY。best-effort:水位失败不阻塞已提交的 package 事实。
  if (formation.kind === 'created') {
    await bumpOutputPackageWatermark(repositories, input.channelId, now);
  }
  // 讨论串投影:package 成形后追加 system 消息,meta 快照与冻结成员一一对应。
  // best-effort:消息追加失败不改写已提交的 package 事实,可由重入路径补齐。
  // #1111:卡片归属触发消息的讨论串;解析失败回退主线(现状)。
  const originThreadId = await resolveOriginThreadId(
    repositories,
    teamId,
    staging?.provenance?.workspaceRunId,
  );
  await appendOutputPackageSystemMessage(repositories, ids, {
    teamId,
    channelId: input.channelId,
    packageId: formation.package.packageId,
    plan,
    memberFacts: formation.members.map((member) => ({
      shortLabel: member.shortLabel,
      filename: member.filename,
      artifactVersionId: member.artifactVersionId,
      collectionId: member.collectionId,
    })),
    workspaceRevisionId: input.workspaceRevisionId,
    publishId: input.publishId,
    createdAt: now,
    ...(originThreadId ? { threadId: originThreadId } : {}),
  });
  return {
    kind: 'applied',
    packageId: formation.package.packageId,
    disposition: formation.kind === 'created' ? 'created' : 'existing',
    receipt,
  };
}

/**
 * #1111:解析触发 dispatch 的用户消息所属讨论串 root,让 output-package 卡片落讨论串
 * 而非主线(设计 §7.4/§8.1:主线是话题入口,文件包展示在讨论串)。
 * 链:provenance.workspaceRunId → dispatch → message;
 * rootThreadId = message.threadId ?? message.id(主线 root 自存根 threadId===id;
 * null 遗留消息按自身为 root)。任一环节缺失返回 undefined——卡片回退主线
 * (现状行为),不丢卡片。纯 Server 侧闭环,不需要 daemon/contracts 透传。
 *
 * 生产实证(2026-08-07):daemon 上报的 provenance.workspaceRunId 等于 dispatchId/taskId,
 * 与 server 侧 workspace_runs.id 不同源——必须两路都试:先按 workspace_runs.id 查
 * (规范形态),查不到再直接按 dispatchId 查(daemon 实况)。
 */
async function resolveOriginThreadId(
  repositories: ServerNextRepositories,
  teamId: ID,
  workspaceRunId: ID | undefined,
): Promise<ID | undefined> {
  if (!workspaceRunId) return undefined;
  try {
    const run = await repositories.workspaceRuns.getForTeam({ teamId, runId: workspaceRunId });
    let dispatchId = run?.dispatchId;
    if (!dispatchId) {
      // daemon 实况:workspaceRunId 即 dispatchId(= taskId)。
      const direct = await repositories.dispatches.getById(workspaceRunId);
      if (direct) dispatchId = direct.id;
    }
    if (!dispatchId) return undefined;
    const dispatch = await repositories.dispatches.getById(dispatchId);
    if (!dispatch?.messageId) return undefined;
    const message = await repositories.messages.getById(dispatch.messageId);
    if (!message) return undefined;
    return message.threadId ?? message.id;
  } catch {
    return undefined;
  }
}

/**
 * Files/Task 详情也必须能从 package 事实反查原讨论串，不能依赖 Web 当前只保留的
 * 最近消息窗口。优先读取既有 package 卡片的 threadId；卡片不存在时回退 delivery
 * provenance。该查询只读且失败关闭，由调用方决定是否允许不可逆退回。
 */
export async function resolveOutputPackageThreadRootMessageId(
  repositories: ServerNextRepositories,
  input: { teamId: ID; channelId: ID; packageId: ID; workspaceRunId?: ID },
): Promise<ID | undefined> {
  const [packageCard, provenanceThreadRootMessageId] = await Promise.all([
    repositories.messages.getByClientMessageId({
      teamId: input.teamId,
      channelId: input.channelId,
      clientMessageId: `output-package:${input.packageId}`,
    }).catch(() => null),
    resolveOriginThreadId(repositories, input.teamId, input.workspaceRunId),
  ]);
  return packageCard?.threadId ?? provenanceThreadRootMessageId;
}

async function appendOutputPackageSystemMessage(
  repositories: ServerNextRepositories,
  ids: { nextId(): ID },
  input: {
    teamId: ID;
    channelId: ID;
    packageId: ID;
    plan: { agentId: ID; taskId: ID; members: readonly { filename: string; sourcePath: string }[] };
    memberFacts: readonly { shortLabel: string; filename: string; artifactVersionId: ID; collectionId: ID }[];
    workspaceRevisionId: ID;
    publishId: ID;
    createdAt: number;
    threadId?: ID;
  },
): Promise<void> {
  try {
    // 幂等:按 packageId 派生 clientMessageId,重入/重复回调不重复追加讨论串卡片。
    const clientMessageId = `output-package:${input.packageId}`;
    const existing = await repositories.messages.getByClientMessageId({
      teamId: input.teamId,
      channelId: input.channelId,
      clientMessageId,
    });
    if (existing) return;
    const [agent, task] = await Promise.all([
      repositories.agents.getById(input.plan.agentId).catch(() => null),
      repositories.tasks.getById(input.plan.taskId).catch(() => null),
    ]);
    await repositories.messages.append({
      id: ids.nextId(),
      teamId: input.teamId,
      channelId: input.channelId,
      senderKind: 'system',
      senderId: 'system',
      body: `Agent 交付 ${input.memberFacts.length} 个文件`,
      createdAt: input.createdAt,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      meta: {
        kind: 'output-package',
        packageId: input.packageId,
        clientMessageId,
        ...(input.threadId ? { threadRootMessageId: input.threadId } : {}),
        ...(task ? { taskId: task.id, taskTitle: task.title } : { taskId: input.plan.taskId }),
        ...(agent ? { agentId: agent.id, agentName: agent.name } : { agentId: input.plan.agentId }),
        memberCount: input.memberFacts.length,
        members: input.memberFacts.map((member) => ({
          shortLabel: member.shortLabel,
          filename: member.filename,
          artifactVersionId: member.artifactVersionId,
          collectionId: member.collectionId,
        })),
        workspaceRevisionId: input.workspaceRevisionId,
        publishId: input.publishId,
        createdAt: input.createdAt,
      },
    });
  } catch {
    // 消息追加失败不影响已提交的 package 事实。
  }
}

/**
 * 读取已成形 package 的卡片 meta 快照(与 appendOutputPackageSystemMessage 同款形状)。
 * #1111 内嵌形态:receiveDispatchResult 把它挂到 agent 回复消息的 meta.outputPackageCard,
 * 卡片随回复气泡内嵌渲染(原型:package-card 在 thread-message 内部),不再以独立
 * system 消息出现在讨论串。读取失败返回 null——回复照常,独立卡片兜底显示。
 */
export async function readOutputPackageCardMeta(
  repositories: ServerNextRepositories,
  input: { teamId: ID; publishId: ID },
): Promise<Record<string, unknown> | null> {
  try {
    const byPublish = await repositories.outputPackages.getPackageByPublishId({
      teamId: input.teamId,
      publishId: input.publishId,
    });
    if (!byPublish) return null;
    const [agent, task, threadRootMessageId] = await Promise.all([
      repositories.agents.getById(byPublish.package.agentId).catch(() => null),
      repositories.tasks.getById(byPublish.package.taskId).catch(() => null),
      resolveOutputPackageThreadRootMessageId(repositories, {
        teamId: input.teamId,
        channelId: byPublish.package.channelId,
        packageId: byPublish.package.packageId,
        ...(byPublish.package.workspaceRunId ? { workspaceRunId: byPublish.package.workspaceRunId } : {}),
      }),
    ]);
    return {
      kind: 'output-package',
      packageId: byPublish.package.packageId,
      ...(threadRootMessageId ? { threadRootMessageId } : {}),
      ...(task ? { taskId: task.id, taskTitle: task.title } : { taskId: byPublish.package.taskId }),
      ...(agent ? { agentId: agent.id, agentName: agent.name } : { agentId: byPublish.package.agentId }),
      memberCount: byPublish.members.length,
      members: byPublish.members.map((member) => ({
        shortLabel: member.shortLabel,
        filename: member.filename,
        artifactVersionId: member.artifactVersionId,
        collectionId: member.collectionId,
      })),
      workspaceRevisionId: byPublish.package.workspaceRevisionId,
      publishId: input.publishId,
      createdAt: byPublish.package.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * 投影读取:Files/Task 用。无业务副作用;package 与冻结成员来自同一 Server 事实。
 */
export async function readOutputPackage(
  repositories: ServerNextRepositories,
  input: { teamId: ID; packageId: ID },
): Promise<OutputPackageProjection | null> {
  const result = await repositories.outputPackages.getPackageById(input);
  if (!result) return null;
  return {
    package: result.package,
    members: result.members.map((member) => ({
      sequence: member.sequence,
      shortLabel: member.shortLabel,
      collectionId: member.collectionId,
      artifactVersionId: member.artifactVersionId,
      sourcePath: member.sourcePath,
      filename: member.filename,
      ...(member.sha256 ? { sha256: member.sha256 } : {}),
      sizeBytes: member.sizeBytes,
    })),
  };
}

async function ensurePublishAgentAuthority(
  repositories: ServerNextRepositories,
  teamId: ID,
  channel: ChannelRecord,
  provenance: { agentId: ID; taskId: ID; taskAttempt: number; workspaceRunId?: ID; deviceId?: ID } | undefined,
): Promise<{ ok: boolean }> {
  if (!provenance) return { ok: false };
  const agent = await repositories.agents.getById(provenance.agentId);
  if (!agent
    || !agent.visibleTeamIds.includes(teamId)
    || !channel.agentMemberIds.includes(agent.id)
    || (provenance.deviceId !== undefined && agent.deviceId !== provenance.deviceId)) {
    return { ok: false };
  }
  return { ok: true };
}

async function resolveStageIdForTask(
  repositories: ServerNextRepositories,
  teamId: ID,
  channelId: ID,
  taskId: ID,
): Promise<ID | undefined> {
  const stages = await repositories.channelProjects.listStages({ teamId, channelId });
  const stage = stages.find((candidate) => candidate.taskId === taskId);
  return stage?.id;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
