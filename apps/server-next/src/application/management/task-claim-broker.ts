import { createHash, randomBytes } from 'node:crypto';
import type {
  TaskClaimAcquireAckV1,
  TaskClaimAcquireV1,
  TaskClaimAuthorityV1,
  TaskClaimExpiredV1,
  TaskClaimFailureAckV1,
  TaskClaimOfferV1,
  TaskClaimReleaseAckV1,
  TaskClaimReleaseV1,
  TaskClaimRelinquishAckV1,
  TaskClaimRelinquishV1,
  TaskClaimRenewAckV1,
  TaskClaimRenewV1,
  TaskOfferResponseKind,
  TaskOfferResponseRecordDto,
  TaskOfferStatus,
  TaskRequirementAttestationV1,
} from '../../../../../packages/contracts/src/index.js';
import {
  decideHardSpecifiedOfferKind,
  desensitizeAllocationSuggestion,
  evaluateClaimRelinquishment,
  evaluateExecutionGrantIssuance,
  evaluateOfferAcceptance,
  evaluateOfferDecline,
  evaluateOfferValidity,
  evaluateTaskClaimAcquire,
  evaluateTaskClaimRelease,
  evaluateTaskClaimRenew,
  validateRequirementAttestation,
  type OfferInvalidationReason,
  type OfferValidity,
  type TaskClaimLeaseRecord as DomainTaskClaimLeaseRecord,
} from '../../../../../packages/domain/src/index.js';
import { resolveProjectStageExecutionGate } from '../project-stage-execution-gate.js';
import {
  filterStrictProjectStageAgentIds,
  resolveProjectStageStableInputs,
} from '../project-stage-advance-service.js';
import type { AgentRecord, ServerNextRepositories, TaskRecord } from '../repositories.js';
import type { TaskClaimLeaseRecord, TaskCoordinationRecord, TaskOfferRecord } from '../task-coordination-repositories.js';
import {
  appendValidatedManagementEventInTransaction,
  ManagementConflictError,
} from './management-kernel.js';
import {
  hashManagementEventPayload,
  parseTaskCoordinationManagementEvent,
} from './management-event-validator.js';

export type TaskClaimCandidateDiagnosticCode =
  | 'AGENT_NOT_VISIBLE'
  | 'AGENT_DELETED'
  | 'AGENT_DEVICE_MISSING'
  | 'DEVICE_OFFLINE'
  | 'AGENT_NOT_READY'
  | 'CAPABILITY_MISSING'
  | 'TASK_CHANNEL_FORBIDDEN'
  | 'DEPENDENCY_NOT_READY'
  | 'DEPENDENCY_CHANNEL_FORBIDDEN'
  /** #822：绑定项目阶段的 Task 仍有未满足的 Stage 依赖或缺失的必需输入。 */
  | 'PROJECT_STAGE_BLOCKED'
  | 'ANCESTOR_AGENT_LOOP'
  | 'TARGET_AGENT_MISMATCH';

export interface TaskClaimCandidateDiagnostic {
  readonly agentId: string;
  readonly deviceId?: string;
  readonly eligible: boolean;
  readonly diagnosticCodes: readonly TaskClaimCandidateDiagnosticCode[];
  readonly missingCapabilities: readonly string[];
}

export interface TaskClaimCandidateResolution {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly candidates: readonly TaskClaimCandidateDiagnostic[];
  readonly ancestorAgentIds: readonly string[];
}

/** #712 切片 C-1：Agent 对显式 Task Offer 的响应输入。 */
export interface TaskOfferRespondInput {
  readonly offerId: string;
  readonly agentId: string;
  readonly kind: TaskOfferResponseKind;
  readonly detail?: string | null;
  /**
   * #947 PR2（ADR-0064 §3）：per-Task requirement attestation——仅 Requirement-confirmation Offer 的 accepted
   * 需要（其余响应为 undefined/null）。Agent 声明其具备本 Task 的 required capability/skill（用于解除 PR1 的
   * fail-closed：manifest 不可得→attestation 覆盖 required→建立 claim）。经 domain validateRequirementAttestation
   * 校验 attested ⊇ required 后才放行。
   */
  readonly attestation?: TaskRequirementAttestationV1;
}

/**
 * #712 切片 C-2b-i：组合+持久化一个完整 Task Offer 的输入。
 * objective/deliverables/riskLevel 等从 task/coordination/criteria/manifest 派生（过渡）；
 * decision 的结构化 objective/inputs/constraints 属更底层切片（计划 §6.3 未完成）。
 */
export interface TaskOfferPublishInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly offerTtlMs: number;
  /** 显式 @Agent（AC#8 仅元数据，不强迫接受）。 */
  readonly hardSpecified: boolean;
  /**
   * ADR-0064 §3 Requirement-confirmation Offer（#947 PR1）：向「硬指定 + required requirement 状态
   * unknown」目标发的受限 Offer。true 时 publishOffer 跳过 active-manifest 要求（manifestRevision 占位 0）
   * 并做发布复验；该 Offer 不当作 eligible，accepted 在 attestation 路径（PR2）落地前 fail-closed。
   */
  readonly requirementConfirmation?: boolean;
  /**
   * 可选：显式指定 offer id（prepareOffers 持久化时与 wire TaskClaimOfferV1.offerId 共享，
   * 使 daemon 用同一 offerId 既能 respond（新路径）也能 acquire（旧兼容路径）。
   * 缺省 nextId 生成。
  */
  readonly id?: string;
  /** #829 标记由项目阶段自动推进产生，accept 时必须重验策略、PI 与稳定输入 fence。 */
  readonly projectStageAuto?: boolean;
}

/**
 * #712 切片 C-1：respondToOffer 结果。
 * - claim_granted：accepted 且同事务创建了 Claim/Lease（AC#4）。
 * - overtaken：并发中被抢先获得 Claim（AC#6 败者），不产 Lease。
 * - response_recorded：rejected/needs_info/counter_proposed 记录为终态，不产 Lease（AC#5）。
 * - not_accepted：offer 失效/候选不合格/claim 策略拒绝，不产 Lease。
 */
export type TaskOfferRespondResult =
  | {
      readonly kind: 'claim_granted';
      readonly lease: TaskClaimAuthorityV1 & { readonly acquiredAt: number; readonly expiresAt: number };
      readonly execution: {
        readonly schemaVersion: 1;
        readonly managementRunId: string;
        readonly taskId: string;
        readonly taskRevision: number;
        readonly taskAttempt: number;
        readonly grantId: string;
        readonly workspaceRevisionId?: string;
        readonly title: string;
        readonly objective: string;
        readonly acceptanceCriteria: readonly unknown[];
        readonly dependencyTaskIds: readonly string[];
        readonly channelId?: string;
      };
    }
  | { readonly kind: 'overtaken' }
  | { readonly kind: 'response_recorded'; readonly status: TaskOfferStatus }
  | {
      readonly kind: 'not_accepted';
      readonly reason: 'offer_invalid' | 'agent_not_qualified' | 'claim_rejected';
      readonly diagnosticCode: string;
    };

export interface ProjectStageClaimGranted {
  readonly managementRunId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly targetAgentId: string;
  readonly objective: string;
}

export interface TaskClaimBroker {
  resolveCandidates(taskId: string, options?: {
    readonly dependencyTaskIds?: readonly string[];
    readonly skipProjectStageGate?: boolean;
  }): Promise<TaskClaimCandidateResolution>;
  resolveProjectStageCandidates(
    taskId: string,
    dependencyTaskIds?: readonly string[],
  ): Promise<TaskClaimCandidateResolution>;
  prepareOffers(taskId: string, options?: {
    readonly allowedAgentIds?: readonly string[];
    readonly projectStageAuto?: boolean;
  }): Promise<readonly TaskClaimOfferV1[]>;
  acquire(input: TaskClaimAcquireV1): Promise<TaskClaimAcquireAckV1>;
  renew(input: TaskClaimRenewV1): Promise<TaskClaimRenewAckV1>;
  release(input: TaskClaimReleaseV1): Promise<TaskClaimReleaseAckV1>;
  /**
   * ADR-0064/0065 #948-E：Agent 携带 authority 显式 relinquish Claim（带 cause）。
   * 开工前（task 未 in_progress）只结束 allocation round、保留 attempt；开工后终止 attempt。
   */
  relinquish(input: TaskClaimRelinquishV1): Promise<TaskClaimRelinquishAckV1>;
  expireClaims(): Promise<readonly TaskClaimExpiredV1[]>;
  disconnectDevice(deviceId: string): void;
  reconnectDevice(deviceId: string): void;
  /** #712 切片 C-1：持久化一个结构化 Task Offer（PI → Agent，状态 open）。 */
  createOffer(record: TaskOfferRecord): Promise<TaskOfferRecord>;
  /**
   * #712 切片 C-2b-i：从 task/coordination/criteria/manifest 派生并持久化完整 Task Offer。
   * 过渡：objective←task.description、deliverables←acceptance criteria、inputs/constraints 暂空、
   * riskLevel 默认 low（decision 结构化字段属后续切片）。为 C-2b-ii daemon 切换提供持久化 substrate。
   */
  publishOffer(input: TaskOfferPublishInput): Promise<TaskOfferRecord>;
  /** #712 切片 C-1：处理 Agent 对 Offer 的显式响应（AC#2/AC#4/AC#5/AC#6）。 */
  respondToOffer(input: TaskOfferRespondInput): Promise<TaskOfferRespondResult>;
  /** #829：自动阶段 Offer 形成 Claim 后，接通 Server 内部 Invocation 创建。 */
  bindProjectStageClaimGranted(
    handler: (claim: ProjectStageClaimGranted) => Promise<void>,
  ): void;
}

export interface CreateTaskClaimBrokerInput {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly leaseTokens?: { nextToken(): string };
  readonly offerTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly piHealthy?: () => Promise<boolean>;
}

const PROJECT_STAGE_AUTO_CONSTRAINT = 'agentbean:project-stage-auto';
const PROJECT_STAGE_FENCE_PREFIX = 'agentbean:project-stage-fence:';

interface StoredOffer extends TaskClaimOfferV1 {
  readonly ancestorAgentIds: readonly string[];
  readonly projectStageAuto: boolean;
  /** #946：发布时冻结的 manifest revision（grant 签发写入；legacy 无 manifest → 0）。 */
  readonly manifestRevision: number;
}

export function createTaskClaimBroker(input: CreateTaskClaimBrokerInput): TaskClaimBroker {
  const offerTtlMs = positiveDuration(input.offerTtlMs ?? 15_000, 'TASK_CLAIM_OFFER_TTL_INVALID');
  const leaseTtlMs = positiveDuration(input.leaseTtlMs ?? 60_000, 'TASK_CLAIM_LEASE_TTL_INVALID');
  const leaseTokens = input.leaseTokens ?? { nextToken: () => randomBytes(32).toString('base64url') };
  const offers = new Map<string, StoredOffer>();
  const disconnectedDevices = new Set<string>();
  const taskTails = new Map<string, Promise<void>>();
  let onProjectStageClaimGranted:
    ((claim: ProjectStageClaimGranted) => Promise<void>) | undefined;

  // #710：候选硬过滤优先用 Team Agent Exposure 公开 capability（active 能力减去 Team restriction）。
  // 过渡兼容（计划 §8：旧代码先降为兼容层，切片 E 强制前保留）：无 active manifest 时回退到
  // legacy skill 名做匹配——仅用名称，永不引入 sourcePath/工具/权限（AC#6）。
  async function resolveEffectiveCapabilities(teamId: string, agent: AgentRecord): Promise<Set<string>> {
    const exposure = input.repositories.agentExposure;
    const now = input.clock.now();
    const active = await exposure.manifests.getActiveByTeamAgent(teamId, agent.id);
    if (active) {
      if (active.validUntil !== null && active.validUntil <= now) {
        await exposure.manifests.setStatus({ id: active.id, status: 'expired', now });
      } else {
        const restriction = await exposure.restrictions.getByTeamAgent(teamId, agent.id);
        const disabled = restriction && restriction.manifestId === active.id ? restriction.disabledCapabilities : [];
        const disabledSet = new Set(disabled.map((entry) => entry.toLowerCase()));
        return new Set(
          active.capabilities
            .map((capability) => capability.name.toLowerCase())
            .filter((name) => !disabledSet.has(name)),
        );
      }
    }
    return new Set((agent.skills ?? []).map((skill) => skill.name.toLowerCase()));
  }

  async function resolveCandidates(taskId: string, options?: {
    readonly dependencyTaskIds?: readonly string[];
    readonly skipProjectStageGate?: boolean;
  }): Promise<TaskClaimCandidateResolution> {
    const task = await input.repositories.tasks.getById(taskId);
    if (!task) throw new Error('TASK_CLAIM_TASK_NOT_FOUND');
    const coordination = await input.repositories.taskCoordination.coordinations.getByTaskId(taskId);
    if (!coordination) throw new Error('TASK_CLAIM_COORDINATION_NOT_FOUND');
    const agents = (await input.repositories.agents.listAll()).filter((agent) =>
      agent.primaryTeamId === task.teamId || agent.visibleTeamIds.includes(task.teamId));
    const devices = new Map((await input.repositories.devices.listByTeam(task.teamId))
      .map((device) => [device.id, device]));
    const dependencies = options?.dependencyTaskIds
      ? options.dependencyTaskIds.map((dependencyTaskId) => ({
        taskId,
        dependencyTaskId,
        taskRevision: task.revision,
      }))
      : await input.repositories.taskCoordination.dependencies.list(taskId);
    const dependencyTasks = await Promise.all(dependencies.map((edge) => input.repositories.tasks.getById(edge.dependencyTaskId)));
    const taskChannel = task.channelId ? await input.repositories.channels.getById(task.channelId) : null;
    const dependencyChannels = new Map<string, Awaited<ReturnType<typeof input.repositories.channels.getById>>>();
    for (const dependencyTask of dependencyTasks) {
      if (dependencyTask?.channelId && !dependencyChannels.has(dependencyTask.channelId)) {
        dependencyChannels.set(dependencyTask.channelId, await input.repositories.channels.getById(dependencyTask.channelId));
      }
    }
    const ancestorAgentIds = await collectAncestorAgentIds(taskId, input.repositories, input.clock.now());
    // #822 AC#5：项目阶段门禁与 Agent 无关，对全部候选统一生效。
    const projectStageGate = await resolveProjectStageExecutionGate(input.repositories, task);
    const candidates: TaskClaimCandidateDiagnostic[] = [];
    for (const agent of agents) {
      const diagnostics: TaskClaimCandidateDiagnosticCode[] = [];
      if (!agent.visibleTeamIds.includes(task.teamId)) diagnostics.push('AGENT_NOT_VISIBLE');
      if (agent.deletedAt !== undefined) diagnostics.push('AGENT_DELETED');
      if (!agent.deviceId) diagnostics.push('AGENT_DEVICE_MISSING');
      const device = agent.deviceId ? devices.get(agent.deviceId) : undefined;
      if (agent.deviceId && (!device || device.status !== 'online' || disconnectedDevices.has(agent.deviceId))) {
        diagnostics.push('DEVICE_OFFLINE');
      }
      if (agent.status !== 'online') diagnostics.push('AGENT_NOT_READY');
      const explicitCapabilities = await resolveEffectiveCapabilities(task.teamId, agent);
      const missingCapabilities = coordination.requiredCapabilities
        .filter((capability) => !explicitCapabilities.has(capability.toLowerCase()));
      if (missingCapabilities.length > 0) diagnostics.push('CAPABILITY_MISSING');
      if (task.channelId && (!taskChannel || !channelAllowsAgent(taskChannel, agent.id))) {
        diagnostics.push('TASK_CHANNEL_FORBIDDEN');
      }
      if (dependencyTasks.some((dependency) => !dependency || dependency.status !== 'done')) {
        diagnostics.push('DEPENDENCY_NOT_READY');
      }
      if (!options?.skipProjectStageGate && projectStageGate.blocked) {
        diagnostics.push('PROJECT_STAGE_BLOCKED');
      }
      if (dependencyTasks.some((dependency) => dependency?.channelId &&
        (!dependencyChannels.get(dependency.channelId) ||
          !channelAllowsAgent(dependencyChannels.get(dependency.channelId), agent.id)))) {
        diagnostics.push('DEPENDENCY_CHANNEL_FORBIDDEN');
      }
      if (ancestorAgentIds.includes(agent.id)) diagnostics.push('ANCESTOR_AGENT_LOOP');
      if (coordination.claimPolicy === 'targeted' && task.assigneeId !== agent.id) {
        diagnostics.push('TARGET_AGENT_MISMATCH');
      }
      candidates.push({
        agentId: agent.id,
        ...(agent.deviceId ? { deviceId: agent.deviceId } : {}),
        eligible: diagnostics.length === 0,
        diagnosticCodes: diagnostics,
        missingCapabilities,
      });
    }
    return {
      taskId,
      taskRevision: task.revision,
      taskAttempt: coordination.attempt,
      candidates: candidates.sort((left, right) => left.agentId.localeCompare(right.agentId)),
      ancestorAgentIds,
    };
  }

  async function resolveProjectStageCandidates(
    taskId: string,
    dependencyTaskIds?: readonly string[],
  ): Promise<TaskClaimCandidateResolution> {
    if (dependencyTaskIds) {
      return resolveCandidates(taskId, { dependencyTaskIds, skipProjectStageGate: true });
    }
    const task = await input.repositories.tasks.getById(taskId);
    if (!task?.channelId) return resolveCandidates(taskId);
    const [dependencies, edges] = await Promise.all([
      input.repositories.taskCoordination.dependencies.list(taskId),
      input.repositories.channelProjects.listEdges({
        teamId: task.teamId,
        channelId: task.channelId,
      }),
    ]);
    const mirroredDependencyIds = new Set(edges
      .filter((edge) => edge.downstreamTaskId === taskId && edge.mirroredTaskDependency)
      .map((edge) => edge.upstreamTaskId));
    const effectiveDependencyTaskIds = [
      ...dependencies
        .map((dependency) => dependency.dependencyTaskId)
        .filter((id) => !mirroredDependencyIds.has(id)),
      ...edges
        .filter((edge) => edge.downstreamTaskId === taskId && edge.semantics === 'blocks_start')
        .map((edge) => edge.upstreamTaskId),
    ];
    return resolveCandidates(taskId, {
      dependencyTaskIds: [...new Set(effectiveDependencyTaskIds)],
      skipProjectStageGate: true,
    });
  }

  // #947 PR1（ADR-0064 §3）：硬指定 (@Agent) 目标的 Offer 种类解析。prepareOffers 的 targeted 分支据此
  // 决定：正常定向 Offer / Requirement-confirmation Offer（仅持久化，不当作 eligible，claim 需 PR2
  // attestation）/ 不发 Offer。复用 resolveCandidates 的硬门槛 diagnosticCodes + active Manifest 的
  // eligibility 三态（domain evaluateAgentEligibility + decideHardSpecifiedOfferKind）。
  type TargetedOfferDecision =
    | { readonly kind: 'normal'; readonly agentId: string; readonly deviceId: string }
    | { readonly kind: 'confirmation'; readonly agentId: string; readonly deviceId?: string }
    | {
        readonly kind: 'no_offer';
        readonly reason: 'target_not_candidate' | 'hard_gate_failed' | 'explicit_unsatisfied';
      };

  async function resolveTargetedOfferKind(
    task: TaskRecord,
    coordination: TaskCoordinationRecord,
    resolution: TaskClaimCandidateResolution,
  ): Promise<TargetedOfferDecision> {
    const targetId = task.assigneeId;
    if (!targetId) return { kind: 'no_offer', reason: 'target_not_candidate' };
    const candidate = resolution.candidates.find((item) => item.agentId === targetId);
    if (!candidate) return { kind: 'no_offer', reason: 'target_not_candidate' };
    // 不可覆盖硬门槛：仅允许 CAPABILITY_MISSING（manifest/legacy 派生软门槛）缺席；任一硬门槛码 → 不发 Offer。
    if (candidate.diagnosticCodes.some((code) => code !== 'CAPABILITY_MISSING')) {
      return { kind: 'no_offer', reason: 'hard_gate_failed' };
    }
    // 合格候选（active manifest 或 legacy skill 覆盖 required + 全硬门槛通过）→ 正常定向 Offer。
    // 保留 legacy 兼容：无 active manifest 但 skills 覆盖的 agent 仍走正常 wire/claim，不被误判为 confirmation
    //（candidate.eligible 由 resolveCandidates 经 resolveEffectiveCapabilities 综合判定，含 manifest 与 legacy 兜底）。
    if (candidate.eligible && candidate.deviceId) {
      return { kind: 'normal', agentId: targetId, deviceId: candidate.deviceId };
    }
    // 非合格（此处仅 CAPABILITY_MISSING）：按 active Exposure Manifest 区分 ADR-0064 §3 两子类——
    // 无 active manifest → required requirement 状态 unknown → Requirement-confirmation Offer；
    // 有 active manifest 但明确缺失 → not_qualified（明确不满足事实）→ 不发 Offer。
    const now = input.clock.now();
    const active = await input.repositories.agentExposure.manifests.getActiveByTeamAgent(task.teamId, targetId);
    const hasActiveManifest = !!active && (active.validUntil === null || active.validUntil > now);
    const state = hasActiveManifest ? 'not_qualified' : 'unknown';
    const offerKind = decideHardSpecifiedOfferKind({ eligibility: { state, available: false } });
    if (offerKind === 'requirement_confirmation') {
      return { kind: 'confirmation', agentId: targetId, deviceId: candidate.deviceId };
    }
    return { kind: 'no_offer', reason: 'explicit_unsatisfied' };
  }

  return {
    resolveCandidates,
    resolveProjectStageCandidates,
    async prepareOffers(taskId, options) {
      await expireClaims();
      const resolution = options?.projectStageAuto
        ? await resolveProjectStageCandidates(taskId)
        : await resolveCandidates(taskId);
      const task = await input.repositories.tasks.getById(taskId);
      if (!task || !['todo', 'in_progress'].includes(task.status)) throw new Error('TASK_CLAIM_TASK_NOT_OFFERABLE');
      const coordination = await input.repositories.taskCoordination.coordinations.getByTaskId(taskId);
      if (!coordination) throw new Error('TASK_CLAIM_COORDINATION_NOT_FOUND');
      const current = await input.repositories.taskCoordination.claimLeases.getCurrent({
        taskId, taskRevision: task.revision, taskAttempt: coordination.attempt,
      });
      if (current && current.expiresAt > input.clock.now()) return [];
      const now = input.clock.now();
      // #947 PR1（ADR-0064 §3）：targeted（显式 @Agent）走硬指定 Offer 种类解析；open 走既有 fan-out。
      const isTargeted = coordination.claimPolicy === 'targeted' && task.assigneeId;
      if (isTargeted) {
        const decision = await resolveTargetedOfferKind(task, coordination, resolution);
        if (decision.kind === 'normal') {
          const offerId = input.ids.nextId();
          let manifestRevision = 0;
          try {
            const published = await this.publishOffer({
              taskId, agentId: decision.agentId, offerTtlMs, hardSpecified: true,
              id: offerId, projectStageAuto: options?.projectStageAuto,
            });
            manifestRevision = published.manifestRevision;
          } catch (error) {
            if (!(error instanceof Error && error.message === 'TASK_CLAIM_MANIFEST_NOT_ACTIVE')) throw error;
            // legacy（无 active manifest）：grant 无 manifest 绑定，manifestRevision 保持 0。
          }
          const stored: StoredOffer = {
            schemaVersion: 1, offerId, deviceId: decision.deviceId, taskId,
            taskRevision: resolution.taskRevision, taskAttempt: resolution.taskAttempt,
            agentId: decision.agentId, requiredCapabilities: [...coordination.requiredCapabilities],
            offerExpiresAt: now + offerTtlMs, manifestRevision,
            ancestorAgentIds: resolution.ancestorAgentIds, projectStageAuto: options?.projectStageAuto === true,
          };
          offers.set(offerId, stored);
          return [{
            schemaVersion: 1, offerId, deviceId: decision.deviceId, taskId,
            taskRevision: resolution.taskRevision, taskAttempt: resolution.taskAttempt,
            agentId: decision.agentId, requiredCapabilities: [...coordination.requiredCapabilities],
            offerExpiresAt: now + offerTtlMs,
          }];
        }
        if (decision.kind === 'confirmation') {
          // Requirement-confirmation Offer：仅持久化（Task/Agent 视图可见、PI 据此请求确认），
          // 不下发 wire、不入内存 offers map——设备无法执行，attestation 路径（PR2）落地前 claim fail-closed。
          try {
            await this.publishOffer({
              taskId, agentId: decision.agentId, offerTtlMs, hardSpecified: true,
              requirementConfirmation: true, id: input.ids.nextId(), projectStageAuto: options?.projectStageAuto,
            });
          } catch (error) {
            if (!(error instanceof Error && error.message === 'TASK_CLAIM_REQUIREMENT_CONFIRMATION_INVALID')) throw error;
          }
        }
        // no_offer（hard_gate_failed / explicit_unsatisfied / target_not_candidate）→ 不发 Offer（allocation_blocked）。
        return [];
      }
      const prepared: StoredOffer[] = [];
      // 非 targeted（open）fan-out：向全部 eligible 候选发 offer。targeted 已在上方分支提前 return。
      const eligibleCandidates = resolution.candidates.filter((item) => {
        if (!item.eligible || !item.deviceId) return false;
        if (options?.allowedAgentIds && !options.allowedAgentIds.includes(item.agentId)) return false;
        return true;
      });
      // #948-F ADR-0064：当前频道无合格候选 → 结构化 allocation_blocked（脱敏建议，仅有权人类可见，
      // 绝不泄露频道外 agent 身份）。事件幂等（同 task+revision+payload → return existing）。
      if (!resolution.candidates.some((item) => item.eligible)) {
        const cause = resolution.candidates.length === 0 ? 'no_candidate' : 'no_qualified_candidate';
        const suggestion = desensitizeAllocationSuggestion({
          cause,
          candidates: resolution.candidates.map((item) => ({
            hasRequiredCapabilities: !item.diagnosticCodes.includes('CAPABILITY_MISSING'),
            channelForbidden: item.diagnosticCodes.includes('TASK_CHANNEL_FORBIDDEN'),
          })),
        });
        await input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
          try {
            await appendTaskClaimEvent(repositories.management, {
              managementRunId: coordination.managementRunId, type: 'allocation-blocked',
              actorKind: 'system', actorId: 'system',
              idempotencyKey: `allocation-blocked:${taskId}:${resolution.taskRevision}`,
              payload: { taskId, taskRevision: resolution.taskRevision, cause,
                suggestionKind: suggestion.kind,
                ...(suggestion.kind === 'escalate_external_capability'
                  ? { externalAgentCount: suggestion.externalAgentCount } : {}) },
            }, input.clock.now(), input.ids);
          } catch (error) {
            // 候选集变化致建议不同 → 同 key 不同 payload 冲突：已记录过 allocation-blocked，幂等跳过。
            if (!(error instanceof ManagementConflictError
              && error.code === 'MANAGEMENT_EVENT_IDEMPOTENCY_CONFLICT')) throw error;
          }
        });
        return [];
      }
      // #948-B ADR-0064：整图原子发布含 Offer——优先从持久化读取 kernel UoW 内原子创建的 offer
      // （避免 broker publishOffer 重复创建）。无持久化 offer 或 projectStageAuto 路径时
      // 回退到既有 broker 创建逻辑（legacy / 项目阶段自动推进兼容）。
      const persistedOffers = options?.projectStageAuto
        ? [] : await input.repositories.taskCoordination.offers.listByTask(taskId);
      const openPersisted = persistedOffers.filter((po) =>
        po.status === 'open' && po.offerExpiresAt > now);
      if (openPersisted.length > 0) {
        for (const po of openPersisted) {
          const candidate = resolution.candidates.find((c) => c.agentId === po.agentId);
          if (!candidate?.deviceId) continue;
          prepared.push({
            schemaVersion: 1,
            offerId: po.id,
            deviceId: candidate.deviceId,
            taskId,
            taskRevision: resolution.taskRevision,
            taskAttempt: resolution.taskAttempt,
            agentId: po.agentId,
            requiredCapabilities: [...coordination.requiredCapabilities],
            // #948-B：持久化 offer 的原始 expiresAt 可能已过期（多次 prepareOffers 间 clock 推进），
            // 用当前时间重算 TTL 使 StoredOffer 在本次分配轮有效。
            offerExpiresAt: now + offerTtlMs,
            manifestRevision: po.manifestRevision,
            ancestorAgentIds: resolution.ancestorAgentIds,
            projectStageAuto: po.objective.constraints.includes(PROJECT_STAGE_AUTO_CONSTRAINT),
          });
        }
      } else {
        for (const candidate of eligibleCandidates) {
        const offerId = input.ids.nextId();
        // C-2b-ii：为 manifest-having 候选持久化完整 TaskOffer（新 respond 路径的 substrate，
        // wire offerId = 持久化 record.id）。legacy（无 active manifest）→ publishOffer 抛
        // MANIFEST_NOT_ACTIVE，跳过持久化仅内存 StoredOffer（旧 acquire 兼容路径）。
        let manifestRevision = 0;
        try {
          const published = await this.publishOffer({
            taskId,
            agentId: candidate.agentId,
            offerTtlMs,
            hardSpecified: coordination.claimPolicy === 'targeted' && task.assigneeId === candidate.agentId,
            id: offerId,
            projectStageAuto: options?.projectStageAuto,
          });
          manifestRevision = published.manifestRevision;
        } catch (error) {
          if (!(error instanceof Error && error.message === 'TASK_CLAIM_MANIFEST_NOT_ACTIVE')) throw error;
          // legacy（无 active manifest）：grant 无 manifest 绑定，manifestRevision 保持 0。
        }
        prepared.push({
          schemaVersion: 1,
          offerId,
          deviceId: candidate.deviceId!,
          taskId,
          taskRevision: resolution.taskRevision,
          taskAttempt: resolution.taskAttempt,
          agentId: candidate.agentId,
          requiredCapabilities: [...coordination.requiredCapabilities],
          offerExpiresAt: now + offerTtlMs,
          manifestRevision,
          ancestorAgentIds: resolution.ancestorAgentIds,
          projectStageAuto: options?.projectStageAuto === true,
        });
      }
      } // #948-B: end of legacy offer creation fallback
      for (const offer of prepared) offers.set(offer.offerId, offer);
      return prepared.map(({
        ancestorAgentIds: _ancestorAgentIds,
        projectStageAuto: _projectStageAuto,
        manifestRevision: _manifestRevision,
        ...offer
      }) => offer);
    },
    async acquire(payload) {
      let offer = offers.get(payload.offerId);
      // #948-B ADR-0064：Map miss → 持久化兜底（kernel UoW 内原子创建的 offer 在 prepareOffers
      // 填充 Map 之前或之后都可能到达——hydrate 前需从持久化读，hydrate 后直接命中 Map）。
      if (!offer) {
        const persisted = await input.repositories.taskCoordination.offers.getById(payload.offerId);
        if (persisted && persisted.agentId === payload.agentId && persisted.status === 'open') {
          const now = input.clock.now();
          if (now >= persisted.offerExpiresAt) {
            return failure('UNAVAILABLE', 'TASK_CLAIM_OFFER_EXPIRED', true);
          }
          const agent = await input.repositories.agents.getById(persisted.agentId);
          if (!agent?.deviceId) {
            return failure('INVALID_REQUEST', 'TASK_CLAIM_OFFER_INVALID', false);
          }
          const ancestorAgentIds = await collectAncestorAgentIds(
            persisted.taskId, input.repositories, now);
          offer = {
            schemaVersion: 1,
            offerId: persisted.id,
            deviceId: agent.deviceId,
            taskId: persisted.taskId,
            taskRevision: persisted.taskRevision,
            taskAttempt: persisted.taskAttempt,
            agentId: persisted.agentId,
            requiredCapabilities: persisted.objective.requiredCapabilities,
            offerExpiresAt: persisted.offerExpiresAt,
            ancestorAgentIds,
            projectStageAuto: persisted.objective.constraints
              .includes(PROJECT_STAGE_AUTO_CONSTRAINT),
            manifestRevision: persisted.manifestRevision,
          };
        }
      }
      if (!offer || offer.agentId !== payload.agentId) return failure('INVALID_REQUEST', 'TASK_CLAIM_OFFER_INVALID', false);
      if (input.clock.now() >= offer.offerExpiresAt) {
        offers.delete(offer.offerId);
        return failure('UNAVAILABLE', 'TASK_CLAIM_OFFER_EXPIRED', true);
      }
      return withTaskLock(offer.taskId, taskTails, async () => {
        if (offer.projectStageAuto) {
          const persisted = await input.repositories.taskCoordination.offers.getById(offer.offerId);
          if (!persisted || !(await projectStageAutoOfferStillCurrent(
            input,
            persisted,
            input.clock.now(),
          ))) {
            return failure('CONFLICT', 'TASK_CLAIM_PROJECT_STAGE_FENCE_STALE', false);
          }
        }
        const resolution = await resolveCandidates(offer.taskId);
        const candidate = resolution.candidates.find((item) => item.agentId === offer.agentId);
        if (!candidate?.eligible || candidate.deviceId !== offer.deviceId) {
          return failure('UNAVAILABLE', candidate?.diagnosticCodes[0] ?? 'TASK_CLAIM_CANDIDATE_UNAVAILABLE', true);
        }
        const leaseToken = leaseTokens.nextToken();
        const leaseTokenHash = hash(leaseToken);
        const leaseFingerprint = leaseTokenHash.slice(0, 16);
        try {
          const result = await input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
            const now = input.clock.now();
            const task = await repositories.tasks.getById(offer.taskId);
            const coordination = await repositories.coordination.coordinations.getByTaskId(offer.taskId);
            if (!task || !coordination || task.revision !== offer.taskRevision ||
                coordination.attempt !== offer.taskAttempt || !['todo', 'in_progress'].includes(task.status)) {
              throw new TaskClaimConflict('TASK_CLAIM_OFFER_STALE');
            }
            if (offer.projectStageAuto) {
              const persisted = await repositories.coordination.offers.getById(offer.offerId);
              if (!persisted || !(await projectStageAutoOfferStillCurrent(input, persisted, now))) {
                throw new TaskClaimConflict('TASK_CLAIM_PROJECT_STAGE_FENCE_STALE');
              }
            }
            const latest = await repositories.coordination.claimLeases.getLatest({
              taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
            });
            if (latest?.status === 'invalidated') throw new TaskClaimConflict('TASK_CLAIM_INVALIDATED');
            const decision = evaluateTaskClaimAcquire({
              current: latest ? toDomainLease(latest) : undefined,
              taskId: task.id,
              taskRevision: task.revision,
              taskAttempt: coordination.attempt,
              nodeKind: coordination.nodeKind,
              agentId: offer.agentId,
              leaseTokenHash,
              leaseFingerprint,
              ancestorAgentIds: offer.ancestorAgentIds,
              now,
              ttlMs: leaseTtlMs,
            });
            if (decision.kind === 'rejected') throw new TaskClaimConflict(`TASK_CLAIM_${code(decision.reason)}`);
            if (decision.kind === 'existing') throw new TaskClaimConflict('TASK_CLAIM_ALREADY_HELD');
            if (offer.projectStageAuto) {
              const acceptedResponse: TaskOfferResponseRecordDto = {
                offerId: offer.offerId,
                agentId: offer.agentId,
                kind: 'accepted',
                detail: null,
                respondedAt: now,
              };
              const accepted = await repositories.coordination.offers.updateStatus({
                id: offer.offerId,
                expectedStatus: 'open',
                status: 'accepted',
                response: acceptedResponse,
                now,
              });
              if (!accepted) throw new TaskClaimConflict('TASK_CLAIM_OFFER_OVERTAKEN');
            }
            if (latest?.status === 'active') {
              const expired = await repositories.coordination.claimLeases.update({
                id: latest.id, expectedStatus: 'active', status: 'expired',
                heartbeatAt: latest.heartbeatAt, expiresAt: latest.expiresAt,
              });
              if (!expired) throw new TaskClaimConflict('TASK_CLAIM_EXPIRE_CONFLICT');
              // #925 P1-b：旧 lease 时间过期但 expireClaims 未扫时被内联过期——同事务撤销其绑定
              // active grant，避免与同 (taskId, taskAttempt) 新 grant 撞唯一索引（sqlite）或双 active grant（memory）。
              for (const grant of await repositories.coordination.executionGrants.listActiveByClaimLease(latest.id)) {
                await repositories.coordination.executionGrants.revoke({
                  id: grant.id, reason: 'claim-expired', revokedAt: now, now,
                });
              }
            }
            const leaseId = input.ids.nextId();
            const lease: TaskClaimLeaseRecord = {
              id: leaseId,
              teamId: task.teamId,
              taskId: task.id,
              taskRevision: task.revision,
              taskAttempt: coordination.attempt,
              agentId: offer.agentId,
              leaseTokenHash,
              leaseFingerprint,
              fencingToken: decision.lease.fencingToken,
              status: 'active',
              acquiredAt: decision.lease.acquiredAt,
              heartbeatAt: decision.lease.renewedAt,
              expiresAt: decision.lease.expiresAt,
            };
            await repositories.coordination.claimLeases.create(lease);
            // #966：claim 时冻结频道当前 workspace revision，写入 grant 供 Agent 读取固定输入版本（AC#1）。
            // 经 input.repositories 读（快照读取，无需与 claim 同事务）；transaction 内 repositories 无此 repo。
            const workspaceRevisionId = task.channelId
              ? (await input.repositories.projectChannelWorkspaces.getForTeam({ teamId: task.teamId, channelId: task.channelId }))?.currentRevisionId
              : undefined;
            const grantDecision = evaluateExecutionGrantIssuance({
              teamId: task.teamId,
              managementRunId: coordination.managementRunId,
              taskId: task.id,
              taskRevision: task.revision,
              taskAttempt: coordination.attempt,
              claimLeaseId: lease.id,
              agentId: offer.agentId,
              manifestRevision: offer.manifestRevision,
              workspaceRevisionId,
              nodeKind: coordination.nodeKind,
              grantedAt: now,
            });
            // root 已被 evaluateTaskClaimAcquire 拒绝；defense in depth：签发决策再次拒绝则回滚。
            if (grantDecision.kind !== 'issued') {
              throw new TaskClaimConflict('TASK_CLAIM_GRANT_REFUSED');
            }
            const grantId = input.ids.nextId();
            await repositories.coordination.executionGrants.create({
              id: grantId, ...grantDecision.grant,
            });
            await appendTaskClaimEvent(repositories.management, {
              managementRunId: coordination.managementRunId,
              type: 'task-claimed',
              actorKind: 'agent',
              actorId: offer.agentId,
              idempotencyKey: `task-claimed:${lease.id}`,
              payload: { taskId: task.id, taskRevision: task.revision, agentId: offer.agentId,
                claimLeaseId: lease.id, attempt: coordination.attempt },
            }, now, input.ids);
            if (task.status === 'todo' || task.assigneeId !== offer.agentId) {
              const updated = await repositories.tasks.update({ taskId: task.id,
                changes: { ...(task.status === 'todo' ? { status: 'in_progress' as const } : {}),
                  assigneeId: offer.agentId, updatedAt: now } });
              if (!updated) throw new TaskClaimConflict('TASK_CLAIM_TASK_UPDATE_CONFLICT');
            }
            if (task.status === 'todo') {
              await appendTaskClaimEvent(repositories.management, {
                managementRunId: coordination.managementRunId,
                type: 'task-state-changed',
                actorKind: 'agent', actorId: offer.agentId,
                idempotencyKey: `task-state-changed:${lease.id}`,
                payload: { taskId: task.id, taskRevision: task.revision, from: 'todo', to: 'in_progress' },
              }, now, input.ids);
            }
            const criteria = (await repositories.coordination.criteria.list(task.id))
              .filter((criterion) => criterion.introducedRevision <= task.revision &&
                (criterion.retiredRevision === undefined || criterion.retiredRevision > task.revision))
              .sort((left, right) => left.position - right.position)
              .map(({ taskId: _taskId, introducedRevision: _introducedRevision,
                retiredRevision: _retiredRevision, position: _position, ...criterion }) => criterion);
            const dependencyTaskIds = (await repositories.coordination.dependencies.list(task.id))
              .map((dependency) => dependency.dependencyTaskId);
            return { lease, task, coordination, criteria, dependencyTaskIds, grantId, workspaceRevisionId };
          });
          consumeTaskOffers(offers, offer.taskId);
          const response = {
            schemaVersion: 1,
            ok: true,
            lease: authority(result.lease, leaseToken),
            execution: {
              schemaVersion: 1,
              managementRunId: result.coordination.managementRunId,
              taskId: result.task.id,
              taskRevision: result.task.revision,
              taskAttempt: result.coordination.attempt,
              grantId: result.grantId,
              ...(result.workspaceRevisionId ? { workspaceRevisionId: result.workspaceRevisionId } : {}),
              title: result.task.title,
              objective: result.task.description ?? result.task.title,
              acceptanceCriteria: result.criteria,
              dependencyTaskIds: result.dependencyTaskIds,
              ...(result.task.channelId ? { channelId: result.task.channelId } : {}),
            },
          } satisfies TaskClaimAcquireAckV1;
          if (offer.projectStageAuto) {
            await notifyProjectStageClaimGranted(onProjectStageClaimGranted, {
              managementRunId: result.coordination.managementRunId,
              taskId: result.task.id,
              taskRevision: result.task.revision,
              taskAttempt: result.coordination.attempt,
              claimLeaseId: result.lease.id,
              targetAgentId: result.lease.agentId,
              objective: result.task.description ?? result.task.title,
            });
          }
          return response;
        } catch (error) {
          if (error instanceof TaskClaimConflict) {
            return failure('CONFLICT', error.message, error.message === 'TASK_CLAIM_ACTIVE_CLAIM_HELD');
          }
          throw error;
        }
      });
    },
    async renew(payload) {
      return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
        const lease = await repositories.coordination.claimLeases.getById(payload.claimLeaseId);
        const now = input.clock.now();
        const decision = evaluateTaskClaimRenew({
          lease: lease ? toDomainLease(lease) : undefined,
          proof: proof(payload), now, ttlMs: leaseTtlMs,
        });
        if (decision.kind === 'rejected') return failure('STALE_AUTHORITY', `TASK_CLAIM_${code(decision.reason)}`, false);
        const updated = await repositories.coordination.claimLeases.update({
          id: payload.claimLeaseId, expectedStatus: 'active', status: 'active',
          heartbeatAt: decision.lease.renewedAt, expiresAt: decision.lease.expiresAt,
        });
        return updated
          ? { schemaVersion: 1, ok: true, expiresAt: updated.expiresAt }
          : failure('CONFLICT', 'TASK_CLAIM_RENEW_CONFLICT', true);
      });
    },
    async release(payload) {
      return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
        const lease = await repositories.coordination.claimLeases.getById(payload.claimLeaseId);
        const now = input.clock.now();
        const decision = evaluateTaskClaimRelease({ lease: lease ? toDomainLease(lease) : undefined,
          proof: proof(payload), now });
        if (decision.kind === 'rejected') return failure('STALE_AUTHORITY', `TASK_CLAIM_${code(decision.reason)}`, false);
        if (decision.kind === 'already-released') {
          return { schemaVersion: 1, ok: true, releasedAt: decision.lease.releasedAt! };
        }
        const updated = await repositories.coordination.claimLeases.update({
          id: payload.claimLeaseId, expectedStatus: 'active', status: 'released',
          heartbeatAt: lease!.heartbeatAt, expiresAt: lease!.expiresAt, releasedAt: now,
        });
        if (updated) {
          // #925：lease 释放 → 绑定 execution context grant 同事务撤销（claim-released）。
          for (const grant of await repositories.coordination.executionGrants.listActiveByClaimLease(payload.claimLeaseId)) {
            await repositories.coordination.executionGrants.revoke({
              id: grant.id, reason: 'claim-released', revokedAt: now, now,
            });
          }
        }
        return updated
          ? { schemaVersion: 1, ok: true, releasedAt: now }
          : failure('CONFLICT', 'TASK_CLAIM_RELEASE_CONFLICT', true);
      });
    },
    async relinquish(payload) {
      return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
        const lease = await repositories.coordination.claimLeases.getById(payload.claimLeaseId);
        const now = input.clock.now();
        const decision = evaluateClaimRelinquishment({
          lease: lease ? toDomainLease(lease) : undefined,
          proof: proof(payload), now, cause: payload.cause,
          ...(payload.detail ? { detail: payload.detail } : {}),
        });
        if (decision.kind === 'rejected') {
          return failure('STALE_AUTHORITY', `TASK_CLAIM_${code(decision.reason)}`, false);
        }
        if (decision.kind === 'no_active_claim') {
          return { schemaVersion: 1, ok: true, releasedAt: now, executionStarted: false,
            attempt: payload.taskAttempt };
        }
        if (decision.kind === 'already_relinquished') {
          return { schemaVersion: 1, ok: true, releasedAt: decision.lease.releasedAt ?? now,
            executionStarted: false, attempt: payload.taskAttempt };
        }
        // decision.kind === 'relinquished'：proof-gated 释放（委托 evaluateTaskClaimRelease）。
        const task = await repositories.tasks.getById(lease!.taskId);
        const coordination = await repositories.coordination.coordinations.getByTaskId(lease!.taskId);
        const updated = await repositories.coordination.claimLeases.update({
          id: payload.claimLeaseId, expectedStatus: 'active', status: 'released',
          heartbeatAt: lease!.heartbeatAt, expiresAt: lease!.expiresAt, releasedAt: now,
        });
        if (!updated) return failure('CONFLICT', 'TASK_CLAIM_RELINQUISH_CONFLICT', true);
        // 释放绑定 execution context grant（claim-released，同 release/#925/#946 模式）。
        for (const grant of await repositories.coordination.executionGrants.listActiveByClaimLease(payload.claimLeaseId)) {
          await repositories.coordination.executionGrants.revoke({
            id: grant.id, reason: 'claim-released', revokedAt: now, now,
          });
        }
        // attempt 语义（ADR-0064/0065）：开工后（task 曾 in_progress）relinquish 终止并消耗 attempt；
        // 开工前只结束 allocation round、保留 attempt。execution-start 信号 = task.status==='in_progress'
        // （execution grant 在 acquire 即签发，故 grant 存在≠已开工）。
        let attempt = coordination?.attempt ?? payload.taskAttempt;
        const executionStarted = task?.status === 'in_progress';
        if (executionStarted && coordination) {
          const waitingForUser = coordination.attempt >= coordination.maxAttempts;
          if (!waitingForUser) {
            const revised = await repositories.coordination.coordinations.update({
              expectedTaskRevision: lease!.taskRevision,
              record: { ...coordination, attempt: coordination.attempt + 1, updatedAt: now },
            });
            if (revised) attempt = revised.attempt;
          }
          await repositories.tasks.update({ taskId: lease!.taskId,
            changes: { status: 'todo', updatedAt: now } });
          await appendTaskClaimEvent(repositories.management, {
            managementRunId: coordination.managementRunId, type: 'task-state-changed',
            actorKind: 'agent', actorId: lease!.agentId, idempotencyKey: `relinquish:${lease!.id}`,
            payload: { taskId: lease!.taskId, taskRevision: lease!.taskRevision,
              from: 'in_progress', to: 'todo' },
          }, now, input.ids);
        }
        return { schemaVersion: 1, ok: true, releasedAt: now, executionStarted, attempt };
      });
    },
    expireClaims,
    disconnectDevice(deviceId) {
      disconnectedDevices.add(deviceId);
      for (const [offerId, offer] of offers) if (offer.deviceId === deviceId) offers.delete(offerId);
    },
    reconnectDevice(deviceId) {
      disconnectedDevices.delete(deviceId);
    },
    async createOffer(record) {
      return input.repositories.taskCoordination.offers.create(record);
    },
    async publishOffer(params) {
      // 输入校验：负/零 TTL 会立即过期（wasteful）；与构造期全局 TTL 同款 positiveDuration。
      positiveDuration(params.offerTtlMs, 'TASK_CLAIM_OFFER_TTL_INVALID');
      const task = await input.repositories.tasks.getById(params.taskId);
      if (!task) throw new Error('TASK_CLAIM_TASK_NOT_FOUND');
      const coordination = await input.repositories.taskCoordination.coordinations.getByTaskId(params.taskId);
      if (!coordination) throw new Error('TASK_CLAIM_COORDINATION_NOT_FOUND');
      // manifestRevision fence：仅向有当前有效 active manifest 的 agent 发 offer（公开契约存在）。
      const activeManifest = await input.repositories.agentExposure.manifests.getActiveByTeamAgent(
        task.teamId, params.agentId,
      );
      const now = input.clock.now();
      const requirementConfirmation = params.requirementConfirmation === true;
      const hasActiveManifest = !!activeManifest
        && (activeManifest.validUntil === null || activeManifest.validUntil > now);
      if (requirementConfirmation) {
        // #947 PR1（ADR-0064 §3 发布复验）：Requirement-confirmation Offer 只向 required requirement
        // 状态 unknown（无 active manifest）的目标发。此刻若已有 active manifest → 不再 unknown
        //（qualified 应走正常 Offer，not_qualified 为明确不满足事实）→ 拒绝发布，避免用确认 Offer 绕过
        // requirement 门槛。不可覆盖硬门槛（channel/visibility/device/dependency…）与最小 preview 由调用方
        // resolveTargetedOfferKind 查 diagnosticCodes 保证；Offer objective 本就只披露 required cap/skill 名。
        if (hasActiveManifest) throw new Error('TASK_CLAIM_REQUIREMENT_CONFIRMATION_INVALID');
      } else if (!hasActiveManifest) {
        throw new Error('TASK_CLAIM_MANIFEST_NOT_ACTIVE');
      }
      const projectStageFence = params.projectStageAuto
        ? await resolveProjectStageOfferFence(input.repositories, task)
        : null;
      if (params.projectStageAuto) {
        const policy = await input.repositories.teamPiPolicy.getOrDefault(task.teamId);
        const piHealthy = await input.piHealthy?.() ?? false;
        const strictAgentIds = await filterStrictProjectStageAgentIds(input.repositories, {
          teamId: task.teamId,
          candidateAgentIds: [params.agentId],
          requiredCapabilities: coordination.requiredCapabilities,
          ...(projectStageFence?.requiresProjectDocumentInputSetV1
            ? { requiredProjectDocumentInputSetVersion: 1 }
            : {}),
          now,
        });
        if (!policy.autoCoordinationEnabled || !piHealthy || !projectStageFence
          || strictAgentIds.length !== 1) {
          throw new Error('TASK_CLAIM_PROJECT_STAGE_AUTO_BLOCKED');
        }
      }
      // 过滤退休 criterion（#709 修订退休的验收标准不进入新 offer 的 deliverables）。
      const criteria = (await input.repositories.taskCoordination.criteria.list(params.taskId))
        .filter((criterion) => criterion.retiredRevision === undefined);
      const record: TaskOfferRecord = {
        id: params.id ?? input.ids.nextId(),
        teamId: task.teamId,
        taskId: task.id,
        agentId: params.agentId,
        taskRevision: task.revision,
        taskAttempt: coordination.attempt,
        manifestRevision: requirementConfirmation ? 0 : activeManifest!.revision,
        // 过渡派生：decision 的结构化 objective/inputs/constraints 属后续切片（计划 §6.3）。
        objective: {
          objective: task.description ?? task.title,
          inputs: projectStageFence ? [projectStageFence.value] : [],
          deliverables: criteria.map((criterion) => criterion.description),
          constraints: params.projectStageAuto ? [PROJECT_STAGE_AUTO_CONSTRAINT] : [],
          riskLevel: 'low',
          requiredCapabilities: [...coordination.requiredCapabilities],
          requiredSkills: [...(coordination.requiredSkills ?? [])],
          preferredSkills: [...(coordination.preferredSkills ?? [])],
        },
        offerTtlMs: params.offerTtlMs,
        offerExpiresAt: now + params.offerTtlMs,
        hardSpecified: params.hardSpecified,
        requirementConfirmation: params.requirementConfirmation === true,
        status: 'open',
        response: null,
        createdAt: now,
        updatedAt: now,
      };
      return input.repositories.taskCoordination.offers.create(record);
    },
    async respondToOffer(payload) {
      const offerStore = input.repositories.taskCoordination.offers;
      const offer = await offerStore.getById(payload.offerId);
      if (!offer || offer.agentId !== payload.agentId) {
        return { kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode: 'TASK_CLAIM_OFFER_INVALID' };
      }
      const now = input.clock.now();
      const validity = await computeOfferValidity(input.repositories, offer, now);
      if (offer.objective.constraints.includes(PROJECT_STAGE_AUTO_CONSTRAINT)
        && !(await projectStageAutoOfferStillCurrent(input, offer, now))) {
        await offerStore.updateStatus({
          id: offer.id,
          expectedStatus: 'open',
          status: 'invalidated',
          response: null,
          now,
        });
        return {
          kind: 'not_accepted',
          reason: 'offer_invalid',
          diagnosticCode: 'TASK_CLAIM_PROJECT_STAGE_FENCE_STALE',
        };
      }

      // 非接受响应：rejected / needs_info / counter_proposed（AC#5：不产 Lease）
      if (payload.kind !== 'accepted') {
        const decline = evaluateOfferDecline({ kind: payload.kind, validity });
        if (decline.kind === 'not_accepted') {
          const diagnosticCode = !validity.acceptable
            ? offerValidityCode(validity.reason) : 'TASK_CLAIM_OFFER_INVALID';
          return { kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode };
        }
        const response: TaskOfferResponseRecordDto = {
          offerId: offer.id, agentId: offer.agentId, kind: payload.kind,
          detail: payload.detail ?? null, respondedAt: now,
        };
        const updated = await offerStore.updateStatus({
          id: offer.id, expectedStatus: 'open', status: payload.kind, response, now,
        });
        // decline 路径无「并发赢家」语义；CAS 失败=offer 已被他者置终态 → not_accepted。
        return updated
          ? { kind: 'response_recorded', status: payload.kind }
          : { kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode: 'TASK_CLAIM_OFFER_NOT_OPEN' };
      }

      // accepted
      // #947 PR2（ADR-0064 §3）：Requirement-confirmation Offer 经 per-Task requirement attestation 解除
      // fail-closed。Agent 随 acceptance 提交 attestation（attested ⊇ required cap+skill），并在本事务通过
      // attestation 校验 + 容量硬门槛复验后 → 建立 claim。无 attestation / 不覆盖 / 硬门槛失败 → 维持拒绝。
      if (offer.requirementConfirmation) {
        if (!payload.attestation) {
          return {
            kind: 'not_accepted', reason: 'offer_invalid',
            diagnosticCode: 'TASK_CLAIM_REQUIREMENT_ATTESTATION_REQUIRED',
          };
        }
        const attestationResult = validateRequirementAttestation({
          attestation: payload.attestation,
          requiredCapabilities: offer.objective.requiredCapabilities,
          requiredSkills: offer.objective.requiredSkills,
        });
        if (!attestationResult.ok) {
          return {
            kind: 'not_accepted', reason: 'offer_invalid',
            diagnosticCode: 'TASK_CLAIM_ATTESTATION_INCOMPLETE',
          };
        }
        // 不可覆盖硬门槛快速预检（claim 事务内会用锁后最新数据复查；此处避免进入锁后才发现失败）
        const gateCheck = await resolveCandidates(offer.taskId);
        const gateCandidate = gateCheck.candidates.find((item) => item.agentId === offer.agentId);
        if (!gateCandidate || gateCandidate.diagnosticCodes.some((code) => code !== 'CAPABILITY_MISSING')) {
          return {
            kind: 'not_accepted', reason: 'agent_not_qualified' as const,
            diagnosticCode: gateCandidate?.diagnosticCodes[0] ?? 'TASK_CLAIM_CANDIDATE_UNAVAILABLE',
          };
        }
      }
      if (!validity.acceptable) {
        return { kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode: offerValidityCode(validity.reason) };
      }
      return withTaskLock(offer.taskId, taskTails, async () => {
        if (offer.objective.constraints.includes(PROJECT_STAGE_AUTO_CONSTRAINT)
          && !(await projectStageAutoOfferStillCurrent(input, offer, input.clock.now()))) {
          const checkedAt = input.clock.now();
          await offerStore.updateStatus({
            id: offer.id,
            expectedStatus: 'open',
            status: 'invalidated',
            response: null,
            now: checkedAt,
          });
          return {
            kind: 'not_accepted',
            reason: 'offer_invalid' as const,
            diagnosticCode: 'TASK_CLAIM_PROJECT_STAGE_FENCE_STALE',
          };
        }
        const resolution = await resolveCandidates(offer.taskId);
        const candidate = resolution.candidates.find((item) => item.agentId === offer.agentId);
        if (!candidate?.eligible) {
          if (!offer.requirementConfirmation) {
            return { kind: 'not_accepted', reason: 'agent_not_qualified' as const,
              diagnosticCode: candidate?.diagnosticCodes[0] ?? 'TASK_CLAIM_CANDIDATE_UNAVAILABLE' };
          }
          // confirmation offer：CAPABILITY_MISSING 已由 attestation 覆盖；只拒硬门槛失败或候选不存在
          if (!candidate || candidate.diagnosticCodes.some((code) => code !== 'CAPABILITY_MISSING')) {
            return { kind: 'not_accepted', reason: 'agent_not_qualified' as const,
              diagnosticCode: candidate?.diagnosticCodes[0] ?? 'TASK_CLAIM_CANDIDATE_UNAVAILABLE' };
          }
        }
        const leaseToken = leaseTokens.nextToken();
        const leaseTokenHash = hash(leaseToken);
        const leaseFingerprint = leaseTokenHash.slice(0, 16);
        const acceptedResponse: TaskOfferResponseRecordDto = {
          offerId: offer.id, agentId: offer.agentId, kind: 'accepted', detail: null, respondedAt: now,
          ...(payload.attestation ? { attestation: payload.attestation } : {}),
        };
        try {
          const result = await input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
            const task = await repositories.tasks.getById(offer.taskId);
            const coordination = await repositories.coordination.coordinations.getByTaskId(offer.taskId);
            if (!task || !coordination || task.revision !== offer.taskRevision ||
                coordination.attempt !== offer.taskAttempt || !['todo', 'in_progress'].includes(task.status)) {
              // AC#4：task 已变 → 回滚，不留 accepted 无 claim
              throw new TaskClaimConflict('TASK_CLAIM_OFFER_STALE');
            }
            if (offer.objective.constraints.includes(PROJECT_STAGE_AUTO_CONSTRAINT)
              && !(await projectStageAutoOfferStillCurrent(input, offer, now))) {
              throw new TaskClaimConflict('TASK_CLAIM_PROJECT_STAGE_FENCE_STALE');
            }
            const latest = await repositories.coordination.claimLeases.getLatest({
              taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
            });
            if (latest?.status === 'invalidated') throw new TaskClaimConflict('TASK_CLAIM_INVALIDATED');
            const decision = evaluateOfferAcceptance({
              eligibility: { state: 'qualified' },
              validity,
              acquire: {
                current: latest ? toDomainLease(latest) : undefined,
                taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
                nodeKind: coordination.nodeKind,
                agentId: offer.agentId, leaseTokenHash, leaseFingerprint,
                ancestorAgentIds: resolution.ancestorAgentIds, now, ttlMs: leaseTtlMs,
              },
            });
            if (decision.kind === 'not_accepted') {
              // 到达此处时 validity/eligibility 已预检通过，剩余 not_accepted 通常为 claim_rejected
              // （evaluateTaskClaimAcquire 因 invalid-claim-state/clock-regressed/fencing-overflow 拒绝）。
              // 经 TaskClaimConflict.offerReason 携带 reason，避免被 catch 一律映射成 offer_invalid。
              throw new TaskClaimConflict(
                decision.acquireRejection
                  ? `TASK_CLAIM_${code(decision.acquireRejection)}`
                  : 'TASK_CLAIM_OFFER_INVALID',
                decision.reason,
              );
            }
            if (decision.kind === 'overtaken') {
              // active-claim-held：他 Agent 已持 lease。标 overtaken（CAS 失败=已终态则忽略）。
              await repositories.coordination.offers.updateStatus({
                id: offer.id, expectedStatus: 'open', status: 'overtaken', response: acceptedResponse, now,
              });
              return { overtaken: true } as const;
            }
            // decision.kind === 'claim_granted'：CAS offer→accepted（AC#4：与 lease 同事务，任一失败整体回滚）
            const accepted = await repositories.coordination.offers.updateStatus({
              id: offer.id, expectedStatus: 'open', status: 'accepted', response: acceptedResponse, now,
            });
            if (!accepted) throw new TaskClaimConflict('TASK_CLAIM_OFFER_OVERTAKEN');
            // 以下 lease 落库 + events + task 更新镜像 acquire() 的 grant 块（AC#4 同事务）。
            // 抽取共享 helper 属后续重构——此处内联以保持既有 acquire 路径零改动、降低回归风险。
            if (latest?.status === 'active') {
              const expired = await repositories.coordination.claimLeases.update({
                id: latest.id, expectedStatus: 'active', status: 'expired',
                heartbeatAt: latest.heartbeatAt, expiresAt: latest.expiresAt,
              });
              if (!expired) throw new TaskClaimConflict('TASK_CLAIM_EXPIRE_CONFLICT');
              // #925 P1-b：旧 lease 时间过期但 expireClaims 未扫时被内联过期——同事务撤销其绑定
              // active grant，避免与同 (taskId, taskAttempt) 新 grant 撞唯一索引（sqlite）或双 active grant（memory）。
              for (const grant of await repositories.coordination.executionGrants.listActiveByClaimLease(latest.id)) {
                await repositories.coordination.executionGrants.revoke({
                  id: grant.id, reason: 'claim-expired', revokedAt: now, now,
                });
              }
            }
            const leaseId = input.ids.nextId();
            const lease: TaskClaimLeaseRecord = {
              id: leaseId, teamId: task.teamId, taskId: task.id,
              taskRevision: task.revision, taskAttempt: coordination.attempt, agentId: offer.agentId,
              leaseTokenHash, leaseFingerprint, fencingToken: decision.lease.fencingToken,
              status: 'active', acquiredAt: decision.lease.acquiredAt,
              heartbeatAt: decision.lease.renewedAt, expiresAt: decision.lease.expiresAt,
            };
            await repositories.coordination.claimLeases.create(lease);
            // #966：claim 时冻结频道当前 workspace revision，写入 grant 供 Agent 读取固定输入版本（AC#1）。
            // 经 input.repositories 读（快照读取，无需与 claim 同事务）；transaction 内 repositories 无此 repo。
            const workspaceRevisionId = task.channelId
              ? (await input.repositories.projectChannelWorkspaces.getForTeam({ teamId: task.teamId, channelId: task.channelId }))?.currentRevisionId
              : undefined;
            const grantDecision = evaluateExecutionGrantIssuance({
              teamId: task.teamId,
              managementRunId: coordination.managementRunId,
              taskId: task.id,
              taskRevision: task.revision,
              taskAttempt: coordination.attempt,
              claimLeaseId: lease.id,
              agentId: offer.agentId,
              manifestRevision: offer.manifestRevision,
              workspaceRevisionId,
              nodeKind: coordination.nodeKind,
              grantedAt: now,
            });
            if (grantDecision.kind !== 'issued') {
              throw new TaskClaimConflict('TASK_CLAIM_GRANT_REFUSED');
            }
            const grantId = input.ids.nextId();
            await repositories.coordination.executionGrants.create({
              id: grantId, ...grantDecision.grant,
            });
            await appendTaskClaimEvent(repositories.management, {
              managementRunId: coordination.managementRunId, type: 'task-claimed',
              actorKind: 'agent', actorId: offer.agentId,
              idempotencyKey: `task-claimed:${lease.id}`,
              payload: { taskId: task.id, taskRevision: task.revision, agentId: offer.agentId,
                claimLeaseId: lease.id, attempt: coordination.attempt },
            }, now, input.ids);
            if (task.status === 'todo' || task.assigneeId !== offer.agentId) {
              const updated = await repositories.tasks.update({ taskId: task.id,
                changes: { ...(task.status === 'todo' ? { status: 'in_progress' as const } : {}),
                  assigneeId: offer.agentId, updatedAt: now } });
              if (!updated) throw new TaskClaimConflict('TASK_CLAIM_TASK_UPDATE_CONFLICT');
            }
            if (task.status === 'todo') {
              await appendTaskClaimEvent(repositories.management, {
                managementRunId: coordination.managementRunId, type: 'task-state-changed',
                actorKind: 'agent', actorId: offer.agentId,
                idempotencyKey: `task-state-changed:${lease.id}`,
                payload: { taskId: task.id, taskRevision: task.revision, from: 'todo', to: 'in_progress' },
              }, now, input.ids);
            }
            const criteria = (await repositories.coordination.criteria.list(task.id))
              .filter((criterion) => criterion.introducedRevision <= task.revision &&
                (criterion.retiredRevision === undefined || criterion.retiredRevision > task.revision))
              .sort((left, right) => left.position - right.position)
              .map(({ taskId: _taskId, introducedRevision: _introducedRevision,
                retiredRevision: _retiredRevision, position: _position, ...criterion }) => criterion);
            const dependencyTaskIds = (await repositories.coordination.dependencies.list(task.id))
              .map((dependency) => dependency.dependencyTaskId);
            return { lease, task, coordination, criteria, dependencyTaskIds, grantId, workspaceRevisionId };
          });
          if ('overtaken' in result) return { kind: 'overtaken' };
          const response = {
            kind: 'claim_granted',
            lease: authority(result.lease, leaseToken),
            execution: {
              schemaVersion: 1, managementRunId: result.coordination.managementRunId,
              taskId: result.task.id, taskRevision: result.task.revision,
              taskAttempt: result.coordination.attempt, grantId: result.grantId,
              ...(result.workspaceRevisionId ? { workspaceRevisionId: result.workspaceRevisionId } : {}),
              title: result.task.title,
              objective: result.task.description ?? result.task.title,
              acceptanceCriteria: result.criteria, dependencyTaskIds: result.dependencyTaskIds,
              ...(result.task.channelId ? { channelId: result.task.channelId } : {}),
            },
          } satisfies TaskOfferRespondResult;
          if (offer.objective.constraints.includes(PROJECT_STAGE_AUTO_CONSTRAINT)) {
            await notifyProjectStageClaimGranted(onProjectStageClaimGranted, {
              managementRunId: result.coordination.managementRunId,
              taskId: result.task.id,
              taskRevision: result.task.revision,
              taskAttempt: result.coordination.attempt,
              claimLeaseId: result.lease.id,
              targetAgentId: result.lease.agentId,
              objective: result.task.description ?? result.task.title,
            });
          }
          return response;
        } catch (error) {
          if (error instanceof TaskClaimConflict) {
            if (error.message === 'TASK_CLAIM_OFFER_OVERTAKEN') return { kind: 'overtaken' };
            return {
              kind: 'not_accepted',
              reason: error.offerReason ?? 'offer_invalid',
              diagnosticCode: error.message,
            };
          }
          throw error;
        }
      });
    },
    bindProjectStageClaimGranted(handler) {
      onProjectStageClaimGranted = handler;
    },
  };

  async function expireClaims(): Promise<readonly TaskClaimExpiredV1[]> {
    const now = input.clock.now();
    for (const [offerId, offer] of offers) if (now >= offer.offerExpiresAt) offers.delete(offerId);
    return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
      const expired: TaskClaimExpiredV1[] = [];
      for (const lease of await repositories.coordination.claimLeases.listActive()) {
        if (now < lease.expiresAt) continue;
        const updated = await repositories.coordination.claimLeases.update({
          id: lease.id, expectedStatus: 'active', status: 'expired',
          heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt,
        });
        if (!updated) continue;
        // #925：lease 过期 → 绑定 execution context grant 同事务撤销（claim-expired）。
        for (const grant of await repositories.coordination.executionGrants.listActiveByClaimLease(lease.id)) {
          await repositories.coordination.executionGrants.revoke({
            id: grant.id, reason: 'claim-expired', revokedAt: now, now,
          });
        }
        expired.push({ schemaVersion: 1, claimLeaseId: lease.id,
          taskId: lease.taskId, agentId: lease.agentId, expiredAt: now });
        const task = await repositories.tasks.getById(lease.taskId);
        const coordination = await repositories.coordination.coordinations.getByTaskId(lease.taskId);
        if (!task || !coordination || task.status !== 'in_progress'
          || task.revision !== lease.taskRevision
          || coordination.taskRevision !== lease.taskRevision
          || coordination.attempt !== lease.taskAttempt) continue;
        const reopened = await repositories.tasks.update({ taskId: task.id,
          changes: { status: 'todo', updatedAt: now } });
        if (!reopened) throw new TaskClaimConflict('TASK_CLAIM_TASK_UPDATE_CONFLICT');
        await appendTaskClaimEvent(repositories.management, {
          managementRunId: coordination.managementRunId,
          type: 'task-state-changed', actorKind: 'system', actorId: 'system',
          idempotencyKey: `task-claim-expired:${lease.id}:state`,
          payload: { taskId: task.id, taskRevision: task.revision,
            from: 'in_progress', to: 'todo' },
        }, now, input.ids);
        const invalidatedInvocationIds = (await repositories.management.invocations
          .listByRun(coordination.managementRunId))
          .filter((invocation) => invocation.intent.taskContext?.claimLeaseId === lease.id)
          .map((invocation) => invocation.id).sort();
        await appendTaskClaimEvent(repositories.management, {
          managementRunId: coordination.managementRunId,
          type: 'claim-invalidated', actorKind: 'system', actorId: 'system',
          idempotencyKey: `task-claim-expired:${lease.id}:invalidated`,
          payload: { taskId: task.id, previousTaskRevision: task.revision,
            claimLeaseId: lease.id, invalidatedInvocationIds,
            reasonCode: 'TASK_CLAIM_EXPIRED' },
        }, now, input.ids);
      }
      return expired;
    });
  }
}

async function notifyProjectStageClaimGranted(
  handler: ((claim: ProjectStageClaimGranted) => Promise<void>) | undefined,
  claim: ProjectStageClaimGranted,
): Promise<void> {
  if (!handler) return;
  try {
    await handler(claim);
  } catch {
    // Claim 已提交，不能因后续派发失败伪装成 Agent 接受失败；后续重算仍会看到待创建 Invocation。
  }
}

async function collectAncestorAgentIds(
  taskId: string,
  repositories: ServerNextRepositories,
  now: number,
): Promise<string[]> {
  const result = new Set<string>();
  const visited = new Set<string>();
  let current = await repositories.taskCoordination.coordinations.getByTaskId(taskId);
  while (current?.parentTaskId && !visited.has(current.parentTaskId)) {
    visited.add(current.parentTaskId);
    const parent = await repositories.taskCoordination.coordinations.getByTaskId(current.parentTaskId);
    if (!parent) break;
    const claim = await repositories.taskCoordination.claimLeases.getLatest({
      taskId: parent.taskId, taskRevision: parent.taskRevision, taskAttempt: parent.attempt,
    });
    if (claim?.status === 'active' && claim.expiresAt > now) result.add(claim.agentId);
    const task = await repositories.tasks.getById(parent.taskId);
    if (task?.assigneeId) result.add(task.assigneeId);
    current = parent;
  }
  return [...result].sort();
}

function channelAllowsAgent(
  channel: Awaited<ReturnType<ServerNextRepositories['channels']['getById']>> | undefined | null,
  agentId: string,
): boolean {
  return !channel || channel.visibility === 'public' || channel.agentMemberIds.includes(agentId);
}

/**
 * #712 切片 C-1：计算 Offer 当前有效性（AC#1 fence + AC#5 失效前置判定）。
 * currentTaskRevision/manifestRevision 在事务外读取——轻微竞态可接受：UoW 内 lease grant
 * 会再次校验 task.revision===offer.taskRevision（STALE），manifest 变化由 CAS 状态机兜底。
 * task 或 active manifest 缺失 → 用 NaN 使 fence 比对失败（判 task_revision_changed / manifest_superseded）。
 */
async function computeOfferValidity(
  repositories: ServerNextRepositories,
  offer: TaskOfferRecord,
  now: number,
): Promise<OfferValidity> {
  const task = await repositories.tasks.getById(offer.taskId);
  const activeManifest = await repositories.agentExposure.manifests.getActiveByTeamAgent(offer.teamId, offer.agentId);
  const manifestRevision = activeManifest && (activeManifest.validUntil === null || activeManifest.validUntil > now)
    ? activeManifest.revision
    // #947 PR2：确认 Offer（manifestRevision=0 sentinel）无 active manifest 时不应判 superseded——
    //   没有 manifest 可比，Agent 未更新 Manifest（仍 unknown）→ 确认 Offer 仍有效。
    //   Agent 后续发布 manifest revision≥1 → 0≠rev → 正确触发 superseded（ADR path-a）。
    : (offer.manifestRevision === 0 ? 0 : Number.NaN);
  return evaluateOfferValidity({
    status: offer.status,
    offerExpiresAt: offer.offerExpiresAt,
    offerTaskRevision: offer.taskRevision,
    offerManifestRevision: offer.manifestRevision,
    now,
    currentTaskRevision: task?.revision ?? Number.NaN,
    currentManifestRevision: manifestRevision,
  });
}

function offerValidityCode(reason: OfferInvalidationReason): string {
  switch (reason) {
    case 'expired': return 'TASK_CLAIM_OFFER_EXPIRED';
    case 'task_revision_changed': return 'TASK_CLAIM_OFFER_TASK_REVISION_CHANGED';
    case 'manifest_superseded': return 'TASK_CLAIM_OFFER_MANIFEST_SUPERSEDED';
    case 'not_open': return 'TASK_CLAIM_OFFER_NOT_OPEN';
  }
}

async function resolveProjectStageOfferFence(
  repositories: ServerNextRepositories,
  task: TaskRecord,
): Promise<{
  value: string;
  requiresProjectDocumentInputSetV1: boolean;
} | null> {
  const stable = await resolveProjectStageStableInputs(repositories, task);
  if (!stable.stageId
    || stable.satisfiedRuleKeys.length !== stable.requiredRuleCount) return null;
  return {
    value: `${PROJECT_STAGE_FENCE_PREFIX}${JSON.stringify({
      stageId: stable.stageId,
      inputs: stable.inputs,
    })}`,
    requiresProjectDocumentInputSetV1: stable.inputs
      .some((item) => item.kind === 'document_revision'),
  };
}

async function projectStageAutoOfferStillCurrent(
  input: CreateTaskClaimBrokerInput,
  offer: TaskOfferRecord,
  now: number,
): Promise<boolean> {
  const validity = await computeOfferValidity(input.repositories, offer, now);
  if (!validity.acceptable) return false;
  const task = await input.repositories.tasks.getById(offer.taskId);
  const coordination = await input.repositories.taskCoordination.coordinations
    .getByTaskId(offer.taskId);
  if (!task || !coordination) return false;
  const currentFence = await resolveProjectStageOfferFence(input.repositories, task);
  const [policy, piHealthy, gate, strictAgentIds] = await Promise.all([
    input.repositories.teamPiPolicy.getOrDefault(task.teamId),
    input.piHealthy?.() ?? Promise.resolve(false),
    resolveProjectStageExecutionGate(input.repositories, task),
    filterStrictProjectStageAgentIds(input.repositories, {
      teamId: task.teamId,
      candidateAgentIds: [offer.agentId],
      requiredCapabilities: coordination.requiredCapabilities,
      ...(currentFence?.requiresProjectDocumentInputSetV1
        ? { requiredProjectDocumentInputSetVersion: 1 }
        : {}),
      now,
    }),
  ]);
  const frozenFence = offer.objective.inputs
    .find((item) => item.startsWith(PROJECT_STAGE_FENCE_PREFIX));
  return policy.autoCoordinationEnabled
    && piHealthy
    && !gate.blocked
    && strictAgentIds.length === 1
    && currentFence !== null
    && frozenFence === currentFence.value;
}

function toDomainLease(lease: TaskClaimLeaseRecord): DomainTaskClaimLeaseRecord {
  return {
    taskId: lease.taskId, taskRevision: lease.taskRevision, taskAttempt: lease.taskAttempt,
    agentId: lease.agentId, leaseTokenHash: lease.leaseTokenHash,
    leaseFingerprint: lease.leaseFingerprint, fencingToken: lease.fencingToken,
    acquiredAt: lease.acquiredAt, renewedAt: lease.heartbeatAt, expiresAt: lease.expiresAt,
    ...(lease.releasedAt !== undefined ? { releasedAt: lease.releasedAt } : {}),
  };
}

function proof(authority: TaskClaimAuthorityV1) {
  return {
    taskId: authority.taskId, taskRevision: authority.taskRevision,
    taskAttempt: authority.taskAttempt, agentId: authority.agentId,
    presentedLeaseTokenHash: hash(authority.leaseToken), fencingToken: authority.fencingToken,
  };
}

function authority(lease: TaskClaimLeaseRecord, token: string): TaskClaimAuthorityV1 & {
  readonly acquiredAt: number; readonly expiresAt: number;
} {
  return {
    schemaVersion: 1, claimLeaseId: lease.id, taskId: lease.taskId,
    taskRevision: lease.taskRevision, taskAttempt: lease.taskAttempt,
    agentId: lease.agentId, leaseToken: token, fencingToken: lease.fencingToken,
    acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt,
  };
}

function failure(
  errorCode: TaskClaimFailureAckV1['errorCode'],
  diagnosticCode: string,
  retryable: boolean,
): TaskClaimFailureAckV1 {
  return { schemaVersion: 1, ok: false, errorCode, diagnosticCode, retryable };
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function code(value: string): string { return value.replaceAll('-', '_').toUpperCase(); }
function positiveDuration(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(errorCode);
  return value;
}
function consumeTaskOffers(offers: Map<string, StoredOffer>, taskId: string): void {
  for (const [offerId, offer] of offers) if (offer.taskId === taskId) offers.delete(offerId);
}

async function appendTaskClaimEvent(
  repositories: ServerNextRepositories['management'],
  event: Parameters<typeof appendValidatedManagementEventInTransaction>[1],
  now: number,
  ids: { nextId(): string },
): Promise<void> {
  await appendValidatedManagementEventInTransaction(repositories, event, now, ids, {
    payloadHash: hashManagementEventPayload({ type: event.type, payload: event.payload }),
    parseEvent: parseTaskCoordinationManagementEvent,
  });
}

async function withTaskLock<T>(
  taskId: string,
  tails: Map<string, Promise<void>>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(taskId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(taskId) === tail) tails.delete(taskId);
  }
}

class TaskClaimConflict extends Error {
  constructor(
    message: string,
    /** #712：respondToOffer not_accepted 时携带 domain reason（claim_rejected 等），供 catch 保留区分。 */
    readonly offerReason?: 'offer_invalid' | 'agent_not_qualified' | 'claim_rejected',
  ) {
    super(message);
  }
}
