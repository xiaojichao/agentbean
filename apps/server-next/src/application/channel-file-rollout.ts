export interface ChannelFileRolloutConfig {
  /** 文件页保持现有兼容读路径；关闭后客户端应回退到消息附件视图。 */
  fileBrowser: boolean;
  /** 大文件流式读与 HTTP Range。 */
  streaming: boolean;
  /** 异步 preview derivative worker。 */
  previewWorker: boolean;
  /** Markdown Channel document 编辑与发布。 */
  markdownEditing: boolean;
  /** 历史 Markdown/附件后台回填。 */
  historyBackfill: boolean;
  /** 旧附件汇总与新索引的只读对照。 */
  indexShadowCompare: boolean;
}

export const DEFAULT_CHANNEL_FILE_ROLLOUT: ChannelFileRolloutConfig = {
  fileBrowser: true,
  streaming: false,
  previewWorker: true,
  markdownEditing: false,
  historyBackfill: false,
  indexShadowCompare: false,
};

const ROLLOUT_ENV_KEYS = {
  fileBrowser: 'AGENTBEAN_CHANNEL_FILES_BROWSER',
  streaming: 'AGENTBEAN_CHANNEL_FILES_STREAMING',
  previewWorker: 'AGENTBEAN_CHANNEL_FILES_PREVIEW_WORKER',
  markdownEditing: 'AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING',
  historyBackfill: 'AGENTBEAN_CHANNEL_FILES_HISTORY_BACKFILL',
  indexShadowCompare: 'AGENTBEAN_CHANNEL_FILES_INDEX_SHADOW_COMPARE',
} as const;

type ChannelFileMetricName = keyof ChannelFileMetricSnapshot;

export interface ChannelFileMetricSnapshot {
  indexShadowComparisons: number;
  indexShadowMismatches: number;
  indexShadowMissing: number;
  indexShadowUnexpected: number;
  indexShadowChanged: number;
  rangeResponses: number;
}

export interface ChannelFileSnapshotEntry {
  id: string;
  logicalPath: string;
  role: string;
}

export interface ChannelFileShadowDiff {
  missingFromIndex: string[];
  unexpectedInIndex: string[];
  changed: string[];
  equal: boolean;
}

export function parseChannelFileRolloutConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChannelFileRolloutConfig {
  return Object.fromEntries(
    Object.entries(DEFAULT_CHANNEL_FILE_ROLLOUT).map(([feature, fallback]) => {
      const key = ROLLOUT_ENV_KEYS[feature as keyof ChannelFileRolloutConfig];
      return [feature, parseBooleanFlag(key, env[key], fallback)];
    }),
  ) as unknown as ChannelFileRolloutConfig;
}

export function compareChannelFileSnapshots(
  legacy: readonly ChannelFileSnapshotEntry[],
  indexed: readonly ChannelFileSnapshotEntry[],
): ChannelFileShadowDiff {
  const legacyById = new Map(legacy.map((entry) => [entry.id, entry]));
  const indexedById = new Map(indexed.map((entry) => [entry.id, entry]));
  const missingFromIndex = [...legacyById.keys()].filter((id) => !indexedById.has(id)).sort();
  const unexpectedInIndex = [...indexedById.keys()].filter((id) => !legacyById.has(id)).sort();
  const changed = [...legacyById.keys()]
    .filter((id) => {
      const left = legacyById.get(id);
      const right = indexedById.get(id);
      return Boolean(right && left && (left.logicalPath !== right.logicalPath || left.role !== right.role));
    })
    .sort();
  return {
    missingFromIndex,
    unexpectedInIndex,
    changed,
    equal: missingFromIndex.length === 0 && unexpectedInIndex.length === 0 && changed.length === 0,
  };
}

export function createChannelFileMetrics() {
  const counters: ChannelFileMetricSnapshot = {
    indexShadowComparisons: 0,
    indexShadowMismatches: 0,
    indexShadowMissing: 0,
    indexShadowUnexpected: 0,
    indexShadowChanged: 0,
    rangeResponses: 0,
  };
  return {
    increment(name: ChannelFileMetricName, amount = 1) {
      counters[name] += amount;
    },
    snapshot(): ChannelFileMetricSnapshot {
      return { ...counters };
    },
  };
}

function parseBooleanFlag(key: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') return false;
  throw new Error(`${key} must be one of true/false, on/off, yes/no, or 1/0`);
}
