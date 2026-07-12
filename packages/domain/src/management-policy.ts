import type { ManagementMode } from '@agentbean/contracts';

export type ManagedPersistentEffect =
  | 'management-run'
  | 'task'
  | 'management-event'
  | 'checkpoint'
  | 'management-message'
  | 'memory-capsule'
  | 'invocation'
  | 'dispatch';

export interface ManagedFallbackBarrierState {
  readonly idempotencyReserved: boolean;
  readonly persistedEffects: readonly ManagedPersistentEffect[];
}

export interface ManagementPreflight {
  readonly workerAvailable: boolean;
  readonly credentialAvailable: boolean;
  readonly placementAllowed: boolean;
  readonly budgetAvailable: boolean;
  readonly targetAvailable: boolean;
}

export type ManagementPreflightCheck = keyof ManagementPreflight;
export type ManagementRequestShape = 'single-agent' | 'multi-agent' | 'decomposition';

export interface EvaluateManagementRouteInput {
  readonly requestId: string;
  readonly mode: ManagementMode;
  readonly requestShape: ManagementRequestShape;
  readonly allowDirectFallbackBeforeBarrier: boolean;
  readonly preflight: ManagementPreflight;
  readonly barrier: ManagedFallbackBarrierState;
}

export type ManagementRouteDecision =
  | {
      readonly kind: 'direct';
      readonly reason: 'configured-direct' | 'preflight-fallback';
      readonly crossedBarrier: false;
      readonly managementEffects: readonly [];
    }
  | {
      readonly kind: 'shadow';
      readonly namespace: string;
      readonly crossedBarrier: false;
      readonly managementEffects: readonly ['shadow-decision-record'];
    }
  | {
      readonly kind: 'managed-preflight-passed';
      readonly crossedBarrier: false;
      readonly next: 'reserve-managed-idempotency';
      readonly managementEffects: readonly [];
    }
  | {
      readonly kind: 'managed';
      readonly crossedBarrier: true;
      readonly managementEffects: readonly [];
    }
  | {
      readonly kind: 'managed-recovery';
      readonly reason: 'fallback-barrier-crossed' | 'reservation-missing-after-side-effect';
      readonly crossedBarrier: true;
      readonly managementEffects: readonly [];
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'managed-preflight-failed';
      readonly missingPreflight: readonly ManagementPreflightCheck[];
      readonly crossedBarrier: false;
    };

const PREFLIGHT_CHECKS: readonly ManagementPreflightCheck[] = [
  'workerAvailable',
  'credentialAvailable',
  'placementAllowed',
  'budgetAvailable',
  'targetAvailable',
];

export function hasCrossedManagedFallbackBarrier(state: ManagedFallbackBarrierState): boolean {
  return state.idempotencyReserved || state.persistedEffects.length > 0;
}

export function missingManagementPreflight(preflight: ManagementPreflight): ManagementPreflightCheck[] {
  return PREFLIGHT_CHECKS.filter((check) => !preflight[check]);
}

export function evaluateManagementRoute(input: EvaluateManagementRouteInput): ManagementRouteDecision {
  const crossedBarrier = hasCrossedManagedFallbackBarrier(input.barrier);
  const missingPreflight = missingManagementPreflight(input.preflight);

  if (crossedBarrier) {
    if (input.mode === 'managed' && input.barrier.idempotencyReserved && missingPreflight.length === 0) {
      return { kind: 'managed', crossedBarrier: true, managementEffects: [] };
    }
    return {
      kind: 'managed-recovery',
      reason: input.barrier.idempotencyReserved
        ? 'fallback-barrier-crossed'
        : 'reservation-missing-after-side-effect',
      crossedBarrier: true,
      managementEffects: [],
    };
  }

  if (input.mode === 'direct') {
    return {
      kind: 'direct',
      reason: 'configured-direct',
      crossedBarrier: false,
      managementEffects: [],
    };
  }

  if (input.mode === 'shadow') {
    return {
      kind: 'shadow',
      namespace: `shadow:${input.requestId}`,
      crossedBarrier: false,
      managementEffects: ['shadow-decision-record'],
    };
  }

  if (missingPreflight.length === 0) {
    return {
      kind: 'managed-preflight-passed',
      crossedBarrier: false,
      next: 'reserve-managed-idempotency',
      managementEffects: [],
    };
  }

  if (input.requestShape === 'single-agent' && input.allowDirectFallbackBeforeBarrier) {
    return {
      kind: 'direct',
      reason: 'preflight-fallback',
      crossedBarrier: false,
      managementEffects: [],
    };
  }

  return {
    kind: 'unavailable',
    reason: 'managed-preflight-failed',
    missingPreflight,
    crossedBarrier: false,
  };
}
