import type { ChatMessage } from './schema';

export function shouldHideTaskSystemMessage(msg: ChatMessage): boolean {
  if (msg.senderKind !== 'system') return false;
  const meta = parseMessageMeta(msg);
  return meta.kind === 'task-created';
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
