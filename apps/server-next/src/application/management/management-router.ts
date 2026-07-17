import { createHash } from 'node:crypto';
import type {
  ManagementBudgetDto,
  ManagementMode,
  ManagerPlacementPolicyDto,
} from '../../../../../packages/contracts/src/index.js';
import {
  evaluateManagementRoute,
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

      if (policy.placementPolicy.placement === 'managed'
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
          placementPolicy: policy.placementPolicy,
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
          placementPolicy: policy.placementPolicy,
          budget: PHASE_2_BUDGET,
          managementPhase: 3,
        });
        return {
          kind: 'managed', mode: 'managed', managementPhase: 3,
          managementRunId: created.run.id, profileId: phase3.profileId,
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
          placementPolicy: policy.placementPolicy,
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
          placementPolicy: policy.placementPolicy,
          budget: PHASE_2_BUDGET,
          managementPhase: 2,
        });
        return {
          kind: 'managed', mode: 'managed', managementPhase: 2,
          managementRunId: created.run.id, profileId: phase2.profileId,
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
        ? await gateway.preflight({ teamId: input.teamId, target, placementPolicy: policy.placementPolicy })
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
        channelId: input.channelId,
        ...(input.rootTaskId ? { rootTaskId: input.rootTaskId } : {}),
        rootMessageId: input.rootMessageId,
        frozenTarget: {
          agentId: target.id,
          kind: target.category === 'agentos-hosted' ? 'agentos-hosted' : 'custom',
        },
        requestKey: requestKey(input),
        requestHash: hash({ body: input.body, targetAgentId: target.id, channelId: input.channelId }),
        placementPolicy: policy.placementPolicy,
        budget: PHASE_1_BUDGET,
      });
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
