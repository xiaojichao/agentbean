import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildProjectDocumentInputSetResultProposal,
  collectProjectDocumentInputSetResults,
  materializeProjectDocumentInputSet,
} from '../src/project-document-input-set.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProjectDocumentInputSet materialization', () => {
  test('downloads with bearer auth, verifies all items, and publishes manifest atomically', async () => {
    const root = await tempRoot();
    const bytes = Buffer.from('# frozen revision\n');
    const fetchFn = vi.fn(async () => new Response(bytes, { status: 200 }));
    const result = await materializeProjectDocumentInputSet({
      serverUrl: 'https://server.example',
      token: 'device-token',
      teamId: 'team-1',
      invocationId: 'invocation-1',
      inputDir: root,
      inputSet: inputSet(bytes),
      fetch: fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://server.example/api/teams/team-1/artifacts/artifact-1/download',
      { headers: { Authorization: 'Bearer device-token' } },
    );
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toMatchObject({
      inputSetId: 'input-set-1',
      invocationId: 'invocation-1',
      items: [{ documentId: 'document-1', localPath: result.manifest.items[0]!.localPath }],
    });
    expect(readFileSync(result.manifest.items[0]!.localPath)).toEqual(bytes);
  });

  test('removes partial files and fails before execution when any required item is invalid', async () => {
    const root = await tempRoot();
    const bytes = Buffer.from('# tampered\n');
    await expect(materializeProjectDocumentInputSet({
      serverUrl: 'https://server.example',
      token: 'device-token',
      teamId: 'team-1',
      invocationId: 'invocation-1',
      inputDir: root,
      inputSet: inputSet(bytes, 'wrong-sha256'),
      fetch: async () => new Response(bytes, { status: 200 }),
    })).rejects.toThrow('PROJECT_DOCUMENT_INPUT_SET_SHA256_MISMATCH');
    expect(existsSync(join(root, 'input-set-input-set-1'))).toBe(false);
    expect(existsSync(join(root, 'input-set-input-set-1.staging'))).toBe(false);
  });

  test('submits each result by manifest identity and digest instead of filename or path', async () => {
    const root = await tempRoot();
    const original = Buffer.from('# original\n');
    const materialized = await materializeProjectDocumentInputSet({
      serverUrl: 'https://server.example',
      token: 'device-token',
      teamId: 'team-1',
      invocationId: 'invocation-1',
      inputDir: root,
      inputSet: inputSet(original),
      fetch: async () => new Response(original, { status: 200 }),
    });
    writeFileSync(materialized.manifest.items[0]!.localPath, '# changed\n');
    writeFileSync(join(dirname(materialized.manifestPath), 'new.md'), '# new\n');

    const collected = collectProjectDocumentInputSetResults(materialized);
    expect(collected.items).toEqual([{
      documentId: 'document-1',
      baseRevisionId: 'revision-1',
      status: 'changed',
      sha256: createHash('sha256').update('# changed\n').digest('hex'),
    }]);
    expect(collected.changedArtifacts[0]).toMatchObject({
      filename: 'plan.md',
      role: 'intermediate',
      sourceRoot: { label: '项目文档回写' },
    });
    expect(collected.newDocumentArtifacts).toMatchObject([{
      filename: 'new.md',
      role: 'run_output',
      relativePath: 'new.md',
    }]);

    const proposal = buildProjectDocumentInputSetResultProposal(materialized, collected, [{
      id: 'artifact-result-1',
      filename: 'renamed-locally.md',
      mimeType: 'text/markdown',
      relativePath: collected.changedArtifacts[0]!.relativePath,
      pathKind: 'generated',
      sha256: collected.changedArtifacts[0]!.sha256,
      sizeBytes: collected.changedArtifacts[0]!.sizeBytes,
      role: 'intermediate',
      sourceRoot: collected.changedArtifacts[0]!.sourceRoot,
    }]);
    expect(proposal.items).toEqual([{
      documentId: 'document-1',
      baseRevisionId: 'revision-1',
      status: 'changed',
      sha256: collected.changedArtifacts[0]!.sha256,
      artifactId: 'artifact-result-1',
    }]);
  });

  test('keeps equal-digest document outputs mapped to their own uploaded Artifacts', () => {
    const changed = createHash('sha256').update('# same\n').digest('hex');
    const materialized = {
      manifestPath: '/tmp/input-set/manifest.json',
      manifest: {
        contractVersion: 1 as const,
        inputSetId: 'input-set-1',
        invocationId: 'invocation-1',
        items: [],
      },
    };
    const sourceRoot = {
      id: 'project-document-input-set:input-set-1',
      kind: 'configured_output' as const,
      label: '项目文档回写',
    };
    const collected = {
      items: [
        { documentId: 'document-1', baseRevisionId: 'revision-1', status: 'changed' as const, sha256: changed },
        { documentId: 'document-2', baseRevisionId: 'revision-2', status: 'changed' as const, sha256: changed },
      ],
      changedArtifacts: [
        { documentId: 'document-1', absolutePath: '/tmp/input-set/001.md', relativePath: '001.md', sha256: changed, sizeBytes: 7, filename: 'one.md', role: 'intermediate' as const, sourceRoot },
        { documentId: 'document-2', absolutePath: '/tmp/input-set/002.md', relativePath: '002.md', sha256: changed, sizeBytes: 7, filename: 'two.md', role: 'intermediate' as const, sourceRoot },
      ],
      newDocumentArtifacts: [],
    };

    const proposal = buildProjectDocumentInputSetResultProposal(materialized, collected, [
      { id: 'artifact-1', filename: 'one.md', mimeType: 'text/markdown', relativePath: '001.md', pathKind: 'generated', sha256: changed, sizeBytes: 7, role: 'intermediate', sourceRoot },
      { id: 'artifact-2', filename: 'two.md', mimeType: 'text/markdown', relativePath: '002.md', pathKind: 'generated', sha256: changed, sizeBytes: 7, role: 'intermediate', sourceRoot },
    ]);
    expect(proposal.items.map((item) => item.artifactId)).toEqual(['artifact-1', 'artifact-2']);
  });
});

function inputSet(bytes: Buffer, sha256 = createHash('sha256').update(bytes).digest('hex')) {
  return {
    id: 'input-set-1',
    contractVersion: 1 as const,
    required: true as const,
    referenceSetId: 'reference-set-1',
    items: [{
      documentId: 'document-1',
      baseRevisionId: 'revision-1',
      revisionNumber: 1,
      artifactId: 'artifact-1',
      displayName: 'plan.md',
      summary: 'document',
      relativePath: 'documents/001-plan.md',
      mimeType: 'text/markdown',
      sizeBytes: bytes.byteLength,
      sha256,
      source: {
        referenceSetId: 'reference-set-1',
        selectionId: 'selection-1',
        selectionSourceKind: 'document' as const,
      },
    }],
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentbean-input-set-'));
  roots.push(root);
  return root;
}
