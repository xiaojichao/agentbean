import { isHiddenSystemMessage } from '@agentbean/contracts';
import { inlineOutputPackageFromMeta, outputPackageFromMeta } from './output-package';
import type { ChatMessage } from './schema';

/**
 * 决定一条系统消息是否应从用户对话视图（频道主时间线、Thread 回复列表、回复计数）中隐藏。
 *
 * 规则的单一真相源是 @agentbean/contracts 的 isHiddenSystemMessage——服务端在序列化边界
 * （enrichMessagesWithArtifacts）同样用它，从源头不再把噪音系统消息发给前端。这里作为前端
 * 防御层：兜底本地/乐观消息，并防未来新的投递路径绕过服务端过滤。management-question /
 * management-delivery 保留可见（前者需回应，后者需验收）。
 * artifact-version-revision（含历史落库）亦隐藏：文件状态看 Files/Task，不进聊天流。
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

/**
 * #1111 内嵌形态:被 agent 回复内嵌吸收的独立 output-package 卡片 id 集合。
 * 某条消息的 meta.outputPackageCard.packageId 与独立卡片相同的,独立卡片隐藏——
 * 覆盖「卡片先到(commit)、回复后到(result)」的实时窗口:回复一到达,
 * 独立卡片即从视图消失,卡片内容随回复气泡内嵌渲染。
 */
export function mergedStandalonePackageCardIds(messages: readonly ChatMessage[]): Set<string> {
  const inlinedPackageIds = new Set<string>();
  for (const message of messages) {
    const inline = inlineOutputPackageFromMeta(parseMessageMeta(message));
    if (inline) inlinedPackageIds.add(inline.packageId);
  }
  const hidden = new Set<string>();
  if (inlinedPackageIds.size === 0) return hidden;
  for (const message of messages) {
    const standalone = outputPackageFromMeta(parseMessageMeta(message));
    if (standalone && inlinedPackageIds.has(standalone.packageId)) hidden.add(message.id);
  }
  return hidden;
}
