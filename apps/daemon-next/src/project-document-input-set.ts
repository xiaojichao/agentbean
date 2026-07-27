import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

type CollectedProjectDocumentInputSetItemResult =
  | Extract<ProjectDocumentInputSetItemResultProposalV1, { status: 'unchanged' | 'failed' }>
  | {
      readonly documentId: string;
      readonly baseRevisionId: string;
      readonly status: 'changed';
      readonly sha256: string;
    };

export interface CollectedProjectDocumentInputSetResults {
  readonly items: readonly CollectedProjectDocumentInputSetItemResult[];
  readonly changedArtifacts: ReadonlyArray<CollectedArtifact & { readonly documentId: string }>;
  readonly newDocumentArtifacts: readonly CollectedArtifact[];
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
      let response: Response;
      try {
        response = await fetchFn(url, {
          headers: { Authorization: `Bearer ${input.token}` },
        });
      } catch {
        throw new Error(`PROJECT_DOCUMENT_INPUT_SET_DOWNLOAD_FAILED:${item.documentId}:network`);
      }
      if (!response.ok) {
        throw new Error(`PROJECT_DOCUMENT_INPUT_SET_DOWNLOAD_FAILED:${item.documentId}:${response.status}`);
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await response.arrayBuffer());
      } catch {
        throw new Error(`PROJECT_DOCUMENT_INPUT_SET_DOWNLOAD_FAILED:${item.documentId}:body`);
      }
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
    if (error instanceof Error && error.message.startsWith('PROJECT_DOCUMENT_INPUT_SET_')) {
      throw error;
    }
    throw new Error('PROJECT_DOCUMENT_INPUT_SET_MATERIALIZATION_FAILED');
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
  const items: CollectedProjectDocumentInputSetItemResult[] = [];
  const changedArtifacts: Array<CollectedArtifact & { readonly documentId: string }> = [];
  const sourceRoot = {
    id: `project-document-input-set:${materialized.manifest.inputSetId}`,
    kind: 'configured_output' as const,
    label: '项目文档回写',
  };
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
        documentId: item.documentId,
        absolutePath: item.localPath,
        relativePath: relative(root, item.localPath),
        sha256,
        sizeBytes: stat.size,
        filename: item.displayName,
        role: 'intermediate',
        sourceRoot,
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
  const knownPaths = new Set(materialized.manifest.items.map((item) => item.localPath));
  const newDocumentArtifacts: CollectedArtifact[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(absolutePath);
        continue;
      }
      if (!entry.isFile()
        || knownPaths.has(absolutePath)
        || !/\.(?:md|markdown)$/i.test(entry.name)) continue;
      const bytes = readFileSync(absolutePath);
      newDocumentArtifacts.push({
        absolutePath,
        relativePath: relative(root, absolutePath),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.byteLength,
        filename: entry.name,
        role: 'run_output',
        sourceRoot,
      });
    }
  }
  return { items, changedArtifacts, newDocumentArtifacts };
}

export function buildProjectDocumentInputSetResultProposal(
  materialized: MaterializedProjectDocumentInputSet,
  collected: CollectedProjectDocumentInputSetResults,
  uploaded: readonly UploadedArtifact[],
): ProjectDocumentInputSetResultProposalV1 {
  const uploadedByRelativePath = new Map(
    uploaded.map((artifact) => [artifact.relativePath, artifact]),
  );
  return {
    contractVersion: 1,
    inputSetId: materialized.manifest.inputSetId,
    invocationId: materialized.manifest.invocationId,
    items: collected.items.map((item): ProjectDocumentInputSetItemResultProposalV1 => {
      if (item.status !== 'changed') return item;
      const changedArtifact = collected.changedArtifacts.find(
        (candidate) => candidate.documentId === item.documentId,
      );
      const artifact = changedArtifact
        ? uploadedByRelativePath.get(changedArtifact.relativePath)
        : undefined;
      return artifact
        ? { ...item, artifactId: artifact.id }
        : {
            documentId: item.documentId,
            baseRevisionId: item.baseRevisionId,
            status: 'failed' as const,
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
