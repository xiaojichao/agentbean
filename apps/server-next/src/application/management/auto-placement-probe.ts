// #647 auto placement 的可用性探测（gateway.probeAutoPlacement 的实现体）。
// 从 dev-server 装配处抽出以便单测：device 信号复用既有 preflight 候选过滤，
// server 信号用 pool.selectWorker。

import type { ManagerPlacementPolicyDto } from '../../../../../packages/contracts/src/index.js';
import type { ManagementPreflight } from '../../../../../packages/domain/src/index.js';

export interface AutoPlacementProbeInput {
  readonly teamId: string;
  readonly placementPolicy: ManagerPlacementPolicyDto;
  readonly managementPhase: 1 | 2 | 3;
}

export interface AutoPlacementProbeResult {
  readonly deviceAvailable: boolean;
  readonly serverAvailable: boolean;
}

interface DevicePreflightScheduler {
  managementPhase2Preflight(input: {
    teamId: string;
    placementPolicy: ManagerPlacementPolicyDto;
    targetAvailable: boolean;
  }): Promise<{ preflight: ManagementPreflight; profileId?: string }>;
  managementPhase3Preflight(input: {
    teamId: string;
    placementPolicy: ManagerPlacementPolicyDto;
    targetAvailable: boolean;
  }): Promise<{ preflight: ManagementPreflight; profileId?: string }>;
}

interface ServerWorkerPoolProbe {
  selectWorker(input: {
    managementPhase: 1 | 2 | 3;
    preferredProvider?: string;
    preferredModel?: string;
  }): unknown;
}

export function createAutoPlacementProbe(dependencies: {
  readonly deviceScheduler: DevicePreflightScheduler;
  readonly serverWorkerPool?: ServerWorkerPoolProbe;
}) {
  return async function probeAutoPlacement(input: AutoPlacementProbeInput): Promise<AutoPlacementProbeResult> {
    // device 侧：复用既有 preflight 的候选过滤（在线 + allowedDeviceIds 授权 + credential ready）。
    const devicePreflight = input.managementPhase === 3
      ? await dependencies.deviceScheduler.managementPhase3Preflight({
          teamId: input.teamId, placementPolicy: input.placementPolicy, targetAvailable: true,
        })
      : await dependencies.deviceScheduler.managementPhase2Preflight({
          teamId: input.teamId, placementPolicy: input.placementPolicy, targetAvailable: true,
        });
    // server 侧：pool.selectWorker（connected + transport + phase 支持；
    // credential production_ready 在注册时 fail-closed）。
    const serverSelected = dependencies.serverWorkerPool?.selectWorker({
      managementPhase: input.managementPhase,
      ...(input.placementPolicy.preferredProvider ? { preferredProvider: input.placementPolicy.preferredProvider } : {}),
      ...(input.placementPolicy.preferredModel ? { preferredModel: input.placementPolicy.preferredModel } : {}),
    });
    return {
      // credential 未就绪的 device worker 不算可用：否则 auto 错误选 device 后下游 preflight
      // 再拒 credential，已授权且可用的 server 兜底被跳过（review finding）。
      deviceAvailable: devicePreflight.preflight.workerAvailable && devicePreflight.preflight.credentialAvailable,
      serverAvailable: Boolean(serverSelected),
    };
  };
}
