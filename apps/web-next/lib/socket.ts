'use client';
import { WEB_EVENTS, type ActivePiModelDto, type AgentExposureActiveProjectionDto, type AgentExposureManifestRevisionDto, type AgentExposureRestrictionDto, type AgentMemoryProjectionConsumptionDto, type AgentMemoryProjectionDto, type AgentTeamCoverageDto, type ChannelFilesResultDto, type CopyPiProviderCardInput, type CreatePiProviderCardInput, type FormalCorrectionType, type FormalMemoryDetailDto, type FormalMemoryDto, type FormalMemoryKind, type FormalMemoryListDto, type FormalMemoryScopeType, type JoinLinkDto, type LocalMemoryGovernanceSummaryDto, type MemoryContentKind, type MemoryGovernanceSnapshotDto, type MemoryKind, type MemoryRedactionLevel, type MemoryScopeType, type MessageMetaDto, type PiProviderCardDto, type PiProviderPresetDescriptorDto, type PublicPiHealthDto, type TeamAgentMemoryOptInDto, type TeamDto, type TaskDagViewDto, type UpdatePiProviderCardInput } from '@agentbean/contracts';
import { io, type Socket } from 'socket.io-client';
import type { ChannelDocumentDto, ChannelDocumentRevisionsResultDto, ChannelDocumentResultDto } from '@agentbean/contracts';
import type { AgentSnapshot, DiscoveredAgent, RuntimeInfo, TeamSummary, ChannelSummary, AgentMetricsSummary, InviteInfo, UserInfo, DeviceInfo, ChatMessage, AgentWorkspaceRun, TeamWorkspaceRun, Artifact, WorkspaceRunDetail, WorkspaceArtifact, WorkspaceRunLogResponse, WorkspaceRunStatus } from './schema.js';
import {
  assertArtifactUploadWithinLimit,
  artifactUploadFallbackUrls as buildArtifactUploadFallbackUrls,
  artifactUploadProxyUrl as buildArtifactUploadProxyUrl,
  artifactUploadUrl as buildArtifactUploadUrl,
} from './artifact-upload';

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
  create(payload: { teamId: string; deviceId: string; name: string; adapterKind?: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; description?: string }): Promise<{ ok: boolean; agent?: AgentSnapshot; error?: string }>;
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
  getActiveModel(): Promise<{ ok: boolean; activeModel?: ActivePiModelDto | null; history?: ActivePiModelDto[]; health?: PublicPiHealthDto; error?: string; message?: string }>;
  getPublicHealth(): Promise<{ ok: boolean; health?: PublicPiHealthDto; error?: string; message?: string }>;
  setActiveModel(revisionId: string): Promise<{ ok: boolean; activeModel?: ActivePiModelDto; error?: string; message?: string }>;
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
    getPublicHealth() { return emitWithTimeout(socket, WEB_EVENTS.piProvider.getPublicHealth, {}); },
    setActiveModel(revisionId) { return emitWithTimeout(socket, WEB_EVENTS.piProvider.setActiveModel, { revisionId }); },
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
  update(payload: { teamId?: string; channelId: string; name?: string; description?: string | null; visibility?: 'public' | 'private' }): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  members(channelId: string, teamId?: string): Promise<{ ok: boolean; humans?: { userId: string; role: string; username: string }[]; agents?: import('./schema').AgentSnapshot[]; error?: string }>;
  addAgent(channelId: string, agentId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  addMember(channelId: string, userId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  removeAgent(channelId: string, agentId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  removeMember(channelId: string, userId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  archive(channelId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  delete(channelId: string, teamId?: string): Promise<{ ok: boolean; channel?: ChannelSummary; error?: string }>;
  searchMessages(query: string, limit?: number, channelId?: string): Promise<{ ok: boolean; messages?: ChatMessage[]; error?: string }>;
  listFiles(channelId: string, cursor?: string, pageSize?: number, path?: string): Promise<{ ok: boolean; files?: ChannelFilesResultDto['files']; directories?: ChannelFilesResultDto['directories']; nextCursor?: string; path?: string; error?: string }>;
  searchFiles(channelId: string, query: string, cursor?: string, pageSize?: number, path?: string): Promise<{ ok: boolean; files?: ChannelFilesResultDto['files']; directories?: ChannelFilesResultDto['directories']; nextCursor?: string; path?: string; error?: string }>;
  listDocuments(channelId: string): Promise<{ ok: boolean; documents?: ChannelDocumentDto[]; error?: string }>;
  getDocument(channelId: string, documentId: string): Promise<{ ok: boolean; document?: ChannelDocumentResultDto['document']; error?: string }>;
  listDocumentRevisions(channelId: string, documentId: string): Promise<{ ok: boolean; document?: ChannelDocumentRevisionsResultDto['document']; revisions?: ChannelDocumentRevisionsResultDto['revisions']; error?: string }>;
  saveDocument(channelId: string, documentId: string, baseRevisionId: string, content: string, filename?: string): Promise<{ ok: boolean; document?: ChannelDocumentResultDto['document']; error?: string }>;
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
    archive(channelId, teamId) { return emitWithTimeout(socket, WEB_EVENTS.channel.archive, { channelId, ...(teamId ? { teamId } : {}) }); },
    delete(channelId, teamId) { return emitWithTimeout(socket, WEB_EVENTS.channel.delete, { channelId, ...(teamId ? { teamId } : {}) }); },
    searchMessages(query, limit, channelId) {
      return emitWithTimeout(socket, WEB_EVENTS.message.search, { query, limit, ...(channelId ? { channelId } : {}) });
    },
    listFiles(channelId, cursor, pageSize, path) {
      return emitWithTimeout(socket, WEB_EVENTS.channelFiles.list, { channelId, ...(cursor ? { cursor } : {}), ...(pageSize ? { pageSize } : {}), ...(path ? { path } : {}) });
    },
    searchFiles(channelId, query, cursor, pageSize, path) {
      return emitWithTimeout(socket, WEB_EVENTS.channelFiles.search, { channelId, query, ...(cursor ? { cursor } : {}), ...(pageSize ? { pageSize } : {}), ...(path ? { path } : {}) });
    },
    listDocuments(channelId) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.list, { channelId }); },
    getDocument(channelId, documentId) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.get, { channelId, documentId }); },
    listDocumentRevisions(channelId, documentId) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.revisions, { channelId, documentId }); },
    saveDocument(channelId, documentId, baseRevisionId, content, filename) { return emitWithTimeout(socket, WEB_EVENTS.channelDocuments.save, { channelId, documentId, baseRevisionId, content, ...(filename ? { filename } : {}) }); },
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
  update(payload: { id: string; title?: string; description?: string; status?: string; assigneeId?: string | null; channelId?: string | null; tags?: string[]; sortOrder?: number }): Promise<{ ok: boolean; task?: any; error?: string }>;
  delete(id: string): Promise<{ ok: boolean; error?: string }>;
  reorder(id: string, sortOrder: number): Promise<{ ok: boolean; error?: string }>;
  onSnapshot(handler: (tasks: any[]) => void): () => void;
}

export function taskEvents(socket: Socket = getWebSocket()): TaskEvents {
  return {
    create(payload) { return emitWithTimeout(socket, WEB_EVENTS.task.create, payload); },
    list(channelId) { return emitWithTimeout(socket, WEB_EVENTS.task.list, { channelId }); },
    getDag(rootTaskId) { return emitWithTimeout(socket, WEB_EVENTS.task.dag, { rootTaskId }); },
    update({ id, ...rest }) { return emitWithTimeout(socket, WEB_EVENTS.task.update, { taskId: id, ...rest }); },
    delete(id) { return emitWithTimeout(socket, WEB_EVENTS.task.delete, { taskId: id }); },
    reorder(id, sortOrder) { return emitWithTimeout(socket, WEB_EVENTS.task.reorder, { taskId: id, sortOrder }); },
    onSnapshot(handler) {
      socket.on(WEB_EVENTS.task.snapshot, handler);
      return () => { socket.off(WEB_EVENTS.task.snapshot, handler); };
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
