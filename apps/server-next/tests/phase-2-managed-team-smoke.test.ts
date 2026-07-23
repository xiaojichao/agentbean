import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type {
  ManagementRuntimeFactory,
  ManagementSession,
  ManagementSessionContextV2,
  ManagementToolExecutor,
  ManagementToolName,
} from '@agentbean/pi-management-runtime';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import {
  createDaemonProtocolClient,
  createDeviceServiceCore,
  createManagementDurableOutbox,
  createPiManagerWorkerHost,
  createTaskClaimProtocolClient,
  type DaemonProtocolSocket,
} from '../../daemon-next/src/index.js';
import { createManagementWorkerProtocol } from '../../daemon-next/src/management-worker-protocol.js';
import { createWebSocketClient, type WebSocketTransport } from '../../web-next/src/index.js';
import { startServerNextDevServer } from '../src/dev-server.js';

type ClientSocket = WebSocketTransport & DaemonProtocolSocket & {
  connect(): void;
  disconnect(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

interface ToolSnapshot {
  taskId: string;
  taskRevision: number;
  taskAttempt: number;
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';
  claimLeaseId?: string;
  claimedAgentId?: string;
}

interface ExecutionRecord {
  agentId: string;
  deviceLabel: string;
  dispatchId: string;
  prompt: string;
  memoryContext?: unknown;
}

const requireFromServer = createRequire(new URL('../package.json', import.meta.url));
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('Phase 3 managed 真实双 Agent / 跨 Task Memory smoke', () => {
  test('Agent A 来源经 Capsule 交给 Agent B，B 仅提 Candidate，最终由用户合并冲突', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-phase2-managed-team-'));
    cleanups.push(async () => rmSync(dataDir, { recursive: true, force: true }));
    const server = await startServerNextDevServer({
      messageIngestionMode: 'legacy',
      config: {
        host: '127.0.0.1', port: 0, storage: 'memory', dataDir,
        sessionSecret: 'phase-2-managed-team-smoke', webEntry: 'preview',
      },
      dispatchTimeout: { timeoutMs: 10_000, intervalMs: 100 },
    });
    cleanups.push(async () => {
      await withTimeout(server.close(), 3_000, 'SERVER_CLOSE_TIMEOUT').catch(() => undefined);
    });

    const webSocket = await connectClient(`${server.baseUrl}/web`);
    const agentSocketA = await connectClient(`${server.baseUrl}/agent`);
    const agentSocketB = await connectClient(`${server.baseUrl}/agent`);
    cleanups.push(async () => {
      webSocket.disconnect(); agentSocketA.disconnect(); agentSocketB.disconnect();
    });
    const web = createWebSocketClient(webSocket);
    const registered = await web.register({ username: 'owner', password: 'secret', teamName: 'Team' }) as {
      token: string;
      user: { id: string };
      currentTeam: { id: string };
      defaultChannel: { id: string };
    };
    const teamId = registered.currentTeam.id;
    const userId = registered.user.id;
    const token = registered.token;
    const channelId = registered.defaultChannel.id;
    const authenticatedWebSocket = await connectClient(`${server.baseUrl}/web`, { auth: { token } });
    cleanups.push(async () => authenticatedWebSocket.disconnect());

    const deviceA = await registerDeviceAndAgent({
      socket: agentSocketA, web, teamId, userId, machineId: 'phase2-device-a',
      agentName: 'Agent A', skillName: 'phase2-agent-a',
    });
    const deviceB = await registerDeviceAndAgent({
      socket: agentSocketB, web, teamId, userId, machineId: 'phase2-device-b',
      agentName: 'Agent B', skillName: 'phase2-agent-b',
    });
    const agentIds = [deviceA.agentId, deviceB.agentId];
    const createdMemory = await authenticatedWebSocket.emitWithAck(WEB_EVENTS.memory.create, {
      token, userId, teamId, kind: 'decision', scopeType: 'team', scopeRef: teamId,
      content: '所有 AgentBean 构建与验收统一使用 Node 24。',
      summary: 'AgentBean 使用 Node 24。', tags: ['phase3-smoke'],
    }) as { ok: boolean; memory: { item: { id: string } } };
    if (!createdMemory.ok) throw new Error(`SMOKE_MEMORY_CREATE_FAILED:${JSON.stringify(createdMemory)}`);
    expect(createdMemory).toMatchObject({ ok: true, memory: { item: { id: expect.any(String) } } });
    const capabilitiesByAgentId = new Map([
      [deviceA.agentId, 'phase2-agent-a'],
      [deviceB.agentId, 'phase2-agent-b'],
    ]);
    const executions: ExecutionRecord[] = [];
    const socketsByAgentId = new Map([
      [deviceA.agentId, agentSocketA],
      [deviceB.agentId, agentSocketB],
    ]);

    const dispatchClientA = createDispatchClient({
      socket: agentSocketA, teamId, userId, machineId: 'phase2-device-a',
      agentId: deviceA.agentId, deviceLabel: 'A', executions,
    });
    const dispatchClientB = createDispatchClient({
      socket: agentSocketB, teamId, userId, machineId: 'phase2-device-b',
      agentId: deviceB.agentId, deviceLabel: 'B', executions,
    });
    const claimClientA = createTaskClaimProtocolClient({
      socket: agentSocketA, getDeviceId: () => dispatchClientA.deviceId,
    });
    const claimClientB = createTaskClaimProtocolClient({
      socket: agentSocketB, getDeviceId: () => dispatchClientB.deviceId,
    });

    const managerState: {
      rootTaskId?: string;
      openTaskId?: string;
      targetedTaskId?: string;
      openClaim?: ToolSnapshot;
      targetedClaim?: ToolSnapshot;
      openInvocation?: Record<string, unknown>;
      replayInvocation?: Record<string, unknown>;
      targetedInvocation?: Record<string, unknown>;
      capsule?: Record<string, unknown>;
      candidate?: Record<string, unknown>;
      replayCandidate?: Record<string, unknown>;
      staleResult?: { isError?: boolean; body: Record<string, unknown> };
      rootDelivery?: Record<string, unknown>;
      error?: string;
    } = {};
    const protocol = createManagementWorkerProtocol({
      socket: agentSocketA,
      workerInstanceId: 'phase-2-live-worker',
      profileId: 'default',
      runtimeVersion: '0.1.0',
      ackTimeoutMs: 5_000,
      toolAckTimeoutMs: 15_000,
    });
    const outbox = await createManagementDurableOutbox({ profileId: 'default', baseDir: dataDir });
    const managementWorkerHost = createPiManagerWorkerHost({
      profileId: 'default', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({
        credentialStatus: 'production_ready', providerId: 'smoke-provider',
        modelId: 'smoke-model', apiKey: 'device-local-model-secret',
      }) },
      outbox,
      createRuntimeFactory: ({ toolExecutor }): ManagementRuntimeFactory => ({
        async createSession({ context }) {
          if (context.schemaVersion !== 2) throw new Error('PHASE_2_CONTEXT_REQUIRED');
          return scriptedManagerSession({
            context, toolExecutor, agentIds, capabilitiesByAgentId, teamId,
            seededMemoryId: createdMemory.memory.item.id, state: managerState,
          });
        },
      }),
    });
    const serviceA = createDeviceServiceCore({
      dispatchClient: dispatchClientA, taskClaimClient: claimClientA, managementWorkerHost,
    });
    const serviceB = createDeviceServiceCore({
      dispatchClient: dispatchClientB,
      taskClaimClient: claimClientB,
      managementWorkerHost: { async start() {}, async stop() {} },
    });
    await serviceA.start();
    await serviceB.start();
    await reportAgentSkill(agentSocketA, teamId, deviceA.deviceId, deviceA.agentId,
      'Agent A', 'phase2-agent-a');
    await reportAgentSkill(agentSocketB, teamId, deviceB.deviceId, deviceB.agentId,
      'Agent B', 'phase2-agent-b');
    const visibleAgents = await webSocket.emitWithAck(WEB_EVENTS.agent.subscribe, { userId, teamId }) as {
      ok: boolean;
      agents: Array<{ id: string; skills?: Array<{ name: string }> }>;
    };
    expect(visibleAgents.ok).toBe(true);
    expect(visibleAgents.agents.find((agent) => agent.id === deviceA.agentId)?.skills?.map((skill) => skill.name))
      .toContain('phase2-agent-a');
    expect(visibleAgents.agents.find((agent) => agent.id === deviceB.agentId)?.skills?.map((skill) => skill.name))
      .toContain('phase2-agent-b');
    cleanups.push(async () => {
      await withTimeout(serviceB.stop(), 2_000, 'SERVICE_B_STOP_TIMEOUT').catch(() => undefined);
      await withTimeout(serviceA.stop(), 2_000, 'SERVICE_A_STOP_TIMEOUT').catch(() => undefined);
    });

    await expect(webSocket.emitWithAck(WEB_EVENTS.managementPolicy.update, {
      userId, teamId, mode: 'managed', maxManagementPhase: 3,
      placementPolicy: {
        placement: 'device', allowedDeviceIds: [deviceA.deviceId, deviceB.deviceId],
        allowServerContext: false, requireLocalModelCredentials: true,
      },
    })).resolves.toMatchObject({ ok: true, policy: { mode: 'managed', maxManagementPhase: 3 } });

    const sent = await webSocket.emitWithAck(WEB_EVENTS.message.send, {
      userId, teamId, channelId, body: '请按依赖顺序完成 Phase 3 跨 Agent Memory smoke',
      asTask: true, clientMessageId: 'phase-3-managed-memory-message',
    }) as { ok: boolean; task?: { id: string }; management?: { managementPhase?: number } };
    expect(sent).toMatchObject({
      ok: true,
      task: { id: expect.any(String) },
      management: { managementPhase: 3 },
    });
    managerState.rootTaskId = sent.task!.id;

    await eventually(async () => {
      expect(managerState.error).toBeUndefined();
      expect(managerState.rootDelivery).toMatchObject({
        deliveryMessageId: expect.any(String), status: 'in_review',
      });
      expect(executions).toHaveLength(2);
      expect(outbox.size()).toBe(0);
    }, 300);

    expect(managerState.openClaim?.claimedAgentId).toBeTruthy();
    const openWinnerId = managerState.openClaim!.claimedAgentId!;
    const openLoserId = agentIds.find((agentId) => agentId !== openWinnerId)!;
    expect(managerState.targetedClaim?.claimedAgentId).toBe(openLoserId);
    expect(managerState.openInvocation).toEqual(managerState.replayInvocation);
    expect(managerState.candidate).toEqual(managerState.replayCandidate);
    expect(managerState.candidate).toMatchObject({ status: 'conflict', candidateId: expect.any(String) });
    expect(managerState.staleResult).toMatchObject({
      isError: true,
      body: { error: expect.stringMatching(/STALE|FUTURE|CONFLICT/) },
    });
    expect(executions.filter((record) => record.agentId === openWinnerId)).toHaveLength(1);
    expect(executions.filter((record) => record.agentId === openLoserId)).toHaveLength(1);
    const targetExecution = executions.find((record) => record.agentId === openLoserId)!;
    if (!targetExecution.memoryContext) {
      const diagnostic = await authenticatedWebSocket.emitWithAck(WEB_EVENTS.memory.snapshot, { token, userId, teamId });
      throw new Error(`SMOKE_CAPSULE_NOT_INJECTED:${JSON.stringify({
        capsule: managerState.capsule, targetExecution, diagnostic,
      })}`);
    }
    const capsuleRef = managerState.capsule!.capsuleRef as { id: string };
    expect(targetExecution.memoryContext).toMatchObject([{
      content: '所有 AgentBean 构建与验收统一使用 Node 24。',
      provenance: {
        origin: 'server', capsuleId: capsuleRef.id,
        sourceRefs: [expect.objectContaining({ sourceKind: 'message' })],
      },
    }]);

    const beforeMerge = await authenticatedWebSocket.emitWithAck(WEB_EVENTS.memory.snapshot, { token, userId, teamId }) as {
      ok: boolean;
      snapshot: { candidates: Array<{ id: string; status: string; conflictMemoryIds: string[] }> };
    };
    const candidateId = managerState.candidate!.candidateId as string;
    expect(beforeMerge.snapshot.candidates).toMatchObject([{
      id: candidateId,
      status: 'conflict', conflictMemoryIds: [createdMemory.memory.item.id],
    }]);
    // 候选来源是频道 message（resolveSourceScope→channel scope），目标是 team scope，
    // 属 channel→team 的 scope expansion（ADR-0007/#719 AC#4），合并须显式确认扩 scope。
    await expect(authenticatedWebSocket.emitWithAck(WEB_EVENTS.memory.candidateMerge, {
      token, userId, teamId, candidateId,
      conflictMemoryId: createdMemory.memory.item.id,
      confirmScopeExpansion: true,
    })).resolves.toMatchObject({ ok: true, candidate: { candidate: {
      status: 'merged', mergedIntoMemoryId: expect.any(String),
    } } });

    const dag = await webSocket.emitWithAck(WEB_EVENTS.task.dag, {
      userId, teamId, rootTaskId: sent.task!.id,
    }) as { ok: boolean; dag: { rootTaskId: string; nodes: Array<{
      task: { id: string; status: string };
      coordination: { dependencyTaskIds: string[] };
    }> } };
    expect(dag.ok).toBe(true);
    expect(dag.dag.rootTaskId).toBe(sent.task!.id);
    expect(dag.dag.nodes.find((node) => node.task.id === managerState.openTaskId)?.task.status)
      .toBe('done');
    const targetedNode = dag.dag.nodes.find((node) => node.task.id === managerState.targetedTaskId);
    expect(targetedNode?.task.status).toBe('done');
    expect(targetedNode?.coordination.dependencyTaskIds).toContain(managerState.openTaskId);

    await expect(webSocket.emitWithAck(WEB_EVENTS.task.update, {
      userId, teamId, taskId: sent.task!.id, status: 'done',
    })).resolves.toMatchObject({ ok: true, task: { id: sent.task!.id, status: 'done' } });

    const firstExecution = executions[0]!;
    const firstSocket = socketsByAgentId.get(firstExecution.agentId)!;
    await expect(firstSocket.emitWithAck(AGENT_EVENTS.dispatch.result, {
      dispatchId: firstExecution.dispatchId,
      agentId: firstExecution.agentId,
      body: 'late duplicate result',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    expect(executions).toHaveLength(2);
  }, 30_000);
});

function scriptedManagerSession(input: {
  context: ManagementSessionContextV2;
  toolExecutor: ManagementToolExecutor;
  agentIds: readonly string[];
  capabilitiesByAgentId: ReadonlyMap<string, string>;
  teamId: string;
  seededMemoryId: string;
  state: {
    rootTaskId?: string;
    openTaskId?: string;
    targetedTaskId?: string;
    openClaim?: ToolSnapshot;
    targetedClaim?: ToolSnapshot;
    openInvocation?: Record<string, unknown>;
    replayInvocation?: Record<string, unknown>;
    targetedInvocation?: Record<string, unknown>;
    capsule?: Record<string, unknown>;
    candidate?: Record<string, unknown>;
    replayCandidate?: Record<string, unknown>;
    staleResult?: { isError?: boolean; body: Record<string, unknown> };
    rootDelivery?: Record<string, unknown>;
    error?: string;
  };
}): ManagementSession {
  let aborted = false;
  return {
    async prompt() {
      try {
      const rootTaskId = input.context.scope.rootTaskId;
      input.state.rootTaskId = rootTaskId;
      const createdOpen = await callTool(input.toolExecutor, input.context, 'tasks.create_subtasks', {
        parentTaskId: rootTaskId,
        subtasks: [{
          clientKey: 'open', title: 'Open claim task', description: '完成 open 分支',
          claimPolicy: 'open', requiredCapabilities: [], acceptanceCriteria: [], maxAttempts: 2,
        }],
      }, 'create-open');
      const openTaskId = (createdOpen.taskIds as string[])[0]!;
      input.state.openTaskId = openTaskId;
      await callTool(input.toolExecutor, input.context, 'tasks.publish_for_claim', {
        taskId: openTaskId, expectedTaskRevision: 1,
      }, 'publish-open');
      const openClaim = await waitForClaim(input.toolExecutor, input.context, openTaskId, 'open');
      input.state.openClaim = openClaim;
      const openInvokeInput = {
        taskId: openTaskId, expectedTaskRevision: openClaim.taskRevision,
        taskAttempt: openClaim.taskAttempt, claimLeaseId: openClaim.claimLeaseId,
        objective: '完成 open 分支', attachmentIds: [],
      };
      input.state.openInvocation = await callTool(
        input.toolExecutor, input.context, 'agents.invoke', openInvokeInput, 'invoke-open');
      input.state.replayInvocation = await callTool(
        input.toolExecutor, input.context, 'agents.invoke', openInvokeInput, 'invoke-open');
      await acceptDelivery(input.toolExecutor, input.context, openClaim, input.state.openInvocation, 'accept-open');
      const openEvidenceRefs = toMemorySourceRefs(input.state.openInvocation.evidenceRefs);
      await callTool(input.toolExecutor, input.context, 'memory.link_sources', {
        memoryId: input.seededMemoryId, sourceRefs: openEvidenceRefs,
      }, 'link-open-memory');

      const stale = await callToolResult(input.toolExecutor, input.context, 'tasks.retry', {
        taskId: openTaskId, expectedTaskRevision: 999, reasonCode: 'SMOKE_STALE_REVISION',
      }, 'retry-open-stale');
      input.state.staleResult = stale;

      const openWinnerId = openClaim.claimedAgentId!;
      const targetedAgentId = input.agentIds.find((agentId) => agentId !== openWinnerId)!;
      const createdTargeted = await callTool(input.toolExecutor, input.context, 'tasks.create_subtasks', {
        parentTaskId: rootTaskId,
        subtasks: [{
          clientKey: 'targeted', title: 'Targeted dependency task', description: '完成 targeted 分支',
          claimPolicy: 'open',
          requiredCapabilities: [input.capabilitiesByAgentId.get(targetedAgentId)!],
          acceptanceCriteria: [], maxAttempts: 2,
        }],
      }, 'create-targeted');
      const targetedTaskId = (createdTargeted.taskIds as string[])[0]!;
      input.state.targetedTaskId = targetedTaskId;
      const dependency = await callTool(input.toolExecutor, input.context, 'tasks.add_dependency', {
        taskId: targetedTaskId, dependencyTaskId: openTaskId, expectedTaskRevision: 1,
      }, 'dependency-targeted');
      const assigned = await callTool(input.toolExecutor, input.context, 'tasks.assign', {
        taskId: targetedTaskId, agentId: targetedAgentId,
        expectedTaskRevision: dependency.taskRevision,
      }, 'assign-targeted');
      await callTool(input.toolExecutor, input.context, 'tasks.publish_for_claim', {
        taskId: targetedTaskId, expectedTaskRevision: assigned.taskRevision,
      }, 'publish-targeted');
      const targetedClaim = await waitForClaim(
        input.toolExecutor, input.context, targetedTaskId, 'targeted');
      input.state.targetedClaim = targetedClaim;
      input.state.capsule = await callTool(input.toolExecutor, input.context, 'memory.create_capsule', {
        targetAgentId: targetedAgentId,
        prompt: 'AgentBean Node 24 构建验收要求',
        limit: 3,
        taskId: targetedTaskId,
      }, 'create-targeted-capsule');
      input.state.targetedInvocation = await callTool(input.toolExecutor, input.context, 'agents.invoke', {
        taskId: targetedTaskId, expectedTaskRevision: targetedClaim.taskRevision,
        taskAttempt: targetedClaim.taskAttempt, claimLeaseId: targetedClaim.claimLeaseId,
        targetAgentId: targetedAgentId,
        objective: '读取最小 Memory Capsule 并完成 targeted 分支', attachmentIds: [],
        memoryCapsuleRef: input.state.capsule.capsuleRef,
      }, 'invoke-targeted');
      await acceptDelivery(
        input.toolExecutor, input.context, targetedClaim, input.state.targetedInvocation, 'accept-targeted');
      const targetedEvidenceRefs = toMemorySourceRefs(input.state.targetedInvocation.evidenceRefs);
      await callTool(input.toolExecutor, input.context, 'memory.link_sources', {
        memoryId: input.seededMemoryId, sourceRefs: targetedEvidenceRefs,
      }, 'link-targeted-memory');
      const proposeInput = {
        targetAgentId: targetedAgentId,
        scopeType: 'team',
        scopeRef: input.teamId,
        contentKind: 'decision',
        proposedContent: 'Agent B 已确认 AgentBean 构建与验收统一使用 Node 24。',
        proposedSummary: 'Agent B 确认 Node 24。',
        sourceRefs: targetedEvidenceRefs,
        taskId: targetedTaskId,
      };
      input.state.candidate = await callTool(
        input.toolExecutor, input.context, 'memory.propose_candidate', proposeInput, 'propose-targeted-memory');
      input.state.replayCandidate = await callTool(
        input.toolExecutor, input.context, 'memory.propose_candidate', proposeInput, 'propose-targeted-memory');

      const rootDelivery = await callToolResult(
        input.toolExecutor, input.context, 'review.submit_root_delivery', {
          body: '两个 Agent 已按依赖顺序完成任务；Agent B 的 Memory 结论仍待人工治理。',
          contributingInvocationIds: [
            input.state.openInvocation.invocationId,
            input.state.targetedInvocation.invocationId,
          ],
        }, 'root-delivery');
      input.state.rootDelivery = rootDelivery.body;
      if (rootDelivery.isError) throw new Error(`ROOT_DELIVERY_FAILED:${JSON.stringify(rootDelivery.body)}`);
      } catch (error) {
        input.state.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    async steer() {},
    async followUp() {},
    async compact() { return { compacted: false, reason: 'not_needed' }; },
    async abort() { aborted = true; },
    async waitForIdle() { if (aborted) throw new Error('MANAGEMENT_SESSION_ABORTED'); },
    subscribe() { return () => undefined; },
    async dispose() {},
  };
}

async function acceptDelivery(
  toolExecutor: ManagementToolExecutor,
  context: ManagementSessionContextV2,
  snapshot: ToolSnapshot,
  invocation: Record<string, unknown>,
  toolCallId: string,
): Promise<void> {
  await callTool(toolExecutor, context, 'tasks.accept_subtask', {
    acceptance: {
      schemaVersion: 1,
      taskId: snapshot.taskId,
      deliveryId: invocation.deliveryId,
      expectedTaskRevision: snapshot.taskRevision,
      taskAttempt: snapshot.taskAttempt,
      claimLeaseId: snapshot.claimLeaseId,
      decision: 'accepted',
      criteriaResults: [],
      reason: 'Phase 2 smoke accepted',
      decidedBy: 'manager',
      decidedAt: Date.now(),
    },
  }, toolCallId);
}

async function waitForClaim(
  toolExecutor: ManagementToolExecutor,
  context: ManagementSessionContextV2,
  taskId: string,
  label: string,
): Promise<ToolSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waited = await callTool(toolExecutor, context, 'tasks.wait', { taskIds: [taskId] },
      `wait-${label}-${attempt}`);
    const snapshot = (waited.taskSnapshots as ToolSnapshot[])[0];
    if (snapshot?.claimLeaseId && snapshot.claimedAgentId) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`TASK_CLAIM_TIMEOUT:${label}`);
}

async function callTool(
  toolExecutor: ManagementToolExecutor,
  context: ManagementSessionContextV2,
  name: ManagementToolName,
  toolInput: Record<string, unknown>,
  toolCallId: string,
): Promise<Record<string, unknown>> {
  const result = await callToolResult(toolExecutor, context, name, toolInput, toolCallId);
  if (result.isError) throw new Error(String(result.body.diagnosticCode ?? `TOOL_FAILED:${name}`));
  return result.body;
}

async function callToolResult(
  toolExecutor: ManagementToolExecutor,
  context: ManagementSessionContextV2,
  name: ManagementToolName,
  toolInput: Record<string, unknown>,
  toolCallId: string,
): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const result = await toolExecutor({
    toolCallId,
    name,
    scope: context.scope,
    input: toolInput,
    metadata: {
      name,
      effect: name === 'tasks.wait' ? 'read' : 'write',
      phase: name.startsWith('memory.') ? 3 : 2,
      inputSchemaVersion: 1,
    },
  });
  return { ...(result.isError ? { isError: true } : {}), body: JSON.parse(result.text) as Record<string, unknown> };
}

function toMemorySourceRefs(value: unknown): Array<{
  schemaVersion: 1;
  sourceKind: 'message';
  sourceId: string;
  snapshotHash: string;
}> {
  if (!Array.isArray(value)) throw new Error('SMOKE_EVIDENCE_REFS_REQUIRED');
  const refs = value.flatMap((entry) => {
    const ref = entry as { kind?: unknown; id?: unknown; snapshotHash?: unknown };
    // 跨 Task Capsule 只冻结 Agent 可共同读取的交付 message；Task/Invocation 追溯由
    // candidate.taskId / sourceInvocationId 保留，避免把另一个 Agent 不可见的 Task 原文带出 scope。
    if (ref.kind !== 'message') return [];
    if (typeof ref.id !== 'string' || typeof ref.snapshotHash !== 'string') {
      throw new Error(`SMOKE_EVIDENCE_REF_INVALID:${JSON.stringify(ref)}`);
    }
    return [{ schemaVersion: 1 as const, sourceKind: ref.kind, sourceId: ref.id, snapshotHash: ref.snapshotHash }];
  });
  if (refs.length === 0) throw new Error('SMOKE_EVIDENCE_REFS_REQUIRED');
  return refs;
}

function createDispatchClient(input: {
  socket: ClientSocket;
  teamId: string;
  userId: string;
  machineId: string;
  agentId: string;
  deviceLabel: string;
  executions: ExecutionRecord[];
}) {
  return createDaemonProtocolClient({
    socket: input.socket,
    executor: async (request) => {
      input.executions.push({
        agentId: input.agentId,
        deviceLabel: input.deviceLabel,
        dispatchId: request.id,
        prompt: request.prompt,
        memoryContext: request.memoryContext,
      });
      return `${input.deviceLabel}:${request.prompt}`;
    },
    device: { teamId: input.teamId, ownerId: input.userId, machineId: input.machineId, profileId: 'default' },
    runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
    agents: [],
    envResolver: async () => ({}),
  });
}

async function registerDeviceAndAgent(input: {
  socket: ClientSocket;
  web: ReturnType<typeof createWebSocketClient>;
  teamId: string;
  userId: string;
  machineId: string;
  agentName: string;
  skillName: string;
}): Promise<{ deviceId: string; agentId: string }> {
  const hello = await input.socket.emitWithAck(AGENT_EVENTS.device.hello, {
    teamId: input.teamId, ownerId: input.userId,
    machineId: input.machineId, profileId: 'default',
  }) as { device: { id: string } };
  const reported = await input.socket.emitWithAck(AGENT_EVENTS.device.runtimes, {
    teamId: input.teamId,
    deviceId: hello.device.id,
    runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
  }) as { runtimes: Array<{ id: string }> };
  const created = await input.web.createAgent({
    userId: input.userId,
    teamId: input.teamId,
    deviceId: hello.device.id,
    runtimeId: reported.runtimes[0]!.id,
    name: input.agentName,
    env: {},
  }) as { agent: { id: string } };
  await reportAgentSkill(input.socket, input.teamId, hello.device.id, created.agent.id,
    input.agentName, input.skillName);
  return { deviceId: hello.device.id, agentId: created.agent.id };
}

async function reportAgentSkill(
  socket: ClientSocket,
  teamId: string,
  deviceId: string,
  agentId: string,
  agentName: string,
  skillName: string,
): Promise<void> {
  await socket.emitWithAck(AGENT_EVENTS.agent.reportCustomSkills, {
    teamId,
    deviceId,
    items: [{
      agentId,
      skills: [{
        name: skillName,
        description: `${agentName} smoke capability`,
        scope: 'user',
        sourcePath: `/smoke/${skillName}/SKILL.md`,
        adapterKind: 'codex-cli',
      }],
    }],
  });
}

async function connectClient(url: string, options: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = createClient(url, {
    transports: ['websocket'], forceNew: true, reconnection: false, ...options,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(error));
    socket.connect();
  });
  return socket;
}

async function eventually(assertion: () => Promise<void>, attempts = 100): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
