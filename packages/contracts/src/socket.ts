import type {
  ManagementLeaseAcquireAckV1,
  ManagementLeaseAcquireV1,
  ManagementLeaseOfferV1,
  ManagementLeaseReleaseAckV1,
  ManagementLeaseReleaseV1,
  ManagementLeaseRenewAckV1,
  ManagementLeaseRenewV1,
  ManagementWorkerAbortV1,
  ManagementWorkerRegisterAckV1,
  ManagementWorkerRegisterV1,
  ManagementWorkerToolRequestV1,
  ManagementWorkerToolResultV1,
} from './management-worker.js';
import type { AcceptanceCriterionDto } from './task-coordination.js';

export const WEB_EVENTS = {
  auth: {
    login: 'auth:login',
    register: 'auth:register',
    whoami: 'auth:whoami',
    changePassword: 'auth:change-password',
  },
  team: {
    list: 'team:list',
    create: 'team:create',
    switch: 'team:switch',
    snapshot: 'teams:snapshot',
    update: 'team:update',
    delete: 'team:delete',
  },
  managementPolicy: {
    get: 'management-policy:get',
    update: 'management-policy:update',
  },
  /** Team 作用域 PI 自动协调开关（#707）；任意成员读，Owner/Admin 写。 */
  piPolicy: {
    get: 'pi-policy:get',
    update: 'pi-policy:update',
  },
  /** 系统作用域 PI Provider Supply；仅系统管理员可访问。 */
  piProvider: {
    listPresets: 'pi-provider:list-presets',
    listCards: 'pi-provider:list-cards',
    getCard: 'pi-provider:get-card',
    createCard: 'pi-provider:create-card',
    updateCard: 'pi-provider:update-card',
    copyCard: 'pi-provider:copy-card',
    discoverModels: 'pi-provider:discover-models',
    runTest: 'pi-provider:run-test',
    cancelTest: 'pi-provider:cancel-test',
    publishCard: 'pi-provider:publish-card',
    setActiveModel: 'pi-provider:set-active-model',
    getActiveModel: 'pi-provider:get-active-model',
    getPublicHealth: 'pi-provider:get-public-health',
  },
  join: {
    create: 'join:create',
    validate: 'join:validate',
    list: 'join:list',
    revoke: 'join:revoke',
  },
  member: {
    list: 'members:list',
    updateHuman: 'member:update-human',
    updateRole: 'member:update-role',
    remove: 'member:remove',
    transferOwner: 'member:transfer-owner',
  },
  device: {
    list: 'device:list',
    get: 'device:get',
    scan: 'device:scan',
    snapshot: 'devices:snapshot',
    status: 'device:status',
    runtimes: 'device:runtimes',
    agentsList: 'device:agents:list',
    rename: 'device:rename',
    delete: 'device:delete',
    selectDirectory: 'device:select-directory',
    listDirectory: 'device:list-directory',
  },
  deviceInvite: {
    create: 'device-invite:create',
    complete: 'device-invite:complete',
  },
  agent: {
    subscribe: 'agents:subscribe',
    create: 'agent:create',
    // 切换 Agent 在 primary team 上的可见性（隐藏 = 移出当前团队成员页）
    setVisibility: 'agent:set-visibility',
    snapshot: 'agents:snapshot',
    status: 'agent:status',
    discovered: 'agents:discovered',
    updateConfig: 'agent:update-config',
    delete: 'agent:delete',
    metrics: 'agent:metrics',
  },
  admin: {
    listTeams: 'admin:list-teams',
    listUsers: 'admin:list-users',
    listDevices: 'admin:list-devices',
    listAgents: 'admin:list-agents',
    deleteTeam: 'admin:delete-team',
    deleteUser: 'admin:delete-user',
    deleteAgent: 'admin:delete-agent',
    transferDeviceOwner: 'admin:transfer-device-owner',
  },
  channel: {
    subscribe: 'channels:subscribe',
    create: 'channel:create',
    join: 'channel:join',
    leave: 'channel:leave',
    history: 'channel:history',
    snapshot: 'channels:snapshot',
    message: 'channel:message',
    update: 'channel:update',
    addMember: 'channel:add-member',
    removeMember: 'channel:remove-member',
    addAgent: 'channel:add-agent',
    removeAgent: 'channel:remove-agent',
    members: 'channel:members',
    archive: 'channel:archive',
    delete: 'channel:delete',
  },
  dm: {
    start: 'dm:start',
    list: 'dm:list',
    snapshot: 'dms:snapshot',
  },
  message: {
    send: 'message:send',
    dispatchStatus: 'message:dispatch-status',
    search: 'message:search',
    context: 'message:context',
    react: 'message:react',
    save: 'message:save',
    listSaved: 'message:list-saved',
    pin: 'message:pin',
    listPinned: 'message:list-pinned',
    edit: 'message:edit',
    delete: 'message:delete',
    pinnedUpdated: 'message:pinned-updated',
    convertToTask: 'message:convert-to-task',
  },
  dispatch: {
    cancel: 'dispatch:cancel',
    cancelChannel: 'dispatch:cancel-channel',
  },
  task: {
    list: 'task:list',
    dag: 'task:dag',
    create: 'task:create',
    update: 'task:update',
    delete: 'task:delete',
    reorder: 'task:reorder',
    snapshot: 'tasks:snapshot',
    updated: 'task:updated',
  },
  memory: {
    snapshot: 'memory:snapshot',
    changed: 'memory:changed',
    create: 'memory:create',
    update: 'memory:update',
    expire: 'memory:expire',
    supersede: 'memory:supersede',
    delete: 'memory:delete',
    grantIssue: 'memory:grant-issue',
    grantRevoke: 'memory:grant-revoke',
    candidateAccept: 'memory:candidate-accept',
    candidateReject: 'memory:candidate-reject',
    candidateMerge: 'memory:candidate-merge',
    localSummary: 'memory:local-summary',
  },
} as const;

export const AGENT_EVENTS = {
  deviceInvite: {
    wait: 'device-invite:wait',
    credentials: 'device-invite:credentials',
  },
  device: {
    hello: 'device:hello',
    runtimes: 'device:runtimes',
    scanRequested: 'device:scan-requested',
    selectDirectoryRequested: 'device:select-directory-requested',
    listDirectoryRequested: 'device:list-directory-requested',
    // 服务端→daemon 单向通知：该设备已被删除，daemon 应回收重连并退出进程。
    removed: 'device:removed',
  },
  agent: {
    registerBatch: 'agent:register-batch',
    reportCustomSkills: 'agent:report-custom-skills',
  },
  dispatch: {
    request: 'dispatch:request',
    cancel: 'dispatch:cancel',
    accepted: 'dispatch:accepted',
    result: 'dispatch:result',
    error: 'dispatch:error',
  },
  managementWorker: {
    register: 'management-worker:register',
    leaseOffer: 'management-worker:lease-offer',
    leaseAcquire: 'management-worker:lease-acquire',
    leaseRenew: 'management-worker:lease-renew',
    leaseRelease: 'management-worker:lease-release',
    abort: 'management-worker:abort',
    toolRequest: 'management-worker:tool-request',
    checkpointFetch: 'management-worker:checkpoint-fetch',
    outboxReplay: 'management-worker:outbox-replay',
    shadowEvaluate: 'management-worker:shadow-evaluate',
    shadowResult: 'management-worker:shadow-result',
  },
  serverWorker: {
    register: 'server-worker:register',
    heartbeat: 'server-worker:heartbeat',
    leaseOffer: 'server-worker:lease-offer',
    leaseAcquire: 'server-worker:lease-acquire',
    leaseRenew: 'server-worker:lease-renew',
    leaseRelease: 'server-worker:lease-release',
    abort: 'server-worker:abort',
    checkpointFetch: 'server-worker:checkpoint-fetch',
    toolRequest: 'server-worker:tool-request',
  },
  taskClaim: {
    offer: 'task-claim:offer',
    acquire: 'task-claim:acquire',
    renew: 'task-claim:renew',
    release: 'task-claim:release',
    expired: 'task-claim:expired',
  },
  memory: {
    governanceSummaryRequested: 'memory:governance-summary-requested',
  },
} as const;

export interface ScanRequestCustomAgent {
  id: string;
  adapterKind: string;
  cwd?: string;
}

export interface ScanRequest {
  requestId: string;
  deviceId: string;
  customAgents?: ScanRequestCustomAgent[];
}

export interface TaskClaimOfferV1 {
  readonly schemaVersion: 1;
  readonly offerId: string;
  readonly deviceId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly agentId: string;
  readonly requiredCapabilities: readonly string[];
  readonly offerExpiresAt: number;
}

export interface TaskClaimAcquireV1 {
  readonly schemaVersion: 1;
  readonly offerId: string;
  readonly agentId: string;
}

export interface TaskClaimExecutionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly managementRunId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly dependencyTaskIds: readonly string[];
  readonly channelId?: string;
}

export interface TaskClaimAuthorityV1 {
  readonly schemaVersion: 1;
  readonly claimLeaseId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly agentId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
}

export type TaskClaimAcquireAckV1 = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly lease: TaskClaimAuthorityV1 & {
    readonly acquiredAt: number;
    readonly expiresAt: number;
  };
  readonly execution: TaskClaimExecutionSnapshotV1;
} | TaskClaimFailureAckV1;

export type TaskClaimRenewV1 = TaskClaimAuthorityV1;
export type TaskClaimReleaseV1 = TaskClaimAuthorityV1 & { readonly reasonCode: string };

export type TaskClaimRenewAckV1 = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly expiresAt: number;
} | TaskClaimFailureAckV1;

export type TaskClaimReleaseAckV1 = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly releasedAt: number;
} | TaskClaimFailureAckV1;

export interface TaskClaimFailureAckV1 {
  readonly schemaVersion: 1;
  readonly ok: false;
  readonly errorCode: 'INVALID_REQUEST' | 'UNAVAILABLE' | 'CONFLICT' | 'STALE_AUTHORITY';
  readonly diagnosticCode: string;
  readonly retryable: boolean;
}

export interface TaskClaimExpiredV1 {
  readonly schemaVersion: 1;
  readonly claimLeaseId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly expiredAt: number;
}

export interface TaskClaimPayloadMapV1 {
  readonly offer: TaskClaimOfferV1;
  readonly acquire: TaskClaimAcquireV1;
  readonly renew: TaskClaimRenewV1;
  readonly release: TaskClaimReleaseV1;
  readonly 'acquire-ack': TaskClaimAcquireAckV1;
  readonly 'renew-ack': TaskClaimRenewAckV1;
  readonly 'release-ack': TaskClaimReleaseAckV1;
  readonly expired: TaskClaimExpiredV1;
}

export type TaskClaimPayloadKind = keyof TaskClaimPayloadMapV1;

export function parseTaskClaimPayload<K extends TaskClaimPayloadKind>(
  kind: K,
  input: unknown,
): TaskClaimPayloadMapV1[K] {
  const value = taskClaimRecord(input);
  switch (kind) {
    case 'offer':
      taskClaimExact(value, ['schemaVersion', 'offerId', 'deviceId', 'taskId', 'taskRevision', 'taskAttempt', 'agentId', 'requiredCapabilities', 'offerExpiresAt']);
      taskClaimSchema(value); taskClaimStrings(value, ['offerId', 'deviceId', 'taskId', 'agentId']);
      taskClaimPositive(value.taskRevision); taskClaimPositive(value.taskAttempt);
      taskClaimStringArray(value.requiredCapabilities); taskClaimNonNegative(value.offerExpiresAt);
      break;
    case 'acquire':
      taskClaimExact(value, ['schemaVersion', 'offerId', 'agentId']);
      taskClaimSchema(value); taskClaimStrings(value, ['offerId', 'agentId']);
      break;
    case 'renew':
      taskClaimAuthority(value, []);
      break;
    case 'release':
      taskClaimAuthority(value, ['reasonCode']); taskClaimString(value.reasonCode);
      break;
    case 'expired':
      taskClaimExact(value, ['schemaVersion', 'claimLeaseId', 'taskId', 'agentId', 'expiredAt']);
      taskClaimSchema(value); taskClaimStrings(value, ['claimLeaseId', 'taskId', 'agentId']);
      taskClaimNonNegative(value.expiredAt);
      break;
    case 'acquire-ack':
      taskClaimAck(value, 'acquire');
      break;
    case 'renew-ack':
      taskClaimAck(value, 'renew');
      break;
    case 'release-ack':
      taskClaimAck(value, 'release');
      break;
  }
  return value as unknown as TaskClaimPayloadMapV1[K];
}

export function safeParseTaskClaimPayload<K extends TaskClaimPayloadKind>(
  kind: K,
  input: unknown,
): { readonly ok: true; readonly value: TaskClaimPayloadMapV1[K] } | { readonly ok: false } {
  try {
    return { ok: true, value: parseTaskClaimPayload(kind, input) };
  } catch {
    return { ok: false };
  }
}

function taskClaimAuthority(value: Record<string, unknown>, extra: readonly string[]): void {
  taskClaimExact(value, ['schemaVersion', 'claimLeaseId', 'taskId', 'taskRevision', 'taskAttempt', 'agentId', 'leaseToken', 'fencingToken', ...extra]);
  taskClaimSchema(value);
  taskClaimStrings(value, ['claimLeaseId', 'taskId', 'agentId', 'leaseToken']);
  taskClaimPositive(value.taskRevision); taskClaimPositive(value.taskAttempt); taskClaimPositive(value.fencingToken);
}

function taskClaimAck(value: Record<string, unknown>, kind: 'acquire' | 'renew' | 'release'): void {
  taskClaimSchema(value);
  if (value.ok === false) {
    taskClaimExact(value, ['schemaVersion', 'ok', 'errorCode', 'diagnosticCode', 'retryable']);
    if (!['INVALID_REQUEST', 'UNAVAILABLE', 'CONFLICT', 'STALE_AUTHORITY'].includes(String(value.errorCode))) taskClaimInvalid();
    taskClaimString(value.diagnosticCode);
    if (typeof value.retryable !== 'boolean') taskClaimInvalid();
    return;
  }
  if (value.ok !== true) taskClaimInvalid();
  if (kind === 'renew') {
    taskClaimExact(value, ['schemaVersion', 'ok', 'expiresAt']); taskClaimNonNegative(value.expiresAt); return;
  }
  if (kind === 'release') {
    taskClaimExact(value, ['schemaVersion', 'ok', 'releasedAt']); taskClaimNonNegative(value.releasedAt); return;
  }
  taskClaimExact(value, ['schemaVersion', 'ok', 'lease', 'execution']);
  const lease = taskClaimRecord(value.lease);
  taskClaimAuthority(lease, ['acquiredAt', 'expiresAt']);
  taskClaimNonNegative(lease.acquiredAt); taskClaimNonNegative(lease.expiresAt);
  const execution = taskClaimRecord(value.execution);
  taskClaimExact(execution, ['schemaVersion', 'managementRunId', 'taskId', 'taskRevision', 'taskAttempt', 'title', 'objective', 'acceptanceCriteria', 'dependencyTaskIds'], ['channelId']);
  taskClaimSchema(execution); taskClaimStrings(execution, ['managementRunId', 'taskId', 'title', 'objective']);
  taskClaimPositive(execution.taskRevision); taskClaimPositive(execution.taskAttempt);
  taskClaimStringArray(execution.dependencyTaskIds);
  if (execution.channelId !== undefined) taskClaimString(execution.channelId);
  if (!Array.isArray(execution.acceptanceCriteria)) taskClaimInvalid();
  for (const criterion of execution.acceptanceCriteria) {
    const item = taskClaimRecord(criterion);
    taskClaimExact(item, ['id', 'description', 'evidenceRequired'], ['allowedEvidenceKinds']);
    taskClaimStrings(item, ['id', 'description']);
    if (typeof item.evidenceRequired !== 'boolean') taskClaimInvalid();
    if (item.allowedEvidenceKinds !== undefined) taskClaimStringArray(item.allowedEvidenceKinds);
  }
}

function taskClaimRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) taskClaimInvalid();
  return value as Record<string, unknown>;
}
function taskClaimExact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) taskClaimInvalid();
}
function taskClaimSchema(value: Record<string, unknown>): void { if (value.schemaVersion !== 1) taskClaimInvalid(); }
function taskClaimString(value: unknown): void { if (typeof value !== 'string' || value.length === 0) taskClaimInvalid(); }
function taskClaimStrings(value: Record<string, unknown>, keys: readonly string[]): void { keys.forEach((key) => taskClaimString(value[key])); }
function taskClaimPositive(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) <= 0) taskClaimInvalid(); }
function taskClaimNonNegative(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) taskClaimInvalid(); }
function taskClaimStringArray(value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) taskClaimInvalid();
}
function taskClaimInvalid(): never { throw new Error('TASK_CLAIM_PAYLOAD_INVALID'); }

/**
 * `/agent` management worker 的方向与 Socket.IO callback ACK 契约。
 * Device hello/Dispatch claim 仍使用各自事件，不能据此推导 management worker 可调度。
 */
export interface ManagementWorkerClientToServerPayloadMapV1 {
  readonly register: ManagementWorkerRegisterV1;
  readonly leaseAcquire: ManagementLeaseAcquireV1;
  readonly leaseRenew: ManagementLeaseRenewV1;
  readonly leaseRelease: ManagementLeaseReleaseV1;
  readonly abort: ManagementWorkerAbortV1;
  readonly toolRequest: ManagementWorkerToolRequestV1;
}

export interface ManagementWorkerServerToClientPayloadMapV1 {
  readonly leaseOffer: ManagementLeaseOfferV1;
}

export interface ManagementWorkerSocketAckMapV1 {
  readonly register: ManagementWorkerRegisterAckV1;
  readonly leaseAcquire: ManagementLeaseAcquireAckV1;
  readonly leaseRenew: ManagementLeaseRenewAckV1;
  readonly leaseRelease: ManagementLeaseReleaseAckV1;
  readonly abort: ManagementLeaseReleaseAckV1;
  readonly toolRequest: ManagementWorkerToolResultV1;
}
