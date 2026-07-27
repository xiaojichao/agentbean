import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type {
  ProjectDocumentInputSetItemResultProposalV1,
  ProjectDocumentInputSetManifestV1,
  ProjectDocumentInputSetResultProposalV1,
  ProjectDocumentInputSetV1,
} from '../../../packages/contracts/src/index.js';
import type { CollectedArtifact } from './artifact-collector.js';
import type { UploadedArtifact } from './artifact-uploader.js';

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

export interface CollectedProjectDocumentInputSetResults {
  readonly items: readonly ProjectDocumentInputSetItemResultProposalV1[];
  readonly changedArtifacts: readonly CollectedArtifact[];
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

/**
 * 执行完成后只按 manifest 身份逐项比较内容摘要。路径不会回传给 Server，
 * 仅用于在 Device 本地找到对应字节并上传 changed Artifact。
 */
export function collectProjectDocumentInputSetResults(
  materialized: MaterializedProjectDocumentInputSet,
): CollectedProjectDocumentInputSetResults {
  const root = dirname(materialized.manifestPath);
  const items: ProjectDocumentInputSetItemResultProposalV1[] = [];
  const changedArtifacts: CollectedArtifact[] = [];
  for (const item of materialized.manifest.items) {
    try {
      const bytes = readFileSync(item.localPath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 === item.sha256) {
        items.push({
          documentId: item.documentId,
          baseRevisionId: item.baseRevisionId,
          status: 'unchanged',
          sha256,
        });
        continue;
      }
      const stat = statSync(item.localPath);
      changedArtifacts.push({
        absolutePath: item.localPath,
        relativePath: relative(root, item.localPath),
        sha256,
        sizeBytes: stat.size,
        filename: item.displayName,
        role: 'intermediate',
        sourceRoot: {
          id: `project-document-input-set:${materialized.manifest.inputSetId}`,
          kind: 'configured_output',
          label: '项目文档回写',
        },
      });
      items.push({
        documentId: item.documentId,
        baseRevisionId: item.baseRevisionId,
        status: 'changed',
        sha256,
      });
    } catch (error) {
      items.push({
        documentId: item.documentId,
        baseRevisionId: item.baseRevisionId,
        status: 'failed',
        error: error instanceof Error ? error.message : 'PROJECT_DOCUMENT_INPUT_SET_RESULT_READ_FAILED',
      });
    }
  }
  return { items, changedArtifacts };
}

export function buildProjectDocumentInputSetResultProposal(
  materialized: MaterializedProjectDocumentInputSet,
  collected: CollectedProjectDocumentInputSetResults,
  uploaded: readonly UploadedArtifact[],
): ProjectDocumentInputSetResultProposalV1 {
  const uploadedByDigest = new Map(uploaded.map((artifact) => [artifact.sha256, artifact]));
  return {
    contractVersion: 1,
    inputSetId: materialized.manifest.inputSetId,
    invocationId: materialized.manifest.invocationId,
    items: collected.items.map((item) => {
      if (item.status !== 'changed' || !item.sha256) return item;
      const artifact = uploadedByDigest.get(item.sha256);
      return artifact
        ? { ...item, artifactId: artifact.id }
        : {
            documentId: item.documentId,
            baseRevisionId: item.baseRevisionId,
            status: 'failed' as const,
            sha256: item.sha256,
            error: 'PROJECT_DOCUMENT_INPUT_SET_RESULT_UPLOAD_FAILED',
          };
    }),
  };
}

function safeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}
