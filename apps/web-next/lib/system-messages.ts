import { isHiddenSystemMessage } from '@agentbean/contracts';
import type { ChatMessage } from './schema';

/**
 * 决定一条系统消息是否应从用户对话视图（频道主时间线、Thread 回复列表、回复计数）中隐藏。
 *
 * 规则的单一真相源是 @agentbean/contracts 的 isHiddenSystemMessage——服务端在序列化边界
 * （enrichMessagesWithArtifacts）同样用它，从源头不再把 PI 系统消息发给前端。这里作为前端
 * 防御层：兜底本地/乐观消息，并防未来新的投递路径绕过服务端过滤。management-question /
 * management-delivery 保留可见（前者需回应，后者需验收）。
 *
 * ADR-0066：PI Manager 是 Server-hosted 内部编排运行时，不以成员/头像/聊天气泡/typing 出现。
 */
export function shouldHideSystemMessage(msg: ChatMessage): boolean {
  return isHiddenSystemMessage({ senderKind: msg.senderKind, meta: parseMessageMeta(msg) });
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
