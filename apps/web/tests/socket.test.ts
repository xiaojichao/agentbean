import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactUploadFallbackUrls, artifactUploadProxyUrl, artifactUploadUrl, uploadArtifact } from '../lib/socket';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('artifactUploadUrl', () => {
  it('builds a backend authenticated upload URL', () => {
    expect(artifactUploadUrl('team one/x')).toBe('http://localhost:4000/api/networks/team%20one%2Fx/artifacts/upload?token=');
  });

  it('keeps the same-origin proxy as an upload fallback', () => {
    expect(artifactUploadProxyUrl('team one/x')).toBe('/api/networks/team%20one%2Fx/artifacts/upload?token=');
    expect(artifactUploadFallbackUrls('team one/x')).toEqual([
      'http://localhost:4000/api/networks/team%20one%2Fx/artifacts/upload?token=',
      '/api/networks/team%20one%2Fx/artifacts/upload?token=',
    ]);
  });

  it('falls back to the same-origin proxy if the direct upload cannot be fetched', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'artifact-1',
        filename: 'hello.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        createdAt: 1,
        downloadUrl: '/download',
        previewUrl: '/preview',
      }), { status: 201, headers: { 'content-type': 'application/json' } }));

    const form = new FormData();
    form.append('channelId', 'channel-1');
    form.append('uploaderId', 'user-1');
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');

    await expect(uploadArtifact('default', form)).resolves.toMatchObject({ id: 'artifact-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:4000/api/networks/default/artifacts/upload?token=', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/networks/default/artifacts/upload?token=', expect.objectContaining({ method: 'POST' }));
  });
});
