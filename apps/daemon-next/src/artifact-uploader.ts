import { readFileSync } from 'node:fs';
import type { CollectedArtifact } from './artifact-collector.js';

/** Matches the server's default single-artifact limit. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface UploadedArtifact {
  id: string;
  filename: string;
  mimeType: string;
  relativePath?: string;
  pathKind: 'generated';
  sha256: string;
  sizeBytes: number;
  role: CollectedArtifact['role'];
  sourceRoot: CollectedArtifact['sourceRoot'];
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
        mimeType: mimeTypeForFilename(artifact.filename),
        relativePath: artifact.relativePath,
        pathKind: 'generated',
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        role: artifact.role,
        sourceRoot: artifact.sourceRoot,
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
      const blob = new Blob([bytes], { type: mimeTypeForFilename(artifact.filename) });
      const form = new FormData();
      form.append('channelId', input.channelId);
      form.append('artifactRole', artifact.role);
      form.append('sourceRootId', artifact.sourceRoot.id);
      form.append('sourceRootKind', artifact.sourceRoot.kind);
      form.append('sourceRootLabel', artifact.sourceRoot.label);
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

function mimeTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}
