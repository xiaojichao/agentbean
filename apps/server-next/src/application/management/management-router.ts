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

/**
 * 默认 placement 只以工厂形态存在，不留模块级共享对象。
 *
 * 这里原本是一个 const 对象，policyForTeam 兜底与 #724 桥接都按引用把它递给调用方。
 * DTO 的 readonly 只在编译期成立，调用方一次 `policy.placementPolicy.placement = 'auto'`
 * 就改写了全进程共享值：此后 #724 桥接（有 target 时本该恒为 device）会落进 auto 解析，
 * 让一个根本没有存储策略行的请求走到 resolveAutoPlacement 与 crossedBarrier 返回点。
 * 工厂每次返回新对象——没有共享对象可改，「桥接绝不选 auto」才是结构性保证，
 * 而不是「碰巧没人去改」的约定。
 */
function defaultPlacementPolicy(): ManagerPlacementPolicyDto {
  return {
    placement: 'device',
    allowServerContext: false,
    requireLocalModelCredentials: true,
  };
}

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
  // crossedBarrier：run 已创建之后才判定的不可用（#657 冻结侧重 preflight）。
  // 这类结果绝不能被任何调用方降级成 direct——barrier 后不得再产生 direct Dispatch。
  | { kind: 'unavailable'; mode: 'managed'; diagnostics: readonly string[]; crossedBarrier?: true };

export interface RouteRequestInput {
  userId: string;
  teamId: string;
  channelId: string;
  rootMessageId: string;
  rootTaskId?: string;
  clientMessageId?: string;
  body: string;
  targetAgentId?: string;
}

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

  // 读路径的唯一出口：无论策略来自仓储还是兜底默认值，出手的都是调用方独占的新对象。
  // 仓储实现可以按引用存取（内存版就是），所以直接把 get() 的结果递出去等于把仓储里的
  // 活对象交给调用方——改它就是改存储行。#836 的桥接回退恰恰要在 routeRequest 之后
  // 再读一次 stored.mode 来判断团队是否显式选了 managed，读到被污染的行会静默改判。
  async function policyForTeam(teamId: string): Promise<ManagementPolicyRecord> {
    const stored = await repositories.management.policies.get(teamId);
    return stored ? detachPolicy(stored) : {
      schemaVersion: 2,
      teamId,
      mode: 'direct',
      maxManagementPhase: 1,
      placementPolicy: defaultPlacementPolicy(),
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
      const placementPolicy = normalizePlacementPolicy(input.placementPolicy ?? defaultPlacementPolicy());
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
      // upsert 的返回值在按引用存取的仓储实现里就是刚落库的那个对象，同样要脱钩再出手。
      return { ok: true as const, policy: detachPolicy(policy), canManage: true as const };
    },

    async route(input: RouteRequestInput): Promise<ManagementRoutingResult> {
      const result = await routeRequest(input);
      // #836：#724 桥接是自动升级——团队从未显式把 mode 切到 managed。桥接路径下
      // barrier 前的任何 unavailable 都不能让消息发送失败，必须回落到团队原本的默认
      // 路径 direct。显式配置 managed 的团队保持 fail closed，barrier 后也绝不回退。
      if (result.kind !== 'unavailable' || result.crossedBarrier) return result;
      const stored = await policyForTeam(input.teamId);
      if (stored.mode !== 'direct') return result;
      return { kind: 'direct', mode: 'direct' };
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

  async function routeRequest(input: RouteRequestInput): Promise<ManagementRoutingResult> {
    let policy = await policyForTeam(input.teamId);
    // #724: 旧 management_policies 未配置（默认 direct）时桥接新 piPolicy。
    // 仅在消息携带 clientMessageId（客户端显式意图）时桥接；否则保持 direct。
    // placement 决策：
    // - 有 target → device placement（Phase 1-3 管理路由，避开 L288 guard）
    // - 无 target → managed placement（Phase 4 server worker）
    // maxManagementPhase 由 rootTaskId 驱动。
    if (policy.mode === 'direct') {
      const piPolicy = await repositories.teamPiPolicy.getOrDefault(input.teamId);
      if (piPolicy.autoCoordinationEnabled && input.clientMessageId?.trim()) {
        const hasRootTask = !!input.rootTaskId?.trim();
        const hasTarget = !!input.targetAgentId;
        policy = {
          ...policy,
          mode: 'managed' as ManagementMode,
          maxManagementPhase: (hasRootTask ? 3 : 1) as 1 | 2 | 3,
          placementPolicy: hasTarget
            ? defaultPlacementPolicy()
            : { placement: 'managed', allowServerContext: true, requireLocalModelCredentials: false },
        };
      }
    }
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
          // run 已创建（barrier 已越过）：标记 crossedBarrier，禁止上层降级成 direct。
          return { kind: 'unavailable', mode: 'managed', crossedBarrier: true,
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
          // run 已创建（barrier 已越过）：标记 crossedBarrier，禁止上层降级成 direct。
          return { kind: 'unavailable', mode: 'managed', crossedBarrier: true,
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
      allowDirectFallbackBeforeBarrier: true,
      preflight,
      barrier: { idempotencyReserved: false, persistedEffects: [] },
    });
    if (decision.kind !== 'managed-preflight-passed') {
      if (decision.kind === 'direct') {
        return { kind: 'direct', mode: 'direct' };
      }
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
  }

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

/**
 * 把策略记录与「别处仍持有的那个对象」彻底脱钩，供读路径出手。
 *
 * 用深拷贝而非逐字段挑选：ManagementPolicyRecord 后续加字段时，逐字段版本会静默漏拷
 * （新字段悄悄退化成共享引用，正是本次要根除的那类 bug），深拷贝不会。策略记录全是
 * JSON 形态数据（字符串/数字/布尔/数组），structuredClone 可安全处理；daemon-next 的
 * local-memory-store / management-durable-outbox 在边界上也是这个写法。
 *
 * 与 normalizePlacementPolicy 的分工：那个是写路径的**校验型**生产者，形状不合法就返回
 * null（managed 带 allowedDeviceIds、未知 placement 等）。读路径不能消费 null 语义——
 * 已落库的行不该在读取时被判死，所以读路径用这个纯结构拷贝，不做校验。两者加上
 * defaultPlacementPolicy() 共三个生产者，共同点是**都只产出新对象**，谁都不外泄共享引用。
 */
function detachPolicy(record: ManagementPolicyRecord): ManagementPolicyRecord {
  return structuredClone(record);
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
