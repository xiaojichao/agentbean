import type { ActiveMemoryContextItemDto, ActiveMemorySourceCode } from '@agentbean/contracts';

/**
 * Active Memory Context → system prompt 片段渲染（issue #720，AC#8）。
 *
 * Coordinator 与 ManagementRun 共用同一渲染：server 调本函数得到字符串，Coordinator
 * 直接拼入 prompt、ManagementRun 写入 checkpoint.contextHints.activeMemorySection。
 * 格式对齐 daemon `runtime-memory-context.ts` 的 renderItem（`[source:id] (kind; reason) content`），
 * 但省略 capsule authority / scopeType 等 PI 消费者不需要的内部标识。
 */

const SOURCE_LABELS: Record<ActiveMemorySourceCode, string> = {
  team_formal_memory: 'Team 策略记忆',
  channel_formal_memory: '当前频道记忆',
  task_fact: '当前任务事实',
  agent_projection: '已启用 Agent 投影',
  experience_pack: '关联经验包',
};

/** 渲染顺序固定（与来源重要性无关，保证输出稳定、可重放）。 */
const SOURCE_ORDER: readonly ActiveMemorySourceCode[] = [
  'team_formal_memory',
  'channel_formal_memory',
  'task_fact',
  'agent_projection',
  'experience_pack',
];

/** 把 Active Memory Context items 渲染为 markdown 片段；空集合返回空串（调用方据此跳过拼入）。 */
export function renderActiveMemorySection(items: readonly ActiveMemoryContextItemDto[]): string {
  if (items.length === 0) return '';
  const grouped = new Map<ActiveMemorySourceCode, ActiveMemoryContextItemDto[]>();
  for (const item of items) {
    const list = grouped.get(item.provenance.source);
    if (list) {
      list.push(item);
    } else {
      grouped.set(item.provenance.source, [item]);
    }
  }
  const lines: string[] = [
    '## Active Memory Context',
    '以下记忆可能已过期或被取代；若与当前输入冲突，请以当前输入为准。',
  ];
  for (const source of SOURCE_ORDER) {
    const group = grouped.get(source);
    if (!group || group.length === 0) continue;
    lines.push(`### ${SOURCE_LABELS[source]}`);
    for (const item of group) {
      lines.push(`- [${item.provenance.source}:${item.id}] (${item.kind}; ${item.selectionReason}) ${item.content}`);
    }
  }
  return lines.join('\n');
}
