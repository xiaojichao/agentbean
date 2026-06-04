import { describe, expect, test } from 'vitest';
import {
  applyAgentSnapshot,
  applyChannelSnapshot,
  appendConversationMessage,
  applyDispatchStatus,
  createSessionStore,
  createWebSocketClient,
  type WebSocketTransport,
} from '../src/index';

describe('web-next first-slice state boundaries', () => {
  test('session store persists only token and current team', () => {
    const store = createSessionStore();

    store.save({
      token: 'token-1',
      currentTeamId: 'team-1',
      user: { id: 'user-1' },
      agents: [{ id: 'agent-1' }],
    });

    expect(store.load()).toEqual({ token: 'token-1', currentTeamId: 'team-1' });
  });

  test('snapshots replace server-owned agent and channel projections without local dedupe decisions', () => {
    expect(
      applyAgentSnapshot(
        [{ id: 'agent-old', name: 'Old' }],
        [
          { id: 'agent-1', name: 'Codex' },
          { id: 'agent-1', name: 'Codex duplicate from server' },
        ],
      ),
    ).toEqual([
      { id: 'agent-1', name: 'Codex' },
      { id: 'agent-1', name: 'Codex duplicate from server' },
    ]);

    expect(applyChannelSnapshot([], [{ id: 'channel-1', name: 'all' }])).toEqual([
      { id: 'channel-1', name: 'all' },
    ]);
  });

  test('conversation appends realtime messages and composer payload omits sender identity', async () => {
    const transport = new RecordingTransport();
    const client = createWebSocketClient(transport);
    const conversation = appendConversationMessage([], {
      id: 'message-1',
      body: 'hello',
      senderKind: 'agent',
    });

    await client.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
      clientMessageId: 'client-1',
    });

    expect(conversation).toEqual([{ id: 'message-1', body: 'hello', senderKind: 'agent' }]);
    expect(transport.emitted[0]?.[1]).toEqual({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
      clientMessageId: 'client-1',
    });
    expect(JSON.stringify(transport.emitted[0]?.[1])).not.toContain('sender');
  });

  test('dispatch status updates replace matching dispatch without reordering unrelated statuses', () => {
    expect(
      applyDispatchStatus(
        [
          { id: 'dispatch-1', status: 'queued' },
          { id: 'dispatch-2', status: 'running' },
        ],
        { id: 'dispatch-1', status: 'completed' },
      ),
    ).toEqual([
      { id: 'dispatch-1', status: 'completed' },
      { id: 'dispatch-2', status: 'running' },
    ]);

    expect(applyDispatchStatus([{ id: 'dispatch-1', status: 'queued' }], { id: 'dispatch-2', status: 'running' })).toEqual([
      { id: 'dispatch-1', status: 'queued' },
      { id: 'dispatch-2', status: 'running' },
    ]);
  });
});

class RecordingTransport implements WebSocketTransport {
  readonly emitted: Array<[string, unknown]> = [];

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    return { ok: true };
  }

  on(): void {
    // State tests only exercise command emission.
  }
}
