/**
 * 频道协作任务的结构化 human trigger。
 *
 * 普通聊天、自然语言判断与 @Agent 不得合成此 payload。只有用户在 composer 中
 * 显式选择“频道 Agent 协作”时，Web 才能随 message:send 提交本合同。
 */

export const CHANNEL_COLLABORATION_TASK_AUDIENCES = ['all-channel-agents'] as const;
export const CHANNEL_COLLABORATION_TASK_TAG = 'channel-collaboration';
export type ChannelCollaborationTaskAudience =
  (typeof CHANNEL_COLLABORATION_TASK_AUDIENCES)[number];

export const CHANNEL_COLLABORATION_TASK_ALLOCATION_MODES = [
  'one-targeted-subtask-per-agent',
] as const;
export type ChannelCollaborationTaskAllocationMode =
  (typeof CHANNEL_COLLABORATION_TASK_ALLOCATION_MODES)[number];

export interface ChannelCollaborationTaskTriggerV1 {
  readonly schemaVersion: 1;
  readonly audience: ChannelCollaborationTaskAudience;
  readonly allocationMode: ChannelCollaborationTaskAllocationMode;
}

export const ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1 = {
  schemaVersion: 1,
  audience: 'all-channel-agents',
  allocationMode: 'one-targeted-subtask-per-agent',
} as const satisfies ChannelCollaborationTaskTriggerV1;

const EXACT_KEYS = ['allocationMode', 'audience', 'schemaVersion'] as const;

export function parseChannelCollaborationTaskTriggerV1(
  value: unknown,
): ChannelCollaborationTaskTriggerV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CHANNEL_COLLABORATION_TASK_TRIGGER_INVALID');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== EXACT_KEYS.length
    || keys.some((key, index) => key !== EXACT_KEYS[index])) {
    throw new Error('CHANNEL_COLLABORATION_TASK_TRIGGER_INVALID');
  }
  if (record.schemaVersion !== 1
    || !CHANNEL_COLLABORATION_TASK_AUDIENCES.includes(
      record.audience as ChannelCollaborationTaskAudience,
    )
    || !CHANNEL_COLLABORATION_TASK_ALLOCATION_MODES.includes(
      record.allocationMode as ChannelCollaborationTaskAllocationMode,
    )) {
    throw new Error('CHANNEL_COLLABORATION_TASK_TRIGGER_INVALID');
  }
  return {
    schemaVersion: 1,
    audience: record.audience as ChannelCollaborationTaskAudience,
    allocationMode: record.allocationMode as ChannelCollaborationTaskAllocationMode,
  };
}
