import type { ChatMessage, Artifact } from '@/lib/schema';
import { useAgentBeanStore } from '@/lib/store';
import { getResolvedServerUrl, getStoredAuthToken } from '@/lib/socket';
import { messageSpeakerName } from '@/lib/display-names';

const KIND_LABEL: Record<ChatMessage['senderKind'], string> = {
  human: '你',
  agent: 'Agent',
  system: '系统',
};

function artifactUrl(path: string): string {
  const token = getStoredAuthToken();
  const sep = path.includes('?') ? '&' : '?';
  return `${getResolvedServerUrl()}${path}${sep}token=${encodeURIComponent(token)}`;
}

function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  if (artifact.mimeType.startsWith('image/')) {
    return (
      <a href={artifactUrl(artifact.downloadUrl)} target="_blank" rel="noreferrer">
        <img
          src={artifactUrl(artifact.previewUrl)}
          alt={artifact.filename}
          className="max-h-48 rounded border border-neutral-100"
        />
      </a>
    );
  }
  return (
    <a
      href={artifactUrl(artifact.downloadUrl)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-blue-600 hover:underline"
    >
      {artifact.filename} ({(artifact.sizeBytes / 1024).toFixed(1)} KB)
    </a>
  );
}

export function ChannelMessage({ msg }: { msg: ChatMessage }) {
  const agent = useAgentBeanStore((s) => msg.senderId ? s.agents[msg.senderId] : undefined);
  const agents = msg.senderId && agent ? { [msg.senderId]: agent } : {};
  const speaker = msg.senderKind === 'agent'
    ? messageSpeakerName(msg, agents)
    : KIND_LABEL[msg.senderKind];
  const time = new Date(msg.createdAt).toLocaleTimeString('zh-CN');

  const meta = (() => {
    if (msg.metaJson) {
      try { return JSON.parse(msg.metaJson); } catch { return undefined; }
    }
    return undefined;
  })();

  if (msg.senderKind === 'system') {
    const tone = meta?.kind === 'reply-fail' || meta?.kind === 'no-online'
      ? 'border-red-500/40 text-red-700 bg-red-50'
      : 'border-amber-500/40 text-amber-700 bg-amber-50';
    return (
      <div className={`mx-auto my-1 max-w-prose rounded border px-2 py-1 text-center text-xs ${tone}`}>
        {msg.body}
      </div>
    );
  }

  const tone = msg.senderKind === 'human'
    ? 'bg-sky-50 text-sky-900 border-sky-100'
    : 'bg-white border-neutral-200';
  return (
    <div className={`rounded border ${tone} px-3 py-2`}>
      <div className="flex items-center justify-between text-xs text-neutral-500 mb-1">
        <span className="font-medium">{speaker}</span>
        <span>{time}</span>
      </div>
      <div className="whitespace-pre-wrap text-sm">{msg.body}</div>
      {msg.artifacts && msg.artifacts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {msg.artifacts.map((a) => (
            <ArtifactPreview key={a.id} artifact={a} />
          ))}
        </div>
      )}
    </div>
  );
}
