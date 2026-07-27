import { describe, expect, test } from 'vitest';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('managed Dispatch lifecycle bridge', () => {
  test('records a canonical terminal Dispatch/event without completing the managed root Task', async () => {
    const harness = await createHarness(true);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    const dispatchId = created.view.dispatchAttempts[0]!.dispatchId;

    await expect(harness.usecases.receiveDispatchResult({ dispatchId, agentId: 'agent-1', body: '原始交付' }))
      .resolves.toMatchObject({ ok: true, dispatch: { status: 'succeeded' } });
    await expect(harness.repositories.tasks.getById('task-1')).resolves.toMatchObject({ status: 'in_progress' });
    const events = await harness.repositories.management.events.list(harness.authority.managementRunId);
    expect(events.filter(({ event }) => event.type === 'dispatch-attempt-completed')).toHaveLength(1);
    await expect(harness.gateway.getView(created.view.id)).resolves.toMatchObject({ status: 'succeeded' });
  });

  test('keeps the existing direct result path unchanged', async () => {
    const harness = await createHarness(false);
    await harness.repositories.dispatches.create({ id: 'direct-dispatch', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1', agentId: 'agent-1', status: 'queued', requestId: 'direct-1', prompt: '完成目标', createdAt: 1, updatedAt: 1 });

    await expect(harness.usecases.receiveDispatchResult({ dispatchId: 'direct-dispatch', agentId: 'agent-1', body: '直接交付' }))
      .resolves.toMatchObject({ ok: true, task: { status: 'in_review' } });
    await expect(harness.repositories.tasks.getById('task-1')).resolves.toMatchObject({ status: 'in_review' });
  });

  test('reclaims manifest results independently, preserves OCC conflicts, and replays idempotently', async () => {
    const harness = await createHarness(true);
    await seedProjectDocumentInputSet(harness.repositories);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    expect(created.view.intent.schemaVersion).toBe(2);
    if (created.view.intent.schemaVersion !== 2) throw new Error('expected V2 InputSet');
    const inputSetId = created.view.intent.projectDocumentInputSet.id;
    const dispatchId = created.view.dispatchAttempts[0]!.dispatchId;

    await harness.repositories.channelDocuments.addRevision({
      documentId: 'document-3',
      expectedCurrentRevisionId: 'revision-3',
      document: {
        id: 'document-3', teamId: 'team-1', channelId: 'channel-1', filename: 'third.md',
        currentRevisionId: 'human-revision-3', createdAt: 1, updatedAt: 15,
      },
      revision: {
        id: 'human-revision-3', documentId: 'document-3',
        artifact: markdownArtifact('human-artifact-3', 'third.md', 'human-sha'),
        revision: 2, createdBy: 'user-1', createdAt: 15, source: 'edit', published: false,
      },
      artifact: markdownArtifact('human-artifact-3', 'third.md', 'human-sha'),
      operation: {
        documentId: 'document-3', idempotencyKey: 'human-edit-3',
        operationType: 'save', requestFingerprint: 'human-edit-3', revisionId: 'human-revision-3',
      },
    });
    for (const artifact of [
      markdownArtifact('artifact-result-2', 'second.md', 'changed-sha-2'),
      markdownArtifact('artifact-result-3', 'third-renamed.md', 'changed-sha-3'),
      markdownArtifact('artifact-new', 'new.md', 'new-sha'),
    ]) await harness.repositories.artifacts.create(artifact);

    const proposal = {
      contractVersion: 1 as const,
      inputSetId,
      invocationId: created.view.id,
      items: [
        { documentId: 'document-1', baseRevisionId: 'revision-1', status: 'unchanged' as const, sha256: 'sha-1' },
        { documentId: 'document-2', baseRevisionId: 'revision-2', status: 'changed' as const, sha256: 'changed-sha-2', artifactId: 'artifact-result-2' },
        { documentId: 'document-3', baseRevisionId: 'revision-3', status: 'changed' as const, sha256: 'changed-sha-3', artifactId: 'artifact-result-3' },
        { documentId: 'document-4', baseRevisionId: 'revision-4', status: 'failed' as const, error: 'AGENT_RESULT_MISSING' },
      ],
    };
    const input = {
      dispatchId,
      agentId: 'agent-1',
      body: '逐项结果',
      artifactIds: ['artifact-result-2', 'artifact-result-3', 'artifact-new'],
      projectDocumentInputSetResult: proposal,
    };
    const result = await harness.usecases.receiveDispatchResult(input);
    expect(result).toMatchObject({
      ok: true,
      projectDocumentInputSetResult: {
        items: [
          { documentId: 'document-1', status: 'unchanged' },
          { documentId: 'document-2', status: 'committed', artifactId: 'artifact-result-2' },
          { documentId: 'document-3', status: 'conflict', artifactId: 'artifact-result-3' },
          { documentId: 'document-4', status: 'failed', error: 'AGENT_RESULT_MISSING' },
        ],
      },
      message: { meta: { projectDocumentInputSetResult: { inputSetId } } },
    });
    await expect(harness.repositories.channelDocuments.listRevisions({ documentId: 'document-1' }))
      .resolves.toHaveLength(1);
    await expect(harness.repositories.channelDocuments.listRevisions({ documentId: 'document-2' }))
      .resolves.toHaveLength(2);
    await expect(harness.repositories.channelDocuments.getForTeam({
      teamId: 'team-1', channelId: 'channel-1', documentId: 'document-3',
    })).resolves.toMatchObject({ currentRevisionId: 'human-revision-3' });
    const documents = await harness.repositories.channelDocuments.listByChannel({
      teamId: 'team-1', channelId: 'channel-1',
    });
    expect(documents.map((document) => document.id)).toContain('channel-document:artifact-new');
    expect(documents.map((document) => document.id)).not.toContain('channel-document:artifact-result-2');
    expect(documents.map((document) => document.id)).not.toContain('channel-document:artifact-result-3');

    await expect(harness.usecases.receiveDispatchResult(input)).resolves.toMatchObject({
      ok: true,
      projectDocumentInputSetResult: {
        items: [
          { status: 'unchanged' },
          { status: 'committed' },
          { status: 'conflict' },
          { status: 'failed' },
        ],
      },
    });
  });

  test('rejects archived late InputSet results without changing document facts', async () => {
    const harness = await createHarness(true);
    await seedProjectDocumentInputSet(harness.repositories);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    if (created.view.intent.schemaVersion !== 2) throw new Error('expected V2 InputSet');
    await harness.repositories.channels.archive({ channelId: 'channel-1', timestamp: 19 });

    await expect(harness.usecases.receiveDispatchResult({
      dispatchId: created.view.dispatchAttempts[0]!.dispatchId,
      agentId: 'agent-1',
      body: '迟到结果',
      projectDocumentInputSetResult: {
        contractVersion: 1,
        inputSetId: created.view.intent.projectDocumentInputSet.id,
        invocationId: created.view.id,
        items: created.view.intent.projectDocumentInputSet.items.map((item) => ({
          documentId: item.documentId,
          baseRevisionId: item.baseRevisionId,
          status: 'unchanged' as const,
          sha256: item.sha256,
        })),
      },
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(harness.repositories.projectDocumentInputSetResults.listByInvocation({
      teamId: 'team-1', channelId: 'channel-1', invocationId: created.view.id,
    })).resolves.toEqual([]);
    await expect(harness.repositories.channelDocuments.listRevisions({ documentId: 'document-1' }))
      .resolves.toHaveLength(1);
  });

  test('keeps a timed-out older attempt from writing after a retry starts', async () => {
    const harness = await createHarness(true);
    await seedProjectDocumentInputSet(harness.repositories);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    if (created.view.intent.schemaVersion !== 2) throw new Error('expected V2 InputSet');
    const oldDispatchId = created.view.dispatchAttempts[0]!.dispatchId;
    await harness.gateway.completeAttempt({
      dispatchId: oldDispatchId,
      status: 'timed_out',
      error: 'DISPATCH_TIMEOUT',
    });
    await harness.gateway.retry({ authority: harness.authority, invocationId: created.view.id });
    await harness.repositories.artifacts.create(
      markdownArtifact('artifact-stale-attempt', '1.md', 'stale-attempt-sha'),
    );

    const result = await harness.usecases.receiveDispatchResult({
      dispatchId: oldDispatchId,
      agentId: 'agent-1',
      body: '旧 attempt 迟到',
      artifactIds: ['artifact-stale-attempt'],
      projectDocumentInputSetResult: {
        contractVersion: 1,
        inputSetId: created.view.intent.projectDocumentInputSet.id,
        invocationId: created.view.id,
        items: created.view.intent.projectDocumentInputSet.items.map((item, index) => index === 0
          ? {
              documentId: item.documentId,
              baseRevisionId: item.baseRevisionId,
              status: 'changed' as const,
              sha256: 'stale-attempt-sha',
              artifactId: 'artifact-stale-attempt',
            }
          : {
              documentId: item.documentId,
              baseRevisionId: item.baseRevisionId,
              status: 'unchanged' as const,
              sha256: item.sha256,
            }),
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projectDocumentInputSetResult?.items.find(
        (item) => item.documentId === 'document-1',
      )).toMatchObject({
        status: 'failed',
        error: 'PROJECT_DOCUMENT_RESULT_INVOCATION_STALE',
      });
    }
    await expect(harness.repositories.channelDocuments.listRevisions({ documentId: 'document-1' }))
      .resolves.toHaveLength(1);
  });

  test('resumes a partially persisted result after the Dispatch is already terminal', async () => {
    const harness = await createHarness(true);
    await seedProjectDocumentInputSet(harness.repositories);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    if (created.view.intent.schemaVersion !== 2) throw new Error('expected V2 InputSet');
    await harness.repositories.artifacts.create(
      markdownArtifact('artifact-recovery', '2.md', 'recovery-sha'),
    );
    const proposal = {
      contractVersion: 1 as const,
      inputSetId: created.view.intent.projectDocumentInputSet.id,
      invocationId: created.view.id,
      items: created.view.intent.projectDocumentInputSet.items.map((item, index) => index === 1
        ? {
            documentId: item.documentId,
            baseRevisionId: item.baseRevisionId,
            status: 'changed' as const,
            sha256: 'recovery-sha',
            artifactId: 'artifact-recovery',
          }
        : {
            documentId: item.documentId,
            baseRevisionId: item.baseRevisionId,
            status: 'unchanged' as const,
            sha256: item.sha256,
          }),
    };
    const input = {
      dispatchId: created.view.dispatchAttempts[0]!.dispatchId,
      agentId: 'agent-1',
      body: '可恢复结果',
      artifactIds: ['artifact-recovery'],
      projectDocumentInputSetResult: proposal,
    };
    const record = harness.repositories.projectDocumentInputSetResults.record;
    let writes = 0;
    harness.repositories.projectDocumentInputSetResults.record = async (result) => {
      writes += 1;
      if (writes === 2) throw new Error('SIMULATED_RESULT_WRITE_FAILURE');
      return record(result);
    };
    await expect(harness.usecases.receiveDispatchResult(input))
      .rejects.toThrow('SIMULATED_RESULT_WRITE_FAILURE');
    harness.repositories.projectDocumentInputSetResults.record = record;

    await expect(harness.usecases.receiveDispatchResult(input)).resolves.toMatchObject({
      ok: true,
      dispatch: { status: 'succeeded' },
      projectDocumentInputSetResult: {
        items: [
          { documentId: 'document-1', status: 'unchanged' },
          { documentId: 'document-2', status: 'committed' },
          { documentId: 'document-3', status: 'unchanged' },
          { documentId: 'document-4', status: 'unchanged' },
        ],
      },
    });
    await expect(harness.repositories.channelDocuments.listRevisions({ documentId: 'document-2' }))
      .resolves.toHaveLength(2);
  });

  test.each([
    ['cancelled', async (h: Awaited<ReturnType<typeof createHarness>>, dispatchId: string) => h.usecases.cancelDispatch({ dispatchId, userId: 'user-1' })],
    ['timed_out', async (h: Awaited<ReturnType<typeof createHarness>>) => h.usecases.failTimedOutDispatches({ olderThan: 21 })],
    ['failed', async (h: Awaited<ReturnType<typeof createHarness>>, dispatchId: string) => h.usecases.receiveDispatchError({ dispatchId, agentId: 'agent-1', error: '失败' })],
  ] as const)('bridges %s into one terminal event', async (status, finish) => {
    const harness = await createHarness(true);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    const dispatchId = created.view.dispatchAttempts[0]!.dispatchId;
    await finish(harness, dispatchId);
    await expect(harness.gateway.getView(created.view.id)).resolves.toMatchObject({ status });
    const events = await harness.repositories.management.events.list(harness.authority.managementRunId);
    expect(events.filter(({ event }) => event.type === 'dispatch-attempt-completed')).toHaveLength(1);
  });
});

async function createHarness(withManagementRun: boolean) {
  const repositories = createInMemoryRepositories();
  let id = 0;
  const clock = { now: () => 20 };
  const ids = { nextId: () => `id-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'user', passwordHash: 'hash', role: 'user', primaryTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', username: 'user', role: 'owner', joinedAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.devices.upsertHello({
    id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'online',
    capabilities: { projectDocumentInputSetVersions: [1] },
    lastSeenAt: 1, createdAt: 1, updatedAt: 1,
  });
  await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online', deviceId: 'device-1', projectDocumentInputSetVersions: [1] });
  await repositories.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1', senderKind: 'human', senderId: 'user-1', body: '完成目标', createdAt: 1, meta: { taskId: 'task-1' } });
  await repositories.tasks.create({ id: 'task-1', teamId: 'team-1', channelId: 'channel-1', title: '完成目标', status: 'in_progress', creatorId: 'user-1', assigneeId: 'agent-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
  const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const run = withManagementRun
    ? (await kernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'task-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1', placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } })).run
    : undefined;
  if (run) await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
  await repositories.taskCoordination.coordinations.create({
    schemaVersion: 1, taskId: 'task-1', teamId: 'team-1',
    managementRunId: run?.id ?? 'unused', rootTaskId: 'task-1', nodeKind: 'root',
    reviewPolicy: 'human', claimPolicy: 'open', requiredCapabilities: [],
    taskRevision: 1, attempt: 1, maxAttempts: 2, createdAt: 1, updatedAt: 1,
  });
  await repositories.taskCoordination.claimLeases.create({
    id: 'claim-1', teamId: 'team-1', taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
    agentId: 'agent-1', leaseTokenHash: 'hash', leaseFingerprint: 'fingerprint',
    fencingToken: 1, status: 'active', acquiredAt: 1, heartbeatAt: 1, expiresAt: 100,
  });
  return {
    repositories,
    gateway: createInvocationGateway({ repositories, clock, ids }),
    usecases: createServerNextUseCases({ repositories, clock, ids }),
    authority: { managementRunId: run?.id ?? 'unused', workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 },
  };
}

function invokeInput(authority: { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number }) {
  return { authority, frozenTargetAgentId: 'agent-1', allowedTargetAgentIds: ['agent-1'], idempotencyKey: 'invoke-1', intent: { schemaVersion: 1 as const, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom' as const, objective: '完成目标', taskContext: { taskId: 'task-1', rootTaskId: 'task-1', taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-1' }, acceptanceCriteria: [], dependencyResults: [], attachmentIds: [] } };
}

function markdownArtifact(id: string, filename: string, sha256: string) {
  return {
    id, teamId: 'team-1', channelId: 'channel-1', uploaderId: 'agent-1',
    filename, mimeType: 'text/markdown', sizeBytes: 10, sha256, createdAt: 10,
  };
}

async function seedProjectDocumentInputSet(
  repositories: ReturnType<typeof createInMemoryRepositories>,
): Promise<void> {
  const items = [];
  for (let index = 1; index <= 4; index += 1) {
    const artifact = markdownArtifact(`artifact-${index}`, `${index}.md`, `sha-${index}`);
    await repositories.channelDocuments.create({
      document: {
        id: `document-${index}`, teamId: 'team-1', channelId: 'channel-1',
        filename: `${index}.md`, currentRevisionId: `revision-${index}`,
        createdAt: 1, updatedAt: 1,
      },
      revision: {
        id: `revision-${index}`, documentId: `document-${index}`, artifact,
        revision: 1, createdBy: 'user-1', createdAt: 1, source: 'attachment', published: false,
      },
    });
    items.push({
      id: `reference-item-${index}`,
      selectionId: 'selection-1',
      kind: 'document_revision' as const,
      position: index - 1,
      documentId: `document-${index}`,
      revisionId: `revision-${index}`,
      revisionNumber: 1,
      filename: `${index}.md`,
      createdAt: 1,
    });
  }
  const selection = {
    id: 'selection-1', referenceSetId: 'reference-set-1', sourceKind: 'bundle_subset' as const,
    position: 0, bundleId: 'bundle-1', bundleName: '输入包', bundleMemberCount: 4,
    createdAt: 1, items: [],
  };
  await repositories.projectReferenceSets.create({
    set: {
      id: 'reference-set-1', contractVersion: 1, teamId: 'team-1', channelId: 'channel-1',
      messageId: 'message-1', createdBy: 'user-1', createdAt: 1, selections: [],
    },
    selections: [selection],
    items,
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'reference-set-create',
      requestFingerprint: 'reference-set-fingerprint', referenceSetId: 'reference-set-1', createdAt: 1,
    },
  });
}
