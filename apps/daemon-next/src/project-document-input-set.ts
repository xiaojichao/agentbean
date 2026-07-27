import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ProjectDocumentInputSetManifestV1,
  ProjectDocumentInputSetV1,
} from '../../../packages/contracts/src/index.js';

export interface MaterializeProjectDocumentInputSetInput {
  serverUrl: string;
  token: string;
  teamId: string;
  invocationId: string;
  inputDir: string;
  inputSet: ProjectDocumentInputSetV1;
  fetch?: typeof fetch;
}

export interface MaterializedProjectDocumentInputSet {
  manifest: ProjectDocumentInputSetManifestV1;
  manifestPath: string;
}

/**
 * 必需 InputSet 的全有或全无物化。
 * 只有全部 HTTP 下载、size/SHA-256 校验和 manifest 写入完成后才原子 rename 到最终目录。
 */
export async function materializeProjectDocumentInputSet(
  input: MaterializeProjectDocumentInputSetInput,
): Promise<MaterializedProjectDocumentInputSet> {
  const fetchFn = input.fetch ?? fetch;
  const safeId = safeSegment(input.inputSet.id) || 'input-set';
  const finalDir = join(input.inputDir, `input-set-${safeId}`);
  const stagingDir = `${finalDir}.staging`;
  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(finalDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  try {
    const manifestItems = [];
    for (const item of input.inputSet.items) {
      const url = `${input.serverUrl}/api/teams/${encodeURIComponent(input.teamId)}/artifacts/${encodeURIComponent(item.artifactId)}/download`;
      const response = await fetchFn(url, {
        headers: { Authorization: `Bearer ${input.token}` },
      });
      if (!response.ok) {
        throw new Error(`PROJECT_DOCUMENT_INPUT_SET_DOWNLOAD_FAILED:${item.documentId}:${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength !== item.sizeBytes) {
        throw new Error(`PROJECT_DOCUMENT_INPUT_SET_SIZE_MISMATCH:${item.documentId}`);
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== item.sha256) {
        throw new Error(`PROJECT_DOCUMENT_INPUT_SET_SHA256_MISMATCH:${item.documentId}`);
      }
      const filename = `${String(manifestItems.length + 1).padStart(3, '0')}-${safeSegment(
        basename(item.relativePath || item.displayName),
      ) || 'document.md'}`;
      const stagingPath = join(stagingDir, filename);
      const localPath = join(finalDir, filename);
      writeFileSync(stagingPath, bytes);
      manifestItems.push({ ...item, localPath });
    }

    const manifest: ProjectDocumentInputSetManifestV1 = {
      contractVersion: 1,
      inputSetId: input.inputSet.id,
      invocationId: input.invocationId,
      items: manifestItems,
    };
    writeFileSync(
      join(stagingDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    renameSync(stagingDir, finalDir);
    return { manifest, manifestPath: join(finalDir, 'manifest.json') };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(finalDir, { recursive: true, force: true });
    throw error;
  }
}

function safeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}
