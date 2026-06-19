import { describe, expect, test } from 'vitest';
import type {
  CreateDaemonProtocolClientInput,
  DaemonDispatchArtifactResult,
  DispatchRequestPayload,
} from '../src/index';

describe('daemon-next index types', () => {
  test('DispatchRequestPayload accepts attachments', () => {
    const payload: DispatchRequestPayload = {
      id: 'd1',
      teamId: 't1',
      channelId: 'c1',
      messageId: 'm1',
      agentId: 'a1',
      requestId: 'r1',
      prompt: 'p',
      attachments: [{ id: 'att-1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 1 }],
    };
    expect(payload.attachments?.[0].name).toBe('a.txt');
  });

  test('DispatchRequestPayload works without attachments (backward compatible)', () => {
    const payload: DispatchRequestPayload = {
      id: 'd1', teamId: 't1', channelId: 'c1', messageId: 'm1', agentId: 'a1', requestId: 'r1', prompt: 'p',
    };
    expect(payload.attachments).toBeUndefined();
  });

  test('CreateDaemonProtocolClientInput requires serverUrl', () => {
    const input: CreateDaemonProtocolClientInput = {
      socket: {} as never,
      executor: async () => 'x',
      device: { teamId: 't1', ownerId: 'o1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
    };
    expect(input.serverUrl).toBe('http://server.test');
  });

  test('DaemonDispatchArtifactResult supports id-only references (no contentBase64)', () => {
    const artifact: DaemonDispatchArtifactResult = {
      id: 'uploaded-id',
      filename: 'out.png',
      pathKind: 'generated',
      relativePath: 'outputs/out.png',
    };
    expect(artifact.contentBase64).toBeUndefined();
  });
});
