import { describe, expect, test, vi } from 'vitest';

import { createCollaborationService } from '../src/application/management/collaboration-service.js';
import { hashManagementCommandInput } from '../src/application/management/management-event-validator.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import {
  createPhase1ManagementToolHandlers,
  createPhase2CollaborationToolHandlers,
} from '../src/application/management/management-tool-executor.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('serial collaboration handoff', () => {
  test('archives a fenced proposal and changes continuation owner only after target acceptance', async () => {
    const harness = await createHarness();
    const [proposal] = await harness.service.recordProposals({
      dispatchId: 'dispatch-a',
      agentId: 'agent-a',
      proposals: [{
        schemaVersion: 1,
        sourceInvocationId: 'invocation-a',
        sourceAgentId: 'agent-a',
        sourceTaskContext: {
          taskId: 'task-root', rootTaskId: 'task-root', taskRevision: 1,
          taskAttempt: 1, claimLeaseId: 'claim-a',
        },
        toAgentId: 'agent-b',
        kind: 'continuation',
        objective: '由 Agent B 完成收尾',
        reason: 'Agent B 具备所需能力',
        contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'deliver_to_root',
      }],
    });
    expect(proposal).toMatchObject({ managementRunId: harness.runId,
      proposal: { sourceInvocationId: 'invocation-a', toAgentId: 'agent-b' } });
    const managementState = await createPhase1ManagementToolHandlers({
      repositories: harness.repositories, kernel: harness.kernel, clock: harness.clock,
      ids: harness.ids, onDispatchCreated() {},
    })['context.get_management_state']!({ schemaVersion: 1, commandId: 'read-state',
      managementRunId: harness.runId, workerId: 'worker-1', toolCallId: 'read-state-call',
      toolName: 'context.get_management_state', input: {} });
    expect(managementState).toMatchObject({ mainAgentId: 'agent-a', activeAgentId: 'agent-a',
      collaborationProposals: [{ proposalId: proposal!.id, sourceInvocationId: 'invocation-a',
        toAgentId: 'agent-b', kind: 'continuation' }] });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ activeAgentId: 'agent-a' });

    const requested = await harness.service.requestHandoff({
      authority: harness.authority,
      idempotencyKey: 'handoff-request-1',
      sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a',
      toAgentId: 'agent-b',
      kind: 'continuation',
      objective: '由 Agent B 完成收尾',
      reason: 'Agent B 具备所需能力',
      contextRefIds: [], dependencyInvocationIds: [], attachmentIds: [],
      acceptanceCriteria: [], returnMode: 'deliver_to_root',
    });
    expect(requested.handoff).toMatchObject({ status: 'requested',
      intent: { fromAgentId: 'agent-a', toAgentId: 'agent-b', kind: 'continuation' } });
    expect(requested.invocation.intent.targetAgentId).toBe('agent-b');
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ activeAgentId: 'agent-a' });

    const dispatchId = requested.view.activeDispatchId!;
    await harness.repositories.dispatches.markAccepted({
      dispatchId, agentId: 'agent-b', expectedUpdatedAt: 20, prompt: '由 Agent B 完成收尾', acceptedAt: 21,
    });
    await harness.service.recordAccepted({ dispatchId });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ activeAgentId: 'agent-b', collaborationMode: 'handoff' });

    await expect(harness.service.recordTerminal({ dispatchId, status: 'failed', artifactIds: [] }))
      .resolves.toMatchObject({ status: 'failed' });
    await expect(harness.service.recordAccepted({ dispatchId }))
      .resolves.toMatchObject({ status: 'failed' });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ activeAgentId: 'agent-a' });
    expect((await harness.repositories.management.events.list(harness.runId))
      .filter(({ event }) => event.type === 'active-agent-changed')).toHaveLength(2);
  });

  test('rejects a stale proposal after the Task revision changes', async () => {
    const harness = await createHarness();
    const [proposal] = await harness.service.recordProposals({
      dispatchId: 'dispatch-a', agentId: 'agent-a', proposals: [{
        schemaVersion: 1, sourceInvocationId: 'invocation-a', sourceAgentId: 'agent-a',
        sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root', taskRevision: 1,
          taskAttempt: 1, claimLeaseId: 'claim-a' },
        toAgentId: 'agent-b', kind: 'consult', objective: '咨询 B', reason: '需要信息',
        contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'return_to_manager',
      }],
    });
    await harness.repositories.tasks.update({ taskId: 'task-root',
      changes: { revision: 2, updatedAt: 22 } });
    await expect(harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'stale-handoff', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [],
      dependencyInvocationIds: [], attachmentIds: [], acceptanceCriteria: [],
      returnMode: 'return_to_manager' })).rejects.toThrow('HANDOFF_PROPOSAL_STALE');
  });

  test('recovers a persisted requested handoff without creating a second handoff', async () => {
    const harness = await createHarness();
    const [proposal] = await harness.service.recordProposals({
      dispatchId: 'dispatch-a', agentId: 'agent-a', proposals: [{
        schemaVersion: 1, sourceInvocationId: 'invocation-a', sourceAgentId: 'agent-a',
        sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root', taskRevision: 1,
          taskAttempt: 1, claimLeaseId: 'claim-a' },
        toAgentId: 'agent-b', kind: 'consult', objective: '咨询 B', reason: '需要信息',
        contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'return_to_manager',
      }],
    });
    const intent = { schemaVersion: 1 as const, managementRunId: harness.runId,
      sourceProposalId: proposal!.id, sourceInvocationId: 'invocation-a', fromAgentId: 'agent-a',
      toAgentId: 'agent-b', kind: 'consult' as const, objective: '咨询 B', reason: '需要信息',
      contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
      returnMode: 'return_to_manager' as const };
    await harness.repositories.management.handoffs.create({ schemaVersion: 1,
      id: 'handoff-recovery', managementRunId: harness.runId, intent,
      intentHash: hashManagementCommandInput(intent), idempotencyKey: 'handoff-recovery-key',
      status: 'requested', createdAt: 20, updatedAt: 20 });
    const recoveredInvocation = await createInvocationGateway({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids }).invoke({ authority: harness.authority,
      frozenTargetAgentId: 'agent-b', allowedTargetAgentIds: ['agent-b'],
      idempotencyKey: 'handoff-recovery-key:invocation', intent: {
        schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-b',
        targetKind: 'custom', objective: '咨询 B', taskContext: proposal!.proposal.sourceTaskContext,
        acceptanceCriteria: [], dependencyResults: [], attachmentIds: [],
      } });
    const run = await harness.repositories.management.runs.getById(harness.runId);
    await harness.repositories.management.runs.update({ ...run!,
      budget: { ...run!.budget, maxExternalInvocations: 2 } });
    await harness.repositories.taskCoordination.claimLeases.update({ id: 'claim-a',
      expectedStatus: 'active', status: 'released', heartbeatAt: 20, expiresAt: 1_000,
      releasedAt: 20 });

    const recovered = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-recovery-key', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });

    expect(recovered.handoff).toMatchObject({ id: 'handoff-recovery', status: 'requested',
      invocationId: recoveredInvocation.view.id });
    expect(recovered.invocation.id).toBe(recoveredInvocation.view.id);
    await expect(harness.repositories.management.handoffs.listByRun(harness.runId))
      .resolves.toHaveLength(1);
  });

  test('replays an existing handoff without re-emitting its Dispatch after live limits drift', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const onDispatchCreated = vi.fn();
    const handler = createPhase2CollaborationToolHandlers({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, onDispatchCreated })['handoffs.request'];
    const request = handoffToolRequest(harness, proposal!.id, 'handoff-replay');

    const first = await handler(request);
    const run = await harness.repositories.management.runs.getById(harness.runId);
    await harness.repositories.management.runs.update({ ...run!,
      budget: { maxSubtasks: 1, maxDepth: 1, maxExternalInvocations: 2 } });
    const target = await harness.repositories.agents.getById('agent-b');
    await harness.repositories.agents.upsert({ ...target!, status: 'offline' });

    await expect(handler({ ...request, commandId: 'handoff-replay-2',
      toolCallId: 'handoff-replay-2' })).resolves.toEqual(first);
    expect(onDispatchCreated).toHaveBeenCalledTimes(1);
    await expect(harness.repositories.management.handoffs.listByRun(harness.runId))
      .resolves.toHaveLength(1);
  });

  test('re-emits an existing queued handoff after the handler process restarts', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-rewake', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });
    const onDispatchCreated = vi.fn();
    const restartedHandler = createPhase2CollaborationToolHandlers({
      repositories: harness.repositories, clock: harness.clock, ids: harness.ids,
      onDispatchCreated,
    })['handoffs.request'];

    await expect(restartedHandler(handoffToolRequest(harness, proposal!.id, 'handoff-rewake')))
      .resolves.toMatchObject({ invocationId: requested.invocation.id, status: 'requested' });
    expect(onDispatchCreated).toHaveBeenCalledOnce();
    expect(onDispatchCreated).toHaveBeenCalledWith(requested.view.activeDispatchId);
  });

  test('keeps the ManagementRun alive when a handoff Invocation fails', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-failure', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });
    const app = createServerNextUseCases({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, managementKernel: harness.kernel,
      messageIngestionMode: 'legacy' });

    await expect(app.receiveDispatchError({ dispatchId: requested.view.activeDispatchId!,
      agentId: 'agent-b', error: 'handoff failed' })).resolves.toMatchObject({ ok: true });
    await expect(harness.repositories.management.handoffs.getById(requested.handoff.id))
      .resolves.toMatchObject({ status: 'failed' });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'running', activeAgentId: 'agent-a' });
  });

  test('matches declared capabilities as well as skill names', async () => {
    const harness = await createHarness();

    await expect(harness.service.listAvailableAgents({ managementRunId: harness.runId,
      capabilityQuery: 'dispatch' })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'agent-a', capabilities: ['dispatch'] }),
      expect.objectContaining({ agentId: 'agent-b', capabilities: ['dispatch'] }),
    ]));
  });

  test('keeps continuation owner transitions valid after the source claim expires', async () => {
    const harness = await createHarness();
    const [proposal] = await harness.service.recordProposals({ dispatchId: 'dispatch-a',
      agentId: 'agent-a', proposals: [{
        schemaVersion: 1, sourceInvocationId: 'invocation-a', sourceAgentId: 'agent-a',
        sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root', taskRevision: 1,
          taskAttempt: 1, claimLeaseId: 'claim-a' },
        toAgentId: 'agent-b', kind: 'continuation', objective: '由 B 收尾', reason: '能力匹配',
        contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'deliver_to_root',
      }] });
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-expired-claim', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'continuation',
      objective: '由 B 收尾', reason: '能力匹配', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' });
    await harness.repositories.taskCoordination.claimLeases.update({ id: 'claim-a',
      expectedStatus: 'active', status: 'released', heartbeatAt: 20, expiresAt: 1_000,
      releasedAt: 20 });

    const dispatchId = requested.view.activeDispatchId!;
    await harness.repositories.dispatches.markAccepted({ dispatchId, agentId: 'agent-b',
      expectedUpdatedAt: 20, prompt: '由 B 收尾', acceptedAt: 21 });
    await harness.service.recordAccepted({ dispatchId });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ activeAgentId: 'agent-b' });
    await harness.service.recordTerminal({ dispatchId, status: 'cancelled', artifactIds: [] });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ activeAgentId: 'agent-a' });
  });

  test('rejects a second active handoff until the serial handoff finishes', async () => {
    const harness = await createHarness();
    await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-serial-1', toAgentId: 'agent-b', kind: 'continuation',
      objective: '第一段交接', reason: '串行执行', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' });

    await expect(harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-serial-2', toAgentId: 'agent-b', kind: 'continuation',
      objective: '第二段交接', reason: '串行执行', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' }))
      .rejects.toThrow('HANDOFF_SERIAL_CONFLICT');
  });

  test('fences a direct continuation and ignores an acceptance after the Task revision changes', async () => {
    const harness = await createHarness();
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-direct-fence', toAgentId: 'agent-b', kind: 'continuation',
      objective: '由 B 继续', reason: '直接交接', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' });
    expect(requested.invocation.intent.taskContext).toMatchObject({ taskId: 'task-root',
      rootTaskId: 'task-root', taskRevision: 1, taskAttempt: 1,
      claimLeaseId: `management:${harness.runId}` });
    await harness.repositories.tasks.update({ taskId: 'task-root',
      changes: { revision: 2, updatedAt: 22 } });
    const dispatchId = requested.view.activeDispatchId!;
    await harness.repositories.dispatches.markAccepted({ dispatchId, agentId: 'agent-b',
      expectedUpdatedAt: 20, prompt: '由 B 继续', acceptedAt: 21 });
    await harness.service.recordAccepted({ dispatchId });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ activeAgentId: 'agent-a' });
  });

  test('reconciles a replayed handoff from the canonical Dispatch lifecycle', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const request = { authority: harness.authority, idempotencyKey: 'handoff-reconcile',
      sourceProposalId: proposal!.id, sourceInvocationId: 'invocation-a', toAgentId: 'agent-b',
      kind: 'consult' as const, objective: '咨询 B', reason: '需要信息', contextRefIds: [],
      dependencyInvocationIds: [], attachmentIds: [], acceptanceCriteria: [],
      returnMode: 'return_to_manager' as const };
    const requested = await harness.service.requestHandoff(request);
    const dispatchId = requested.view.activeDispatchId!;
    await harness.repositories.dispatches.markAccepted({ dispatchId, agentId: 'agent-b',
      expectedUpdatedAt: 20, prompt: '咨询 B', acceptedAt: 21 });
    await expect(harness.service.requestHandoff(request))
      .resolves.toMatchObject({ handoff: { status: 'accepted' }, disposition: 'existing' });
    await createInvocationGateway({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids }).completeAttempt({ dispatchId,
      status: 'succeeded', actorKind: 'agent', actorId: 'agent-b' });
    await expect(harness.service.requestHandoff(request))
      .resolves.toMatchObject({ handoff: { status: 'returned' }, disposition: 'existing' });
  });

  test('patches a terminal handoff result after replay reconcile observed the succeeded dispatch first', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const request = { authority: harness.authority, idempotencyKey: 'handoff-result-patch',
      sourceProposalId: proposal!.id, sourceInvocationId: 'invocation-a', toAgentId: 'agent-b',
      kind: 'consult' as const, objective: '咨询 B', reason: '需要信息', contextRefIds: [],
      dependencyInvocationIds: [], attachmentIds: [], acceptanceCriteria: [],
      returnMode: 'return_to_manager' as const };
    const requested = await harness.service.requestHandoff(request);
    const dispatchId = requested.view.activeDispatchId!;
    await createInvocationGateway({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids }).completeAttempt({ dispatchId,
      status: 'succeeded', actorKind: 'agent', actorId: 'agent-b' });
    await expect(harness.service.requestHandoff(request))
      .resolves.toMatchObject({ handoff: { status: 'returned' }, disposition: 'existing' });

    await expect(harness.service.recordTerminal({ dispatchId, status: 'succeeded',
      artifactIds: ['artifact-result'], result: { schemaVersion: 1,
        invocationId: requested.invocation.id, agentId: 'agent-b', status: 'succeeded',
        body: '真实结果', artifactIds: ['artifact-result'], memoryCandidateIds: [],
        startedAt: 20, completedAt: 20 } }))
      .resolves.toMatchObject({ status: 'returned', result: { body: '真实结果',
        artifactIds: ['artifact-result'] } });
    await expect(harness.repositories.management.handoffs.getById(requested.handoff.id))
      .resolves.toMatchObject({ status: 'returned', result: { body: '真实结果' } });
  });

  test('await_result reconciles a canonical terminal invocation before timeout expires', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-await-reconcile', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });
    await createInvocationGateway({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids }).completeAttempt({
      dispatchId: requested.view.activeDispatchId!, status: 'succeeded',
      actorKind: 'agent', actorId: 'agent-b',
    });
    const awaitResult = createPhase2CollaborationToolHandlers({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, onDispatchCreated() {}, pollIntervalMs: 1,
      resultGraceMs: 20 })['handoffs.await_result'];

    await expect(awaitResult({ schemaVersion: 2, managementPhase: 2, commandId: 'await-reconcile',
      managementRunId: harness.runId, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'await-reconcile', toolCallId: 'await-reconcile', toolName: 'handoffs.await_result',
      input: { handoffId: requested.handoff.id, timeoutAt: 1_000 } }))
      .resolves.toMatchObject({ handoffId: requested.handoff.id, status: 'returned' });
  });

  test('await_result waits for the terminal result write instead of returning an empty response', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-await-result-grace', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });
    const dispatchId = requested.view.activeDispatchId!;
    // 复现 receiveDispatchResult 的写入顺序：completeAttempt 先置 canonical 终态，
    // recordTerminal 稍后才把 AgentInvocationResultDto 补写到 handoff。
    await createInvocationGateway({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids }).completeAttempt({ dispatchId,
      status: 'succeeded', actorKind: 'agent', actorId: 'agent-b' });
    const awaitResult = createPhase2CollaborationToolHandlers({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, onDispatchCreated() {}, pollIntervalMs: 1,
      resultGraceMs: 5_000 })['handoffs.await_result'];

    const pending = awaitResult({ schemaVersion: 2, managementPhase: 2,
      commandId: 'await-result-grace', managementRunId: harness.runId, workerId: 'worker-1',
      leaseToken: 'token', fencingToken: 1, idempotencyKey: 'await-result-grace',
      toolCallId: 'await-result-grace', toolName: 'handoffs.await_result',
      input: { handoffId: requested.handoff.id } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await harness.service.recordTerminal({ dispatchId, status: 'succeeded',
      artifactIds: ['artifact-late'], result: { schemaVersion: 1,
        invocationId: requested.invocation.id, agentId: 'agent-b', status: 'succeeded',
        body: '迟到的结果', artifactIds: ['artifact-late'], memoryCandidateIds: [],
        startedAt: 20, completedAt: 20 } });

    await expect(pending).resolves.toMatchObject({ handoffId: requested.handoff.id,
      status: 'returned', result: { body: '迟到的结果', artifactIds: ['artifact-late'] } });
  });

  test('keeps private handoff workspace runs out of public workspace-run reads and lists', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-private-workspace-run', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });
    const app = createServerNextUseCases({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, managementKernel: harness.kernel });
    await expect(app.receiveDispatchResult({ dispatchId: requested.view.activeDispatchId!,
      agentId: 'agent-b', body: '仅返回 Manager',
      workspaceRun: { id: 'workspace-private', status: 'succeeded', cwd: '/repo',
        command: 'npm test', startedAt: 18, completedAt: 20 },
      artifacts: [{ id: 'artifact-private-log', filename: 'workspace-run.log',
        mimeType: 'text/plain', sizeBytes: 10, relativePath: 'logs/workspace-run.log',
        pathKind: 'workspace' }] })).resolves.toMatchObject({ ok: true });

    await expect(app.getWorkspaceRun({ userId: 'user-1', teamId: 'team-1',
      runId: 'workspace-private' })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(app.getWorkspaceRunDetail({ userId: 'user-1', teamId: 'team-1',
      runId: 'workspace-private' })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(app.getWorkspaceRunLogFile({ userId: 'user-1', teamId: 'team-1',
      runId: 'workspace-private' })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(app.getArtifact({ userId: 'user-1', teamId: 'team-1',
      artifactId: 'artifact-private-log' })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(app.getArtifactFile({ userId: 'user-1', teamId: 'team-1',
      artifactId: 'artifact-private-log' })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(app.listTeamWorkspaceRuns({ userId: 'user-1', teamId: 'team-1',
      pageSize: 20 })).resolves.toMatchObject({ ok: true, runs: [] });
    await expect(app.listAgentWorkspaceRuns({ userId: 'user-1', teamId: 'team-1',
      agentId: 'agent-b' })).resolves.toMatchObject({ ok: true, runs: [] });
    await harness.repositories.workspaceRuns.create({ id: 'workspace-public',
      teamId: 'team-1', channelId: 'channel-1', messageId: 'message-root',
      dispatchId: 'dispatch-a', agentId: 'agent-a', status: 'succeeded',
      cwd: '/repo', command: 'npm test', startedAt: 10, completedAt: 11,
      createdAt: 10, updatedAt: 10, artifactIds: [] });
    await expect(app.listTeamWorkspaceRuns({ userId: 'user-1', teamId: 'team-1',
      pageSize: 1 })).resolves.toMatchObject({ ok: true,
      runs: [{ workspaceRun: { id: 'workspace-public' } }] });
    const awaitResult = createPhase2CollaborationToolHandlers({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, onDispatchCreated() {} })['handoffs.await_result'];
    await expect(awaitResult({ schemaVersion: 2, managementPhase: 2, commandId: 'await-private-workspace',
      managementRunId: harness.runId, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'await-private-workspace', toolCallId: 'await-private-workspace',
      toolName: 'handoffs.await_result', input: { handoffId: requested.handoff.id } }))
      .resolves.toMatchObject({ status: 'returned',
        result: { workspaceRunId: 'workspace-private', artifactIds: ['artifact-private-log'] } });
  });

  test('lets direct continuation proposals reuse the server-owned management task fence', async () => {
    const harness = await createHarness();
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-direct-next-proposal', toAgentId: 'agent-b', kind: 'continuation',
      objective: '由 B 继续', reason: '直接交接', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });

    await expect(harness.service.recordProposals({ dispatchId: requested.view.activeDispatchId!,
      agentId: 'agent-b', proposals: [{
        schemaVersion: 1, sourceInvocationId: requested.invocation.id, sourceAgentId: 'agent-b',
        sourceTaskContext: requested.invocation.intent.taskContext,
        toAgentId: 'agent-a', kind: 'consult', objective: '回问 A', reason: '补充信息',
        contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'return_to_manager',
      }] })).resolves.toMatchObject([
      expect.objectContaining({ proposal: expect.objectContaining({
        sourceInvocationId: requested.invocation.id, toAgentId: 'agent-a',
      }) }),
    ]);
  });

  test('moves a deliver_to_root handoff result into root review instead of skipping closeout', async () => {
    const harness = await createHarness();
    const [proposal] = await harness.service.recordProposals({ dispatchId: 'dispatch-a',
      agentId: 'agent-a', proposals: [{ schemaVersion: 1, sourceInvocationId: 'invocation-a',
        sourceAgentId: 'agent-a', sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root',
          taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-a' }, toAgentId: 'agent-b',
        kind: 'continuation', objective: '由 B 收尾', reason: '能力匹配', contextRefs: [],
        dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'deliver_to_root' }] });
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-root-review', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'continuation',
      objective: '由 B 收尾', reason: '能力匹配', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' });
    const app = createServerNextUseCases({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, managementKernel: harness.kernel });

    await expect(app.receiveDispatchResult({ dispatchId: requested.view.activeDispatchId!,
      agentId: 'agent-b', body: '最终交付' })).resolves.toMatchObject({
      ok: true, message: { body: '最终交付' },
    });
    await expect(harness.repositories.tasks.getById('task-root'))
      .resolves.toMatchObject({ status: 'in_review' });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'in_review' });
    const events = await harness.repositories.management.events.list(harness.runId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({
        type: 'root-delivery-submitted',
        payload: expect.objectContaining({ contributingInvocationIds: [requested.invocation.id] }),
      }) }),
    ]));
  });

  test('leaves runs with coordination subtasks open for the canonical root delivery path', async () => {
    const harness = await createHarness();
    await harness.repositories.tasks.create({ id: 'task-sub-1', teamId: 'team-1',
      channelId: 'channel-1', title: 'Sub', status: 'in_progress', creatorId: 'user-1',
      tags: [], sortOrder: 1, revision: 1, createdAt: 1, updatedAt: 1 });
    await harness.repositories.taskCoordination.coordinations.create({ schemaVersion: 1,
      taskId: 'task-sub-1', teamId: 'team-1', managementRunId: harness.runId,
      nodeKind: 'subtask', parentTaskId: 'task-root', reviewPolicy: 'manager',
      claimPolicy: 'targeted', requiredCapabilities: [], attempt: 1, maxAttempts: 2,
      taskRevision: 1, createdAt: 1, updatedAt: 1 });
    const [proposal] = await harness.service.recordProposals({ dispatchId: 'dispatch-a',
      agentId: 'agent-a', proposals: [{ schemaVersion: 1, sourceInvocationId: 'invocation-a',
        sourceAgentId: 'agent-a', sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root',
          taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-a' }, toAgentId: 'agent-b',
        kind: 'continuation', objective: '由 B 收尾', reason: '能力匹配', contextRefs: [],
        dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'deliver_to_root' }] });
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-subtask-run', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'continuation',
      objective: '由 B 收尾', reason: '能力匹配', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' });
    const app = createServerNextUseCases({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, managementKernel: harness.kernel });

    await expect(app.receiveDispatchResult({ dispatchId: requested.view.activeDispatchId!,
      agentId: 'agent-b', body: '最终交付' })).resolves.toMatchObject({
      ok: true, message: { body: '最终交付' },
    });
    // 公开交付照常落库，但根任务/run 不提前进入审核：含 subtask 的 run 必须由
    // Manager 走带 readiness/验收校验的 canonical submitRootDelivery 闭环。
    await expect(harness.repositories.tasks.getById('task-root'))
      .resolves.toMatchObject({ status: 'in_progress' });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'running' });
    const events = await harness.repositories.management.events.list(harness.runId);
    expect(events.some(({ event }) => event.type === 'root-delivery-submitted')).toBe(false);
  });

  test('rejects management-fence proposals after the run enters review', async () => {
    const harness = await createHarness();
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-review-fence', toAgentId: 'agent-b', kind: 'continuation',
      objective: '由 B 收尾', reason: '直接交接', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' });
    const app = createServerNextUseCases({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, managementKernel: harness.kernel });
    await expect(app.receiveDispatchResult({ dispatchId: requested.view.activeDispatchId!,
      agentId: 'agent-b', body: '最终交付' })).resolves.toMatchObject({ ok: true });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'in_review' });

    await expect(harness.service.recordProposals({
      dispatchId: requested.view.activeDispatchId!, agentId: 'agent-b', proposals: [{
        schemaVersion: 1, sourceInvocationId: requested.invocation.id, sourceAgentId: 'agent-b',
        sourceTaskContext: requested.invocation.intent.taskContext,
        toAgentId: 'agent-a', kind: 'consult', objective: '回问 A', reason: '补充信息',
        contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'return_to_manager' }] })).rejects.toThrow('HANDOFF_PROPOSAL_STALE');
  });

  test('times out an active handoff and rolls continuation ownership back', async () => {
    const harness = await createHarness();
    const [proposal] = await harness.service.recordProposals({ dispatchId: 'dispatch-a',
      agentId: 'agent-a', proposals: [{ schemaVersion: 1, sourceInvocationId: 'invocation-a',
        sourceAgentId: 'agent-a', sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root',
          taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-a' }, toAgentId: 'agent-b',
        kind: 'continuation', objective: '由 B 收尾', reason: '能力匹配', contextRefs: [],
        dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'deliver_to_root' }] });
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-timeout', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'continuation',
      objective: '由 B 收尾', reason: '能力匹配', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' });
    const dispatchId = requested.view.activeDispatchId!;
    await harness.repositories.dispatches.markAccepted({ dispatchId, agentId: 'agent-b',
      expectedUpdatedAt: 20, prompt: '由 B 收尾', acceptedAt: 20 });
    await harness.service.recordAccepted({ dispatchId });
    const awaitResult = createPhase2CollaborationToolHandlers({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, onDispatchCreated() {} })['handoffs.await_result'];
    await expect(awaitResult({ schemaVersion: 2, managementPhase: 2, commandId: 'await-timeout',
      managementRunId: harness.runId, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'await-timeout', toolCallId: 'await-timeout', toolName: 'handoffs.await_result',
      input: { handoffId: requested.handoff.id, timeoutAt: 20 } }))
      .resolves.toMatchObject({ status: 'timed_out' });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ activeAgentId: 'agent-a' });
  });

  test('keeps return-to-manager results out of the public thread', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-private-result', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });
    const app = createServerNextUseCases({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, managementKernel: harness.kernel });
    const delivered = await app.receiveDispatchResult({ dispatchId: requested.view.activeDispatchId!,
      agentId: 'agent-b', body: '仅返回 Manager' });
    expect(delivered).toMatchObject({ ok: true, dispatch: { status: 'succeeded' } });
    expect(delivered).not.toHaveProperty('message');
    const result = await app.receiveDispatchResult({ dispatchId: requested.view.activeDispatchId!,
      agentId: 'agent-b', body: '重复' });
    expect(result).toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(harness.repositories.messages.listByThread({ channelId: 'channel-1',
      threadId: 'message-root', limit: 20 })).resolves.toHaveLength(1);
    await expect(harness.repositories.management.handoffs.getById(requested.handoff.id))
      .resolves.toMatchObject({ status: 'returned', result: { body: '仅返回 Manager',
        invocationId: requested.invocation.id, agentId: 'agent-b', status: 'succeeded' } });
    const awaitResult = createPhase2CollaborationToolHandlers({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, onDispatchCreated() {} })['handoffs.await_result'];
    await expect(awaitResult({ schemaVersion: 2, managementPhase: 2, commandId: 'await-private',
      managementRunId: harness.runId, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'await-private', toolCallId: 'await-private', toolName: 'handoffs.await_result',
      input: { handoffId: requested.handoff.id } })).resolves.toMatchObject({ status: 'returned',
        result: { body: '仅返回 Manager', invocationId: requested.invocation.id } });
  });

  test('rejects an already expired handoff deadline before persisting or dispatching', async () => {
    const harness = await createHarness();

    await expect(harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-expired-deadline', toAgentId: 'agent-b', kind: 'consult',
      objective: '过期工作', reason: '旧请求', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager', deadlineAt: 19 }))
      .rejects.toThrow('HANDOFF_DEADLINE_EXPIRED');
    await expect(harness.repositories.management.handoffs.listByRun(harness.runId))
      .resolves.toHaveLength(0);
  });

  test('routes handoff cancellation through collaboration state without terminating the run', async () => {
    const harness = await createHarness();
    const [proposal] = await recordConsultProposal(harness);
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-cancel', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'return_to_manager' });
    const handler = createPhase1ManagementToolHandlers({ repositories: harness.repositories,
      kernel: harness.kernel, clock: harness.clock, ids: harness.ids,
      onDispatchCreated() {} })['agents.cancel_invocation']!;

    await expect(handler({ schemaVersion: 1, commandId: 'cancel-handoff',
      managementRunId: harness.runId, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'cancel-handoff', toolCallId: 'cancel-handoff',
      toolName: 'agents.cancel_invocation', input: { invocationId: requested.invocation.id,
        reasonCode: 'manager_cancelled' } })).resolves.toMatchObject({ status: 'cancelled' });
    await expect(harness.repositories.management.handoffs.getById(requested.handoff.id))
      .resolves.toMatchObject({ status: 'cancelled' });
    await expect(harness.repositories.management.runs.getById(harness.runId))
      .resolves.toMatchObject({ status: 'running', activeAgentId: 'agent-a' });
  });

  test('delivers the invocation source and selected handoff context to the target executor', async () => {
    const harness = await createHarness();
    const criterion = { id: 'criterion-1', description: '给出可验证结果', evidenceRequired: true };
    const contextRef = { kind: 'message' as const, id: 'message-root', snapshotHash: 'sha256:context',
      capturedAt: 10 };
    await harness.repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1',
      channelId: 'channel-1', uploaderId: 'user-1', filename: 'brief.md',
      mimeType: 'text/markdown', sizeBytes: 10, createdAt: 10 });
    const [proposal] = await harness.service.recordProposals({ dispatchId: 'dispatch-a',
      agentId: 'agent-a', proposals: [{
        schemaVersion: 1, sourceInvocationId: 'invocation-a', sourceAgentId: 'agent-a',
        sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root', taskRevision: 1,
          taskAttempt: 1, claimLeaseId: 'claim-a' },
        toAgentId: 'agent-b', kind: 'consult', objective: '咨询 B', reason: '需要信息',
        contextRefs: [contextRef], dependencyResults: [], acceptanceCriteria: [criterion],
        attachmentIds: ['artifact-1'], returnMode: 'return_to_manager',
      }] });
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-context', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'consult',
      objective: '咨询 B', reason: '需要信息', contextRefIds: ['message-root'],
      dependencyInvocationIds: [], attachmentIds: ['artifact-1'], acceptanceCriteria: [criterion],
      returnMode: 'return_to_manager' });
    const app = createServerNextUseCases({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, managementKernel: harness.kernel });

    await expect(app.getDispatchRequest({ dispatchId: requested.view.activeDispatchId! }))
      .resolves.toMatchObject({ ok: true, request: {
        prompt: '咨询 B',
        attachments: [{ id: 'artifact-1', name: 'brief.md', mimeType: 'text/markdown' }],
        managementInvocationId: requested.invocation.id,
        managementContext: {
          invocationId: requested.invocation.id,
          taskContext: { taskId: 'task-root', taskRevision: 1, taskAttempt: 1,
            claimLeaseId: 'claim-a' },
          contextRefs: [contextRef],
          dependencyResults: [],
          acceptanceCriteria: [criterion],
        },
      } });
  });

  test('routes follow-up thread messages to the accepted continuation owner', async () => {
    const harness = await createHarness();
    const [proposal] = await harness.service.recordProposals({ dispatchId: 'dispatch-a',
      agentId: 'agent-a', proposals: [{
        schemaVersion: 1, sourceInvocationId: 'invocation-a', sourceAgentId: 'agent-a',
        sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root', taskRevision: 1,
          taskAttempt: 1, claimLeaseId: 'claim-a' },
        toAgentId: 'agent-b', kind: 'continuation', objective: '由 B 收尾', reason: '能力匹配',
        contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'deliver_to_root',
      }] });
    const requested = await harness.service.requestHandoff({ authority: harness.authority,
      idempotencyKey: 'handoff-follow-up', sourceProposalId: proposal!.id,
      sourceInvocationId: 'invocation-a', toAgentId: 'agent-b', kind: 'continuation',
      objective: '由 B 收尾', reason: '能力匹配', contextRefIds: [], dependencyInvocationIds: [],
      attachmentIds: [], acceptanceCriteria: [], returnMode: 'deliver_to_root' });
    await harness.service.recordAccepted({ dispatchId: requested.view.activeDispatchId! });
    const app = createServerNextUseCases({ repositories: harness.repositories,
      clock: harness.clock, ids: harness.ids, managementKernel: harness.kernel,
      messageIngestionMode: 'legacy' });

    await expect(app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      threadId: 'message-root', body: '补充一个要求' }))
      .resolves.toMatchObject({ ok: true, route: { kind: 'dispatch', agentId: 'agent-b' } });
  });
});

async function recordConsultProposal(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.service.recordProposals({ dispatchId: 'dispatch-a', agentId: 'agent-a', proposals: [{
    schemaVersion: 1, sourceInvocationId: 'invocation-a', sourceAgentId: 'agent-a',
    sourceTaskContext: { taskId: 'task-root', rootTaskId: 'task-root', taskRevision: 1,
      taskAttempt: 1, claimLeaseId: 'claim-a' },
    toAgentId: 'agent-b', kind: 'consult', objective: '咨询 B', reason: '需要信息',
    contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
    returnMode: 'return_to_manager',
  }] });
}

function handoffToolRequest(
  harness: Awaited<ReturnType<typeof createHarness>>,
  proposalId: string,
  idempotencyKey: string,
) {
  return { schemaVersion: 2 as const, managementPhase: 2 as const,
    commandId: idempotencyKey, managementRunId: harness.runId, workerId: 'worker-1',
    toolCallId: idempotencyKey, toolName: 'handoffs.request' as const,
    leaseToken: 'token', fencingToken: 1, idempotencyKey,
    input: { sourceProposalId: proposalId, sourceInvocationId: 'invocation-a',
      toAgentId: 'agent-b', kind: 'consult' as const, objective: '咨询 B', reason: '需要信息',
      contextRefIds: [], dependencyInvocationIds: [], attachmentIds: [], acceptanceCriteria: [],
      returnMode: 'return_to_manager' as const } };
}

async function createHarness() {
  const repositories = createInMemoryRepositories();
  let id = 0;
  const clock = { now: () => 20 };
  const ids = { nextId: () => `collab-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'user', role: 'user',
    passwordHash: 'unused', primaryTeamId: 'team-1', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private',
    ownerId: 'user-1', createdAt: 1 });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', username: 'user',
    role: 'owner', joinedAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel',
    name: 'general', visibility: 'public', humanMemberIds: ['user-1'],
    agentMemberIds: ['agent-a', 'agent-b'], createdAt: 1 });
  for (const agentId of ['agent-a', 'agent-b']) {
    await repositories.agents.upsert({ id: agentId, primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'], name: agentId, adapterKind: 'codex',
      category: 'executor-hosted', source: 'custom', status: 'online' });
  }
  await repositories.messages.append({ id: 'message-root', teamId: 'team-1',
    channelId: 'channel-1', threadId: 'message-root', senderKind: 'human', senderId: 'user-1',
    body: '先由 A 开始，再交给 B', createdAt: 1, meta: { taskId: 'task-root' } });
  await repositories.tasks.create({ id: 'task-root', teamId: 'team-1', channelId: 'channel-1',
    title: 'Root', status: 'in_progress', creatorId: 'user-1', tags: [], sortOrder: 0,
    revision: 1, createdAt: 1, updatedAt: 1 });
  const kernel = createManagementKernel({ repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const { run } = await kernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1',
    rootTaskId: 'task-root', rootMessageId: 'message-root',
    frozenTarget: { agentId: 'agent-a', kind: 'custom' }, requestKey: 'collab-run',
    requestHash: 'collab-run-hash', placementPolicy: { placement: 'device',
      allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 }, managementPhase: 2 });
  await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 1_000 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1,
    taskId: 'task-root', teamId: 'team-1', managementRunId: run.id, nodeKind: 'root',
    reviewPolicy: 'human', claimPolicy: 'targeted', requiredCapabilities: [], attempt: 1,
    maxAttempts: 2, taskRevision: 1, createdAt: 1, updatedAt: 1 });
  await repositories.taskCoordination.claimLeases.create({ id: 'claim-a', teamId: 'team-1',
    taskId: 'task-root', taskRevision: 1, taskAttempt: 1, agentId: 'agent-a',
    leaseTokenHash: 'hash', leaseFingerprint: 'fp', fencingToken: 1, status: 'active',
    acquiredAt: 1, heartbeatAt: 1, expiresAt: 1_000 });
  await repositories.management.invocations.create({ schemaVersion: 1, id: 'invocation-a',
    managementRunId: run.id, intent: { schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1',
      targetAgentId: 'agent-a', targetKind: 'custom', objective: '先做前置工作',
      taskContext: { taskId: 'task-root', rootTaskId: 'task-root', taskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-a' }, acceptanceCriteria: [], dependencyResults: [],
      attachmentIds: [] }, intentHash: 'hash-invocation-a', idempotencyKey: 'invoke-a', createdAt: 1 });
  await repositories.dispatches.create({ id: 'dispatch-a', teamId: 'team-1', channelId: 'channel-1',
    messageId: 'message-root', agentId: 'agent-a', status: 'succeeded', requestId: 'request-a',
    prompt: '先做前置工作', createdAt: 1, updatedAt: 2, completedAt: 2 });
  await repositories.management.dispatchAttempts.create({ id: 'attempt-a', invocationId: 'invocation-a',
    dispatchId: 'dispatch-a', attemptNumber: 1, status: 'succeeded', startedAt: 1, completedAt: 2 });
  const authority = { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 };
  return { repositories, runId: run.id, authority, kernel, clock, ids,
    service: createCollaborationService({ repositories, clock, ids }) };
}
