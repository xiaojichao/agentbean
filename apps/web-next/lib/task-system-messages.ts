import type { ChatMessage } from './schema';

export function shouldHideTaskSystemMessage(msg: ChatMessage): boolean {
  if (msg.senderKind !== 'system') return false;
  const meta = parseMessageMeta(msg);
  return meta.kind === 'task-created';
}

function parseMessageMeta(msg: ChatMessage): Record<string, unknown> {
  if (!msg.metaJson) return {};
  try {
    return JSON.parse(msg.metaJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}
