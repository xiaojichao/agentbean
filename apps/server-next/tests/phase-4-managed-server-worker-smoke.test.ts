import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import type { ManagementLeaseOfferV1 } from '../../../packages/contracts/src/index.js';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import {
  createDaemonProtocolClient,
  createDeviceServiceCore,
  createTaskClaimProtocolClient,
  type DaemonProtocolSocket,
} from '../../daemon-next/src/index.js';
import { createWebSocketClient, type WebSocketTransport } from '../../web-next/src/index.js';
import { startServerNextDevServer } from '../src/dev-server.js';

type WebSocketClient = ReturnType<typeof createWebSocketClient>;
type ClientSocket = WebSocketTransport & DaemonProtocolSocket & {
  connect(): void;
  disconnect(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

interface ExecutionRecord {
  agentId: string;
  dispatchId: string;
  prompt: string;
}

const requireFromServer = createRequire(new URL('../package.json', import.meta.url));
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};

const SERVER_WORKER_TOKEN = 'phase-4-managed-server-worker-auth-token-32-chars';
const WORKER_POOL_ID = 'pool-phase-4-smoke';
const PROVIDER_CREDENTIAL_REF = 'provider-credential-phase-4-smoke';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('Phase 4 Managed Server Worker end-to-end smoke', () => {
  test('drives a rooted Managed Run from owner opt-in through Server Worker execution to root delivery', async () => {
    const harness = await createPhase4Harness();
    const owner = await harness.registerOwner();
    const device = await harness.registerDeviceAgent({ web: owner.web, teamId: owner.teamId, userId: owner.userId });
    const worker = await harness.connectServerWorker('server-worker-primary');
    await worker.register('server-worker-primary');
    await harness.optIntoManagedPlacement(owner.authenticatedSocket, owner.teamId, owner.userId);

    const sent = await harness.sendRootedMessage(owner.authenticatedSocket, {
      userId: owner.userId, teamId: owner.teamId, channelId: owner.channelId, key: 'root-delivery',
    });
    expect(sent.management?.kind).toBe('managed');
    const managementRunId = sent.management!.managementRunId!;

    const offer = await harness.waitForOffer(worker);
    const lease = await worker.acquireLease({
      schemaVersion: 1, offerId: offer.offerId, workerInstanceId: 'server-worker-primary',
    });
    expect(lease).toMatchObject({ ok: true, fencingToken: 1 });
    if (!lease.ok) throw new Error('Server Worker lease expected');

    const checkpoint = await worker.fetchCheckpoint({
      schemaVersion: 1, managementRunId, workerId: lease.workerId,
      leaseToken: lease.leaseToken, fencingToken: lease.fencingToken, knownCheckpointRevision: 0,
    });
    const rootTaskId = checkpoint.context.rootTaskId;
    if (!rootTaskId) throw new Error('checkpoint must expose the root task id');

    const delivery = await driveSingleSubtaskToRootDelivery(worker, {
      managementRunId, workerId: lease.workerId,
      leaseToken: lease.leaseToken, fencingToken: lease.fencingToken,
      rootTaskId, requiredCapability: device.skillName,
    });
    expect(delivery).toMatchObject({ status: 'in_review', deliveryMessageId: expect.any(String) });
    expect(harness.executions).toHaveLength(1);
    expect(harness.executions[0]!.agentId).toBe(device.agentId);
  });

  test('keeps ordinary chat on the direct path even after managed placement is opted in', async () => {
    const harness = await createPhase4Harness();
    const owner = await harness.registerOwner();
    await harness.registerDeviceAgent({ web: owner.web, teamId: owner.teamId, userId: owner.userId });
    const worker = await harness.connectServerWorker('server-worker-direct');
    await worker.register('server-worker-direct');
    await harness.optIntoManagedPlacement(owner.authenticatedSocket, owner.teamId, owner.userId);

    const chat = await owner.authenticatedSocket.emitWithAck(WEB_EVENTS.message.send, {
      userId: owner.userId, teamId: owner.teamId, channelId: owner.channelId,
      body: '一条不需要 Server Worker 的轻量问答',
    }) as { ok: boolean; management?: { kind: string } };
    expect(chat).toMatchObject({ ok: true, management: { kind: 'direct' } });
    expect(worker.offers).toHaveLength(0);
  });

  test('reports an unavailable Server Worker and never falls back to Device placement', async () => {
    const harness = await createPhase4Harness();
    const owner = await harness.registerOwner();
    await harness.registerDeviceAgent({ web: owner.web, teamId: owner.teamId, userId: owner.userId });
    await harness.optIntoManagedPlacement(owner.authenticatedSocket, owner.teamId, owner.userId);

    const sent = await harness.sendRootedMessage(owner.authenticatedSocket, {
      userId: owner.userId, teamId: owner.teamId, channelId: owner.channelId, key: 'unavailable',
    });
    // Server Worker 不可用时 sendMessage 把 unavailable 诊断作为 VALIDATION_ERROR 失败返回,绝不降级 Device
    expect(sent.ok).toBe(false);
    expect(sent.message).toEqual(expect.stringMatching(/MANAGEMENT_PHASE_2_WORKER_PROFILE_UNAVAILABLE|MANAGEMENT_PHASE_2_PREFLIGHT/));
  });

  test('queues a second rooted Run at full capacity and schedules it after the first releases', async () => {
    const harness = await createPhase4Harness();
    const owner = await harness.registerOwner();
    await harness.registerDeviceAgent({ web: owner.web, teamId: owner.teamId, userId: owner.userId });
    const worker = await harness.connectServerWorker('server-worker-queue');
    await worker.register('server-worker-queue');
    await harness.optIntoManagedPlacement(owner.authenticatedSocket, owner.teamId, owner.userId);

    const first = await harness.sendRootedMessage(owner.authenticatedSocket, { userId: owner.userId, teamId: owner.teamId, channelId: owner.channelId, key: 'queue-first' });
    const second = await harness.sendRootedMessage(owner.authenticatedSocket, { userId: owner.userId, teamId: owner.teamId, channelId: owner.channelId, key: 'queue-second' });
    expect(first.management?.kind).toBe('managed');
    expect(second.management).toMatchObject({ kind: 'managed', schedulingDiagnostic: 'SERVER_WORKER_CAPACITY_EXHAUSTED' });

    const firstOffer = await harness.waitForOffer(worker);
    expect(firstOffer.managementRunId).toBe(first.management!.managementRunId);
    expect(worker.offers.filter((offer) => offer.managementRunId === second.management!.managementRunId)).toHaveLength(0);

    const firstLease = await worker.acquireLease({
      schemaVersion: 1, offerId: firstOffer.offerId, workerInstanceId: 'server-worker-queue',
    });
    if (!firstLease.ok) throw new Error('first lease expected');
    await worker.releaseLease({
      schemaVersion: 1, managementRunId: first.management!.managementRunId!,
      workerId: firstLease.workerId, leaseToken: firstLease.leaseToken,
      fencingToken: firstLease.fencingToken, idempotencyKey: 'queue-first-release', reasonCode: 'COMPLETED',
    });

    const secondOffer = await harness.waitForOffer(worker, second.management!.managementRunId!);
    expect(secondOffer.managementRunId).toBe(second.management!.managementRunId);
  });

  test('takes over a Run on a second Server Worker after the first crashes, with a higher fencing token', async () => {
    const harness = await createPhase4Harness({ leaseTtlMs: 200 });
    const owner = await harness.registerOwner();
    await harness.registerDeviceAgent({ web: owner.web, teamId: owner.teamId, userId: owner.userId });
    const primary = await harness.connectServerWorker('server-worker-crash');
    const secondary = await harness.connectServerWorker('server-worker-takeover');
    await primary.register('server-worker-crash');
    await secondary.register('server-worker-takeover');
    await harness.optIntoManagedPlacement(owner.authenticatedSocket, owner.teamId, owner.userId);

    const sent = await harness.sendRootedMessage(owner.authenticatedSocket, { userId: owner.userId, teamId: owner.teamId, channelId: owner.channelId, key: 'takeover' });
    const offer = await harness.waitForOffer(primary);
    const first = await primary.acquireLease({
      schemaVersion: 1, offerId: offer.offerId, workerInstanceId: 'server-worker-crash',
    });
    if (!first.ok) throw new Error('first lease expected');

    primary.disconnect();

    const takeoverOffer = await harness.waitForOffer(secondary, sent.management!.managementRunId!);
    expect(takeoverOffer.managementRunId).toBe(sent.management!.managementRunId);
    const second = await secondary.acquireLease({
      schemaVersion: 1, offerId: takeoverOffer.offerId, workerInstanceId: 'server-worker-takeover',
    });
    expect(second).toMatchObject({ ok: true, fencingToken: 2 });
  });

  test('fails a queued Run after the queue timeout instead of waiting forever', async () => {
    const harness = await createPhase4Harness({ queueTimeoutMs: 150 });
    const owner = await harness.registerOwner();
    await harness.registerDeviceAgent({ web: owner.web, teamId: owner.teamId, userId: owner.userId });
    const worker = await harness.connectServerWorker('server-worker-timeout');
    await worker.register('server-worker-timeout');
    await harness.optIntoManagedPlacement(owner.authenticatedSocket, owner.teamId, owner.userId);

    const busy = await harness.sendRootedMessage(owner.authenticatedSocket, { userId: owner.userId, teamId: owner.teamId, channelId: owner.channelId, key: 'timeout-busy' });
    const queued = await harness.sendRootedMessage(owner.authenticatedSocket, { userId: owner.userId, teamId: owner.teamId, channelId: owner.channelId, key: 'timeout-queued' });
    expect(queued.management).toMatchObject({ schedulingDiagnostic: 'SERVER_WORKER_CAPACITY_EXHAUSTED' });

    const busyOffer = await harness.waitForOffer(worker);
    const busyLease = await worker.acquireLease({
      schemaVersion: 1, offerId: busyOffer.offerId, workerInstanceId: 'server-worker-timeout',
    });
    if (!busyLease.ok) throw new Error('busy lease expected');
    expect(worker.offers.filter((offer) => offer.managementRunId === queued.management!.managementRunId)).toHaveLength(0);

    await eventually(async () => {
      const db = harness.openTeamDatabase();
      try {
        const run = db.prepare('SELECT status FROM management_runs WHERE id = ?')
          .get(queued.management!.managementRunId!) as { status: string } | undefined;
        expect(run?.status).toBe('failed');
        const failed = db.prepare('SELECT type FROM management_events WHERE management_run_id = ? AND type = ?')
          .all(queued.management!.managementRunId!, 'run-failed') as { type: string }[];
        expect(failed).toHaveLength(1);
      } finally {
        db.close();
      }
    }, 250);
    expect(busy.management!.managementRunId).toBeTruthy();
  });

  test('denies a Server Worker tool request after the initiating user is removed from the team', async () => {
    const harness = await createPhase4Harness();
    const owner = await harness.registerOwner();
    const collaborator = await harness.inviteCollaborator(owner);
    await harness.registerDeviceAgent({ web: owner.web, teamId: owner.teamId, userId: owner.userId });
    const worker = await harness.connectServerWorker('server-worker-revoke');
    await worker.register('server-worker-revoke');
    await harness.optIntoManagedPlacement(owner.authenticatedSocket, owner.teamId, owner.userId);

    const sent = await harness.sendRootedMessage(collaborator.authenticatedSocket, {
      userId: collaborator.userId, teamId: owner.teamId, channelId: owner.channelId, key: 'revoke',
    });
    expect(sent.management?.kind).toBe('managed');
    const managementRunId = sent.management!.managementRunId!;

    const offer = await harness.waitForOffer(worker);
    const lease = await worker.acquireLease({
      schemaVersion: 1, offerId: offer.offerId, workerInstanceId: 'server-worker-revoke',
    });
    if (!lease.ok) throw new Error('lease expected');
    await worker.fetchCheckpoint({
      schemaVersion: 1, managementRunId, workerId: lease.workerId,
      leaseToken: lease.leaseToken, fencingToken: lease.fencingToken, knownCheckpointRevision: 0,
    });

    const removed = await owner.authenticatedSocket.emitWithAck(WEB_EVENTS.member.remove, {
      userId: owner.userId, teamId: owner.teamId, targetUserId: collaborator.userId,
    }) as { ok: boolean };
    expect(removed.ok).toBe(true);

    // 用一个合法的 Phase 1 读工具触发 executeTool 权限复验;collaborator 被移除后 Team 成员资格校验 fail closed
    const denied = await worker.callTool({
      schemaVersion: 1, commandId: 'cmd-revoke', managementRunId,
      workerId: lease.workerId, toolCallId: 'tool-revoke', toolName: 'context.get_management_state',
      input: {},
    });
    expect(denied).toMatchObject({ ok: false, diagnosticCode: 'SERVER_WORKER_TEAM_FORBIDDEN' });
  });
});

interface OwnerContext {
  readonly web: WebSocketClient;
  readonly authenticatedSocket: ClientSocket;
  readonly token: string;
  readonly userId: string;
  readonly teamId: string;
  readonly channelId: string;
}

interface CollaboratorContext {
  readonly authenticatedSocket: ClientSocket;
  readonly userId: string;
}

interface FakeServerWorker {
  readonly offers: ManagementLeaseOfferV1[];
  disconnect(): void;
  register(workerInstanceId: string): Promise<{ ok: boolean; workerId?: string }>;
  acquireLease(payload: unknown): Promise<Record<string, unknown>>;
  releaseLease(payload: unknown): Promise<Record<string, unknown>>;
  fetchCheckpoint(payload: unknown): Promise<{ context: { rootTaskId?: string } }>;
  callTool(payload: unknown): Promise<{ ok: boolean; output?: Record<string, unknown>; diagnosticCode?: string }>;
}

interface Phase4Harness {
  readonly baseUrl: string;
  readonly executions: ExecutionRecord[];
  registerOwner(): Promise<OwnerContext>;
  inviteCollaborator(owner: OwnerContext): Promise<CollaboratorContext>;
  registerDeviceAgent(input: { web: WebSocketClient; teamId: string; userId: string }): Promise<{ deviceId: string; agentId: string; skillName: string }>;
  connectServerWorker(workerInstanceId: string): Promise<FakeServerWorker>;
  optIntoManagedPlacement(socket: ClientSocket, teamId: string, userId: string): Promise<void>;
  sendRootedMessage(socket: ClientSocket, input: { userId: string; teamId: string; channelId: string; key: string }): Promise<{ management?: { kind: string; managementRunId?: string; schedulingDiagnostic?: string; diagnostics?: readonly string[] } }>;
  waitForOffer(worker: FakeServerWorker, managementRunId?: string): Promise<ManagementLeaseOfferV1>;
  openTeamDatabase(): import('better-sqlite3').Database;
}

async function createPhase4Harness(tuning: { queueTimeoutMs?: number; leaseTtlMs?: number } = {}): Promise<Phase4Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-phase4-managed-e2e-'));
  cleanups.push(async () => rmSync(dataDir, { recursive: true, force: true }));
  const executions: ExecutionRecord[] = [];
  const server = await startServerNextDevServer({
    config: {
      host: '127.0.0.1', port: 0, storage: 'sqlite', dataDir,
      sessionSecret: 'phase-4-managed-server-worker-smoke', webEntry: 'preview',
      serverWorker: {
        workerPoolId: WORKER_POOL_ID,
        providerCredentialRef: PROVIDER_CREDENTIAL_REF,
        authToken: SERVER_WORKER_TOKEN,
        ...(tuning.queueTimeoutMs ? { queueTimeoutMs: tuning.queueTimeoutMs } : {}),
        ...(tuning.leaseTtlMs ? { leaseTtlMs: tuning.leaseTtlMs } : {}),
      },
    },
    dispatchTimeout: { timeoutMs: 5_000, intervalMs: 100 },
  });
  cleanups.push(async () => {
    await withTimeout(server.close(), 3_000, 'SERVER_CLOSE_TIMEOUT').catch(() => undefined);
  });
  const baseUrl = server.baseUrl;

  return {
    baseUrl,
    executions,
    async registerOwner() {
      const socket = await connectClient(`${baseUrl}/web`);
      cleanups.push(async () => socket.disconnect());
      const web = createWebSocketClient(socket);
      const registered = await web.register({ username: 'owner', password: 'secret', teamName: 'Team' }) as {
        token: string; user: { id: string }; currentTeam: { id: string }; defaultChannel: { id: string };
      };
      const authenticatedSocket = await connectClient(`${baseUrl}/web`, { auth: { token: registered.token } });
      cleanups.push(async () => authenticatedSocket.disconnect());
      return {
        web, authenticatedSocket,
        token: registered.token,
        userId: registered.user.id,
        teamId: registered.currentTeam.id,
        channelId: registered.defaultChannel.id,
      };
    },
    async inviteCollaborator(owner) {
      const joinLink = await owner.web.createJoinLink({ userId: owner.userId, teamId: owner.teamId }) as { link: { code: string } };
      const collaboratorSocket = await connectClient(`${baseUrl}/web`);
      cleanups.push(async () => collaboratorSocket.disconnect());
      const collaboratorWeb = createWebSocketClient(collaboratorSocket);
      const registered = await collaboratorWeb.register({
        username: 'collaborator', password: 'secret', teamName: 'Collab Team',
        joinCode: joinLink.link.code,
      }) as { token: string; user: { id: string } };
      const authenticatedSocket = await connectClient(`${baseUrl}/web`, { auth: { token: registered.token } });
      cleanups.push(async () => authenticatedSocket.disconnect());
      return { authenticatedSocket, userId: registered.user.id };
    },
    async registerDeviceAgent({ web, teamId, userId }) {
      const skillName = 'phase4-device-agent';
      const agentSocket = await connectClient(`${baseUrl}/agent`);
      cleanups.push(async () => agentSocket.disconnect());
      const hello = await agentSocket.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId, ownerId: userId, machineId: 'phase4-device', profileId: 'default',
      }) as { device: { id: string } };
      const reported = await agentSocket.emitWithAck(AGENT_EVENTS.device.runtimes, {
        teamId, deviceId: hello.device.id, runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      }) as { runtimes: Array<{ id: string }> };
      const created = await web.createAgent({
        userId, teamId, deviceId: hello.device.id, runtimeId: reported.runtimes[0]!.id,
        name: 'Phase 4 Device Agent', env: {},
      }) as { agent: { id: string } };
      await agentSocket.emitWithAck(AGENT_EVENTS.agent.reportCustomSkills, {
        teamId, deviceId: hello.device.id,
        items: [{ agentId: created.agent.id, skills: [{
          name: skillName, description: 'phase 4 smoke capability', scope: 'user',
          sourcePath: `/smoke/${skillName}/SKILL.md`, adapterKind: 'codex-cli',
        }] }],
      });
      const dispatchClient = createDaemonProtocolClient({
        socket: agentSocket,
        executor: async (request) => {
          executions.push({ agentId: created.agent.id, dispatchId: request.id, prompt: request.prompt });
          return `device:${request.prompt}`;
        },
        device: { teamId, ownerId: userId, machineId: 'phase4-device', profileId: 'default' },
        runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
        agents: [],
        envResolver: async () => ({}),
      });
      const claimClient = createTaskClaimProtocolClient({
        socket: agentSocket, getDeviceId: () => hello.device.id,
      });
      const service = createDeviceServiceCore({
        dispatchClient, taskClaimClient: claimClient,
        managementWorkerHost: { async start() {}, async stop() {} },
      });
      await service.start();
      cleanups.push(async () => { await withTimeout(service.stop(), 2_000, 'DEVICE_STOP').catch(() => undefined); });
      return { deviceId: hello.device.id, agentId: created.agent.id, skillName };
    },
    async connectServerWorker(workerInstanceId) {
      const socket = await connectClient(`${baseUrl}/server-worker`, { auth: { serverWorkerToken: SERVER_WORKER_TOKEN } });
      cleanups.push(async () => socket.disconnect());
      return createFakeServerWorker(socket);
    },
    async optIntoManagedPlacement(socket, teamId, userId) {
      const ack = await socket.emitWithAck(WEB_EVENTS.managementPolicy.update, {
        userId, teamId, mode: 'managed', maxManagementPhase: 2,
        placementPolicy: {
          placement: 'managed', allowServerContext: true, requireLocalModelCredentials: false,
        },
      }) as { ok: boolean };
      if (!ack.ok) throw new Error(`managementPolicy.update failed: ${JSON.stringify(ack)}`);
    },
    async sendRootedMessage(socket, { userId, teamId, channelId, key }) {
      // body 以 @未知名开头,使 routeMessage 落到 unknown-mention(no-dispatch):
      // managed placement 守卫要求"无显式 target",否则回退 direct dispatch。
      // device placement 无此守卫(phase-2 smoke 因此不受影响),server placement 需要显式 no-target。
      return socket.emitWithAck(WEB_EVENTS.message.send, {
        userId, teamId, channelId, body: `@server-worker Phase 4 rooted task ${key}`, asTask: true, clientMessageId: `phase-4-${key}`,
      }) as Promise<{ ok?: boolean; code?: string; message?: string; management?: { kind: string; managementRunId?: string; schedulingDiagnostic?: string; diagnostics?: readonly string[] } }>;
    },
    async waitForOffer(worker, managementRunId) {
      return waitForOffer(worker, managementRunId);
    },
    openTeamDatabase() {
      return openTeamDatabase(dataDir);
    },
  };
}

function createFakeServerWorker(socket: ClientSocket): FakeServerWorker {
  const offers: ManagementLeaseOfferV1[] = [];
  socket.on(AGENT_EVENTS.serverWorker.leaseOffer, (offer, ack) => {
    offers.push(offer as ManagementLeaseOfferV1);
    // server 用 emitWithAck 发 lease-offer 并等待 worker ack;不回 ack 会卡到 offer 超时
    if (typeof ack === 'function') (ack as (response: unknown) => void)({ ok: true });
  });
  return {
    offers,
    disconnect: () => socket.disconnect(),
    register: (workerInstanceId) => socket.emitWithAck(AGENT_EVENTS.serverWorker.register, {
      schemaVersion: 2, workerInstanceId, profileId: 'profile-1', runtimeVersion: '0.1.0',
      supportedProtocolVersions: [1, 2], supportedPhases: [1, 2, 3],
      credentialStatus: 'production_ready', providerId: 'provider-1', modelId: 'model-1',
      host: { kind: 'server', workerPoolId: WORKER_POOL_ID },
      providerCredentialRef: PROVIDER_CREDENTIAL_REF,
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    }) as Promise<{ ok: boolean; workerId?: string }>,
    acquireLease: (payload) => socket.emitWithAck(AGENT_EVENTS.serverWorker.leaseAcquire, payload) as Promise<Record<string, unknown>>,
    releaseLease: (payload) => socket.emitWithAck(AGENT_EVENTS.serverWorker.leaseRelease, payload) as Promise<Record<string, unknown>>,
    fetchCheckpoint: (payload) => socket.emitWithAck(AGENT_EVENTS.serverWorker.checkpointFetch, payload) as Promise<{ context: { rootTaskId?: string } }>,
    callTool: (payload) => socket.emitWithAck(AGENT_EVENTS.serverWorker.toolRequest, payload) as Promise<{ ok: boolean; output?: Record<string, unknown>; diagnosticCode?: string }>,
  };
}

async function driveSingleSubtaskToRootDelivery(
  worker: FakeServerWorker,
  scope: { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number; rootTaskId: string; requiredCapability: string },
): Promise<{ deliveryMessageId?: string; status?: string }> {
  const base = { schemaVersion: 2 as const, managementPhase: 2 as const, managementRunId: scope.managementRunId, workerId: scope.workerId };
  const authority = { leaseToken: scope.leaseToken, fencingToken: scope.fencingToken };
  const created = await worker.callTool({ ...base, commandId: 'cmd-create', toolCallId: 'tool-create', toolName: 'tasks.create_subtasks', ...authority, idempotencyKey: 'create-subtask', input: {
    parentTaskId: scope.rootTaskId,
    subtasks: [{
      clientKey: 'only', title: 'Phase 4 single subtask', description: 'smoke',
      claimPolicy: 'open', requiredCapabilities: [scope.requiredCapability], acceptanceCriteria: [], maxAttempts: 2,
    }],
  } });
  const subtaskId = (created.output!.taskIds as string[])[0]!;
  await worker.callTool({ ...base, commandId: 'cmd-publish', toolCallId: 'tool-publish', toolName: 'tasks.publish_for_claim', ...authority, idempotencyKey: 'publish-subtask', input: {
    taskId: subtaskId, expectedTaskRevision: 1,
  } });
  const claim = await waitForClaim(worker, base, authority, subtaskId);
  const invoked = await worker.callTool({ ...base, commandId: 'cmd-invoke', toolCallId: 'tool-invoke', toolName: 'agents.invoke', ...authority, idempotencyKey: 'invoke-subtask', input: {
    taskId: subtaskId, expectedTaskRevision: claim.taskRevision, taskAttempt: claim.taskAttempt,
    claimLeaseId: claim.claimLeaseId, objective: 'complete the phase 4 subtask', attachmentIds: [],
  } });
  const invocationId = invoked.output!.invocationId as string;
  const deliveryId = invoked.output!.deliveryId as string;
  await worker.callTool({ ...base, commandId: 'cmd-accept', toolCallId: 'tool-accept', toolName: 'tasks.accept_subtask', ...authority, idempotencyKey: 'accept-subtask', input: {
    acceptance: {
      schemaVersion: 1, taskId: subtaskId, deliveryId, expectedTaskRevision: claim.taskRevision,
      taskAttempt: claim.taskAttempt, claimLeaseId: claim.claimLeaseId, decision: 'accepted' as const,
      criteriaResults: [], reason: 'phase 4 smoke', decidedBy: 'manager', decidedAt: Date.now(),
    },
  } });
  // review.submit_root_delivery 是 Phase 1 写工具(schemaVersion 1),与前面的 Phase 2 tasks.* 工具不同 parser
  const delivery = await worker.callTool({
    schemaVersion: 1, commandId: 'cmd-deliver', managementRunId: scope.managementRunId, workerId: scope.workerId,
    toolCallId: 'tool-deliver', toolName: 'review.submit_root_delivery',
    ...authority, idempotencyKey: 'root-delivery',
    input: { body: 'Server Worker 已完成有根任务交付', contributingInvocationIds: [invocationId] },
  });
  return delivery.output as { deliveryMessageId?: string; status?: string };
}

async function waitForClaim(
  worker: FakeServerWorker,
  base: { managementRunId: string; workerId: string },
  authority: { leaseToken: string; fencingToken: number },
  taskId: string,
): Promise<{ taskRevision: number; taskAttempt: number; claimLeaseId: string }> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const waited = await worker.callTool({
      schemaVersion: 2, managementPhase: 2, managementRunId: base.managementRunId, workerId: base.workerId,
      commandId: `cmd-wait-${attempt}`, toolCallId: `tool-wait-${attempt}`, toolName: 'tasks.wait',
      ...authority, idempotencyKey: `wait-${attempt}`, input: { taskIds: [taskId] },
    });
    const snapshot = (waited.output!.taskSnapshots as Array<{ taskId: string; taskRevision: number; taskAttempt: number; claimLeaseId?: string }>)[0];
    if (snapshot?.claimLeaseId) {
      return { taskRevision: snapshot.taskRevision, taskAttempt: snapshot.taskAttempt, claimLeaseId: snapshot.claimLeaseId! };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('TASK_CLAIM_TIMEOUT');
}

async function waitForOffer(worker: FakeServerWorker, managementRunId?: string): Promise<ManagementLeaseOfferV1> {
  return eventually(async () => {
    const match = managementRunId
      ? worker.offers.find((offer) => offer.managementRunId === managementRunId)
      : worker.offers[worker.offers.length - 1];
    if (!match) throw new Error('lease-offer not received yet');
    return match;
  }, 300);
}

function openTeamDatabase(dataDir: string): import('better-sqlite3').Database {
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => import('better-sqlite3').Database;
  const db = new Database(join(dataDir, 'team.sqlite'));
  db.pragma('busy_timeout = 2000');
  return db;
}

async function connectClient(url: string, options: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = createClient(url, { transports: ['websocket'], forceNew: true, reconnection: false, ...options });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(error));
    socket.connect();
  });
  return socket;
}

async function eventually<T>(assertion: () => Promise<T>, attempts = 100): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await assertion();
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
