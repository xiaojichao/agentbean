import { introPrompt } from './prompt.js';
import type { AgentRuntime } from './registry.js';
import { newId } from './ids.js';

export interface IntroChannel { id: string; name: string }

export interface DispatchResult { ok: boolean; body?: string; error?: string; artifactIds?: string[]; }

export type DispatchFn = (req: {
  agentId: string;
  channelId: string;
  prompt: string;
  requestId: string;
  networkId?: string;
}) => Promise<DispatchResult>;

export interface IntroMessage {
  id: string;
  channelId: string;
  senderKind: 'agent' | 'system';
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson: string | null;
}

export interface RunIntrosInput {
  channel: IntroChannel;
  members: AgentRuntime[];
  dispatch: DispatchFn;
  onMessage: (m: IntroMessage) => void;
}

export async function runIntros(input: RunIntrosInput): Promise<void> {
  for (const m of input.members) {
    if (m.status !== 'online') {
      input.onMessage({
        id: newId(),
        channelId: input.channel.id,
        senderKind: 'system',
        senderId: null,
        body: `${m.name} 当前离线,未发送自我介绍。`,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'intro-skip', agentId: m.id }),
      });
      continue;
    }
    const requestId = newId();
    const result = await input.dispatch({
      agentId: m.id,
      channelId: input.channel.id,
      prompt: introPrompt({ channelName: input.channel.name, role: m.role }),
      requestId,
    });
    if (result.ok && result.body) {
      input.onMessage({
        id: newId(),
        channelId: input.channel.id,
        senderKind: 'agent',
        senderId: m.id,
        body: result.body,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'intro' }),
      });
    } else {
      input.onMessage({
        id: newId(),
        channelId: input.channel.id,
        senderKind: 'system',
        senderId: null,
        body: `${m.name} 自我介绍失败: ${result.error ?? 'unknown'}`,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'intro-fail', agentId: m.id }),
      });
    }
  }
}
