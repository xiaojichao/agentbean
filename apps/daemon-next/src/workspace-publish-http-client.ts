/**
 * #967 / #1003：daemon → Server Workspace publish staging 全 HTTP 客户端。
 * begin/get/commit JSON；put 分块 raw body。
 */

import type { StagingRemoteClient } from './workspace-publish-recovery.js';

export interface CreateHttpWorkspaceStagingClientInput {
  readonly serverUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

/** 完整 StagingRemoteClient（HTTP only，device 或 session Bearer）。 */
export function createHttpWorkspaceStagingClient(
  input: CreateHttpWorkspaceStagingClientInput,
): StagingRemoteClient {
  const fetchFn = input.fetch ?? fetch;
  const base = String(input.serverUrl ?? '').replace(/\/$/, '');
  if (!base) {
    const missing = async (): Promise<{ ok: false; error: string }> => (
      { ok: false, error: 'SERVER_URL_MISSING' }
    );
    return {
      begin: missing,
      putChunk: missing,
      get: missing,
      commit: missing,
    };
  }
  const auth = { Authorization: `Bearer ${input.token}` };

  async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return {
    async begin(begin) {
      const response = await fetchFn(
        `${base}/api/teams/${encodeURIComponent(begin.teamId)}/workspace-publish-staging/begin`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            channelId: begin.channelId,
            publishId: begin.publishId,
            baselineRevisionId: begin.baselineRevisionId,
            files: begin.files,
            ...(begin.provenance ? { provenance: begin.provenance } : {}),
          }),
        },
      );
      const body = await readJson(response);
      if (!response.ok || body.ok !== true || !body.staging) {
        return { ok: false, error: String(body.error ?? body.message ?? `HTTP_${response.status}`) };
      }
      return {
        ok: true,
        staging: body.staging as {
          status: string;
          files: Array<{ path: string; receivedBytes: number; complete: boolean }>;
        },
      };
    },

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
          ...auth,
          'content-type': 'application/octet-stream',
          'x-channel-id': put.channelId,
          'x-publish-id': put.publishId,
          'x-workspace-path': put.path,
          'x-upload-offset': String(put.offset),
        },
        body: new Uint8Array(put.content),
      });
      const body = await readJson(response);
      if (!response.ok || body.ok !== true || !body.staging) {
        return { ok: false, error: String(body.error ?? body.message ?? `HTTP_${response.status}`) };
      }
      return {
        ok: true,
        staging: body.staging as {
          files: Array<{ path: string; receivedBytes: number; complete: boolean }>;
        },
      };
    },

    async get(get) {
      const url = new URL(
        `${base}/api/teams/${encodeURIComponent(get.teamId)}/workspace-publish-staging`,
      );
      url.searchParams.set('channelId', get.channelId);
      url.searchParams.set('publishId', get.publishId);
      const response = await fetchFn(url.toString(), { method: 'GET', headers: auth });
      const body = await readJson(response);
      if (!response.ok || body.ok !== true || !body.staging) {
        return { ok: false, error: String(body.error ?? body.message ?? `HTTP_${response.status}`) };
      }
      return {
        ok: true,
        staging: body.staging as {
          status: string;
          committedRevisionId?: string;
          files: Array<{ path: string; receivedBytes: number; complete: boolean }>;
        },
      };
    },

    async commit(commit) {
      const response = await fetchFn(
        `${base}/api/teams/${encodeURIComponent(commit.teamId)}/workspace-publish-staging/commit`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            channelId: commit.channelId,
            publishId: commit.publishId,
          }),
        },
      );
      const body = await readJson(response);
      if (!response.ok || body.ok !== true || !body.staging) {
        const details = body.details as { conflictingPaths?: string[] } | undefined;
        return {
          ok: false,
          error: String(body.error ?? body.message ?? `HTTP_${response.status}`),
          ...(details ? { details } : {}),
        };
      }
      return {
        ok: true,
        staging: body.staging as { status: string; committedRevisionId?: string },
        ...(body.workspace
          ? {
              workspace: body.workspace as {
                currentRevisionId: string;
                currentRevision?: {
                  id: string;
                  files: Array<{ path: string; artifactId: string }>;
                };
              },
            }
          : {}),
      };
    },
  };
}

/** 仅 put 客户端（向后兼容旧测试名）。 */
export function createHttpWorkspaceStagingPutClient(
  input: CreateHttpWorkspaceStagingClientInput,
): Pick<StagingRemoteClient, 'putChunk'> {
  const full = createHttpWorkspaceStagingClient(input);
  return { putChunk: full.putChunk.bind(full) };
}

/** 读取频道当前 Workspace revision（device materialize / user get）。 */
export async function fetchProjectChannelWorkspaceCurrent(input: {
  serverUrl: string;
  token: string;
  teamId: string;
  channelId: string;
  fetch?: typeof fetch;
}): Promise<{ ok: true; currentRevisionId: string } | { ok: false; error: string }> {
  const fetchFn = input.fetch ?? fetch;
  const base = String(input.serverUrl ?? '').replace(/\/$/, '');
  if (!base) return { ok: false, error: 'SERVER_URL_MISSING' };
  const url = new URL(`${base}/api/teams/${encodeURIComponent(input.teamId)}/project-channel-workspace`);
  url.searchParams.set('channelId', input.channelId);
  const response = await fetchFn(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${input.token}` },
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!response.ok || body.ok !== true || !body.workspace) {
    return { ok: false, error: String(body.error ?? body.message ?? `HTTP_${response.status}`) };
  }
  const workspace = body.workspace as { currentRevisionId?: string; currentRevision?: { id?: string } };
  const id = workspace.currentRevisionId ?? workspace.currentRevision?.id;
  if (!id) return { ok: false, error: 'WORKSPACE_REVISION_MISSING' };
  return { ok: true, currentRevisionId: id };
}
