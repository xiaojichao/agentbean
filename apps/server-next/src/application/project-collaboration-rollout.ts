import { parseBooleanFlag } from './channel-file-rollout.js';

export interface ProjectCollaborationRolloutConfig {
  /** 只读项目投影与人工 Stage/Edge 配置。 */
  projectStage: boolean;
  /** 逻辑产物提升、人工审核与唯一最终版。 */
  reviewFinalization: boolean;
  /** 固定文档包、Selection 与稳定消息引用。 */
  bundleSelection: boolean;
  /** capability-gated InputSet 启动与逐项输出回收。 */
  inputSetOutput: boolean;
  /** PI Manager 基于权威项目事实自动推进下游 Stage。 */
  managerAutoAdvance: boolean;
}

export const DEFAULT_PROJECT_COLLABORATION_ROLLOUT: ProjectCollaborationRolloutConfig = {
  projectStage: false,
  reviewFinalization: false,
  bundleSelection: false,
  inputSetOutput: false,
  managerAutoAdvance: false,
};

export const FULL_PROJECT_COLLABORATION_ROLLOUT: ProjectCollaborationRolloutConfig = {
  projectStage: true,
  reviewFinalization: true,
  bundleSelection: true,
  inputSetOutput: true,
  managerAutoAdvance: true,
};

export type ProjectMutationFailureReason =
  | 'disabled'
  | 'permission'
  | 'archived'
  | 'validation'
  | 'idempotency_conflict'
  | 'revision_conflict'
  | 'scope_conflict'
  | 'unknown';

export type ProjectInputSetFailureReason =
  | 'capability'
  | 'download'
  | 'checksum'
  | 'materialization'
  | 'result_validation'
  | 'unknown';

export type ProjectInputSetResultStatus =
  | 'unchanged'
  | 'committed'
  | 'conflict'
  | 'failed';

export interface ProjectCollaborationMetricSnapshot {
  readonly mutationFailures: {
    readonly total: number;
    readonly byReason: Partial<Record<ProjectMutationFailureReason, number>>;
  };
  readonly occConflicts: number;
  readonly inputSet: {
    readonly failures: number;
    readonly failuresByReason: Partial<Record<ProjectInputSetFailureReason, number>>;
    readonly items: Record<ProjectInputSetResultStatus, number>;
  };
  readonly eventBroadcastLatencyMs: {
    readonly count: number;
    readonly total: number;
    readonly max: number;
  };
}

export function createProjectCollaborationMetrics() {
  let mutationFailureTotal = 0;
  let occConflicts = 0;
  let inputSetFailures = 0;
  const mutationFailures: Partial<Record<ProjectMutationFailureReason, number>> = {};
  const inputSetFailuresByReason: Partial<Record<ProjectInputSetFailureReason, number>> = {};
  const inputSetItems: Record<ProjectInputSetResultStatus, number> = {
    unchanged: 0,
    committed: 0,
    conflict: 0,
    failed: 0,
  };
  const eventLatency = { count: 0, total: 0, max: 0 };

  return {
    recordMutationFailure(reason: ProjectMutationFailureReason) {
      mutationFailureTotal += 1;
      mutationFailures[reason] = (mutationFailures[reason] ?? 0) + 1;
      if (reason === 'revision_conflict') occConflicts += 1;
    },
    recordInputSetFailure(reason: ProjectInputSetFailureReason) {
      inputSetFailures += 1;
      inputSetFailuresByReason[reason] = (inputSetFailuresByReason[reason] ?? 0) + 1;
    },
    recordInputSetResult(status: ProjectInputSetResultStatus) {
      inputSetItems[status] += 1;
      if (status === 'conflict') occConflicts += 1;
    },
    observeEventBroadcastLatency(durationMs: number) {
      const safeDuration = Number.isFinite(durationMs)
        ? Math.max(0, Math.round(durationMs))
        : 0;
      eventLatency.count += 1;
      eventLatency.total += safeDuration;
      eventLatency.max = Math.max(eventLatency.max, safeDuration);
    },
    snapshot(): ProjectCollaborationMetricSnapshot {
      return {
        mutationFailures: {
          total: mutationFailureTotal,
          byReason: { ...mutationFailures },
        },
        occConflicts,
        inputSet: {
          failures: inputSetFailures,
          failuresByReason: { ...inputSetFailuresByReason },
          items: { ...inputSetItems },
        },
        eventBroadcastLatencyMs: { ...eventLatency },
      };
    },
  };
}

const ROLLOUT_ENV_KEYS = {
  projectStage: 'AGENTBEAN_PROJECT_STAGE',
  reviewFinalization: 'AGENTBEAN_PROJECT_REVIEW_FINALIZATION',
  bundleSelection: 'AGENTBEAN_PROJECT_BUNDLE_SELECTION',
  inputSetOutput: 'AGENTBEAN_PROJECT_INPUT_SET_OUTPUT',
  managerAutoAdvance: 'AGENTBEAN_PROJECT_MANAGER_AUTO_ADVANCE',
} as const;

export function parseProjectCollaborationRolloutConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProjectCollaborationRolloutConfig {
  const config = Object.fromEntries(
    Object.entries(DEFAULT_PROJECT_COLLABORATION_ROLLOUT).map(([feature, fallback]) => {
      const key = ROLLOUT_ENV_KEYS[feature as keyof ProjectCollaborationRolloutConfig];
      return [feature, parseBooleanFlag(key, env[key], fallback)];
    }),
  ) as unknown as ProjectCollaborationRolloutConfig;

  return validateProjectCollaborationRolloutConfig(config);
}

export function validateProjectCollaborationRolloutConfig(
  config: ProjectCollaborationRolloutConfig,
): ProjectCollaborationRolloutConfig {
  const phases = [
    ['projectStage', undefined],
    ['reviewFinalization', 'projectStage'],
    ['bundleSelection', 'reviewFinalization'],
    ['inputSetOutput', 'bundleSelection'],
    ['managerAutoAdvance', 'inputSetOutput'],
  ] as const;
  for (const [feature, prerequisite] of phases) {
    if (prerequisite && config[feature] && !config[prerequisite]) {
      throw new Error(
        `${ROLLOUT_ENV_KEYS[feature]} requires ${ROLLOUT_ENV_KEYS[prerequisite]}`,
      );
    }
  }
  return config;
}
