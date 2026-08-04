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
  const task = staging?.provenance?.taskId
    ? await repositories.tasks.getById(staging.provenance.taskId)
    : null;
  const coordination = task
    ? await repositories.taskCoordination.coordinations.getByTaskId(task.id)
    : null;
  const workspaceRunId = staging?.provenance?.workspaceRunId;
  const workspaceRun = workspaceRunId
    ? await repositories.workspaceRuns.getForTeam({ teamId, runId: workspaceRunId })
    : null;
  const invocationId = workspaceRun?.managementInvocationId;
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
              taskId: staging.provenance.taskId,
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
    workspaceRun: workspaceRun ? { id: workspaceRun.id, ...(workspaceRun.managementInvocationId ? { managementInvocationId: workspaceRun.managementInvocationId } : {}) } : null,
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
  // 讨论串投影:package 成形后追加 system 消息,meta 快照与冻结成员一一对应。
  // best-effort:消息追加失败不改写已提交的 package 事实,可由重入路径补齐。
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
  });
  return {
    kind: 'applied',
    packageId: formation.package.packageId,
    disposition: formation.kind === 'created' ? 'created' : 'existing',
    receipt,
  };
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
      meta: {
        kind: 'output-package',
        packageId: input.packageId,
        clientMessageId,
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
