import { readFileSync } from 'node:fs';
import type { CollectedArtifact } from './artifact-collector.js';

/** 10MB, matching server MAX_ARTIFACT_UPLOAD_BODY_BYTES. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface UploadedArtifact {
  id: string;
  filename: string;
  relativePath?: string;
  pathKind: 'generated';
  sha256: string;
  sizeBytes: number;
}

export interface UploadArtifactsInput {
  serverUrl: string;
  token: string;
  teamId: string;
  channelId: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  maxBytes?: number;
}

/**
 * Uploads each collected artifact via the server multipart upload route and returns
 * the server-assigned artifact ids. Failures (after retries) and oversize files are
 * skipped so they never block the dispatch result.
 */
export async function uploadArtifacts(
  input: UploadArtifactsInput,
  collected: CollectedArtifact[],
): Promise<UploadedArtifact[]> {
  const fetchFn = input.fetch ?? fetch;
  const maxRetries = input.maxRetries ?? 2;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const results: UploadedArtifact[] = [];

  for (const artifact of collected) {
    if (artifact.sizeBytes > maxBytes) {
      continue;
    }
    const id = await uploadOne(fetchFn, input, artifact, maxRetries);
    if (id) {
      results.push({
        id,
        filename: artifact.filename,
        relativePath: artifact.relativePath,
        pathKind: 'generated',
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      });
    }
  }
  return results;
}

async function uploadOne(
  fetchFn: typeof fetch,
  input: UploadArtifactsInput,
  artifact: CollectedArtifact,
  maxRetries: number,
): Promise<string | undefined> {
  const url = `${input.serverUrl}/api/teams/${encodeURIComponent(input.teamId)}/artifacts/upload`;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const bytes = readFileSync(artifact.absolutePath);
      const blob = new Blob([bytes]);
      const form = new FormData();
      form.append('channelId', input.channelId);
      form.append('file', blob, artifact.filename);
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.token}` },
        body: form,
      });
      if (!response.ok) {
        if (attempt < maxRetries) {
          continue;
        }
        return undefined;
      }
      const body = (await response.json()) as { ok: true; artifact: { id: string } };
      return body.artifact.id;
    } catch {
      if (attempt < maxRetries) {
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}
