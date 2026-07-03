import { describe, expect, test } from 'vitest';
import { chatArtifactUrl } from '../lib/chat-artifact-url';
import type { Artifact } from '../lib/schema';

const baseArtifact: Artifact = {
  id: 'artifact image/1',
  filename: 'ChatGPT Image.png',
  mimeType: 'image/png',
  sizeBytes: 42,
  createdAt: 1,
};

describe('chatArtifactUrl', () => {
  test('为缺少 previewUrl 的上传图片按 teamId 生成可预览地址', () => {
    expect(
      chatArtifactUrl(baseArtifact, 'preview', {
        serverUrl: 'https://agentbean.dev',
        token: 'token 1',
        teamId: 'team 1',
      }),
    ).toBe('https://agentbean.dev/api/teams/team%201/artifacts/artifact%20image%2F1/preview?token=token%201');
  });

  test('服务端已返回 URL 时优先使用原始 previewUrl', () => {
    expect(
      chatArtifactUrl(
        {
          ...baseArtifact,
          previewUrl: '/api/teams/server-team/artifacts/server-artifact/preview?size=large',
        },
        'preview',
        {
          serverUrl: 'https://agentbean.dev',
          token: 'token 1',
          teamId: 'team 1',
        },
      ),
    ).toBe('https://agentbean.dev/api/teams/server-team/artifacts/server-artifact/preview?size=large&token=token%201');
  });

  test('没有可归属 teamId 时返回 null', () => {
    expect(
      chatArtifactUrl(baseArtifact, 'download', {
        serverUrl: 'https://agentbean.dev',
        token: 'token 1',
      }),
    ).toBeNull();
  });
});
