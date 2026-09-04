'use client';
import { WEB_EVENTS, type ActiveMemoryAttributionDto, type ActivePiModelDto, type AgentExposureActiveProjectionDto, type AgentExposureManifestRevisionDto, type AgentExposureRestrictionDto, type AgentMemoryProjectionConsumptionDto, type AgentMemoryProjectionDto, type AgentTeamCoverageDto, type ArtifactRole, type ChannelExperienceAttachmentDto, type ChannelFilesResultDto, type ChannelProjectOverviewDto, type ConsistencyTokenV1, type CopyPiProviderCardInput, type CreateInitialProjectStageInput, type CreatePiProviderCardInput, type CreateProjectStageEdgeInput, type CreateProjectStageInput, type DeleteProjectStageEdgeInput, type CreateProjectDocumentBundleInput, type ExperiencePackDto, type FormalCorrectionType, type FormalMemoryDetailDto, type FormalMemoryDto, type FormalMemoryKind, type FormalMemoryListDto, type FormalMemoryScopeType, type JoinLinkDto, type LocalMemoryGovernanceSummaryDto, type MemoryContentKind, type MemoryGovernanceSnapshotDto, type MemoryKind, type MemoryRedactionLevel, type MemoryScopeType, type MessageMetaDto, type PiConfigurationReadinessDto, type PiProviderCardDto, type PiProviderPresetDescriptorDto, type OutputPackageDto, type OutputPackagePendingDeliveryDto, type OutputPackageProjectionResultV1, type OutputPackageSummaryDto, type PackageMemberAvailableActionsDto, type PackageReviewAction, type PackageReviewDto, type ProjectArtifactCollectionDto, type ProjectArtifactFinalizationDto, type ProjectArtifactLibraryDto, type ProjectArtifactReviewDto, type ProjectArtifactVersionDto, type ProjectDocumentBundleDetailDto, type ProjectDocumentBundleDto, type PromoteArtifactToProjectVersionInput, type SetProjectArtifactFinalVersionInput, type StageDeliveryReviewWorkspaceV1, type SubmitProjectArtifactReviewInput, type TeamAgentMemoryOptInDto, type TeamDto, type TaskDagViewDto, type TaskDeliveryOverviewV1, type ChannelTaskWorkspaceV1, type UpdatePiProviderCardInput, type ProjectChannelWorkspaceDto, type ArtifactRevisionConflictDto, type ArtifactVersionRevisionSaveResultDto, type PackageReviewRevisionSaveV1 } from '@agentbean/contracts';

/** #1061 三个 package review 命令的 socket payload(userId/teamId 由 Server 注入)。 */
export type PackageReviewCommandSocketPayload = {
  channelId: string;
  packageId: string;
  collectionId: string;
  versionId: string;
  decision: PackageReviewDto['decision'];
  comment: string;
  idempotencyKey: string;
  expectedCollectionRevision?: number;
  expectedTaskRevision?: number;
  expectedTaskAttempt?: number;
  rejectReason?: string;
  saveRevision?: PackageReviewRevisionSaveV1;
};

export type PackageBatchReviewCommandSocketPayload = {
  channelId: string;
  packageId: string;
  deliveryId: string;
  expectedPackageRevision: number;
  targets: readonly { collectionId: string; artifactVersionId: string }[];
  decision: PackageReviewDto['decision'];
  comment: string;
  idempotencyKey: string;
};

export type { PackageMemberAvailableActionsDto, PackageReviewAction };
import { io, type Socket } from 'socket.io-client';
import type {
  PromotionGateCommandInputMapV1,
  PromotionGateCommandResponseV1,
} from '@agentbean/contracts';
import type { ChannelDocumentDto, ChannelDocumentRevisionsResultDto, ChannelDocumentResultDto, MessageDto, PublishChannelDocumentResultDto } from '@agentbean/contracts';
import type { AgentAutoAcceptPolicyDto, AgentCapabilityDirectoryDto } from '@agentbean/contracts';
import type { AgentSnapshot, DiscoveredAgent, RuntimeInfo, TeamSummary, ChannelSummary, AgentMetricsSummary, InviteInfo, UserInfo, DeviceInfo, ChatMessage, AgentWorkspaceRun, TeamWorkspaceRun, Artifact, WorkspaceRunDetail, WorkspaceArtifact, WorkspaceRunLogResponse, WorkspaceRunStatus } from './schema.js';
import {
  assertArtifactUploadWithinLimit,
  artifactUploadFallbackUrls as buildArtifactUploadFallbackUrls,
  artifactUploadProxyUrl as buildArtifactUploadProxyUrl,
  artifactUploadUrl as buildArtifactUploadUrl,
} from './artifact-upload';
import { clearChannelDocumentDrafts } from './channel-document-drafts';
import { clearBrowserPush } from './browser-push';

const configuredUrl = process.env.NEXT_PUBLIC_AGENT_BEAN_SERVER_URL;
const TOKEN_STORAGE_KEY = 'agentbean.token';
const DEVICE_ID_STORAGE_KEY = 'agentbean.deviceId';
const DEVICE_TOKEN_STORAGE_KEY = 'agentbean.deviceToken';

let webSocket: Socket | null = null;
const webToken = process.env.NEXT_PUBLIC_AGENT_BEAN_WEB_TOKEN ?? process.env.NEXT_PUBLIC_AGENT_BEAN_AGENT_TOKEN ?? '';

function getStoredToken(): string {
  if (typeof window === 'undefined') return webToken;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? webToken;
}

export function getStoredAuthToken(): string {
  return getStoredToken();
}

export function getStoredDeviceId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
}

export function setStoredDeviceId(deviceId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
}

function getStoredDeviceToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY) ?? '';
}

export function setStoredDeviceToken(deviceToken: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, deviceToken);
}

export function clearStoredAuth(): void {
  if (typeof window === 'undefined') return;
  void clearBrowserPush().catch(() => undefined);
  clearChannelDocumentDrafts(window.localStorage);
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(DEVICE_ID_STORAGE_KEY);
}

export function resolveDeviceLoginDeviceId(complete: { invite?: { deviceId?: string }; credentials?: { deviceId?: string; machineId?: string } }): string | undefined {
  return complete.invite?.deviceId ?? complete.credentials?.deviceId ?? complete.credentials?.machineId;
}

function getServerUrl(): string {
  if (configuredUrl) return configuredUrl;
  if (typeof window !== 'undefined') return window.location.origin;
  return 'http://localhost:4100';
}

export function getResolvedServerUrl(): string {
  return getServerUrl();
}

export function authedApiUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${getServerUrl()}${path}${sep}token=${encodeURIComponent(getStoredAuthToken())}`;
}

export function artifactUploadUrl(teamId: string): string {
  return buildArtifactUploadUrl(getServerUrl(), teamId, getStoredAuthToken());
}

export function artifactUploadProxyUrl(teamId: string): string {
  return buildArtifactUploadProxyUrl(teamId, getStoredAuthToken());
}

export function artifactUploadFallbackUrls(teamId: string): string[] {
  return buildArtifactUploadFallbackUrls(getServerUrl(), teamId, getStoredAuthToken());
}

function cloneFormData(form: FormData): FormData {
  const cloned = new FormData();
  for (const [key, value] of form.entries()) {
    cloned.append(key, value);
  }
  return cloned;
}

export async function uploadArtifact(teamId: string, form: FormData): Promise<Artifact> {
  assertArtifactUploadWithinLimit(form);
  let lastError: Error | null = null;
  for (const url of artifactUploadFallbackUrls(teamId)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: cloneFormData(form),
      });
      if (res.ok) {
        const payload = await res.json() as Artifact | { artifact?: Artifact };
        if ('artifact' in payload && payload.artifact) return payload.artifact;
        return payload as Artifact;
      }
      const text = await res.text();
      lastError = new Error(text || `${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Failed to fetch');
    }
  }
  throw lastError ?? new Error('Failed to upload artifact');
}

export async function fetchAgentWorkspace(teamId: string, agentId: string): Promise<{ ok: boolean; runs?: AgentWorkspaceRun[]; error?: string }> {
  try {
    const res = await fetch(authedApiUrl(`/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}/workspace`));
    if (!res.ok) return { ok: false, error: await res.text() };
    return await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to fetch workspace' };
  }
}

export async function fetchTeamWorkspaceRuns(
  teamId: string,
  filters?: { agentId?: string; deviceId?: string; status?: WorkspaceRunStatus },
  pagination?: { cursor?: string; pageSize?: number },
): Promise<{ ok: boolean; runs?: TeamWorkspaceRun[]; nextCursor?: string; error?: string }> {
  try {
    const params = new URLSearchParams();
    if (filters?.agentId) params.set('agentId', filters.agentId);
    if (filters?.deviceId) params.set('deviceId', filters.deviceId);
    if (filters?.status) params.set('status', filters.status);
    if (pagination?.cursor) params.set('cursor', pagination.cursor);
    if (pagination?.pageSize) params.set('pageSize', String(pagination.pageSize));
    const query = params.toString();
    const res = await fetch(
      authedApiUrl(`/api/teams/${encodeURIComponent(teamId)}/workspace-runs${query ? `?${query}` : ''}`),
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: body?.error ?? body?.message ?? `${res.status} ${res.statusText}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to fetch workspace runs' };
  }
}

export async function fetchWorkspaceRunDetail(teamId: string, runId: string): Promise<{ ok: boolean; workspaceRun?: WorkspaceRunDetail; artifacts?: WorkspaceArtifact[]; error?: string }> {
  try {
    const path = `/api/teams/${encodeURIComponent(teamId)}/workspace-runs/${encodeURIComponent(runId)}`;
    const res = await fetch(authedApiUrl(path));
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: body?.error ?? body?.message ?? `${res.status} ${res.statusText}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to fetch workspace run' };
  }
}

export async function fetchWorkspaceRunLog(
  teamId: string,
  runId: string,
  options?: { query?: string; tailLines?: number; maxBytes?: number },
): Promise<WorkspaceRunLogResponse> {
  try {
    const params = new URLSearchParams();
    if (options?.query) params.set('query', options.query);
    if (options?.tailLines) params.set('tailLines', String(options.tailLines));
    if (options?.maxBytes) params.set('maxBytes', String(options.maxBytes));
    const query = params.toString();
    const path = `/api/teams/${encodeURIComponent(teamId)}/workspace-runs/${encodeURIComponent(runId)}/log${query ? `?${query}` : ''}`;
    const res = await fetch(authedApiUrl(path));
    const body = await res.json().catch(() => null) as WorkspaceRunLogResponse | null;
    if (!res.ok) {
      return { ok: false, error: body?.error ?? `${res.status} ${res.statusText}` };
    }
    return body ?? { ok: false, error: 'Invalid workspace run log response' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to fetch workspace run log' };
  }
}

export function getWebSocket(): Socket {
  if (webSocket) return webSocket;
  let retriedWithWebToken = false;
  webSocket = io(`${getServerUrl()}/web`, { transports: ['websocket'], autoConnect: true, auth: { token: getStoredToken(), currentDeviceId: getStoredDeviceId(), deviceToken: getStoredDeviceToken() } });
  webSocket.on('connect_error', () => {
    if (typeof window === 'undefined' || retriedWithWebToken || !webToken) return;
    const storedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!storedToken || storedToken === webToken) return;
    retriedWithWebToken = true;
    clearStoredAuth();
    webSocket?.disconnect();
    webSocket!.auth = { token: webToken, currentDeviceId: getStoredDeviceId(), deviceToken: '' };
    webSocket?.connect();
  });
  return webSocket;
}

export function resetWebSocket(): Socket {
  webSocket?.disconnect();
  webSocket = null;
  return getWebSocket();
}

export function createInviteSocket(): Socket {
  return io(`${getServerUrl()}/web`, { transports: ['websocket'], autoConnect: true, auth: { invite: true } });
}

export interface AgentEvents {
  onSnapshot(handler: (snap: AgentSnapshot[]) => void): () => void;
  onStatus(handler: (snap: AgentSnapshot) => void): () => void;
  onDiscovered(handler: (payload: { runtimes: RuntimeInfo[]; agents: DiscoveredAgent[] }) => void): () => void;
  metrics(teamId: string): Promise<{ ok: boolean; summaries?: AgentMetricsSummary[]; error?: string }>;
  // 设置 Agent 对指定团队的可见性（替代旧的 publish/unpublish，由后端统一收敛到 visibleTeamIds）
  setVisibility(agentId: string, teamId: string, visible: boolean): Promise<{ ok: boolean; agent?: AgentSnapshot; error?: string }>;
  delete(agentId: string, teamId?: string): Promise<{ ok: boolean; agent?: AgentSnapshot; error?: string }>;
  create(payload: { teamId: string; deviceId: string; name: string; adapterKind?: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; description?: string; projectDocumentInputSetVersions?: number[] }): Promise<{ ok: boolean; agent?: AgentSnapshot; error?: string }>;
  updateConfig(payload: { id: string; teamId?: string; name: string; adapterKind?: string; command?: string; cwd?: string | null; description?: string | null; env?: Record<string, string> }): Promise<{ ok: boolean; agent?: AgentSnapshot; error?: string }>;
  subscribe(teamId: string): void;
}

// 超时不再 reject（避免调用方未 catch 时变 Uncaught (in promise)），
// 改为 resolve { ok:false, error:'timeout' } + console.warn 保留可观测性。
// 所有调用方均以 `if (res.ok)` 守卫，超时自然降级（列表留空 / 表单报错）。
export function emitWithTimeout(socket: Socket, event: string, payload: any, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (typeof console !== 'undefined') {
        console.warn(`[socket] ${event} ack timeout after ${timeoutMs}ms`);
      }
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    socket.emit(event, payload, (res: any) => { clearTimeout(timer); resolve(res); });
  });
}

/**
 * #965 AC#4：读取某次 PI 协调（coordination decision）使用的 Active Memory 来源归因。
 * 服务端读取时复验频道读权限，未授权或无归因返回 null（不泄露存在性/其他 scope 正文）。
 */
export async function fetchMemoryAttribution(input: {
  teamId: string;
  jobId?: string;
  messageId?: string;
}): Promise<{ ok: boolean; attribution?: ActiveMemoryAttributionDto | null; error?: string }> {
  return emitWithTimeout(getWebSocket(), WEB_EVENTS.memoryAttribution.get, input);
}

export function agentEvents(socket: Socket = getWebSocket()): AgentEvents {
  return {
    onSnapshot(handler) {
      const wrapped = (snap: AgentSnapshot[]) => handler(snap);
      socket.on(WEB_EVENTS.agent.snapshot, wrapped);
      return () => { socket.off(WEB_EVENTS.agent.snapshot, wrapped); };
    },
    onStatus(handler) {
      const wrapped = (snap: AgentSnapshot) => handler(snap);
      socket.on(WEB_EVENTS.agent.status, wrapped);
      return () => { socket.off(WEB_EVENTS.agent.status, wrapped); };
    },
    onDiscovered(handler) {
      socket.on(WEB_EVENTS.agent.discovered, handler);
      return () => { socket.off(WEB_EVENTS.agent.discovered, handler); };
    },
    metrics(teamId) {
      return emitWithTimeout(socket, WEB_EVENTS.agent.metrics, { teamId });
    },
    subscribe(teamId) { socket.emit(WEB_EVENTS.agent.subscribe, { teamId }); },
    create(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.agent.create, payload);
    },
    updateConfig({ id, ...rest }) {
      return emitWithTimeout(socket, WEB_EVENTS.agent.updateConfig, { agentId: id, ...rest });
    },
    setVisibility(agentId, teamId, visible) {
      return emitWithTimeout(socket, WEB_EVENTS.agent.setVisibility, { agentId, teamId, visible });
    },
    delete(agentId, teamId) {
      return emitWithTimeout(socket, WEB_EVENTS.agent.delete, { agentId, ...(teamId ? { teamId } : {}) });
    },
  };
}

export interface TeamEvents {
  list(): Promise<{ ok: boolean; teams?: TeamSummary[]; error?: string }>;
  create(payload: { name: string; path?: string; description?: string; visibility?: 'public' | 'private' }): Promise<{ ok: boolean; team?: TeamSummary; defaultChannel?: { id: string; name: string }; error?: string }>;
  switch(teamId: string): Promise<{ ok: boolean; currentTeam?: TeamSummary; error?: string }>;
  update(payload: { teamId?: string; name?: string }): Promise<{ ok: boolean; team?: TeamSummary; error?: string }>;
  delete(teamId: string): Promise<{ ok: boolean; fallbackTeam?: TeamSummary | null; error?: string }>;
  onSnapshot(handler: (nets: TeamSummary[]) => void): () => void;
  subscribe(): void;
}

export function teamEvents(socket: Socket = getWebSocket()): TeamEvents {
  return {
    list() {
      return emitWithTimeout(socket, WEB_EVENTS.team.list, {});
    },
    create(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.team.create, payload);
    },
    switch(teamId) {
      return emitWithTimeout(socket, WEB_EVENTS.team.switch, { teamId });
    },
    update(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.team.update, payload);
    },
    delete(teamId) {
      return emitWithTimeout(socket, WEB_EVENTS.team.delete, { teamId });
    },
    onSnapshot(handler) {
      socket.on(WEB_EVENTS.team.snapshot, handler);
      return () => { socket.off(WEB_EVENTS.team.snapshot, handler); };
    },
    subscribe() { socket.emit(WEB_EVENTS.team.list, {}); },
  };
}

export interface PiPolicyEvents {
  get(teamId: string): Promise<{ ok: boolean; autoCoordinationEnabled?: boolean; error?: string }>;
  update(payload: { teamId: string; autoCoordinationEnabled: boolean }): Promise<{ ok: boolean; autoCoordinationEnabled?: boolean; error?: string }>;
}

export function piPolicyEvents(socket: Socket = getWebSocket()): PiPolicyEvents {
  return {
    get(teamId) { return emitWithTimeout(socket, WEB_EVENTS.piPolicy.get, { teamId }); },
    update(payload) { return emitWithTimeout(socket, WEB_EVENTS.piPolicy.update, payload); },
  };
}

export interface AgentExposureActiveResult {
  ok: boolean;
  projection?: AgentExposureActiveProjectionDto;
  error?: string;
  message?: string;
}
export interface AgentExposureRevisionResult {
  ok: boolean;
  revisions?: AgentExposureManifestRevisionDto[];
  activeRestriction?: AgentExposureRestrictionDto | null;
  error?: string;
  message?: string;
}
export interface AgentExposureCoverageResult {
  ok: boolean;
  coverage?: AgentTeamCoverageDto;
  error?: string;
  message?: string;
}
export interface AgentExposureManifestResult {
  ok: boolean;
  manifest?: AgentExposureManifestRevisionDto;
  supersededManifestId?: string | null;
  error?: string;
  message?: string;
}
export interface AgentExposureRestrictionResult {
  ok: boolean;
  restriction?: AgentExposureRestrictionDto;
  error?: string;
  message?: string;
}
export interface AgentCapabilityDirectoryResult {
  ok: boolean;
  directory?: AgentCapabilityDirectoryDto;
  error?: string;
  message?: string;
}
export interface AgentAutoAcceptPolicyResult {
  ok: boolean;
  policy?: AgentAutoAcceptPolicyDto | null;
  error?: string;
  message?: string;
}
export interface AgentMemoryProjectionResult {
  ok: boolean;
  projection?: AgentMemoryProjectionDto;
  supersededProjectionId?: string | null;
  error?: string;
  message?: string;
}
export interface AgentMemoryProjectionRevisionResult {
  ok: boolean;
  revisions?: AgentMemoryProjectionDto[];
  activeOptIn?: TeamAgentMemoryOptInDto | null;
  error?: string;
  message?: string;
}
export interface AgentMemoryProjectionConsumptionResult {
  ok: boolean;
  projections?: AgentMemoryProjectionConsumptionDto[];
  error?: string;
  message?: string;
}
export interface TeamAgentMemoryOptInResult {
  ok: boolean;
  optIn?: TeamAgentMemoryOptInDto;
  error?: string;
  message?: string;
}

/** #710 Team Agent Exposure socket 客户端。服务端强制授权（owner 发布、Team admin 收紧）。 */
export function agentExposureEvents(socket: Socket = getWebSocket()) {
  return {
    createDraft(payload: {
      teamId: string; agentId: string;
      capabilities: { name: string; description: string }[];
      skills: { name: string; description: string }[];
      constraints?: { kind: string; description: string }[];
      availability?: { status: 'available' | 'unavailable'; reason?: string };
      validUntil?: number | null;
    }): Promise<AgentExposureManifestResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.createDraft, payload);
    },
    updateDraft(payload: {
      teamId: string; manifestId: string;
      capabilities: { name: string; description: string }[];
      skills: { name: string; description: string }[];
      constraints?: { kind: string; description: string }[];
      availability?: { status: 'available' | 'unavailable'; reason?: string };
      validUntil?: number | null;
    }): Promise<AgentExposureManifestResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.updateDraft, payload);
    },
    publish(payload: { teamId: string; manifestId: string }): Promise<AgentExposureManifestResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.publish, payload);
    },
    revoke(payload: { teamId: string; agentId: string }): Promise<{ ok: boolean; revoked?: boolean; error?: string; message?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.revoke, payload);
    },
    listRevisions(teamId: string, agentId: string): Promise<AgentExposureRevisionResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.listRevisions, { teamId, agentId });
    },
    getActive(teamId: string, agentId: string): Promise<AgentExposureActiveResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.getActive, { teamId, agentId });
    },
    getTeamCoverage(teamId: string): Promise<AgentExposureCoverageResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.getTeamCoverage, { teamId });
    },
    upsertRestriction(payload: {
      teamId: string; agentId: string;
      disabledCapabilities: string[]; disabledSkills: string[];
    }): Promise<AgentExposureRestrictionResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.upsertRestriction, payload);
    },
    getCapabilityDirectory(teamId: string, channelId?: string): Promise<AgentCapabilityDirectoryResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.getCapabilityDirectory, {
        teamId,
        ...(channelId ? { channelId } : {}),
      });
    },
    upsertAutoAcceptPolicy(payload: {
      teamId: string; agentId: string; enabled: boolean;
      allowedCapabilityIds: string[]; allowUnspecifiedCapabilities: boolean;
      allowedRiskLevels: ('low' | 'high')[]; allowFrozenProjectInputs: boolean;
      requireCompletePreview: boolean; maxActiveClaims: number; validUntil?: number | null;
    }): Promise<AgentAutoAcceptPolicyResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.upsertAutoAcceptPolicy, payload);
    },
    getAutoAcceptPolicy(teamId: string, agentId: string): Promise<AgentAutoAcceptPolicyResult> {
      return emitWithTimeout(socket, WEB_EVENTS.agentExposure.getAutoAcceptPolicy, { teamId, agentId });
    },
  };
}

/** #718 Team-scoped Agent Memory 投影 socket 客户端。owner 发布/撤回，Team Owner/Admin opt-in，成员/PI 只读消费。 */
export function agentMemoryProjectionEvents(socket: Socket = getWebSocket()) {
  return {
    createDraft(payload: {
      teamId: string; agentId: string; kind: FormalMemoryKind; content: string;
      summary?: string; tags?: string[]; validUntil?: number | null;
    }): Promise<AgentMemoryProjectionResult> {
      return emitWithTimeout(socket, WEB_EVENTS.memory.projectionCreateDraft, payload);
    },
    updateDraft(payload: {
      teamId: string; projectionId: string; kind: FormalMemoryKind; content: string;
      summary?: string; tags?: string[]; validUntil?: number | null;
    }): Promise<AgentMemoryProjectionResult> {
      return emitWithTimeout(socket, WEB_EVENTS.memory.projectionUpdateDraft, payload);
    },
    publish(payload: { teamId: string; projectionId: string }): Promise<AgentMemoryProjectionResult> {
      return emitWithTimeout(socket, WEB_EVENTS.memory.projectionPublish, payload);
    },
    withdraw(payload: { teamId: string; agentId: string }): Promise<{ ok: boolean; withdrawn?: boolean; error?: string; message?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.memory.projectionWithdraw, payload);
    },
    listRevisions(teamId: string, agentId: string): Promise<AgentMemoryProjectionRevisionResult> {
      return emitWithTimeout(socket, WEB_EVENTS.memory.projectionListRevisions, { teamId, agentId });
    },
    upsertOptIn(payload: { teamId: string; agentId: string; enabled: boolean }): Promise<TeamAgentMemoryOptInResult> {
      return emitWithTimeout(socket, WEB_EVENTS.memory.projectionUpsertOptIn, payload);
    },
    getConsumable(teamId: string, agentId?: string): Promise<AgentMemoryProjectionConsumptionResult> {
      return emitWithTimeout(socket, WEB_EVENTS.memory.projectionGetConsumable, { teamId, agentId });
    },
  };
}

export interface PiProviderEvents {
  listPresets(): Promise<{ ok: boolean; presets?: PiProviderPresetDescriptorDto[]; error?: string; message?: string }>;
  listCards(): Promise<{ ok: boolean; cards?: PiProviderCardDto[]; error?: string; message?: string }>;
  getCard(cardId: string): Promise<{ ok: boolean; card?: PiProviderCardDto; error?: string; message?: string }>;
  createCard(payload: Omit<CreatePiProviderCardInput, never>): Promise<{ ok: boolean; card?: PiProviderCardDto; error?: string; message?: string }>;
  updateCard(payload: UpdatePiProviderCardInput): Promise<{ ok: boolean; card?: PiProviderCardDto; error?: string; message?: string }>;
  copyCard(payload: CopyPiProviderCardInput): Promise<{ ok: boolean; card?: PiProviderCardDto; error?: string; message?: string }>;
  discoverModels(cardId: string): Promise<{ ok: boolean; discoverySupported?: boolean; models?: { modelId: string }[]; diagnosticCode?: string | null; error?: string; message?: string }>;
  runTest(cardId: string): Promise<{ ok: boolean; test?: unknown; card?: PiProviderCardDto; error?: string; message?: string }>;
  cancelTest(cardId: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string; message?: string }>;
  publishCard(cardId: string): Promise<{ ok: boolean; card?: PiProviderCardDto; error?: string; message?: string }>;
  getActiveModel(): Promise<{ ok: boolean; activeModel?: ActivePiModelDto | null; history?: ActivePiModelDto[]; readiness?: PiConfigurationReadinessDto; error?: string; message?: string }>;
  setActiveModel(revisionId: string): Promise<{ ok: boolean; activeModel?: ActivePiModelDto; error?: string; message?: string }>;
  /** #699 US 84：系统管理员紧急停止/恢复 PI。 */
  setEmergencyStop(active: boolean): Promise<{ ok: boolean; emergencyStopActive?: boolean; error?: string; message?: string }>;
  getEmergencyStop(): Promise<{ ok: boolean; emergencyStopActive?: boolean; error?: string; message?: string }>;
}

export function piProviderEvents(socket: Socket = getWebSocket()): PiProviderEvents {
  return {
    listPresets() { return emitWithTimeout(socket, WEB_EVENTS.piProvider.listPresets, {}); },
    listCards() { return emitWithTimeout(socket, WEB_EVENTS.piProvider.listCards, {}); },
    getCard(cardId) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.getCard, { cardId }); },
    createCard(payload) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.createCard, payload); },
    updateCard(payload) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.updateCard, payload); },
    copyCard(payload) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.copyCard, payload); },
    discoverModels(cardId) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.discoverModels, { cardId }); },
    runTest(cardId) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.runTest, { cardId }, 300_000); },
    cancelTest(cardId) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.cancelTest, { cardId }); },
    publishCard(cardId) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.publishCard, { cardId }); },
    getActiveModel() { return emitWithTimeout(socket, WEB_EVENTS.piProvider.getActiveModel, {}); },
    setActiveModel(revisionId) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.setActiveModel, { revisionId }); },
    setEmergencyStop(active: boolean) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.setEmergencyStop, { active }); },
    getEmergencyStop() { return emitWithTimeout(socket, WEB_EVENTS.piProvider.getEmergencyStop, {}); },
  };
}

/** #699 US 29：PI Token Usage socket 客户端。 */
export function piUsageEvents(socket: Socket = getWebSocket()) {
  return {
    getTeamUsage(since?: number): Promise<{ ok: boolean; totalInputTokens?: number; totalOutputTokens?: number; totalDecisions?: number; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.piUsage.getTeamUsage, { since });
    },
  };
}

export interface SystemKnowledgeEvents {
  list(): Promise<any>;
  detail(memoryId: string): Promise<any>;
  create(payload: { kind: FormalMemoryKind; content: string; summary?: string; changeReason?: string; validUntil?: number }): Promise<any>;
  revise(payload: { memoryId: string; content: string; summary?: string; changeReason: string; validUntil?: number }): Promise<any>;
  deactivate(payload: { memoryId: string; changeReason: string }): Promise<any>;
  delete(memoryId: string, changeReason?: string): Promise<any>;
}

export function systemKnowledgeEvents(socket: Socket = getWebSocket()): SystemKnowledgeEvents {
  return {
    list() { return emitWithTimeout(socket, WEB_EVENTS.systemKnowledge.list, {}); },
    detail(memoryId) { return emitWithTimeout(socket, WEB_EVENTS.systemKnowledge.detail, { memoryId }); },
    create(payload) { return emitWithTimeout(socket, WEB_EVENTS.systemKnowledge.create, payload); },
    revise(payload) { return emitWithTimeout(socket, WEB_EVENTS.systemKnowledge.revise, payload); },
    deactivate(payload) { return emitWithTimeout(socket, WEB_EVENTS.systemKnowledge.deactivate, payload); },
    delete(memoryId, changeReason) { return emitWithTimeout(socket, WEB_EVENTS.systemKnowledge.delete, { memoryId, ...(changeReason ? { changeReason } : {}) }); },
  };
}

export interface UserMemoryEvents {
  list(): Promise<any>;
  detail(memoryId: string): Promise<any>;
  create(payload: { kind: FormalMemoryKind; content: string; summary?: string; changeReason?: string; validUntil?: number }): Promise<any>;
  revise(payload: { memoryId: string; content: string; summary?: string; changeReason: string; validUntil?: number }): Promise<any>;
  deactivate(payload: { memoryId: string; changeReason: string }): Promise<any>;
  delete(memoryId: string, changeReason?: string): Promise<any>;
}

export function userMemoryEvents(socket: Socket = getWebSocket()): UserMemoryEvents {
  return {
    list() { return emitWithTimeout(socket, WEB_EVENTS.userMemory.list, {}); },
    detail(memoryId) { return emitWithTimeout(socket, WEB_EVENTS.userMemory.detail, { memoryId }); },
    create(payload) { return emitWithTimeout(socket, WEB_EVENTS.userMemory.create, payload); },
    revise(payload) { return emitWithTimeout(socket, WEB_EVENTS.userMemory.revise, payload); },
    deactivate(payload) { return emitWithTimeout(socket, WEB_EVENTS.userMemory.deactivate, payload); },
    delete(memoryId, changeReason) { return emitWithTimeout(socket, WEB_EVENTS.userMemory.delete, { memoryId, ...(changeReason ? { changeReason } : {}) }); },
  };
}

export interface ChannelEvents {
  join(teamId: string, channelId: string, limit?: number): Promise<{ ok: boolean; messages?: ChatMessage[]; error?: string }>;
  subscribe(teamId: string): void;
  create(payload: { teamId: string; name: string; title?: string; visibility: 'public' | 'private'; humanMemberIds?: string[]; agentMemberIds?: string[] }): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  update(payload: { teamId?: string; channelId: string; name?: string; title?: string | null; visibility?: 'public' | 'private' }): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  members(channelId: string, teamId?: string): Promise<{ ok: boolean; humans?: { userId: string; role: string; username: string }[]; agents?: import('./schema').AgentSnapshot[]; error?: string }>;
  addAgent(channelId: string, agentId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  addMember(channelId: string, userId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  removeAgent(channelId: string, agentId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  removeMember(channelId: string, userId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  archive(channelId: string, teamId?: string, confirmationToken?: string): Promise<{ ok: boolean; channel?: ChannelSummary; preflight?: import('@agentbean/contracts').ChannelArchivePreflightDto; confirmation?: import('@agentbean/contracts').ChannelArchiveConfirmationDto; error?: string }>;
  delete(channelId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  searchMessages(query: string, limit?: number, channelId?: string): Promise<{ ok: boolean; messages?: ChatMessage[]; error?: string }>;
  listFiles(channelId: string, cursor?: string, pageSize?: number, path?: string, role?: ArtifactRole | 'all'): Promise<{ ok: boolean; files?: ChannelFilesResultDto['files']; directories?: ChannelFilesResultDto['directories']; nextCursor?: string; path?: string; error?: string }>;
  searchFiles(channelId: string, query: string, cursor?: string, pageSize?: number, path?: string, role?: ArtifactRole | 'all'): Promise<{ ok: boolean; files?: ChannelFilesResultDto['files']; directories?: ChannelFilesResultDto['directories']; nextCursor?: string; path?: string; error?: string }>;
  listDocuments(channelId: string): Promise<{ ok: boolean; documents?: ChannelDocumentDto[]; error?: string }>;
  getDocument(channelId: string, documentId: string): Promise<{ ok: boolean; document?: ChannelDocumentResultDto['document']; error?: string }>;
  listDocumentRevisions(channelId: string, documentId: string): Promise<{ ok: boolean; document?: ChannelDocumentRevisionsResultDto['document']; revisions?: ChannelDocumentRevisionsResultDto['revisions']; error?: string }>;
  deriveDocument(channelId: string, sourceArtifactId: string, content: string, filename: string, targetDocumentId?: string, targetBaseRevisionId?: string): Promise<{ ok: boolean; document?: ChannelDocumentResultDto['document']; error?: string; message?: string }>;
  saveDocument(channelId: string, documentId: string, baseRevisionId: string, content: string, filename?: string, idempotencyKey?: string): Promise<{ ok: boolean; document?: ChannelDocumentResultDto['document']; error?: string }>;
  restoreDocument(channelId: string, documentId: string, revisionId: string, baseRevisionId: string, idempotencyKey: string): Promise<{ ok: boolean; document?: ChannelDocumentResultDto['document']; error?: string }>;
  publishDocument(channelId: string, documentId: string, baseRevisionId: string, content: string, filename: string, idempotencyKey: string): Promise<{ ok: boolean; document?: PublishChannelDocumentResultDto['document']; message?: MessageDto; error?: string }>;
}

export function channelEvents(socket: Socket = getWebSocket()): ChannelEvents {
  return {
    join(teamId, channelId, limit) { return emitWithTimeout(socket, WEB_EVENTS.channel.join, { teamId, channelId, limit }); },
    subscribe(teamId) { socket.emit(WEB_EVENTS.channel.subscribe, { teamId }); },
    create(payload) { return emitWithTimeout(socket, WEB_EVENTS.channel.create, payload); },
    update(payload) { return emitWithTimeout(socket, WEB_EVENTS.channel.update, payload); },
    members(channelId, teamId) { return emitWithTimeout(socket, WEB_EVENTS.channel.members, { channelId, ...(teamId ? { teamId } : {}) }); },
    addAgent(channelId, agentId, teamId) { return emitWithTimeout(socket, WEB_EVENTS.channel.addAgent, { channelId, agentId, ...(teamId ? { teamId } : {}) }); },
    addMember(channelId, userId, teamId) { return emitWithTimeout(socket, WEB_EVENTS.channel.addMember, { channelId, memberUserId: userId, ...(teamId ? { teamId } : {}) }); },
    removeAgent(channelId, agentId, teamId) { return emitWithTimeout(socket, WEB_EVENTS.channel.removeAgent, { channelId, agentId, ...(teamId ? { teamId } : {}) }); },
    removeMember(channelId, userId, teamId) { return emitWithTimeout(socket, WEB_EVENTS.channel.removeMember, { channelId, memberUserId: userId, ...(teamId ? { teamId } : {}) }); },
    archive(channelId, teamId, confirmationToken) { return emitWithTimeout(socket, WEB_EVENTS.channel.archive, { channelId, ...(teamId ? { teamId } : {}), ...(confirmationToken ? { confirmationToken } : {}) }); },
    delete(channelId, teamId) { return emitWithTimeout(socket, WEB_EVENTS.channel.delete, { channelId, ...(teamId ? { teamId } : {}) }); },
    searchMessages(query, limit, channelId) {
      return emitWithTimeout(socket, WEB_EVENTS.message.search, { query, limit, ...(channelId ? { channelId } : {}) });
    },
    listFiles(channelId, cursor, pageSize, path, role) {
      return emitWithTimeout(socket, WEB_EVENTS.channelFiles.list, { channelId, ...(cursor ? { cursor } : {}), ...(pageSize ? { pageSize } : {}), ...(path ? { path } : {}), ...(role && role !== 'all' ? { role } : {}) });
    },
    searchFiles(channelId, query, cursor, pageSize, path, role) {
      return emitWithTimeout(socket, WEB_EVENTS.channelFiles.search, { channelId, query, ...(cursor ? { cursor } : {}), ...(pageSize ? { pageSize } : {}), ...(path ? { path } : {}), ...(role && role !== 'all' ? { role } : {}) });
    },
    listDocuments(channelId) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.list, { channelId }); },
    getDocument(channelId, documentId) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.get, { channelId, documentId }); },
    listDocumentRevisions(channelId, documentId) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.revisions, { channelId, documentId }); },
    deriveDocument(channelId, sourceArtifactId, content, filename, targetDocumentId, targetBaseRevisionId) {
      return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.derive, {
        channelId, sourceArtifactId, content, filename,
        ...(targetDocumentId ? { targetDocumentId } : {}),
        ...(targetBaseRevisionId ? { targetBaseRevisionId } : {}),
      });
    },
    saveDocument(channelId, documentId, baseRevisionId, content, filename, idempotencyKey) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.save, { channelId, documentId, baseRevisionId, content, ...(filename ? { filename } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) }); },
    restoreDocument(channelId, documentId, revisionId, baseRevisionId, idempotencyKey) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.restore, { channelId, documentId, revisionId, baseRevisionId, idempotencyKey }); },
    publishDocument(channelId, documentId, baseRevisionId, content, filename, idempotencyKey) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.publish, { channelId, documentId, baseRevisionId, content, filename, idempotencyKey }); },
  };
}

export interface MessageReactionEvents {
  context(messageId: string): Promise<{ ok: boolean; targetMessageId?: string; threadRootId?: string; messages?: ChatMessage[]; error?: string }>;
  react(messageId: string, on: boolean, emoji?: string): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  save(messageId: string, on: boolean): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  listSaved(): Promise<{ ok: boolean; messages?: ChatMessage[]; error?: string }>;
  pin(messageId: string, on: boolean): Promise<{ ok: boolean; messageId?: string; channelId?: string; error?: string }>;
  listPinned(channelId: string): Promise<{ ok: boolean; messages?: ChatMessage[]; error?: string }>;
  edit(messageId: string, body: string, meta?: MessageMetaDto): Promise<{ ok: boolean; message?: ChatMessage; error?: string }>;
  delete(messageId: string): Promise<{ ok: boolean; message?: ChatMessage; error?: string }>;
  convertToTask(messageId: string): Promise<{ ok: boolean; message?: ChatMessage; task?: { id: string; title: string; status: string; channelId?: string | null }; error?: string }>;
}

export function messageReactionEvents(socket: Socket = getWebSocket()): MessageReactionEvents {
  return {
    context(messageId) { return emitWithTimeout(socket, WEB_EVENTS.message.context, { messageId }); },
    react(messageId, on, emoji) { return emitWithTimeout(socket, WEB_EVENTS.message.react, { messageId, on, emoji: emoji || '❤️' }); },
    save(messageId, on) { return emitWithTimeout(socket, WEB_EVENTS.message.save, { messageId, on }); },
    listSaved() { return emitWithTimeout(socket, WEB_EVENTS.message.listSaved, {}); },
    pin(messageId, on) { return emitWithTimeout(socket, WEB_EVENTS.message.pin, { messageId, on }); },
    listPinned(channelId) { return emitWithTimeout(socket, WEB_EVENTS.message.listPinned, { channelId }); },
    edit(messageId, body, meta) { return emitWithTimeout(socket, WEB_EVENTS.message.edit, { messageId, body, ...(meta ? { meta } : {}) }); },
    delete(messageId) { return emitWithTimeout(socket, WEB_EVENTS.message.delete, { messageId }); },
    convertToTask(messageId) { return emitWithTimeout(socket, WEB_EVENTS.message.convertToTask, { messageId }); },
  };
}

export interface DispatchEvents {
  cancelChannel(teamId: string, channelId: string): Promise<{ ok: boolean; dispatches?: Array<{ id: string; channelId: string; messageId: string; status?: import('./schema').DispatchStatus }>; error?: string }>;
}

export function dispatchEvents(socket: Socket = getWebSocket()): DispatchEvents {
  return {
    cancelChannel(teamId, channelId) { return emitWithTimeout(socket, WEB_EVENTS.dispatch.cancelChannel, { teamId, channelId }); },
  };
}

export interface AuthEvents {
  register(payload: { username: string; password: string; email?: string; joinCode?: string; sessionId?: string }): Promise<{ ok: boolean; token?: string; user?: UserInfo; currentTeam?: { id: string; name: string; path: string }; defaultChannel?: { id: string; name: string }; error?: string }>;
  login(payload: { username: string; password: string; joinCode?: string }): Promise<{ ok: boolean; token?: string; user?: UserInfo; currentTeam?: { id: string; name: string; path: string }; error?: string }>;
  whoami(): Promise<{ ok: boolean; user?: UserInfo; currentTeam?: TeamSummary; error?: string }>;
  inviteCreate(payload?: { teamId?: string; purpose?: 'user' | 'device'; profileId?: string }): Promise<{ ok: boolean; invite?: InviteInfo; error?: string }>;
  deviceLogin(payload: { inviteCode: string; username: string; password: string }): Promise<{ ok: boolean; token?: string; deviceToken?: string; teamId?: string; teamPath?: string; userId?: string; username?: string; role?: 'admin' | 'user'; deviceId?: string; error?: string }>;
  changePassword(payload: { currentPassword: string; newPassword: string }): Promise<{ ok: boolean; error?: string }>;
  // 已登录用户直接用现有 token 完成 device invite（不需再输密码），用于让 web 关联本机设备。
  completeDeviceInvite(payload: { code: string }): Promise<{ ok: boolean; invite?: { deviceId?: string }; credentials?: { token?: string; deviceId?: string; machineId?: string }; team?: { id: string; name: string; path: string }; error?: string }>;
}

export function authEvents(socket: Socket = getWebSocket()): AuthEvents {
  return {
    register(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.auth.register, payload, 20000);
    },
    login(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.auth.login, payload, 20000);
    },
    whoami() {
      return emitWithTimeout(socket, WEB_EVENTS.auth.whoami, { token: getStoredAuthToken(), deviceToken: getStoredDeviceToken() });
    },
    inviteCreate(payload = {}) {
      const { teamId, ...rest } = payload;
      const resolvedTeamId = teamId && teamId !== 'default' ? teamId : undefined;
      return emitWithTimeout(socket, WEB_EVENTS.deviceInvite.create, {
        ...rest,
        ...(resolvedTeamId ? { teamId: resolvedTeamId } : {}),
      });
    },
    async deviceLogin({ inviteCode, username, password }) {
      const login = await emitWithTimeout(socket, WEB_EVENTS.auth.login, { username, password }, 20000);
      if (!login?.ok || !login.token || !login.user?.id) {
        return { ok: false, error: login?.error ?? 'LOGIN_FAILED' };
      }
      const complete = await emitWithTimeout(socket, WEB_EVENTS.deviceInvite.complete, { code: inviteCode, userId: login.user.id }, 20000);
      if (!complete?.ok) {
        return { ok: false, error: complete?.error ?? 'INVITE_COMPLETE_FAILED' };
      }
      const team = complete.team ?? login.currentTeam;
      const credentials = complete.credentials ?? {};
      return {
        ok: true,
        token: login.token,
        deviceToken: credentials.token,
        teamId: team?.id ?? credentials.teamId,
        teamPath: team?.path ?? team?.id ?? credentials.teamId,
        userId: login.user.id,
        username: login.user.username,
        role: login.user.role,
        deviceId: resolveDeviceLoginDeviceId(complete),
      };
    },
    changePassword(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.auth.changePassword, payload);
    },
    completeDeviceInvite(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.deviceInvite.complete, payload, 20000);
    },
  };
}

export interface JoinEvents {
  create(payload: { teamId?: string; maxUses?: number; expiresAt?: number }): Promise<{ ok: boolean; link?: import('./schema').JoinLinkInfo; error?: string; message?: string }>;
  list(payload?: { teamId?: string }): Promise<{ ok: boolean; links?: import('./schema').JoinLinkInfo[]; error?: string; message?: string }>;
  revoke(payload: { teamId?: string; code: string }): Promise<{ ok: boolean; error?: string; message?: string }>;
  validate(payload: { code: string }): Promise<{ ok: boolean; link?: JoinLinkDto; team?: TeamDto; error?: string; message?: string }>;
}

// server 的 JoinLinkDto 只返回 code，不含 url；前端按 /join/[code] 路由构造完整邀请链接
function joinLinkUrl(code: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/join/${code}`;
}

export function joinEvents(socket: Socket = getWebSocket()): JoinEvents {
  return {
    create(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.join.create, payload).then((res) => {
        if (res?.ok && res.link && !res.link.url) {
          res.link.url = joinLinkUrl(res.link.code);
        }
        return res;
      });
    },
    list(payload = {}) {
      return emitWithTimeout(socket, WEB_EVENTS.join.list, payload).then((res) => {
        if (res?.ok && Array.isArray(res.links)) {
          for (const link of res.links) {
            if (link && !link.url) {
              link.url = joinLinkUrl(link.code);
            }
          }
        }
        return res;
      });
    },
    revoke(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.join.revoke, payload);
    },
    validate(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.join.validate, payload);
    },
  };
}

export interface DeviceAgent {
  id: string;
  name: string;
  adapterKind: string;
  category: string;
  source: string;
  command: string | null;
  args: string | null;
  cwd: string | null;
  description: string | null;
  deviceId: string;
  status: string;
  primaryTeamId: string;
  visibleTeamIds: string[];
}

export interface DeviceRuntime {
  name: string;
  adapterKind: string;
  command: string;
  installed: boolean;
}

export interface DeviceEvents {
  list(teamId?: string): Promise<{ ok: boolean; devices?: DeviceInfo[]; error?: string }>;
  get(payload: { id: string }): Promise<{ ok: boolean; device?: any; error?: string }>;
  agentsList(deviceId: string, teamId?: string | null): Promise<{ ok: boolean; agents?: DeviceAgent[]; runtimes?: DeviceRuntime[]; error?: string }>;
  scan(deviceId: string): Promise<{ ok: boolean; error?: string }>;
  selectDirectory(deviceId: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  listDirectory(deviceId: string, path: string): Promise<{ ok: boolean; entries?: Array<{ name: string; isDir: boolean }>; homePath?: string; error?: string; truncated?: boolean }>;
  /**
   * #1084 切片3：读本机 .agentbean snapshots 副本字节（频道文件预览/下载本机优先）。
   * 失败/离线/越界由调用方静默回退 server artifact download URL。
   */
  readFile(deviceId: string, teamId: string, channelId: string, revisionId: string, path: string): Promise<{
    ok: boolean;
    contentBase64?: string;
    sizeBytes?: number;
    sha256?: string;
    error?: string;
  }>;
  scanDescriptor(deviceId: string, cwd: string, adapterKind: string): Promise<{
    ok: boolean;
    descriptor?: {
      name: string | null;
      description: string | null;
      capabilities: string[];
      capabilitiesSummarized: string[];
      rawContent: string | null;
      contentHash: string | null;
      sourcePath: string | null;
    } | null;
    skills?: { name: string; description: string; scope: string; sourcePath: string; adapterKind: string }[];
    error?: string;
  }>;
  delete(id: string): Promise<{ ok: boolean; error?: string }>;
  rename(id: string, name: string): Promise<{ ok: boolean; device?: DeviceInfo; error?: string }>;
  onSnapshot(handler: (devices: DeviceInfo[]) => void): () => void;
  onStatus(handler: (device: DeviceInfo) => void): () => void;
  subscribe(teamId: string): void;
}

export function deviceEvents(socket: Socket = getWebSocket()): DeviceEvents {
  return {
    list(teamId) {
      return emitWithTimeout(socket, WEB_EVENTS.device.list, teamId ? { teamId } : {});
    },
    get({ id }) {
      return emitWithTimeout(socket, WEB_EVENTS.device.get, { id, deviceId: id });
    },
    agentsList(deviceId, teamId) {
      return emitWithTimeout(socket, WEB_EVENTS.device.agentsList, teamId ? { deviceId, teamId } : { deviceId });
    },
    scan(deviceId) {
      return emitWithTimeout(socket, WEB_EVENTS.device.scan, { deviceId });
    },
    selectDirectory(deviceId) {
      return emitWithTimeout(socket, WEB_EVENTS.device.selectDirectory, { deviceId }, 125000);
    },
    listDirectory(deviceId, path) {
      return emitWithTimeout(socket, WEB_EVENTS.device.listDirectory, { deviceId, path }, 15000);
    },
    readFile(deviceId, teamId, channelId, revisionId, path) {
      return emitWithTimeout(socket, WEB_EVENTS.device.readFile, { deviceId, teamId, channelId, revisionId, path }, 20000);
    },
    scanDescriptor(deviceId, cwd, adapterKind) {
      return emitWithTimeout(socket, WEB_EVENTS.device.scanDescriptor, { deviceId, cwd, adapterKind }, 20000);
    },
    delete(id) {
      return emitWithTimeout(socket, WEB_EVENTS.device.delete, { id, deviceId: id });
    },
    rename(id, name) {
      return emitWithTimeout(socket, WEB_EVENTS.device.rename, { id, deviceId: id, name });
    },
    onSnapshot(handler) {
      socket.on(WEB_EVENTS.device.snapshot, handler);
      return () => { socket.off(WEB_EVENTS.device.snapshot, handler); };
    },
    onStatus(handler) {
      socket.on(WEB_EVENTS.device.status, handler);
      return () => { socket.off(WEB_EVENTS.device.status, handler); };
    },
    subscribe(teamId) { socket.emit(WEB_EVENTS.device.list, { teamId }); },
  };
}

export interface TaskEvents {
  create(payload: { title: string; description?: string; status?: string; assigneeId?: string; channelId?: string; tags?: string[] }): Promise<{ ok: boolean; task?: any; error?: string }>;
  list(channelId?: string): Promise<{ ok: boolean; tasks?: any[]; error?: string }>;
  getDag(rootTaskId: string): Promise<{ ok: boolean; dag?: TaskDagViewDto; error?: string }>;
  channelWorkspace(channelId: string): Promise<{
    ok: boolean;
    workspace?: ChannelTaskWorkspaceV1;
    error?: string;
    message?: string;
  }>;
  update(payload: { id: string; title?: string; description?: string; status?: string; assigneeId?: string | null; channelId?: string | null; tags?: string[]; sortOrder?: number }): Promise<{ ok: boolean; task?: any; error?: string }>;
  delete(id: string): Promise<{ ok: boolean; error?: string }>;
  reorder(id: string, sortOrder: number): Promise<{ ok: boolean; error?: string }>;
  cancel(id: string, reason: string): Promise<{ ok: boolean; task?: any; error?: string }>;
  close(id: string, reason: string): Promise<{ ok: boolean; task?: any; error?: string }>;
  createContinuation(
    payload: PromotionGateCommandInputMapV1['create-task-continuation'],
    idempotencyKey: string,
  ): Promise<{ ok: boolean; response?: PromotionGateCommandResponseV1; error?: string }>;
  /** #995 根交付人审 accept。 */
  acceptRootDelivery(payload: {
    taskId: string;
    deliveryMessageId?: string;
    expectedTaskRevision?: number;
  }): Promise<{ ok: boolean; task?: any; error?: string }>;
  /** #995 根交付人审 reject。 */
  rejectRootDelivery(payload: {
    taskId: string;
    reason: string;
    expectedTaskRevision?: number;
  }): Promise<{ ok: boolean; task?: any; error?: string }>;
  onSnapshot(handler: (tasks: any[]) => void): () => void;
}

export function taskEvents(socket: Socket = getWebSocket()): TaskEvents {
  return {
    create(payload) { return emitWithTimeout(socket, WEB_EVENTS.task.create, payload); },
    list(channelId) { return emitWithTimeout(socket, WEB_EVENTS.task.list, { channelId }); },
    getDag(rootTaskId) { return emitWithTimeout(socket, WEB_EVENTS.task.dag, { rootTaskId }); },
    channelWorkspace(channelId) {
      return emitWithTimeout(socket, WEB_EVENTS.task.channelWorkspace, { channelId });
    },
    update({ id, ...rest }) { return emitWithTimeout(socket, WEB_EVENTS.task.update, { taskId: id, ...rest }); },
    delete(id) { return emitWithTimeout(socket, WEB_EVENTS.task.delete, { taskId: id }); },
    reorder(id, sortOrder) { return emitWithTimeout(socket, WEB_EVENTS.task.reorder, { taskId: id, sortOrder }); },
    cancel(id, reason) { return emitWithTimeout(socket, WEB_EVENTS.task.cancel, { taskId: id, reason }); },
    close(id, reason) { return emitWithTimeout(socket, WEB_EVENTS.task.close, { taskId: id, reason }); },
    createContinuation(payload, idempotencyKey) {
      return emitWithTimeout(socket, WEB_EVENTS.promotion.command, {
        envelope: {
          schemaVersion: 1,
          commandName: 'create-task-continuation',
          commandSchemaVersion: 1,
          idempotencyKey,
        },
        payload,
      });
    },
    acceptRootDelivery(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.task.acceptRootDelivery, payload);
    },
    rejectRootDelivery(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.task.rejectRootDelivery, payload);
    },
    onSnapshot(handler) {
      socket.on(WEB_EVENTS.task.snapshot, handler);
      return () => { socket.off(WEB_EVENTS.task.snapshot, handler); };
    },
  };
}

/** #998 System activity query/command 客户端入口。 */
export function notificationEvents(socket: Socket = getWebSocket()) {
  return {
    pushConfig() {
      return emitWithTimeout(socket, WEB_EVENTS.notifications.pushConfig, {}) as Promise<{ ok: boolean; publicKey?: string | null }>;
    },
    pushSubscribe(input: { subscription: PushSubscriptionJSON }) {
      return emitWithTimeout(socket, WEB_EVENTS.notifications.pushSubscribe, input) as Promise<{ ok: boolean; error?: string }>;
    },
    pushUnsubscribe(input: { endpoint: string }) {
      return emitWithTimeout(socket, WEB_EVENTS.notifications.pushUnsubscribe, input) as Promise<{ ok: boolean; error?: string }>;
    },
    list(input: { teamId: string; cursor?: import('@agentbean/contracts').CompletionNotificationCursor }) {
      return emitWithTimeout(socket, WEB_EVENTS.notifications.list, input) as Promise<{
        ok: boolean; items?: import('@agentbean/contracts').CompletionNotificationDto[]; unreadCount?: number; error?: string;
        nextCursor?: import('@agentbean/contracts').CompletionNotificationCursor | null;
      }>;
    },
    markRead(input: { teamId: string; id: string }) {
      return emitWithTimeout(socket, WEB_EVENTS.notifications.markRead, input) as Promise<{ ok: boolean; error?: string }>;
    },
    onChanged(handler: (wake: import('@agentbean/contracts').CompletionNotificationWake) => void) {
      socket.on(WEB_EVENTS.notifications.changed, handler);
      return () => { socket.off(WEB_EVENTS.notifications.changed, handler); };
    },
  };
}

export function systemActivityEvents(socket: Socket = getWebSocket()) {
  return {
    query(input: { queryName: string; payload: unknown; userId: string; teamId: string }) {
      return emitWithTimeout(socket, WEB_EVENTS.systemActivity.query, input);
    },
    command(input: { envelope: unknown; payload: unknown; userId: string; teamId: string }) {
      return emitWithTimeout(socket, WEB_EVENTS.systemActivity.command, input);
    },
    onNotice(handler: (payload: unknown) => void) {
      socket.on(WEB_EVENTS.systemActivity.notice, handler);
      return () => { socket.off(WEB_EVENTS.systemActivity.notice, handler); };
    },
  };
}

/** #1014 Task remediation 具名 command 客户端入口。 */
export function taskRemediationEvents(socket: Socket = getWebSocket()) {
  return {
    command(input: { envelope: unknown; payload: unknown; userId: string; teamId: string }) {
      return emitWithTimeout(socket, WEB_EVENTS.taskRemediation.command, input);
    },
  };
}

export interface ProjectMutationResult {
  ok: boolean;
  overview?: ChannelProjectOverviewDto;
  replayed?: boolean;
  error?: string;
  message?: string;
}

export interface ProjectEvents {
  overview(channelId: string): Promise<{ ok: boolean; overview?: ChannelProjectOverviewDto | null; error?: string; message?: string }>;
  /** #966 读取 Project Channel Workspace 当前或指定 revision 的文件清单 + provenance。 */
  workspace(channelId: string, revisionId?: string): Promise<{ ok: boolean; workspace?: ProjectChannelWorkspaceDto | null; error?: string; message?: string }>;
  /** #966 原子发布：以基线 revision 为依据整体创建下一 workspace revision。 */
  publishWorkspace(payload: { channelId: string; baselineRevisionId: string; files: Array<{ path: string; artifactId: string }> }): Promise<{ ok: boolean; workspace?: ProjectChannelWorkspaceDto | null; error?: string; message?: string; details?: Record<string, unknown> }>;
  createInitialStage(payload: Omit<CreateInitialProjectStageInput, 'userId' | 'teamId'>): Promise<ProjectMutationResult>;
  createStage(payload: Omit<CreateProjectStageInput, 'userId' | 'teamId'>): Promise<ProjectMutationResult>;
  createStageEdge(payload: Omit<CreateProjectStageEdgeInput, 'userId' | 'teamId'>): Promise<ProjectMutationResult>;
  deleteStageEdge(payload: Omit<DeleteProjectStageEdgeInput, 'userId' | 'teamId'>): Promise<ProjectMutationResult>;
  onUpdated(channelId: string, handler: (overview: ChannelProjectOverviewDto | null) => void): () => void;
  /** #823 按逻辑产物读取当前版、历史、来源与 lineage。 */
  artifactCollections(channelId: string): Promise<{
    ok: boolean;
    library?: ProjectArtifactLibraryDto;
    error?: string;
    message?: string;
  }>;
  promoteArtifact(payload: Omit<PromoteArtifactToProjectVersionInput, 'userId' | 'teamId'>): Promise<{
    ok: boolean;
    library?: ProjectArtifactLibraryDto;
    collection?: ProjectArtifactCollectionDto;
    version?: ProjectArtifactVersionDto;
    replayed?: boolean;
    error?: string;
    message?: string;
  }>;
  submitArtifactReview(payload: Omit<SubmitProjectArtifactReviewInput, 'userId' | 'teamId'>): Promise<{
    ok: boolean;
    library?: ProjectArtifactLibraryDto;
    review?: ProjectArtifactReviewDto;
    replayed?: boolean;
    error?: string;
    message?: string;
  }>;
  setArtifactFinalVersion(payload: Omit<SetProjectArtifactFinalVersionInput, 'userId' | 'teamId' | 'manager'>): Promise<{
    ok: boolean;
    library?: ProjectArtifactLibraryDto;
    finalization?: ProjectArtifactFinalizationDto;
    replayed?: boolean;
    error?: string;
    message?: string;
  }>;
  onArtifactsUpdated(channelId: string, handler: (library: ProjectArtifactLibraryDto | null) => void): () => void;
  /** #1060 列出频道 OutputPackage(含 pendingDeliveries「交付处理中」)。 */
  listOutputPackages(payload: { channelId: string; taskId?: string; limit?: number }): Promise<{
    ok: boolean;
    packages?: OutputPackageSummaryDto[];
    pendingDeliveries?: OutputPackagePendingDeliveryDto[];
    nextCursor?: { createdAt: number; packageId: string };
    error?: string;
    message?: string;
  }>;
  /** #1060 获取单个 OutputPackage(含冻结成员);#1063 支持 projection 请求。 */
  getOutputPackage(payload: {
    channelId: string;
    packageId: string;
    projection?: { policy: 'delivered' | 'current' | 'final' | 'specified'; versions?: { collectionId: string; versionId: string }[] };
  }): Promise<{
    ok: boolean;
    package?: OutputPackageDto;
    /** Server 从 package 卡片/provenance 解析的原讨论串 root。 */
    threadRootMessageId?: string;
    /** #1061 AC11:Server 按当前用户计算的可执行动作(web 只渲染 Server 给的动作)。 */
    availableActions?: PackageMemberAvailableActionsDto[];
    /** #1063 请求携带 projection 时返回解析结果块。 */
    projection?: OutputPackageProjectionResultV1;
    asOf?: number;
    audienceScope?: string;
    error?: string;
    message?: string;
  }>;
  /** #1065 AC3/AC4：Task 交付聚合视图(目标/acceptance/焦点/availableActions/时间线)。 */
  queryTaskDeliveryOverview(payload: { channelId: string; taskId: string }): Promise<{
    ok: boolean;
    overview?: TaskDeliveryOverviewV1;
    error?: string;
    message?: string;
  }>;
  /** #1176：只在阶段详情打开时读取一次完整交付审核工作区。 */
  queryStageDeliveryReviewWorkspace(payload: {
    schemaVersion: 1;
    channelId: string;
    stageId: string;
    taskId: string;
    minimumConsistency?: ConsistencyTokenV1;
  }): Promise<{
    ok: boolean;
    workspace?: StageDeliveryReviewWorkspaceV1;
    error?: string;
    message?: string;
  }>;
  /** #1061 AC1:对 package 成员版本提交审核(approved/changes_requested/rejected)。 */
  submitPackageArtifactReview(payload: Omit<PackageReviewCommandSocketPayload, 'userId' | 'teamId'>): Promise<{
    ok: boolean;
    review?: PackageReviewDto;
    revision?: ArtifactVersionRevisionSaveResultDto;
    replayed?: boolean;
    error?: string;
    message?: string;
    revisionConflict?: ArtifactRevisionConflictDto;
  }>;
  /** #1199 全有或全无的批量逐文件审核。 */
  submitPackageArtifactReviews(payload: PackageBatchReviewCommandSocketPayload): Promise<{
    ok: boolean;
    reviews?: readonly PackageReviewDto[];
    replayed?: boolean;
    details?: {
      rejectedTargets?: readonly { collectionId?: string; artifactVersionId?: string; reason: string }[];
    };
    error?: string;
    message?: string;
  }>;
  /** #1061 AC9:"通过并设为最终版"(一个事务两个独立事实)。 */
  submitPackageReviewAndFinalize(payload: Omit<PackageReviewCommandSocketPayload, 'userId' | 'teamId'>): Promise<{
    ok: boolean;
    review?: PackageReviewDto;
    finalization?: ProjectArtifactFinalizationDto;
    collection?: ProjectArtifactCollectionDto;
    revision?: ArtifactVersionRevisionSaveResultDto;
    replayed?: boolean;
    error?: string;
    message?: string;
    revisionConflict?: ArtifactRevisionConflictDto;
  }>;
  /** #1061 AC6:审核(changes_requested/rejected)与退回 Task delivery 原子提交。 */
  submitPackageReviewAndRejectDelivery(payload: Omit<PackageReviewCommandSocketPayload, 'userId' | 'teamId'>): Promise<{
    ok: boolean;
    review?: PackageReviewDto;
    task?: { taskId: string; taskRevision: number; taskAttempt: number; status: string };
    replayed?: boolean;
    error?: string;
    message?: string;
  }>;
  /** #1062 基于明确版本保存 Markdown 修订(stale → error CONFLICT + details.revisionConflict)。 */
  saveArtifactVersionRevision(payload: {
    channelId: string;
    collectionId: string;
    baseVersionId: string;
    content: string;
    filename?: string;
    expectedCollectionRevision: number;
    revisionBasis: {
      sourceVersionId: string;
      basisReviewId?: string;
      packageId?: string;
      deliveryId?: string;
    };
    idempotencyKey: string;
  }): Promise<{
    ok: boolean;
    revision?: ArtifactVersionRevisionSaveResultDto;
    replayed?: boolean;
    error?: string;
    message?: string;
    revisionConflict?: ArtifactRevisionConflictDto;
  }>;
  /** #825 按一次 Agent 输出读取固定成员的 Markdown 文档包。 */
  documentBundles(channelId: string): Promise<{
    ok: boolean;
    bundles?: ProjectDocumentBundleDto[];
    archived?: boolean;
    error?: string;
    message?: string;
  }>;
  documentBundle(payload: { channelId: string; bundleId: string }): Promise<{
    ok: boolean;
    bundle?: ProjectDocumentBundleDetailDto;
    archived?: boolean;
    error?: string;
    message?: string;
  }>;
  createDocumentBundle(payload: Omit<CreateProjectDocumentBundleInput, 'userId' | 'teamId'>): Promise<{
    ok: boolean;
    bundle?: ProjectDocumentBundleDetailDto;
    replayed?: boolean;
    error?: string;
    message?: string;
  }>;
  onDocumentBundlesUpdated(
    channelId: string,
    handler: (bundles: ProjectDocumentBundleDto[]) => void,
  ): () => void;
}

export function projectEvents(socket: Socket = getWebSocket()): ProjectEvents {
  return {
    overview(channelId) {
      return emitWithTimeout(socket, WEB_EVENTS.project.overview, { channelId });
    },
    workspace(channelId, revisionId?) {
      return emitWithTimeout(socket, WEB_EVENTS.project.workspace, { channelId, ...(revisionId ? { revisionId } : {}) });
    },
    publishWorkspace(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.publishWorkspace, payload);
    },
    createInitialStage(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.createInitialStage, payload);
    },
    createStage(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.createStage, payload);
    },
    createStageEdge(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.createStageEdge, payload);
    },
    deleteStageEdge(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.deleteStageEdge, payload);
    },
    onUpdated(channelId, handler) {
      const listener = (payload: { channelId?: string; overview?: ChannelProjectOverviewDto | null }) => {
        if (payload.channelId === channelId) handler(payload.overview ?? null);
      };
      socket.on(WEB_EVENTS.project.updated, listener);
      return () => { socket.off(WEB_EVENTS.project.updated, listener); };
    },
    artifactCollections(channelId) {
      return emitWithTimeout(socket, WEB_EVENTS.project.artifactCollections, { channelId });
    },
    promoteArtifact(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.promoteArtifact, payload);
    },
    submitArtifactReview(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.submitArtifactReview, payload);
    },
    setArtifactFinalVersion(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.setArtifactFinalVersion, payload);
    },
    onArtifactsUpdated(channelId, handler) {
      const listener = (payload: { channelId?: string; library?: ProjectArtifactLibraryDto | null }) => {
        if (payload.channelId === channelId) handler(payload.library ?? null);
      };
      socket.on(WEB_EVENTS.project.artifactsUpdated, listener);
      return () => { socket.off(WEB_EVENTS.project.artifactsUpdated, listener); };
    },
    listOutputPackages(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.listOutputPackages, payload);
    },
    getOutputPackage(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.getOutputPackage, payload);
    },
    queryTaskDeliveryOverview(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.task.deliveryOverview, payload);
    },
    queryStageDeliveryReviewWorkspace(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.task.stageDeliveryReviewWorkspace, payload);
    },
    submitPackageArtifactReview(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.submitPackageArtifactReview, payload);
    },
    submitPackageArtifactReviews(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.submitPackageArtifactReviews, payload);
    },
    submitPackageReviewAndFinalize(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.submitPackageReviewAndFinalize, payload);
    },
    submitPackageReviewAndRejectDelivery(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.submitPackageReviewAndRejectDelivery, payload);
    },
    saveArtifactVersionRevision(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.saveArtifactVersionRevision, payload);
    },
    documentBundles(channelId) {
      return emitWithTimeout(socket, WEB_EVENTS.project.documentBundles, { channelId });
    },
    documentBundle(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.documentBundle, payload);
    },
    createDocumentBundle(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.project.createDocumentBundle, payload);
    },
    onDocumentBundlesUpdated(channelId, handler) {
      const listener = (payload: { channelId?: string; bundles?: ProjectDocumentBundleDto[] }) => {
        if (payload.channelId === channelId) handler(payload.bundles ?? []);
      };
      socket.on(WEB_EVENTS.project.documentBundlesUpdated, listener);
      return () => { socket.off(WEB_EVENTS.project.documentBundlesUpdated, listener); };
    },
  };
}

export interface MemberEvents {
  list(payload?: { teamId?: string }): Promise<{ ok: boolean; humans?: { userId: string; role: string; username: string; email?: string | null; description?: string | null; joinedAt?: number; createdAt?: number }[]; agents?: import('./schema').AgentSnapshot[]; error?: string }>;
  updateHuman(payload: { userId: string; teamId?: string; description?: string | null }): Promise<{ ok: boolean; human?: { userId: string; role: string; username: string; email?: string | null; description?: string | null; joinedAt?: number; createdAt?: number }; error?: string }>;
  updateRole(payload: { targetUserId: string; teamId?: string; role: 'owner' | 'admin' | 'member' }): Promise<{ ok: boolean; member?: { id: string; teamId: string; userId: string; username: string; role: string }; error?: string }>;
  remove(payload: { targetUserId: string; teamId?: string }): Promise<{ ok: boolean; userId?: string; error?: string }>;
  transferOwner(payload: { targetUserId: string; teamId?: string }): Promise<{ ok: boolean; team?: { id: string; name: string }; member?: { id: string; teamId: string; userId: string; username: string; role: string }; error?: string }>;
}

export function memberEvents(socket: Socket = getWebSocket()): MemberEvents {
  return {
    list(payload = {}) {
      return emitWithTimeout(socket, WEB_EVENTS.member.list, payload);
    },
    updateHuman({ userId, ...rest }) {
      return emitWithTimeout(socket, WEB_EVENTS.member.updateHuman, { targetUserId: userId, ...rest });
    },
    updateRole(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.member.updateRole, payload);
    },
    remove(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.member.remove, payload);
    },
    transferOwner(payload) {
      return emitWithTimeout(socket, WEB_EVENTS.member.transferOwner, payload);
    },
  };
}

export interface MemoryEvents {
  snapshot(teamId: string): Promise<{ ok: boolean; snapshot?: MemoryGovernanceSnapshotDto; error?: string; message?: string }>;
  create(payload: { teamId: string; kind: MemoryKind; scopeType: MemoryScopeType; scopeRef: string; content: string; summary?: string; tags?: readonly string[]; validUntil?: number; asCandidate?: boolean }): Promise<{ ok: boolean; error?: string; message?: string }>;
  update(payload: { teamId: string; memoryId: string; expectedUpdatedAt: number; content?: string; summary?: string; tags?: readonly string[]; validUntil?: number }): Promise<{ ok: boolean; error?: string; message?: string }>;
  expire(teamId: string, memoryId: string): Promise<{ ok: boolean; error?: string; message?: string }>;
  supersede(payload: { teamId: string; memoryId: string; content: string; summary?: string; tags?: readonly string[] }): Promise<{ ok: boolean; error?: string; message?: string }>;
  delete(teamId: string, memoryId: string): Promise<{ ok: boolean; error?: string; message?: string }>;
  issueGrant(payload: { teamId: string; grantId?: string; sourceScopeType: MemoryScopeType; sourceScopeRef: string; targetAgentId: string; authorizedContentKind: MemoryContentKind; authorizedRedactionLevel: MemoryRedactionLevel; expiresAt: number }): Promise<{ ok: boolean; error?: string; message?: string }>;
  revokeGrant(teamId: string, grantId: string): Promise<{ ok: boolean; error?: string; message?: string }>;
  acceptCandidate(payload: { teamId: string; candidateId: string; kind: MemoryKind; summary?: string; tags?: readonly string[]; validUntil?: number }): Promise<{ ok: boolean; error?: string; message?: string }>;
  rejectCandidate(teamId: string, candidateId: string): Promise<{ ok: boolean; error?: string; message?: string }>;
  mergeCandidate(teamId: string, candidateId: string, conflictMemoryId: string): Promise<{ ok: boolean; error?: string; message?: string }>;
  localSummaries(teamId: string): Promise<{ ok: boolean; summaries?: readonly LocalMemoryGovernanceSummaryDto[]; error?: string }>;
  // Formal Memory Center (issue #716)
  formalList(payload: { teamId: string; scopeType: FormalMemoryScopeType; scopeRef: string }): Promise<{ ok: boolean; list?: FormalMemoryListDto; error?: string; message?: string }>;
  formalDetail(payload: { teamId: string; memoryId: string }): Promise<{ ok: boolean; memory?: FormalMemoryDetailDto; error?: string; message?: string }>;
  formalCreate(payload: { teamId: string; kind: FormalMemoryKind; scopeType: FormalMemoryScopeType; scopeRef: string; content: string; summary?: string; tags?: readonly string[]; changeReason?: string; validUntil?: number }): Promise<{ ok: boolean; memory?: FormalMemoryDto; error?: string; message?: string }>;
  formalRevise(payload: { teamId: string; memoryId: string; content: string; summary?: string; tags?: readonly string[]; changeReason: string }): Promise<{ ok: boolean; memory?: FormalMemoryDto; error?: string; message?: string }>;
  formalDeactivate(payload: { teamId: string; memoryId: string; changeReason: string }): Promise<{ ok: boolean; memory?: FormalMemoryDto; error?: string; message?: string }>;
  formalDelete(payload: { teamId: string; memoryId: string; changeReason?: string }): Promise<{ ok: boolean; memory?: FormalMemoryDto; error?: string; message?: string }>;
  proposeCorrection(payload: { teamId: string; scopeType: FormalMemoryScopeType; scopeRef: string; targetMemoryId?: string; correctionType: FormalCorrectionType; kind?: FormalMemoryKind; content: string; summary?: string; reason: string }): Promise<{ ok: boolean; memory?: FormalMemoryDto; error?: string; message?: string }>;
  formalAccept(payload: { teamId: string; memoryId: string }): Promise<{ ok: boolean; memory?: FormalMemoryDto; error?: string; message?: string }>;
  formalReject(payload: { teamId: string; memoryId: string; changeReason?: string }): Promise<{ ok: boolean; memory?: FormalMemoryDto; error?: string; message?: string }>;
  onChanged(handler: (payload: { teamId: string }) => void): () => void;
}

export function memoryEvents(socket: Socket = getWebSocket()): MemoryEvents {
  return {
    snapshot(teamId) { return emitWithTimeout(socket, WEB_EVENTS.memory.snapshot, { teamId }); },
    create(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.create, payload); },
    update(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.update, payload); },
    expire(teamId, memoryId) { return emitWithTimeout(socket, WEB_EVENTS.memory.expire, { teamId, memoryId }); },
    supersede(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.supersede, payload); },
    delete(teamId, memoryId) { return emitWithTimeout(socket, WEB_EVENTS.memory.delete, { teamId, memoryId }); },
    issueGrant(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.grantIssue, payload); },
    revokeGrant(teamId, grantId) { return emitWithTimeout(socket, WEB_EVENTS.memory.grantRevoke, { teamId, grantId }); },
    acceptCandidate(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.candidateAccept, payload); },
    rejectCandidate(teamId, candidateId) { return emitWithTimeout(socket, WEB_EVENTS.memory.candidateReject, { teamId, candidateId }); },
    mergeCandidate(teamId, candidateId, conflictMemoryId) { return emitWithTimeout(socket, WEB_EVENTS.memory.candidateMerge, { teamId, candidateId, conflictMemoryId }); },
    localSummaries(teamId) { return emitWithTimeout(socket, WEB_EVENTS.memory.localSummary, { teamId }); },
    formalList(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.formalList, payload); },
    formalDetail(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.formalDetail, payload); },
    formalCreate(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.formalCreate, payload); },
    formalRevise(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.formalRevise, payload); },
    formalDeactivate(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.formalDeactivate, payload); },
    formalDelete(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.formalDelete, payload); },
    proposeCorrection(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.proposeCorrection, payload); },
    formalAccept(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.formalAccept, payload); },
    formalReject(payload) { return emitWithTimeout(socket, WEB_EVENTS.memory.formalReject, payload); },
    onChanged(handler) {
      socket.on(WEB_EVENTS.memory.changed, handler);
      return () => { socket.off(WEB_EVENTS.memory.changed, handler); };
    },
  };
}

/** #722/#723 Experience Pack socket 客户端：list/CRUD/频道 attachment。 */
export function experiencePackEvents(socket: Socket = getWebSocket()) {
  return {
    listByTeam(teamId: string): Promise<{ ok: boolean; packs?: ExperiencePackDto[]; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.listByTeam, { teamId });
    },
    getById(teamId: string, packId: string): Promise<{ ok: boolean; pack?: ExperiencePackDto; attachments?: ChannelExperienceAttachmentDto[]; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.getById, { teamId, packId });
    },
    createDraft(payload: {
      teamId: string; actorId: string; title: string; summary?: string;
      sourceChannelId: string; applicabilityConditions?: string;
      exclusionConditions?: string; conclusions?: string; limitations?: string;
      sources?: readonly { sourceKind: string; sourceId: string; snapshotHash: string; sourceScopeType: string; sourceScopeRef: string }[];
    }): Promise<{ ok: boolean; pack?: ExperiencePackDto; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.createDraft, payload);
    },
    approve(teamId: string, actorId: string, packId: string): Promise<{ ok: boolean; pack?: ExperiencePackDto; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.approve, { teamId, actorId, packId });
    },
    withdraw(teamId: string, actorId: string, packId: string): Promise<{ ok: boolean; pack?: ExperiencePackDto; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.withdraw, { teamId, actorId, packId });
    },
    markSourceInvalid(teamId: string, actorId: string, packId: string, reason: string): Promise<{ ok: boolean; pack?: ExperiencePackDto; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.markSourceInvalid, { teamId, actorId, packId, reason });
    },
    recommendToChannel(teamId: string, actorId: string, packId: string, channelId: string): Promise<{ ok: boolean; attachment?: ChannelExperienceAttachmentDto; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.recommendToChannel, { teamId, actorId, packId, channelId });
    },
    confirmAttachment(teamId: string, actorId: string, packId: string, channelId: string): Promise<{ ok: boolean; attachment?: ChannelExperienceAttachmentDto; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.confirmAttachment, { teamId, actorId, packId, channelId });
    },
    revokeAttachment(teamId: string, actorId: string, packId: string, channelId: string): Promise<{ ok: boolean; attachment?: ChannelExperienceAttachmentDto; error?: string }> {
      return emitWithTimeout(socket, WEB_EVENTS.experiencePack.revokeAttachment, { teamId, actorId, packId, channelId });
    },
  };
}

export interface DmChannel { id: string; name: string; dmTargetId: string; createdAt: number; }

export interface DmEvents {
  start(agentId: string): Promise<{ ok: boolean; dm?: DmChannel; error?: string }>;
  list(): Promise<{ ok: boolean; dms?: DmChannel[]; error?: string }>;
  onSnapshot(handler: (dms: DmChannel[]) => void): () => void;
}

export function dmEvents(socket: Socket = getWebSocket()): DmEvents {
  return {
    start(agentId) { return emitWithTimeout(socket, WEB_EVENTS.dm.start, { agentId }); },
    list() { return emitWithTimeout(socket, WEB_EVENTS.dm.list, {}); },
    onSnapshot(handler) {
      socket.on(WEB_EVENTS.dm.snapshot, handler);
      return () => { socket.off(WEB_EVENTS.dm.snapshot, handler); };
    },
  };
}
