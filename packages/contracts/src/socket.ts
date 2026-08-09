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
import type { TaskOfferResponseKind } from './agent-exposure.js';
import type { AgentDescriptorDto } from './agent.js';

export const WEB_EVENTS = {
  auth: {
    login: 'auth:login',
    register: 'auth:register',
    whoami: 'auth:whoami',
    changePassword: 'auth:change-password',
    /** 用户自删账号：无任何仍拥有的 team 时允许；系统管理员不可自删。 */
    deleteAccount: 'auth:delete-account',
  },
  team: {
    list: 'team:list',
    create: 'team:create',
    switch: 'team:switch',
    snapshot: 'teams:snapshot',
    update: 'team:update',
    delete: 'team:delete',
  },
  /** Team 作用域 PI 自动协调开关（#707）；任意成员读，Owner/Admin 写。 */
  /** @deprecated managementPolicy 事件已移除（#724）；请使用 piPolicy。 */
  piPolicy: {
    get: 'pi-policy:get',
    update: 'pi-policy:update',
  },
  /** #923 Promotion proposal 与 Team rollout/policy 控制；完整 projection 属后续切片。 */
  promotion: {
    semanticEvaluate: 'promotion:semantic-evaluate',
    proposalAction: 'promotion:proposal-action',
    semanticRolloutUpdate: 'promotion:semantic-rollout-update',
    teamPolicyUpdate: 'promotion:team-policy-update',
    teamPolicyApply: 'promotion:team-policy-apply',
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
    /** #699 US 84：系统管理员紧急停止/恢复 PI 自动协调。 */
    setEmergencyStop: 'pi-provider:set-emergency-stop',
    getEmergencyStop: 'pi-provider:get-emergency-stop',
  },
  /** #699 US 29：PI Token Usage 查询（per-team）。 */
  piUsage: {
    getTeamUsage: 'pi-usage:get-team-usage',
  },
  /** 系统作用域 System Knowledge；仅系统管理员可访问（#717）。 */
  systemKnowledge: {
    list: 'system-knowledge:list',
    detail: 'system-knowledge:detail',
    create: 'system-knowledge:create',
    revise: 'system-knowledge:revise',
    deactivate: 'system-knowledge:deactivate',
    delete: 'system-knowledge:delete',
  },
  /** 个人作用域 User Memory；仅用户本人可访问（#717）。 */
  userMemory: {
    list: 'user-memory:list',
    detail: 'user-memory:detail',
    create: 'user-memory:create',
    revise: 'user-memory:revise',
    deactivate: 'user-memory:deactivate',
    delete: 'user-memory:delete',
  },
  /**
   * #965 AC#4：读取某次 PI 协调实际使用的 Active Memory 来源归因。
   * 只返回 id/来源码/理由码（无正文）；服务端读取时复验频道读权限，未授权 fail-closed 返回 null。
   */
  memoryAttribution: {
    get: 'memory-attribution:get',
  },
  /** #722 Reusable Experience Pack；#723 三态 attachment 生命周期。 */
  experiencePack: {
    createDraft: 'experience-pack:create-draft',
    approve: 'experience-pack:approve',
    withdraw: 'experience-pack:withdraw',
    markSourceInvalid: 'experience-pack:mark-source-invalid',
    listByTeam: 'experience-pack:list-by-team',
    getById: 'experience-pack:get-by-id',
    recommendToChannel: 'experience-pack:recommend-to-channel',
    confirmAttachment: 'experience-pack:confirm-attachment',
    revokeAttachment: 'experience-pack:revoke-attachment',
  },
  /** #710 Team Agent Exposure 管理；Agent owner 发布/撤回，Team Owner/Admin 收紧。 */
  agentExposure: {
    createDraft: 'agent-exposure:create-draft',
    updateDraft: 'agent-exposure:update-draft',
    publish: 'agent-exposure:publish',
    revoke: 'agent-exposure:revoke',
    listRevisions: 'agent-exposure:list-revisions',
    getActive: 'agent-exposure:get-active',
    upsertRestriction: 'agent-exposure:upsert-restriction',
    getTeamCoverage: 'agent-exposure:get-team-coverage',
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
    /**
     * #1084 切片3：web→server 请求读本机 .agentbean snapshots 副本（频道文件预览/下载优先本机）。
     * server 转发为 device:read-file-requested 到 daemon，daemon 读 snapshots/<revisionId>/<path> 字节。
     */
    readFile: 'device:read-file',
    // web→server：请求 daemon 扫描指定目录的 AGENTS.md/CLAUDE.md descriptor（表单 cwd 选定后）。
    scanDescriptor: 'device:scan-descriptor',
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
    createUser: 'admin:create-user',
    updateUser: 'admin:update-user',
    resetUserPassword: 'admin:reset-user-password',
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
  channelFiles: {
    list: 'channel-files:list',
    search: 'channel-files:search',
  },
  channelDocuments: {
    list: 'channel-documents:list',
    get: 'channel-documents:get',
    revisions: 'channel-documents:revisions',
    derive: 'channel-documents:derive',
    save: 'channel-documents:save',
    restore: 'channel-documents:restore',
    publish: 'channel-documents:publish',
  },
  project: {
    overview: 'project:overview',
    createInitialStage: 'project:create-initial-stage',
    createStage: 'project:create-stage',
    createStageEdge: 'project:create-stage-edge',
    deleteStageEdge: 'project:delete-stage-edge',
    updated: 'project:updated',
    artifactCollections: 'project:artifact-collections',
    promoteArtifact: 'project:promote-artifact',
    submitArtifactReview: 'project:submit-artifact-review',
    setArtifactFinalVersion: 'project:set-artifact-final-version',
    artifactsUpdated: 'project:artifacts-updated',
    documentBundles: 'project:document-bundles',
    documentBundle: 'project:document-bundle',
    createDocumentBundle: 'project:create-document-bundle',
    documentBundlesUpdated: 'project:document-bundles-updated',
    resolveReferences: 'project:resolve-references',
    resolveReferenceOrdinal: 'project:resolve-reference-ordinal',
    referencesUpdated: 'project:references-updated',
    workspace: 'project:workspace',
    createWorkspace: 'project:create-workspace',
    importWorkspace: 'project:import-workspace',
    publishWorkspace: 'project:publish-workspace',
    materializeWorkspace: 'project:materialize-workspace',
    /** #969 导出归档封存清单（仅频道治理者）。 */
    exportWorkspace: 'project:export-workspace',
    /** #969 列出 workspace 全部 revision（默认最新在前）。 */
    workspaceRevisions: 'project:workspace-revisions',
    /** #967 以稳定 publish identity 开启/续用暂存会话。 */
    beginWorkspacePublishStaging: 'project:begin-workspace-publish-staging',
    /** #967 查询暂存进度或已提交的最终结果（幂等）。 */
    getWorkspacePublishStaging: 'project:get-workspace-publish-staging',
    /** #967 原子提交暂存 → 新 revision（重复调用不重复创建 revision）。 */
    commitWorkspacePublishStaging: 'project:commit-workspace-publish-staging',
    /** #1060 列出频道 OutputPackage(含 pendingDeliveries「交付处理中」投影)。 */
    listOutputPackages: 'project:list-output-packages',
    /** #1060 获取单个 OutputPackage(含冻结成员)。 */
    getOutputPackage: 'project:get-output-package',
    /** #1061 对 package 成员版本提交审核(approved/changes_requested/rejected)。 */
    submitPackageArtifactReview: 'project:submit-package-artifact-review',
    /** #1061 "通过并设为最终版":一个事务写 review 与 finalization 两个独立事实。 */
    submitPackageReviewAndFinalize: 'project:submit-package-review-and-finalize',
    /** #1061 审核(changes_requested/rejected)与退回 Task delivery 原子提交。 */
    submitPackageReviewAndRejectDelivery: 'project:submit-package-review-and-reject-delivery',
    /** #1061 package 审核/最终版事实变化后的推送(三投影刷新)。 */
    packageReviewUpdated: 'project:package-review-updated',
    /** #1062 基于明确版本保存 Markdown 修订(原子产生新版本并移动 current)。 */
    saveArtifactVersionRevision: 'project:save-artifact-version-revision',
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
    // #921 Message tracer command 路径（ADR-0067 registry；envelope.commandName 路由 send/check-inbox/ack）。
    messageTracer: { command: 'message-tracer:command', delivered: 'message:delivered' },
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
    cancel: 'task:cancel',
    close: 'task:close',
    /** #995 根交付人审：具名 lifecycle command，禁止用 task:update 旁路进 done。 */
    acceptRootDelivery: 'task:accept-root-delivery',
    rejectRootDelivery: 'task:reject-root-delivery',
    /** #1065 AC3/AC4：Task 交付聚合视图(目标/acceptance/焦点/availableActions/时间线)。 */
    deliveryOverview: 'task:delivery-overview',
    /** 频道 Tasks 标签单次读取 Server 权威卡片投影，避免逐卡 N+1。 */
    channelWorkspace: 'task:channel-workspace',
    snapshot: 'tasks:snapshot',
    updated: 'task:updated',
  },
  /**
   * #929 System activity / attention / change feed。
   * notice 只是可丢失唤醒；权威事实走 query/pull-change-feed。
   * review/remediation 仍走各自具名 lifecycle/remediation command。
   */
  systemActivity: {
    command: 'system-activity:command',
    query: 'system-activity:query',
    notice: 'system-activity:notice',
  },
  /**
   * #931 Team PI authority cutover / legacy 兼容退役。
   * 仅 Team Owner/Admin 可执行写 command；Server 推导 authority，禁止客户端自报。
   */
  /** #1014 Task failure remediation 具名 command（envelope.commandName 路由）。 */
  taskRemediation: {
    command: 'task-remediation:command',
  },
  piAuthorityCutover: {
    command: 'pi-authority-cutover:command',
    query: 'pi-authority-cutover:query',
  },
  /** #931 PI authority cutover 具名 command/query。 */

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
    // Formal Memory Center (issue #716)。事件名保持 memory:* 前缀，
    // 避开 readiness 的 management|invocation|checkpoint 正则豁免陷阱。
    formalList: 'memory:formal-list',
    formalDetail: 'memory:formal-detail',
    formalCreate: 'memory:formal-create',
    formalRevise: 'memory:formal-revise',
    formalDeactivate: 'memory:formal-deactivate',
    formalDelete: 'memory:formal-delete',
    proposeCorrection: 'memory:propose-correction',
    formalAccept: 'memory:formal-accept',
    formalReject: 'memory:formal-reject',
    // Agent Memory Projection (issue #718)。事件名保持 memory:* 前缀。
    // Agent owner 发布/撤回投影；Team Owner/Admin opt-in；PI/成员只读消费。
    projectionCreateDraft: 'memory:projection-create-draft',
    projectionUpdateDraft: 'memory:projection-update-draft',
    projectionPublish: 'memory:projection-publish',
    projectionWithdraw: 'memory:projection-withdraw',
    projectionListRevisions: 'memory:projection-list-revisions',
    projectionUpsertOptIn: 'memory:projection-upsert-opt-in',
    projectionGetConsumable: 'memory:projection-get-consumable',
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
    /**
     * #1084 切片3：server→daemon 请求读 snapshots/<revisionId>/<path> 字节（web 频道文件预览/下载本机优先）。
     * daemon 在 file-reader 内 readpath 白名单限定 snapshots 子树，越界 → OUTSIDE_SNAPSHOTS。
     */
    readFileRequested: 'device:read-file-requested',
    // 服务端→daemon：扫描指定目录的 AGENTS.md/CLAUDE.md descriptor（web 表单 cwd 选定后触发）。
    scanDescriptorRequested: 'device:scan-descriptor-requested',
    // 服务端→daemon 单向通知：该设备已被删除，daemon 应回收重连并退出进程。
    removed: 'device:removed',
  },
  agent: {
    registerBatch: 'agent:register-batch',
    reportCustomSkills: 'agent:report-custom-skills',
    // daemon→服务端：上报指定目录扫描到的 descriptor（AGENTS.md/CLAUDE.md + skills）。
    reportDescriptor: 'agent:report-descriptor',
  },
  dispatch: {
    request: 'dispatch:request',
    cancel: 'dispatch:cancel',
    accepted: 'dispatch:accepted',
    result: 'dispatch:result',
    error: 'dispatch:error',
    progress: 'dispatch:progress',
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
    respond: 'task-claim:respond',
    relinquish: 'task-claim:relinquish',
  },
  promotion: {
    escalate: 'promotion:agent-escalate',
  },
  memory: {
    governanceSummaryRequested: 'memory:governance-summary-requested',
  },
  workspace: {
    // 服务端→daemon 单向通知：频道工作区 revision 已 commit（某设备发布了交付物）。
    // daemon 收到后把该 revision materialize 到本机 ~/.agentbean/.../channels/<id>/snapshots/<revisionId>/。
    revisionCommitted: 'workspace:revision-committed',
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

/**
 * server→daemon：频道工作区 revision 已 commit 的单向通知（fire-and-forget）。
 * daemon 收到后用 device token + teamId/channelId/revisionId 拉 revision 文件清单并 materialize
 * 到本机 ~/.agentbean/workspaces/<teamId>/channels/<channelId>/snapshots/<revisionId>/。
 * - teamId：revision 所属 Team（跨 Team 场景下可能与 device 归属 Team 不同；daemon 用此值查 server）。
 * - deviceId：可选；存在时 daemon 据此早退过滤（非本机则忽略）。
 */
export interface WorkspaceRevisionCommittedPayload {
  teamId: string;
  channelId: string;
  workspaceId: string;
  revisionId: string;
  deviceId?: string;
}

/** server→daemon：请求扫描指定目录的 descriptor（AGENTS.md/CLAUDE.md + skills）。 */
export interface ScanDescriptorRequest {
  requestId: string;
  cwd: string;
  adapterKind: string;
}

/**
 * #1084 切片3：web→server→daemon 请求读本机 snapshots 副本单文件字节。
 * - teamId/channelId/revisionId 定位 snapshots root（channelProjectionRoot/snapshots/<revisionId>/）。
 * - path 是相对该 root 的 POSIX 相对路径（daemon 内 readpath 白名单会再校验，越界 → OUTSIDE_SNAPSHOTS）。
 */
export interface ReadFileRequestDto {
  deviceId: string;
  teamId: string;
  channelId: string;
  revisionId: string;
  path: string;
}

/**
 * #1084 切片3 readFile 回包。
 * - ok 时附 contentBase64 + sizeBytes；sha256 可选（daemon 计算回传，web 与 server artifact.sha256 比对判本机是否最新）。
 * - 失败码：OUTSIDE_SNAPSHOTS（readpath 白名单越界，专用）/ PATH_NOT_FOUND / PERMISSION_DENIED / RATE_LIMITED。
 */
export type ReadFileResultDto =
  | { ok: true; contentBase64: string; sizeBytes: number; sha256?: string }
  | { ok: false; error: 'PATH_NOT_FOUND' | 'PERMISSION_DENIED' | 'RATE_LIMITED' | 'OUTSIDE_SNAPSHOTS' };

/** daemon→server：descriptor 扫描结果上报。 */
export interface ReportDescriptorPayload {
  requestId: string;
  teamId: string;
  deviceId: string;
  agentId?: string;
  cwd: string;
  descriptor: AgentDescriptorDto;
  skills: {
    name: string;
    description: string;
    scope: string;
    sourcePath: string;
    adapterKind: string;
  }[];
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

/**
 * #712 切片 C-2a：Agent 对 Task Offer 的显式响应请求（替代旧 canAcceptOffer+acquire 隐式接受）。
 * 路由到 broker.respondToOffer；只有 accepted 才产 Claim/Lease（AC#4）。
 */
export interface TaskClaimRespondV1 {
  readonly schemaVersion: 1;
  readonly offerId: string;
  readonly agentId: string;
  readonly kind: TaskOfferResponseKind;
  readonly detail?: string | null;
}

export interface TaskClaimExecutionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly managementRunId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  /** #925 execution context grant id：claim 成功同事务签发的输入访问凭证。 */
  readonly grantId: string;
  /** #966 claim 时冻结的 Project Channel Workspace revisionId；Agent 据此读取固定输入版本。undefined=频道无 workspace。 */
  readonly workspaceRevisionId?: string;
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

/**
 * ADR-0064/0065 #948-E：Agent 显式 relinquish Claim 的成因（AC#5）。区别于 release（无归因
 * 的底层释放），relinquish 携带 cause 供 PI 决定重规划/交接/失败。
 */
export type ClaimRelinquishmentCause =
  | 'agent_voluntary'
  | 'task_unfeasible'
  | 'agent_unavailable'
  | 'context_changed';

/**
 * ADR-0064/0065 #948-E：Agent 携带当前 authority 显式 relinquish Claim。开工前（task 未
 * in_progress）只结束 allocation round、保留 attempt；开工后终止 attempt（attempt+1 可重试）。
 */
export type TaskClaimRelinquishV1 = TaskClaimAuthorityV1 & {
  readonly cause: ClaimRelinquishmentCause;
  readonly detail?: string;
};

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

/**
 * ADR-0064/0065 #948-E：executionStarted 表示该 claim 是否已进入执行（task 曾 in_progress），
 * 驱动 attempt 消耗——开工后 relinquish 终止 attempt（attempt+1，可重试时），开工前保留。
 */
export type TaskClaimRelinquishAckV1 = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly releasedAt: number;
  readonly executionStarted: boolean;
  readonly attempt: number;
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
  readonly respond: TaskClaimRespondV1;
  readonly relinquish: TaskClaimRelinquishV1;
  readonly 'acquire-ack': TaskClaimAcquireAckV1;
  readonly 'renew-ack': TaskClaimRenewAckV1;
  readonly 'release-ack': TaskClaimReleaseAckV1;
  readonly 'relinquish-ack': TaskClaimRelinquishAckV1;
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
    case 'respond':
      taskClaimExact(value, ['schemaVersion', 'offerId', 'agentId', 'kind'], ['detail']);
      taskClaimSchema(value); taskClaimStrings(value, ['offerId', 'agentId']);
      if (!['accepted', 'rejected', 'needs_info', 'counter_proposed'].includes(String(value.kind))) taskClaimInvalid();
      if (value.detail !== undefined && value.detail !== null && typeof value.detail !== 'string') taskClaimInvalid();
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
