import type { ChatMessage } from './schema';

/**
 * 决定一条系统消息是否应从用户对话视图（频道主时间线、Thread 回复列表、回复计数）中隐藏。
 *
 * 隐藏的判定独立于渲染：被隐藏的消息不进入 visibleMessages，因此既不渲染为聊天气泡/
 * 系统药丸，也不计入 Thread 回复数。management-question / management-delivery 保留可见：
 * 前者是 PI Manager 向用户提问（需回应），后者是 PI Manager 提交的交付物（需验收）。
 *
 * ADR-0066：PI Manager 是 Server-hosted 内部编排运行时，不以成员/头像/聊天气泡/typing 出现。
 */
export function shouldHideSystemMessage(msg: ChatMessage): boolean {
  if (msg.senderKind !== 'system') return false;
  const meta = parseMessageMeta(msg);
  // task-created：已由 Task 消息/活动卡代表，去重隐藏。
  if (meta.kind === 'task-created') return true;
  // management-status：PI 运行时状态更新，属瞬态编排噪音（management-tool-executor.ts）。
  if (meta.kind === 'management-status') return true;
  // PI 协调输出：channel-coordination-coordinator.ts 以 senderId='pi-coordinator'、
  // meta.coordination 落库，正文以「PI 建议…」开头的内部建议，不作为用户可见聊天气泡。
  if (meta.coordination !== undefined) return true;
  return false;
}

function parseMessageMeta(msg: ChatMessage): Record<string, unknown> {
  if (msg.meta && typeof msg.meta === 'object') return msg.meta;
  if (!msg.metaJson) return {};
  try {
    const parsed = JSON.parse(msg.metaJson);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
