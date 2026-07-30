/**
 * #963 Device-bound Agent 生命周期隔离 —— 纯策略。
 *
 * 职责：编码「Agent 是 Device-bound Agent」的域合同。
 * 无 server 依赖、无 IO、无副作用，可独立单测。
 */
export interface DeviceAgentBindingInput {
  readonly agentDeviceId: string | undefined;
  readonly agentStatus: string;
  readonly agentDeletedAt: number | undefined;
  readonly deviceStatus: string | undefined;
  readonly deviceExists: boolean;
}

export type DeviceAgentLifecycleRejection =
  | 'device_missing'
  | 'device_deleted'
  | 'device_offline'
  | 'agent_not_ready';

export interface DeviceAgentLifecycleDecision {
  readonly kind: 'eligible' | 'ineligible';
  readonly reason?: DeviceAgentLifecycleRejection;
}

/**
 * 评估 Device-bound Agent 是否处于可执行的生命周期状态。
 * 规则（按优先级）：
 * 1. agent 无 deviceId → device_missing
 * 2. agent 已软删除 → device_deleted
 * 3. device 不存在或离线 → device_offline
 * 4. agent 状态非 online → agent_not_ready
 * 5. 全部通过 → eligible
 */
export function evaluateDeviceAgentLifecycle(
  input: DeviceAgentBindingInput,
): DeviceAgentLifecycleDecision {
  if (input.agentDeviceId === undefined || input.agentDeviceId === null) {
    return { kind: 'ineligible', reason: 'device_missing' };
  }
  if (input.agentDeletedAt !== undefined) {
    return { kind: 'ineligible', reason: 'device_deleted' };
  }
  if (!input.deviceExists || input.deviceStatus !== 'online') {
    return { kind: 'ineligible', reason: 'device_offline' };
  }
  if (input.agentStatus !== 'online') {
    return { kind: 'ineligible', reason: 'agent_not_ready' };
  }
  return { kind: 'eligible' };
}

export interface DeviceAgentLifecycleBatchResult {
  readonly eligible: readonly { readonly agentId: string; readonly deviceId: string }[];
  readonly ineligible: readonly {
    readonly agentId: string;
    readonly deviceId: string | undefined;
    readonly reason: DeviceAgentLifecycleRejection;
  }[];
}

export function resolveAgentLifecycleFromDevice(
  device: { readonly id: string; readonly status: string } | null | undefined,
  agents: readonly {
    readonly id: string;
    readonly deviceId: string | undefined;
    readonly status: string;
    readonly deletedAt: number | undefined;
  }[],
): DeviceAgentLifecycleBatchResult {
  const eligible: { agentId: string; deviceId: string }[] = [];
  const ineligible: { agentId: string; deviceId: string | undefined; reason: DeviceAgentLifecycleRejection }[] = [];
  for (const agent of agents) {
    const decision = evaluateDeviceAgentLifecycle({
      agentDeviceId: agent.deviceId,
      agentStatus: agent.status,
      agentDeletedAt: agent.deletedAt,
      deviceStatus: device?.status,
      deviceExists: device !== null && device !== undefined,
    });
    if (decision.kind === 'eligible') {
      eligible.push({ agentId: agent.id, deviceId: agent.deviceId! });
    } else {
      ineligible.push({ agentId: agent.id, deviceId: agent.deviceId, reason: decision.reason! });
    }
  }
  return { eligible, ineligible };
}

export type DeviceLifecycleEvent = 'online' | 'offline' | 'revoked' | 'deleted';

export interface DeviceAgentLifecycleEffect {
  readonly event: DeviceLifecycleEvent;
  readonly agentEffect: 'none' | 'mark_offline' | 'mark_deleted' | 'remove_from_channels';
  readonly description: string;
}

export function describeDeviceLifecycleEffect(
  event: DeviceLifecycleEvent,
): DeviceAgentLifecycleEffect {
  switch (event) {
    case 'online':
      return { event: 'online', agentEffect: 'none', description: 'Device 在线：custom agent 可由 deviceHello 恢复为 online' };
    case 'offline':
      return { event: 'offline', agentEffect: 'mark_offline', description: 'Device 离线：所有关联 Agent 标记为 offline，失去执行资格' };
    case 'revoked':
      return { event: 'revoked', agentEffect: 'mark_deleted', description: 'Device 凭证被撤销：关联 Agent 软删除' };
    case 'deleted':
      return { event: 'deleted', agentEffect: 'mark_deleted', description: 'Device 被删除：关联 Agent 软删除并从所有频道移除' };
  }
}
