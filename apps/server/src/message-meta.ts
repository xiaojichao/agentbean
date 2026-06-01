export interface MessageWithMeta {
  senderKind: string;
  metaJson?: string | null;
}

function parseMeta(metaJson: string | null | undefined): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function enrichAgentSenderName<T extends MessageWithMeta>(message: T, senderName: string | null | undefined): T {
  const cleanName = (senderName ?? '').trim();
  if (message.senderKind !== 'agent' || !cleanName) return message;

  const meta = parseMeta(message.metaJson);
  const existingName = typeof meta.senderName === 'string' ? meta.senderName.trim() : '';
  if (existingName) return message;

  return {
    ...message,
    metaJson: JSON.stringify({ ...meta, senderName: cleanName }),
  };
}
