export const CHANNEL_DOCUMENT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHANNEL_DOCUMENT_DRAFT_PREFIX = 'agentbean.channel-document-draft:';

export interface ChannelDocumentDraftIdentity {
  userId: string;
  teamId: string;
  documentId: string;
  baseRevisionId: string;
}

export interface ChannelDocumentDraft {
  content: string;
  filename: string;
  updatedAt: number;
}

function draftKey(identity: ChannelDocumentDraftIdentity): string {
  return CHANNEL_DOCUMENT_DRAFT_PREFIX + [
    identity.userId,
    identity.teamId,
    identity.documentId,
    identity.baseRevisionId,
  ].map(encodeURIComponent).join(':');
}

export function writeChannelDocumentDraft(
  storage: Storage,
  identity: ChannelDocumentDraftIdentity,
  draft: ChannelDocumentDraft,
): void {
  storage.setItem(draftKey(identity), JSON.stringify(draft));
}

export function readChannelDocumentDraft(
  storage: Storage,
  identity: ChannelDocumentDraftIdentity,
  now = Date.now(),
): ChannelDocumentDraft | null {
  const key = draftKey(identity);
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as Partial<ChannelDocumentDraft>;
    if (
      typeof draft.content !== 'string'
      || typeof draft.filename !== 'string'
      || typeof draft.updatedAt !== 'number'
      || !Number.isFinite(draft.updatedAt)
      || now - draft.updatedAt > CHANNEL_DOCUMENT_DRAFT_TTL_MS
    ) {
      storage.removeItem(key);
      return null;
    }
    return {
      content: draft.content,
      filename: draft.filename,
      updatedAt: draft.updatedAt,
    };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function removeChannelDocumentDraft(
  storage: Storage,
  identity: ChannelDocumentDraftIdentity,
): void {
  storage.removeItem(draftKey(identity));
}

export function clearChannelDocumentDrafts(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(CHANNEL_DOCUMENT_DRAFT_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
