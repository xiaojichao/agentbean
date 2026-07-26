import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { materializeProjectDocumentInputSet } from '../src/project-document-input-set.js';

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
