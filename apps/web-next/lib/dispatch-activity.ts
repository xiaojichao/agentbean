import type { ChatMessage, DispatchStatus } from './schema';

const MAX_OBJECTIVE_CHARS = 72;

function truncateText(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join('')}…`;
}

export function dispatchObjective(body: string): string | null {
  const objective = body
    .trim()
    .replace(/^(?:@\S+\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return objective ? truncateText(objective, MAX_OBJECTIVE_CHARS) : null;
}

export function pendingDispatchStatusText(input: {
  status: Extract<DispatchStatus, 'queued' | 'sent' | 'accepted' | 'running'>;
  body: string;
  agentName?: string;
}): string {
  const mentionedAgent = input.body.trim().match(/^@(\S+)/)?.[1];
  const agentName = input.agentName?.trim() || mentionedAgent || 'Agent';
  const objective = dispatchObjective(input.body);
  const objectiveText = objective ? `：「${objective}」` : '';

  if (input.status === 'queued' || input.status === 'sent') {
    return `正在发送给 ${agentName}${objectiveText}`;
  }
  return `${agentName} 已接收，正在处理${objectiveText}`;
}

export function isDispatchAgentMessage(message: ChatMessage, dispatchId?: string): boolean {
  if (message.senderKind !== 'agent') return false;
  let meta = message.meta;
  if ((!meta || typeof meta !== 'object') && message.metaJson) {
    try {
      meta = JSON.parse(message.metaJson) as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  return Boolean(
    meta
    && typeof meta === 'object'
    && meta.kind === 'dispatch-agent-message'
    && (!dispatchId || meta.dispatchId === dispatchId),
  );
}
