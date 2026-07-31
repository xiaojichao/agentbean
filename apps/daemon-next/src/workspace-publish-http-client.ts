/**
 * #967 hardening：daemon → Server Workspace publish staging HTTP 客户端。
 * put 走分块续传路由；begin/get/commit 走 JSON HTTP（与 socket 语义对齐，便于恢复上传）。
 */

import type { StagingRemoteClient } from './workspace-publish-recovery.js';

export interface CreateHttpWorkspaceStagingClientInput {
  readonly serverUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

/**
 * 构造 StagingRemoteClient：
 * - putChunk → POST /api/teams/:teamId/workspace-publish-staging/put（raw body）
 * - begin/get/commit 通过 usecase-equivalent JSON routes 尚未暴露时，
 *   由调用方用 socket 或注入实现；本客户端实现 put + 可选 JSON 扩展点。
 *
 * 当前 Server 已接线 put HTTP；begin/get/commit 仍以 socket/usecase 为主。
 * 本工厂实现 **putChunk** 的真实 HTTP，其余方法需由 `overrides` 补齐（通常接 socket emit）。
 */
export function createHttpWorkspaceStagingPutClient(
  input: CreateHttpWorkspaceStagingClientInput,
): Pick<StagingRemoteClient, 'putChunk'> {
  const fetchFn = input.fetch ?? fetch;
  const base = input.serverUrl.replace(/\/$/, '');

  return {
    async putChunk(put) {
      const url = new URL(
        `${base}/api/teams/${encodeURIComponent(put.teamId)}/workspace-publish-staging/put`,
      );
      url.searchParams.set('channelId', put.channelId);
      url.searchParams.set('publishId', put.publishId);
      url.searchParams.set('path', put.path);
      url.searchParams.set('offset', String(put.offset));
      const response = await fetchFn(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.token}`,
          'content-type': 'application/octet-stream',
          'x-channel-id': put.channelId,
          'x-publish-id': put.publishId,
          'x-workspace-path': put.path,
          'x-upload-offset': String(put.offset),
        },
        body: new Uint8Array(put.content),
      });
      let body: { ok?: boolean; error?: string; message?: string; staging?: { files: Array<{ path: string; receivedBytes: number; complete: boolean }> } };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        return { ok: false, error: `HTTP_${response.status}` };
      }
      if (!response.ok || !body.ok || !body.staging) {
        return { ok: false, error: body.error ?? body.message ?? `HTTP_${response.status}` };
      }
      return { ok: true, staging: body.staging };
    },
  };
}

/** 组合 put HTTP + 自定义 begin/get/commit（例如 socket emit）。 */
export function createHttpWorkspaceStagingClient(
  input: CreateHttpWorkspaceStagingClientInput & {
    readonly begin: StagingRemoteClient['begin'];
    readonly get: StagingRemoteClient['get'];
    readonly commit: StagingRemoteClient['commit'];
  },
): StagingRemoteClient {
  const putClient = createHttpWorkspaceStagingPutClient(input);
  return {
    begin: input.begin,
    get: input.get,
    commit: input.commit,
    putChunk: putClient.putChunk.bind(putClient),
  };
}
