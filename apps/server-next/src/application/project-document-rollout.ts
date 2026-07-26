import { parseBooleanFlag } from './channel-file-rollout.js';

/**
 * #830：文档包回填的 rollout 开关。
 *
 * 与 #770 的 ChannelFileRolloutConfig 分开，因为两者的回退面完全不同：关闭本开关只是
 * 不再产生新的回填裁决，既有 Bundle、#770 文件库读路径与 Markdown 编辑一律不受影响。
 * 默认关闭且默认 dry-run —— 打开开关本身不应该写库，必须再显式关掉 dry-run。
 */
export interface ProjectDocumentRolloutConfig {
  /** 后台扫描历史 Workspace Run 并裁决是否成包。 */
  bundleBackfill: boolean;
  /** 只裁决并记录报告，不写任何 Bundle。 */
  bundleBackfillDryRun: boolean;
}

export const DEFAULT_PROJECT_DOCUMENT_ROLLOUT: ProjectDocumentRolloutConfig = {
  bundleBackfill: false,
  bundleBackfillDryRun: true,
};

const ROLLOUT_ENV_KEYS = {
  bundleBackfill: 'AGENTBEAN_PROJECT_DOCUMENT_BUNDLE_BACKFILL',
  bundleBackfillDryRun: 'AGENTBEAN_PROJECT_DOCUMENT_BUNDLE_BACKFILL_DRY_RUN',
} as const;

export function parseProjectDocumentRolloutConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProjectDocumentRolloutConfig {
  return Object.fromEntries(
    Object.entries(DEFAULT_PROJECT_DOCUMENT_ROLLOUT).map(([feature, fallback]) => {
      const key = ROLLOUT_ENV_KEYS[feature as keyof ProjectDocumentRolloutConfig];
      return [feature, parseBooleanFlag(key, env[key], fallback)];
    }),
  ) as unknown as ProjectDocumentRolloutConfig;
}
