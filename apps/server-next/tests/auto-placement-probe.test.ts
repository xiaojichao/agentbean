import { describe, expect, test, vi } from 'vitest';

import { createAutoPlacementProbe } from '../src/application/management/auto-placement-probe.js';

// #647 review 修复：probe 的 device 可用信号必须含 credential 就绪——
// device worker 在线但 credential 未就绪时若判 device 可用，auto 会错误选 device，
// 下游 preflight 再拒 credential，导致已授权且可用的 server 兜底被跳过。

function harness(overrides: Partial<{
  workerAvailable: boolean;
  credentialAvailable: boolean;
  serverSelected: boolean;
  withPool: boolean;
}> = {}) {
  const preflight = {
    workerAvailable: overrides.workerAvailable ?? true,
    credentialAvailable: overrides.credentialAvailable ?? true,
    placementAllowed: true,
    budgetAvailable: true,
    targetAvailable: true,
  };
  const deviceScheduler = {
    managementPhase2Preflight: vi.fn(async () => ({ preflight })),
    managementPhase3Preflight: vi.fn(async () => ({ preflight })),
  };
  const serverWorkerPool = (overrides.withPool ?? true)
    ? { selectWorker: vi.fn(() => (overrides.serverSelected ?? true) ? { workerId: 'w-1', profileId: 'profile-1' } : undefined) }
    : undefined;
  const probe = createAutoPlacementProbe({ deviceScheduler, serverWorkerPool });
  return { probe, deviceScheduler, serverWorkerPool };
}

const input = {
  teamId: 'team-1',
  placementPolicy: {
    placement: 'auto' as const,
    allowedDeviceIds: ['device-1'],
    allowServerContext: true,
    requireLocalModelCredentials: true,
  },
  managementPhase: 2 as const,
};

describe('createAutoPlacementProbe（#647）', () => {
  test('device worker 在线且 credential 就绪 → deviceAvailable true', async () => {
    const { probe } = harness({ workerAvailable: true, credentialAvailable: true });
    await expect(probe(input)).resolves.toMatchObject({ deviceAvailable: true });
  });

  test('device worker 在线但 credential 未就绪 → deviceAvailable false（server 兜底不被跳过）', async () => {
    const { probe } = harness({ workerAvailable: true, credentialAvailable: false });
    await expect(probe(input)).resolves.toMatchObject({ deviceAvailable: false });
  });

  test('server 侧：selectWorker 有候选 → serverAvailable true；无候选/无 pool → false', async () => {
    const withWorker = harness({ serverSelected: true });
    await expect(withWorker.probe(input)).resolves.toMatchObject({ serverAvailable: true });
    const noWorker = harness({ serverSelected: false });
    await expect(noWorker.probe(input)).resolves.toMatchObject({ serverAvailable: false });
    const noPool = harness({ withPool: false });
    await expect(noPool.probe(input)).resolves.toMatchObject({ serverAvailable: false });
  });

  test('managementPhase 3 走 V3 preflight；phase 1/2 走 phase2 preflight', async () => {
    const { probe, deviceScheduler } = harness();
    await probe({ ...input, managementPhase: 3 });
    expect(deviceScheduler.managementPhase3Preflight).toHaveBeenCalledTimes(1);
    expect(deviceScheduler.managementPhase2Preflight).not.toHaveBeenCalled();
    await probe({ ...input, managementPhase: 1 });
    expect(deviceScheduler.managementPhase2Preflight).toHaveBeenCalledTimes(1);
  });

  test('server 侧 selectWorker 收到请求的 phase 与 provider 偏好', async () => {
    const { probe, serverWorkerPool } = harness();
    await probe({
      ...input,
      placementPolicy: { ...input.placementPolicy, preferredProvider: 'anthropic' },
      managementPhase: 3,
    });
    expect(serverWorkerPool?.selectWorker).toHaveBeenCalledWith(expect.objectContaining({
      managementPhase: 3,
      preferredProvider: 'anthropic',
    }));
  });
});
