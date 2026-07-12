import { describe, expect, test } from 'vitest';

import {
  evaluateManagementRoute,
  hasCrossedManagedFallbackBarrier,
  type EvaluateManagementRouteInput,
  type ManagedPersistentEffect,
  type ManagementPreflight,
} from '../src/index.js';

const ready: ManagementPreflight = {
  workerAvailable: true,
  credentialAvailable: true,
  placementAllowed: true,
  budgetAvailable: true,
  targetAvailable: true,
};

function input(overrides: Partial<EvaluateManagementRouteInput> = {}): EvaluateManagementRouteInput {
  return {
    requestId: 'request-1',
    mode: 'managed',
    requestShape: 'single-agent',
    allowDirectFallbackBeforeBarrier: true,
    preflight: ready,
    barrier: { idempotencyReserved: false, persistedEffects: [] },
    ...overrides,
  };
}

describe('Phase 0 management rollout policy', () => {
  test('direct creates no management side effects', () => {
    expect(evaluateManagementRoute(input({ mode: 'direct' }))).toEqual({
      kind: 'direct',
      reason: 'configured-direct',
      crossedBarrier: false,
      managementEffects: [],
    });
  });

  test('shadow can only write a request-namespaced decision record', () => {
    expect(evaluateManagementRoute(input({ mode: 'shadow' }))).toEqual({
      kind: 'shadow',
      namespace: 'shadow:request-1',
      crossedBarrier: false,
      managementEffects: ['shadow-decision-record'],
    });
  });

  test.each(Object.keys(ready) as Array<keyof ManagementPreflight>)(
    'managed preflight requires %s',
    (missing) => {
      expect(evaluateManagementRoute(input({
        requestShape: 'multi-agent',
        preflight: { ...ready, [missing]: false },
      }))).toEqual({
        kind: 'unavailable',
        reason: 'managed-preflight-failed',
        missingPreflight: [missing],
        crossedBarrier: false,
      });
    },
  );

  test('only an explicit single-Agent request may fallback before the barrier', () => {
    const unavailablePreflight = { ...ready, workerAvailable: false };
    expect(evaluateManagementRoute(input({ preflight: unavailablePreflight }))).toMatchObject({
      kind: 'direct',
      reason: 'preflight-fallback',
      crossedBarrier: false,
      managementEffects: [],
    });
    for (const requestShape of ['multi-agent', 'decomposition'] as const) {
      expect(evaluateManagementRoute(input({
        requestShape,
        preflight: unavailablePreflight,
      }))).toMatchObject({
        kind: 'unavailable',
        reason: 'managed-preflight-failed',
      });
    }
  });

  test('an idempotency reservation permanently crosses the barrier', () => {
    expect(hasCrossedManagedFallbackBarrier({ idempotencyReserved: true, persistedEffects: [] })).toBe(true);
    expect(evaluateManagementRoute(input({
      mode: 'direct',
      preflight: { ...ready, workerAvailable: false },
      barrier: { idempotencyReserved: true, persistedEffects: [] },
    }))).toEqual({
      kind: 'managed-recovery',
      reason: 'fallback-barrier-crossed',
      crossedBarrier: true,
      managementEffects: [],
    });
  });

  test.each([
    'management-run', 'task', 'management-event', 'checkpoint', 'management-message',
    'memory-capsule', 'invocation', 'dispatch',
  ] satisfies readonly ManagedPersistentEffect[])('%s permanently crosses the fallback barrier', (effect) => {
    expect(hasCrossedManagedFallbackBarrier({
      idempotencyReserved: false,
      persistedEffects: [effect],
    })).toBe(true);
  });

  test('fully ready managed requests stay managed without crossing the barrier early', () => {
    expect(evaluateManagementRoute(input())).toEqual({
      kind: 'managed-preflight-passed',
      crossedBarrier: false,
      next: 'reserve-managed-idempotency',
      managementEffects: [],
    });
  });

  test('managed execution is only authorized after the idempotency reservation crosses the barrier', () => {
    expect(evaluateManagementRoute(input({
      barrier: { idempotencyReserved: true, persistedEffects: [] },
    }))).toEqual({
      kind: 'managed',
      crossedBarrier: true,
      managementEffects: [],
    });
  });

  test('a persisted effect without its idempotency reservation enters recovery', () => {
    expect(evaluateManagementRoute(input({
      barrier: { idempotencyReserved: false, persistedEffects: ['management-event'] },
    }))).toEqual({
      kind: 'managed-recovery',
      reason: 'reservation-missing-after-side-effect',
      crossedBarrier: true,
      managementEffects: [],
    });
  });
});
