import { createHash } from 'node:crypto';
import type {
  AutoPlacementResolutionDto,
  ManagementBudgetDto,
  ManagementMode,
  ManagerPlacementPolicyDto,
} from '../../../../../packages/contracts/src/index.js';
import {
  clampManagementBudgetOverrides,
  evaluateManagementRoute,
  mergeManagementBudget,
  resolveAutoPlacement,
  type ManagementBudgetOverridesInput,
  type ManagementPreflight,
} from '../../../../../packages/domain/src/index.js';
import type { AgentRecord, ServerNextRepositories } from '../repositories.js';
import type { ManagementPolicyRecord } from '../management-repositories.js';
import type { createManagementKernel } from './management-kernel.js';

type ManagementKernel = ReturnType<typeof createManagementKernel>;

const DEFAULT_PLACEMENT_POLICY: ManagerPlacementPolicyDto = {
  placement: 'device',
  allowServerContext: false,
  requireLocalModelCredentials: true,
};

const PHASE_1_BUDGET: ManagementBudgetDto = {
  maxSubtasks: 1,
  maxDepth: 1,
  maxExternalInvocations: 1,
};

const PHASE_2_BUDGET: ManagementBudgetDto = {
  maxSubtasks: 20,
  maxDepth: 3,
  maxExternalInvocations: 20,
};

export interface ManagementRoutingGateway {
  preflight(input: {
    teamId: string;
    target: AgentRecord;
    placementPolicy: ManagerPlacementPolicyDto;
  }): Promise<ManagementPreflight>;
  preflightPhase2?(input: {
    teamId: string;
    target: AgentRecord | null;
    placementPolicy: ManagerPlacementPolicyDto;
  }): Promise<{ preflight: ManagementPreflight; profileId?: string }>;
  preflightPhase3?(input: {
    teamId: string;
    target: AgentRecord | null;
    placementPolicy: ManagerPlacementPolicyDto;
  }): Promise<{ preflight: ManagementPreflight; profileId?: string }>;
  /**
   * auto placement 的可用性探测（#647）：返回 device/server 两侧的布尔级可用信号。
   * 未装配时 router fail closed（按两侧全不可用处理，绝不乱猜）。
   */
  probeAutoPlacement?(input: {
    teamId: string;
    placementPolicy: ManagerPlacementPolicyDto;
    managementPhase: 1 | 2 | 3;
  }): Promise<{ deviceAvailable: boolean; serverAvailable: boolean }>;
  schedule(input: { managementRunId: string; profileId: string }): Promise<{
    ok: boolean;
    diagnosticCode?: string;
  }>;
}

export type ManagementRoutingResult =
  | { kind: 'direct'; mode: 'direct' | 'shadow'; shadowRequestKey?: string }
  | {
      kind: 'managed';
      mode: 'managed';
      managementRunId: string;
      profileId: string;
      disposition: 'created' | 'existing';
      managementPhase: 1 | 2 | 3;
      schedulingDiagnostic?: string;
    }
  | { kind: 'unavailable'; mode: 'managed'; diagnostics: readonly string[] };

export interface ManagementRouterDependencies {
  repositories: ServerNextRepositories;
  kernel: ManagementKernel;
  gateway?: ManagementRoutingGateway;
  clock: { now(): number };
  ids: { nextId(): string };
}

export function createManagementRouter(dependencies: ManagementRouterDependencies) {
  const { repositories, kernel, clock } = dependencies;

  // #647：auto placement 解析决定随 run 落审计（仅 run 创建时一次；幂等重放不重复写）。
  // 用 action='access' + diagnosticCode 携带理由码，避开审计表 action CHECK 约束的表重建 migration。
  async function recordAutoPlacementAudit(
    input: { userId: string; teamId: string },
    created: { run: { id: string }; disposition: 'created' | 'existing' },
    autoPlacement: AutoPlacementResolutionDto | undefined,
  ): Promise<void> {
    if (!autoPlacement || created.disposition !== 'created') return;
    await repositories.management.accessAudits.append({
      id: dependencies.ids.nextId(),
      managementRunId: created.run.id,
      userId: input.userId,
      teamId: input.teamId,
      scopeType: 'management',
      scopeId: created.run.id,
      action: 'access',
      decision: 'allowed',
      diagnosticCode: `AUTO_PLACEMENT_${autoPlacement.reasonCode.toUpperCase().replace(/-/g, '_')}`,
      createdAt: clock.now(),
    });
  }

  async function policyForTeam(teamId: string): Promise<ManagementPolicyRecord> {
    return (await repositories.management.policies.get(teamId)) ?? {
      schemaVersion: 2,
      teamId,
      mode: 'direct',
      maxManagementPhase: 1,
      placementPolicy: DEFAULT_PLACEMENT_POLICY,
      updatedBy: '',
      updatedAt: 0,
    };
  }

  return {
    async getPolicy(input: { userId: string; teamId: string }) {
      const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
      if (!role) return { ok: false as const, error: 'FORBIDDEN' };
      return { ok: true as const, policy: await policyForTeam(input.teamId), canManage: role === 'owner' || role === 'admin' };
    },

    async updatePolicy(input: {
      userId: string;
      teamId: string;
      mode: ManagementMode;
      maxManagementPhase?: 1 | 2 | 3;
      placementPolicy?: ManagerPlacementPolicyDto;
      budgetOverrides?: ManagementBudgetOverridesInput;
    }) {
      const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
      if (role !== 'owner' && role !== 'admin') return { ok: false as const, error: 'FORBIDDEN' };
      if (!isManagementMode(input.mode)) return { ok: false as const, error: 'VALIDATION_ERROR' };
      if (input.maxManagementPhase !== undefined && input.maxManagementPhase !== 1 && input.maxManagementPhase !== 2 && input.maxManagementPhase !== 3) {
        return { ok: false as const, error: 'VALIDATION_ERROR' };
      }
      const currentPolicy = await policyForTeam(input.teamId);
      const placementPolicy = normalizePlacementPolicy(input.placementPolicy ?? DEFAULT_PLACEMENT_POLICY);
      if (!placementPolicy) return { ok: false as const, error: 'VALIDATION_ERROR' };
      // #648 预算覆盖：传入即整体钳制（非法 → VALIDATION_ERROR 不留半个覆盖）；未传保留既有。
      let budgetOverrides = currentPolicy.budgetOverrides;
      if (input.budgetOverrides !== undefined) {
        const clamped = clampManagementBudgetOverrides(input.budgetOverrides);
        if (clamped === null) return { ok: false as const, error: 'VALIDATION_ERROR' };
        budgetOverrides = clamped;
      }
      const maxManagementPhase = input.maxManagementPhase ?? currentPolicy.maxManagementPhase;
      if (placementPolicy.placement === 'managed'
        && (input.mode !== 'managed' || maxManagementPhase < 2)) {
        return { ok: false as const, error: 'VALIDATION_ERROR' };
      }
      if (input.mode === 'managed' && placementPolicy.placement === 'device'
        && !placementPolicy.allowedDeviceIds?.length) {
        return { ok: false as const, error: 'VALIDATION_ERROR' };
      }
      for (const deviceId of placementPolicy.allowedDeviceIds ?? []) {
        const device = await repositories.devices.getById(deviceId);
        if (!device || device.teamId !== input.teamId) return { ok: false as const, error: 'VALIDATION_ERROR' };
      }
      const policy = await repositories.management.policies.upsert({
        schemaVersion: 2,
        teamId: input.teamId,
        mode: input.mode,
        maxManagementPhase,
        placementPolicy,
        ...(budgetOverrides ? { budgetOverrides } : {}),
        updatedBy: input.userId,
        updatedAt: clock.now(),
      });
      return { ok: true as const, policy, canManage: true as const };
    },

    async route(input: {
      userId: string;
      teamId: string;
      channelId: string;
      rootMessageId: string;
      rootTaskId?: string;
      clientMessageId?: string;
      body: string;
      targetAgentId?: string;
    }): Promise<ManagementRoutingResult> {
      const policy = await policyForTeam(input.teamId);
      if (policy.mode === 'direct') return { kind: 'direct', mode: 'direct' };

      const target = input.targetAgentId
        ? await repositories.agents.getById(input.targetAgentId)
        : null;
      if (policy.mode === 'shadow') {
        const shadowRequestKey = `shadow:${requestKey(input)}`;
        return {
          kind: 'direct',
          mode: 'shadow',
          shadowRequestKey,
        };
      }

      // Phase 2/3 orchestration is rooted in a Task. A plain channel @mention
      // without a Task remains the established direct Agent message path; it
      // must not enter the rooted management preflight and fail validation.
      if (policy.maxManagementPhase >= 2 && target && !input.rootTaskId?.trim()) {
        return { kind: 'direct', mode: 'direct' };
      }

      // #647 auto placement：建 run 前解析一次，resolved placement 替换 policy 值并随 run 冻结；
      // 之后守卫、preflight、createOrResumeRun、恢复与审计全部消费 resolved 值，不再感知 auto。
      let placementPolicy = policy.placementPolicy;
      let autoPlacement: AutoPlacementResolutionDto | undefined;
      if (placementPolicy.placement === 'auto') {
        // 幂等重放（requestKey 已有 reservation）跳过解析：解析只发生一次，
        // probe 状态漂移不改变已有 run。但下行守卫/preflight/schedule 必须消费
        // 冻结值而非 auto 原值——用 reservation 取出 run 的 placementPolicy 替换。
        const existingReservation = await repositories.management.reservations.getByRequestKey({
          teamId: input.teamId,
          requestKey: requestKey(input),
        });
        if (existingReservation) {
          const existingRun = await repositories.management.runs.getById(existingReservation.managementRunId);
          if (existingRun) {
            placementPolicy = existingRun.placementPolicy;
          }
        } else {
          const probe = await dependencies.gateway?.probeAutoPlacement?.({
            teamId: input.teamId,
            placementPolicy,
            managementPhase: policy.maxManagementPhase,
          }) ?? { deviceAvailable: false, serverAvailable: false };
          const resolution = resolveAutoPlacement({
            allowServerContext: placementPolicy.allowServerContext,
            deviceAvailable: probe.deviceAvailable,
            serverAvailable: probe.serverAvailable,
          });
          if (!resolution.ok) {
            return {
              kind: 'unavailable',
              mode: 'managed',
              diagnostics: [`AUTO_PLACEMENT_${resolution.reasonCode.toUpperCase().replace(/-/g, '_')}`],
            };
          }
          autoPlacement = { resolvedPlacement: resolution.placement, reasonCode: resolution.reasonCode };
          const preferred = {
            ...(placementPolicy.preferredProvider ? { preferredProvider: placementPolicy.preferredProvider } : {}),
            ...(placementPolicy.preferredModel ? { preferredModel: placementPolicy.preferredModel } : {}),
          };
          placementPolicy = resolution.placement === 'managed'
            // 与 normalizePlacementPolicy 的 managed 约束形状一致。
            ? { placement: 'managed', allowServerContext: true, requireLocalModelCredentials: false, ...preferred }
            : { placement: 'device',
                ...(placementPolicy.allowedDeviceIds?.length ? { allowedDeviceIds: placementPolicy.allowedDeviceIds } : {}),
                allowServerContext: placementPolicy.allowServerContext,
                requireLocalModelCredentials: placementPolicy.requireLocalModelCredentials,
                ...preferred };
        }
      }

      if (placementPolicy.placement === 'managed'
        && (!input.rootTaskId?.trim() || target)) {
        return { kind: 'direct', mode: 'direct' };
      }

      if (policy.maxManagementPhase === 3) {
        const diagnostics: string[] = [];
        if (!input.clientMessageId?.trim()) diagnostics.push('MANAGEMENT_CLIENT_MESSAGE_ID_REQUIRED');
        if (!input.rootTaskId?.trim()) diagnostics.push('MANAGEMENT_PHASE_2_ROOT_TASK_REQUIRED');
        if (diagnostics.length > 0 || !input.rootTaskId) {
          return { kind: 'unavailable', mode: 'managed', diagnostics };
        }
        const phase3 = await dependencies.gateway?.preflightPhase3?.({
          teamId: input.teamId,
          target,
          placementPolicy,
        }) ?? { preflight: unavailablePreflight() };
        const decision = evaluateManagementRoute({
          requestId: requestKey(input),
          mode: 'managed',
          requestShape: 'multi-agent',
          allowDirectFallbackBeforeBarrier: false,
          preflight: phase3.preflight,
          barrier: { idempotencyReserved: false, persistedEffects: [] },
        });
        if (decision.kind !== 'managed-preflight-passed' || !phase3.profileId) {
          return {
            kind: 'unavailable',
            mode: 'managed',
            diagnostics: decision.kind === 'unavailable'
              ? decision.missingPreflight.map((item) => `MANAGEMENT_PHASE_2_PREFLIGHT_${item.toUpperCase()}_MISSING`)
              : ['MANAGEMENT_PHASE_2_WORKER_PROFILE_UNAVAILABLE'],
          };
        }
        const created = await kernel.createOrResumeRun({
          teamId: input.teamId,
          initiatedByUserId: input.userId,
          channelId: input.channelId,
          rootTaskId: input.rootTaskId,
          rootMessageId: input.rootMessageId,
          ...(target ? { frozenTarget: {
            agentId: target.id,
            kind: target.category === 'agentos-hosted' ? 'agentos-hosted' : 'custom',
          } } : {}),
          requestKey: requestKey(input),
          requestHash: hash({ body: input.body, targetAgentId: target?.id ?? null,
            channelId: input.channelId, rootTaskId: input.rootTaskId, managementPhase: 3 }),
          placementPolicy,
          budget: mergeManagementBudget(PHASE_2_BUDGET, policy.budgetOverrides),
          managementPhase: 3,
          ...(autoPlacement ? { autoPlacement } : {}),
        });
        await recordAutoPlacementAudit(input, created, autoPlacement);
        // #657 并发首建：本地新 resolve 但拿到 existing run（对方先建）且冻结值不同向时，
        // 必须按冻结值重做 preflight——否则 schedule 按冻结值分流会拿错 profileId。
        let profileId3 = phase3.profileId;
        if (autoPlacement && created.disposition === 'existing'
          && created.run.placementPolicy.placement !== placementPolicy.placement) {
          const frozen = await dependencies.gateway?.preflightPhase3?.({
            teamId: input.teamId, target, placementPolicy: created.run.placementPolicy,
          });
          // 拿不到冻结侧 profileId 时 fail closed（不拿本地解析的错配值）；
          // run 由先建方的 schedule 或后续 resume 推进。
          if (!frozen?.profileId) {
            return { kind: 'unavailable', mode: 'managed',
              diagnostics: ['AUTO_PLACEMENT_FROZEN_PREFLIGHT_UNAVAILABLE'] };
          }
          profileId3 = frozen.profileId;
        }
        return {
          kind: 'managed', mode: 'managed', managementPhase: 3,
          managementRunId: created.run.id, profileId: profileId3,
          disposition: created.disposition,
        };
      }

      if (policy.maxManagementPhase === 2) {
        const diagnostics: string[] = [];
        if (!input.clientMessageId?.trim()) diagnostics.push('MANAGEMENT_CLIENT_MESSAGE_ID_REQUIRED');
        if (!input.rootTaskId?.trim()) diagnostics.push('MANAGEMENT_PHASE_2_ROOT_TASK_REQUIRED');
        if (diagnostics.length > 0 || !input.rootTaskId) {
          return { kind: 'unavailable', mode: 'managed', diagnostics };
        }
        const phase2 = await dependencies.gateway?.preflightPhase2?.({
          teamId: input.teamId,
          target,
          placementPolicy,
        }) ?? { preflight: unavailablePreflight() };
        const decision = evaluateManagementRoute({
          requestId: requestKey(input),
          mode: 'managed',
          requestShape: 'multi-agent',
          allowDirectFallbackBeforeBarrier: false,
          preflight: phase2.preflight,
          barrier: { idempotencyReserved: false, persistedEffects: [] },
        });
        if (decision.kind !== 'managed-preflight-passed' || !phase2.profileId) {
          return {
            kind: 'unavailable',
            mode: 'managed',
            diagnostics: decision.kind === 'unavailable'
              ? decision.missingPreflight.map((item) => `MANAGEMENT_PHASE_2_PREFLIGHT_${item.toUpperCase()}_MISSING`)
              : ['MANAGEMENT_PHASE_2_WORKER_PROFILE_UNAVAILABLE'],
          };
        }
        const created = await kernel.createOrResumeRun({
          teamId: input.teamId,
          initiatedByUserId: input.userId,
          channelId: input.channelId,
          rootTaskId: input.rootTaskId,
          rootMessageId: input.rootMessageId,
          ...(target ? { frozenTarget: {
            agentId: target.id,
            kind: target.category === 'agentos-hosted' ? 'agentos-hosted' : 'custom',
          } } : {}),
          requestKey: requestKey(input),
          requestHash: hash({ body: input.body, targetAgentId: target?.id ?? null,
            channelId: input.channelId, rootTaskId: input.rootTaskId, managementPhase: 2 }),
          placementPolicy,
          budget: mergeManagementBudget(PHASE_2_BUDGET, policy.budgetOverrides),
          managementPhase: 2,
          ...(autoPlacement ? { autoPlacement } : {}),
        });
        await recordAutoPlacementAudit(input, created, autoPlacement);
        // #657 并发首建：同 phase 3 分支的冻结值重算。
        let profileId2 = phase2.profileId;
        if (autoPlacement && created.disposition === 'existing'
          && created.run.placementPolicy.placement !== placementPolicy.placement) {
          const frozen = await dependencies.gateway?.preflightPhase2?.({
            teamId: input.teamId, target, placementPolicy: created.run.placementPolicy,
          });
          if (!frozen?.profileId) {
            return { kind: 'unavailable', mode: 'managed',
              diagnostics: ['AUTO_PLACEMENT_FROZEN_PREFLIGHT_UNAVAILABLE'] };
          }
          profileId2 = frozen.profileId;
        }
        return {
          kind: 'managed', mode: 'managed', managementPhase: 2,
          managementRunId: created.run.id, profileId: profileId2,
          disposition: created.disposition,
        };
      }

      const diagnostics: string[] = [];
      if (!input.clientMessageId?.trim()) diagnostics.push('MANAGEMENT_CLIENT_MESSAGE_ID_REQUIRED');
      if (!target) diagnostics.push('MANAGEMENT_EXPLICIT_TARGET_REQUIRED');
      const device = target?.deviceId ? await repositories.devices.getById(target.deviceId) : null;
      if (!device?.profileId) diagnostics.push('MANAGEMENT_TARGET_PROFILE_UNAVAILABLE');
      if (diagnostics.length > 0 || !target || !device?.profileId) {
        return { kind: 'unavailable', mode: 'managed', diagnostics };
      }

      const gateway = dependencies.gateway;
      const preflight = gateway
        ? await gateway.preflight({ teamId: input.teamId, target, placementPolicy })
        : unavailablePreflight();
      const decision = evaluateManagementRoute({
        requestId: requestKey(input),
        mode: 'managed',
        requestShape: 'single-agent',
        allowDirectFallbackBeforeBarrier: false,
        preflight,
        barrier: { idempotencyReserved: false, persistedEffects: [] },
      });
      if (decision.kind !== 'managed-preflight-passed') {
        return {
          kind: 'unavailable',
          mode: 'managed',
          diagnostics: decision.kind === 'unavailable'
            ? decision.missingPreflight.map((item) => `MANAGEMENT_PREFLIGHT_${item.toUpperCase()}_MISSING`)
            : ['MANAGEMENT_ROUTE_UNAVAILABLE'],
        };
      }

      const created = await kernel.createOrResumeRun({
        teamId: input.teamId,
        initiatedByUserId: input.userId,
        channelId: input.channelId,
        ...(input.rootTaskId ? { rootTaskId: input.rootTaskId } : {}),
        rootMessageId: input.rootMessageId,
        frozenTarget: {
          agentId: target.id,
          kind: target.category === 'agentos-hosted' ? 'agentos-hosted' : 'custom',
        },
        requestKey: requestKey(input),
        requestHash: hash({ body: input.body, targetAgentId: target.id, channelId: input.channelId }),
        placementPolicy,
        budget: mergeManagementBudget(PHASE_1_BUDGET, policy.budgetOverrides),
        ...(autoPlacement ? { autoPlacement } : {}),
      });
      await recordAutoPlacementAudit(input, created, autoPlacement);
      return {
        kind: 'managed',
        mode: 'managed',
        managementPhase: 1,
        managementRunId: created.run.id,
        profileId: device.profileId,
        disposition: created.disposition,
      };
    },

    async scheduleManaged(input: Extract<ManagementRoutingResult, { kind: 'managed' }>) {
      const scheduled = await dependencies.gateway?.schedule({
        managementRunId: input.managementRunId,
        profileId: input.profileId,
      }) ?? { ok: false, diagnosticCode: 'MANAGEMENT_WORKER_UNAVAILABLE' };
      return {
        ...input,
        ...(!scheduled.ok ? {
          schedulingDiagnostic: scheduled.diagnosticCode ?? 'MANAGEMENT_WORKER_UNAVAILABLE',
        } : {}),
      };
    },

    async recordShadowDecision(input: { shadowRequestKey: string; body: string; targetAgentId?: string }) {
      const target = input.targetAgentId ? await repositories.agents.getById(input.targetAgentId) : null;
      await persistShadowDecision({ shadowRequestKey: input.shadowRequestKey, body: input.body, target });
    },
  };

  async function persistShadowDecision(input: { shadowRequestKey: string; body: string; target: AgentRecord | null }) {
    if (await repositories.management.shadowDecisions.getByRequestKey(input.shadowRequestKey)) return;
    const inputHash = hash({ body: input.body, targetAgentId: input.target?.id ?? null });
    await repositories.management.shadowDecisions.create({
      id: dependencies.ids.nextId(),
      shadowRequestKey: input.shadowRequestKey,
      inputHash,
      objectiveHash: hash(input.body),
      argumentHash: hash([]),
      target: input.target ? { agentId: input.target.id, kind: input.target.category } : {},
      toolSequence: [],
      diagnostics: { codes: ['MANAGEMENT_SHADOW_EVALUATION_UNAVAILABLE'] },
      createdAt: clock.now(),
    });
  }
}

function requestKey(input: { teamId: string; userId: string; clientMessageId?: string; rootMessageId: string }): string {
  return `${input.teamId}:${input.userId}:${input.clientMessageId?.trim() || input.rootMessageId}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unavailablePreflight(): ManagementPreflight {
  return { workerAvailable: false, credentialAvailable: false, placementAllowed: false, budgetAvailable: true, targetAvailable: false };
}

function isManagementMode(value: unknown): value is ManagementMode {
  return value === 'direct' || value === 'shadow' || value === 'managed';
}

function normalizePlacementPolicy(value: ManagerPlacementPolicyDto): ManagerPlacementPolicyDto | null {
  if (value.placement !== 'device' && value.placement !== 'auto' && value.placement !== 'managed') return null;
  if (value.placement === 'managed') {
    if (value.allowServerContext !== true
      || value.requireLocalModelCredentials !== false
      || value.allowedDeviceIds?.length) return null;
    return {
      placement: 'managed',
      allowServerContext: true,
      requireLocalModelCredentials: false,
      ...(value.preferredProvider?.trim() ? { preferredProvider: value.preferredProvider.trim() } : {}),
      ...(value.preferredModel?.trim() ? { preferredModel: value.preferredModel.trim() } : {}),
    };
  }
  const allowedDeviceIds = value.allowedDeviceIds?.filter((item) => typeof item === 'string' && item.length > 0);
  return {
    placement: value.placement,
    ...(allowedDeviceIds?.length ? { allowedDeviceIds: [...new Set(allowedDeviceIds)] } : {}),
    allowServerContext: value.allowServerContext === true,
    requireLocalModelCredentials: value.requireLocalModelCredentials !== false,
    ...(value.preferredProvider?.trim() ? { preferredProvider: value.preferredProvider.trim() } : {}),
    ...(value.preferredModel?.trim() ? { preferredModel: value.preferredModel.trim() } : {}),
  };
}
