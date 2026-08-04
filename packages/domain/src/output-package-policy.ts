import type { OutputPackageRejectionReason } from '@agentbean/contracts';

/**
 * #1060 OutputPackage 成形判定纯策略(父规格 #1059 §3/§4)。
 *
 * 输入全部由 Server 从已持久化事实加载(staging/revision/task/coordination/claim/invocation/
 * workspaceRun),调用方不得自报 provenance。判定只回答三件事:
 * - replay:同一 publish identity 已有 package(自然幂等,同一 delivery 收敛同一 package);
 * - rejected:结构化拒绝码,无副作用、不留部分事实,committed Workspace revision 保持可恢复;
 * - create:给出完整成形计划(collection 创建/追加、冻结成员、delivery lineage),由持久层在
 *   单个事务内复核约束后一次性落库。
 *
 * 关键不变量:
 * - package 出现本身不推进 Task(本判定不产出任何 Task 状态变更);
 * - 同一 delivery 中同一逻辑 collection(规范化相对路径)至多一个 delivered version;
 * - 成员顺序/短标识/交付版本/角色/final 必需性在计划中冻结,落库后不可变。
 */

/** 交付文件快照(来自已 committed 的 Workspace revision)。 */
export interface OutputPackageDeliveryFileSnapshot {
  readonly path: string;
  /** commit 物化后的 artifact 引用;缺失即文件集合不完整。 */
  readonly artifactId?: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
}

export interface OutputPackageStagingSnapshot {
  readonly status: 'open' | 'committed' | 'failed';
  readonly channelId: string;
  readonly committedRevisionId?: string;
  readonly provenance?: {
    readonly agentId: string;
    readonly taskId: string;
    readonly taskAttempt: number;
    readonly deviceId?: string;
    readonly workspaceRunId?: string;
  };
}

export interface OutputPackageTaskSnapshot {
  readonly id: string;
  readonly teamId: string;
  readonly channelId?: string;
  readonly revision: number;
}

export interface OutputPackageCoordinationSnapshot {
  readonly attempt: number;
}

export interface OutputPackageWorkspaceRunSnapshot {
  readonly id: string;
  readonly managementInvocationId?: string;
}

export interface OutputPackageInvocationSnapshot {
  readonly id: string;
  readonly targetAgentId: string;
  readonly taskContext?: {
    readonly taskId: string;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly claimLeaseId: string;
  };
}

export interface OutputPackageClaimSnapshot {
  readonly id: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly status: 'active' | 'released' | 'expired' | 'invalidated';
}

/** 成形计划中的单个冻结成员(落库后不可变)。 */
export interface OutputPackageMemberPlan {
  readonly sequence: number;
  readonly shortLabel: string;
  /** 逻辑 collection 身份键 = 规范化相对路径(同频道同人交付同路径 → 追加 version)。 */
  readonly collectionKey: string;
  readonly artifactId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly sourcePath: string;
}

export interface OutputPackageFormationPlan {
  readonly agentId: string;
  readonly taskId: string;
  readonly taskBinding: 'managed' | 'unmanaged';
  readonly taskAttempt: number;
  readonly taskRevision?: number;
  readonly invocationId?: string;
  readonly workspaceRunId?: string;
  readonly claimLeaseId?: string;
  readonly deviceId?: string;
  readonly members: readonly OutputPackageMemberPlan[];
}

export type OutputPackageFormationDecision =
  | { readonly kind: 'rejected'; readonly reasonCode: OutputPackageRejectionReason }
  | { readonly kind: 'create'; readonly plan: OutputPackageFormationPlan };

/**
 * 判定一次 committed Agent delivery 是否能形成 OutputPackage。
 * 复验顺序即拒绝优先级:先目标事实(staging/revision/channel),再完整性,再 authority,
 * 最后 Task/Invocation/claim lineage——任一失败都不应进入成形。
 */
export function evaluateOutputPackageFormation(input: {
  readonly teamId: string;
  readonly channelId: string;
  /** command input 声明的目标 revision(必须与 staging 已 commit 的 revision 一致)。 */
  readonly expectedWorkspaceRevisionId: string;
  readonly channel: { readonly exists: boolean; readonly archived: boolean };
  readonly staging: OutputPackageStagingSnapshot | null;
  readonly revision: { readonly id: string; readonly files: readonly OutputPackageDeliveryFileSnapshot[] } | null;
  /** Server 对交付 Agent 的 authority 复验结果(存在/Team 可见/频道成员/Device 绑定)。 */
  readonly agentAuthorityOk: boolean;
  /** 真实 Task 快照;null = 合成 taskId(daemon fallback),只记 provenance。 */
  readonly task: OutputPackageTaskSnapshot | null;
  /** managed run 的 coordination;null = 普通频道任务或合成 taskId。 */
  readonly coordination: OutputPackageCoordinationSnapshot | null;
  /** provenance.workspaceRunId 解析结果;provenance 未带时传 null。 */
  readonly workspaceRun: OutputPackageWorkspaceRunSnapshot | null;
  /** workspaceRun.managementInvocationId 解析结果;无关联时传 null。 */
  readonly invocation: OutputPackageInvocationSnapshot | null;
  /** invocation intent taskContext.claimLeaseId 解析结果;无关联时传 null。 */
  readonly claim: OutputPackageClaimSnapshot | null;
}): OutputPackageFormationDecision {
  // 注意:同一 delivery/publish identity 的自然幂等收敛由持久层(repo 的 publishId 唯一键)
  // 与 handler 的 receipt 预查负责,本纯函数只判首次成形。

  if (!input.channel.exists) {
    return { kind: 'rejected', reasonCode: 'channel-not-found' };
  }
  if (input.channel.archived) {
    return { kind: 'rejected', reasonCode: 'channel-archived' };
  }

  const staging = input.staging;
  if (!staging
    || staging.channelId !== input.channelId
    || staging.status !== 'committed'
    || !staging.committedRevisionId
    || staging.committedRevisionId !== input.expectedWorkspaceRevisionId
    || !input.revision
    || input.revision.id !== input.expectedWorkspaceRevisionId) {
    // 未 commit / commit 失败 / 恢复中的 staging 不产生完整 package(Device seam 边界)。
    return { kind: 'rejected', reasonCode: 'workspace-revision-not-committed' };
  }

  const provenance = staging.provenance;
  const files = input.revision.files;
  if (!provenance || files.length === 0 || files.some((file) => !file.artifactId)) {
    return { kind: 'rejected', reasonCode: 'incomplete-delivery' };
  }

  // 同一 delivery 中同一逻辑 collection(相对路径)至多一个 delivered version(#1059 §4)。
  const seenPaths = new Set<string>();
  for (const file of files) {
    if (seenPaths.has(file.path)) {
      return { kind: 'rejected', reasonCode: 'duplicate-manifest-entry' };
    }
    seenPaths.add(file.path);
  }

  if (!input.agentAuthorityOk) {
    return { kind: 'rejected', reasonCode: 'agent-authority-revoked' };
  }

  // Task lineage 复验:合成 taskId 只记 provenance;真实 Task 按 managed/unmanaged 分级绑定。
  const task = input.task;
  let taskBinding: 'managed' | 'unmanaged' = 'unmanaged';
  let taskRevision: number | undefined;
  let invocationId: string | undefined;
  let workspaceRunId: string | undefined;
  let claimLeaseId: string | undefined;

  if (task) {
    if (task.teamId !== input.teamId || (task.channelId && task.channelId !== input.channelId)) {
      return { kind: 'rejected', reasonCode: 'task-authority-mismatch' };
    }
    const coordination = input.coordination;
    if (coordination) {
      // managed run:attempt 是当前 delivery contract 的fence,漂移即本次交付已被取代。
      if (coordination.attempt !== provenance.taskAttempt) {
        return { kind: 'rejected', reasonCode: 'task-attempt-superseded' };
      }
      if (provenance.workspaceRunId) {
        const run = input.workspaceRun;
        if (!run || run.id !== provenance.workspaceRunId) {
          return { kind: 'rejected', reasonCode: 'invocation-mismatch' };
        }
        if (run.managementInvocationId) {
          const invocation = input.invocation;
          const context = invocation?.taskContext;
          if (!invocation
            || invocation.id !== run.managementInvocationId
            || !context
            || invocation.targetAgentId !== provenance.agentId
            || context.taskId !== task.id
            || context.taskAttempt !== provenance.taskAttempt) {
            return { kind: 'rejected', reasonCode: 'invocation-mismatch' };
          }
          if (context.taskRevision !== task.revision) {
            return { kind: 'rejected', reasonCode: 'task-attempt-superseded' };
          }
          const claim = input.claim;
          if (!claim
            || claim.id !== context.claimLeaseId
            || claim.status === 'invalidated'
            || claim.status === 'expired') {
            return { kind: 'rejected', reasonCode: 'claim-inactive' };
          }
          if (claim.taskRevision !== task.revision || claim.taskAttempt !== provenance.taskAttempt) {
            return { kind: 'rejected', reasonCode: 'task-attempt-superseded' };
          }
          invocationId = invocation.id;
          claimLeaseId = claim.id;
        }
        workspaceRunId = run.id;
      }
      taskBinding = 'managed';
      taskRevision = task.revision;
    } else {
      // 普通频道任务(无 management 链):绑定当前 revision,attempt 只记 provenance。
      taskBinding = 'managed';
      taskRevision = task.revision;
    }
  }

  const members: OutputPackageMemberPlan[] = files.map((file, index) => ({
    sequence: index + 1,
    shortLabel: `F${index + 1}`,
    collectionKey: file.path,
    artifactId: file.artifactId as string,
    filename: file.filename,
    sizeBytes: file.sizeBytes,
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
    sourcePath: file.path,
  }));

  return {
    kind: 'create',
    plan: {
      agentId: provenance.agentId,
      taskId: provenance.taskId,
      taskBinding,
      taskAttempt: provenance.taskAttempt,
      ...(taskRevision !== undefined ? { taskRevision } : {}),
      ...(invocationId ? { invocationId } : {}),
      ...(workspaceRunId ? { workspaceRunId } : {}),
      ...(claimLeaseId ? { claimLeaseId } : {}),
      ...(provenance.deviceId ? { deviceId: provenance.deviceId } : {}),
      members,
    },
  };
}
