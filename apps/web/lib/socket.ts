'use client';
import { io, type Socket } from 'socket.io-client';
import type { AgentSnapshot, DiscoveredAgent, RuntimeInfo, TeamSummary, AgentMetricsSummary, InviteInfo, UserInfo, DeviceInfo, ChatMessage, AgentWorkspaceRun, Artifact, WorkspaceRunDetail, WorkspaceArtifact } from './schema.js';

const configuredUrl = process.env.NEXT_PUBLIC_AGENT_BEAN_SERVER_URL ?? 'http://localhost:4000';
const TOKEN_STORAGE_KEY = 'agentbean.token';
const DEVICE_ID_STORAGE_KEY = 'agentbean.deviceId';

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

function getServerUrl(): string {
  return configuredUrl;
}

export function getResolvedServerUrl(): string {
  return getServerUrl();
}

export function authedApiUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${getServerUrl()}${path}${sep}token=${encodeURIComponent(getStoredAuthToken())}`;
}

export function artifactUploadUrl(networkId: string): string {
  return authedApiUrl(`/api/teams/${encodeURIComponent(networkId)}/artifacts/upload`);
}

export function artifactUploadProxyUrl(networkId: string): string {
  return `/api/teams/${encodeURIComponent(networkId)}/artifacts/upload?token=${encodeURIComponent(getStoredAuthToken())}`;
}

export function artifactUploadFallbackUrls(networkId: string): string[] {
  const urls = [artifactUploadUrl(networkId), artifactUploadProxyUrl(networkId)];
  return [...new Set(urls)];
}

function cloneFormData(form: FormData): FormData {
  const cloned = new FormData();
  for (const [key, value] of form.entries()) {
    cloned.append(key, value);
  }
  return cloned;
}

export async function uploadArtifact(networkId: string, form: FormData): Promise<Artifact> {
  let lastError: Error | null = null;
  for (const url of artifactUploadFallbackUrls(networkId)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: cloneFormData(form),
      });
      if (res.ok) return await res.json() as Artifact;
      const text = await res.text();
      lastError = new Error(text || `${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Failed to fetch');
    }
  }
  throw lastError ?? new Error('Failed to upload artifact');
}

export async function fetchAgentWorkspace(networkId: string, agentId: string): Promise<{ ok: boolean; runs?: AgentWorkspaceRun[]; error?: string }> {
  try {
    const res = await fetch(authedApiUrl(`/api/teams/${encodeURIComponent(networkId)}/agents/${encodeURIComponent(agentId)}/workspace`));
    if (!res.ok) return { ok: false, error: await res.text() };
    return await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to fetch workspace' };
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

export function getWebSocket(): Socket {
  if (webSocket) return webSocket;
  let retriedWithWebToken = false;
  webSocket = io(`${getServerUrl()}/web`, { transports: ['websocket'], autoConnect: true, auth: { token: getStoredToken(), currentDeviceId: getStoredDeviceId() } });
  webSocket.on('connect_error', () => {
    if (typeof window === 'undefined' || retriedWithWebToken || !webToken) return;
    const storedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!storedToken || storedToken === webToken) return;
    retriedWithWebToken = true;
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    webSocket?.disconnect();
    webSocket!.auth = { token: webToken, currentDeviceId: getStoredDeviceId() };
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
  metrics(): Promise<{ ok: boolean; summaries?: AgentMetricsSummary[]; error?: string }>;
  publish(agentId: string, networkId: string): Promise<{ ok: boolean; error?: string }>;
  unpublish(agentId: string, networkId: string): Promise<{ ok: boolean; error?: string }>;
  delete(agentId: string): Promise<{ ok: boolean; error?: string }>;
  create(payload: { name: string; adapterKind: string; command: string; args?: string[]; category?: string; cwd?: string; env?: Record<string, string>; description?: string; deviceId?: string; networkId?: string }): Promise<{ ok: boolean; agent?: any; error?: string }>;
  updateConfig(payload: { id: string; name: string; adapterKind?: string; command?: string; cwd?: string | null; description?: string | null }): Promise<{ ok: boolean; agent?: any; error?: string }>;
  listCustom(payload?: { deviceId?: string }): Promise<{ ok: boolean; agents?: AgentSnapshot[]; error?: string }>;
  subscribe(): void;
}

function emitWithTimeout(socket: Socket, event: string, payload: any, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), timeoutMs);
    socket.emit(event, payload, (res: any) => { clearTimeout(timer); resolve(res); });
  });
}

export function agentEvents(socket: Socket = getWebSocket()): AgentEvents {
  return {
    onSnapshot(handler) {
      socket.on('agents:snapshot', handler);
      return () => { socket.off('agents:snapshot', handler); };
    },
    onStatus(handler) {
      socket.on('agent:status', handler);
      return () => { socket.off('agent:status', handler); };
    },
    onDiscovered(handler) {
      socket.on('agents:discovered', handler);
      return () => { socket.off('agents:discovered', handler); };
    },
    metrics() {
      return emitWithTimeout(socket, 'agent:metrics', {});
    },
    subscribe() { socket.emit('agents:subscribe', {}); },
    create(payload) {
      return emitWithTimeout(socket, 'agent:create', payload);
    },
    listCustom(payload = {}) {
      return emitWithTimeout(socket, 'agent:custom:list', payload);
    },
    updateConfig({ id, ...rest }) {
      return emitWithTimeout(socket, 'agent:update-config', { agentId: id, ...rest });
    },
    publish(agentId, networkId) {
      return emitWithTimeout(socket, 'agent:publish', { agentId, networkId });
    },
    unpublish(agentId, networkId) {
      return emitWithTimeout(socket, 'agent:unpublish', { agentId, networkId });
    },
    delete(agentId) {
      return emitWithTimeout(socket, 'agent:delete', { agentId });
    },
  };
}

export interface TeamEvents {
  list(): Promise<{ ok: boolean; teams?: TeamSummary[]; error?: string }>;
  create(payload: { name: string; path?: string; description?: string; visibility?: 'public' | 'private' }): Promise<{ ok: boolean; team?: TeamSummary; defaultChannel?: { id: string; name: string }; error?: string }>;
  switch(teamId: string): Promise<{ ok: boolean; currentTeam?: TeamSummary; error?: string }>;
  update(payload: { name?: string }): Promise<{ ok: boolean; team?: TeamSummary; error?: string }>;
  delete(networkId: string): Promise<{ ok: boolean; fallbackTeam?: TeamSummary | null; error?: string }>;
  onSnapshot(handler: (nets: TeamSummary[]) => void): () => void;
  subscribe(): void;
}

export function teamEvents(socket: Socket = getWebSocket()): TeamEvents {
  return {
    list() {
      return emitWithTimeout(socket, 'team:list', {});
    },
    create(payload) {
      return emitWithTimeout(socket, 'team:create', payload);
    },
    switch(teamId) {
      return emitWithTimeout(socket, 'team:switch', { teamId });
    },
    update(payload) {
      return emitWithTimeout(socket, 'team:update', payload);
    },
    delete(teamId) {
      return emitWithTimeout(socket, 'team:delete', { teamId });
    },
    onSnapshot(handler) {
      socket.on('teams:snapshot', handler);
      return () => { socket.off('teams:snapshot', handler); };
    },
    subscribe() { socket.emit('team:list', {}); },
  };
}

/** @deprecated Use teamEvents() instead */
export const networkEvents = teamEvents;

export interface ChannelEvents {
  update(payload: { channelId: string; name?: string; description?: string | null; visibility?: 'public' | 'private' }): Promise<{ ok: boolean; error?: string }>;
  members(channelId: string): Promise<{ ok: boolean; humans?: { userId: string; role: string; username: string }[]; agents?: import('./schema').AgentSnapshot[]; error?: string }>;
  addAgent(channelId: string, agentId: string): Promise<{ ok: boolean; error?: string }>;
  addMember(channelId: string, userId: string): Promise<{ ok: boolean; error?: string }>;
  removeAgent(channelId: string, agentId: string): Promise<{ ok: boolean; error?: string }>;
  removeMember(channelId: string, userId: string): Promise<{ ok: boolean; error?: string }>;
  leave(channelId: string): Promise<{ ok: boolean; error?: string }>;
  archive(channelId: string): Promise<{ ok: boolean; error?: string }>;
  delete(channelId: string): Promise<{ ok: boolean; error?: string }>;
  stopAgents(channelId: string): Promise<{ ok: boolean; stopped?: number; error?: string }>;
  searchMessages(query: string, limit?: number): Promise<{ ok: boolean; messages?: ChatMessage[]; error?: string }>;
}

export function channelEvents(socket: Socket = getWebSocket()): ChannelEvents {
  return {
    update(payload) { return emitWithTimeout(socket, 'channel:update', payload); },
    members(channelId) { return emitWithTimeout(socket, 'channel:members', { channelId }); },
    addAgent(channelId, agentId) { return emitWithTimeout(socket, 'channel:add-agent', { channelId, agentId }); },
    addMember(channelId, userId) { return emitWithTimeout(socket, 'channel:add-member', { channelId, memberUserId: userId }); },
    removeAgent(channelId, agentId) { return emitWithTimeout(socket, 'channel:remove-agent', { channelId, agentId }); },
    removeMember(channelId, userId) { return emitWithTimeout(socket, 'channel:remove-member', { channelId, memberUserId: userId }); },
    leave(channelId) { return emitWithTimeout(socket, 'channel:leave', { channelId }); },
    archive(channelId) { return emitWithTimeout(socket, 'channel:archive', { channelId }); },
    delete(channelId) { return emitWithTimeout(socket, 'channel:delete', { channelId }); },
    stopAgents(channelId) { return emitWithTimeout(socket, 'channel:stop-agents', { channelId }); },
    searchMessages(query, limit) { return emitWithTimeout(socket, 'message:search', { query, limit }); },
  };
}

export interface MessageReactionEvents {
  react(messageId: string, on: boolean, emoji?: string): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  save(messageId: string, on: boolean): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  listSaved(): Promise<{ ok: boolean; messages?: ChatMessage[]; error?: string }>;
}

export function messageReactionEvents(socket: Socket = getWebSocket()): MessageReactionEvents {
  return {
    react(messageId, on, emoji) { return emitWithTimeout(socket, 'message:react', { messageId, on, emoji: emoji || '❤️' }); },
    save(messageId, on) { return emitWithTimeout(socket, 'message:save', { messageId, on }); },
    listSaved() { return emitWithTimeout(socket, 'message:list-saved', {}); },
  };
}

export interface AuthEvents {
  register(payload: { username: string; password: string; email?: string; inviteToken?: string; sessionId?: string }): Promise<{ ok: boolean; token?: string; user?: UserInfo; currentTeam?: { id: string; name: string; path: string }; defaultChannel?: { id: string; name: string }; error?: string }>;
  login(payload: { username: string; password: string; joinCode?: string }): Promise<{ ok: boolean; token?: string; user?: UserInfo; currentTeam?: { id: string; name: string; path: string }; error?: string }>;
  whoami(): Promise<{ ok: boolean; user?: UserInfo; error?: string }>;
  inviteCreate(payload?: { networkId?: string; purpose?: 'user' | 'device' }): Promise<{ ok: boolean; invite?: InviteInfo; error?: string }>;
  deviceLogin(payload: { inviteCode: string; username: string; password: string }): Promise<{ ok: boolean; token?: string; networkId?: string; networkPath?: string; userId?: string; username?: string; role?: 'admin' | 'user'; deviceId?: string; error?: string }>;
  changePassword(payload: { currentPassword: string; newPassword: string }): Promise<{ ok: boolean; error?: string }>;
}

export function authEvents(socket: Socket = getWebSocket()): AuthEvents {
  return {
    register(payload) {
      return emitWithTimeout(socket, 'auth:register', payload, 20000);
    },
    login(payload) {
      return emitWithTimeout(socket, 'auth:login', payload, 20000);
    },
    whoami() {
      return emitWithTimeout(socket, 'auth:whoami', { token: getStoredAuthToken() });
    },
    inviteCreate(payload = {}) {
      return emitWithTimeout(socket, 'invite:create', payload);
    },
    deviceLogin(payload) {
      return emitWithTimeout(socket, 'auth:device-login', payload, 20000);
    },
    changePassword(payload) {
      return emitWithTimeout(socket, 'auth:change-password', payload);
    },
  };
}

export interface JoinEvents {
  create(payload: { maxUses?: number; expiresAt?: number }): Promise<{ ok: boolean; link?: import('./schema').JoinLinkInfo; error?: string }>;
  list(): Promise<{ ok: boolean; links?: import('./schema').JoinLinkInfo[]; error?: string }>;
  revoke(payload: { code: string }): Promise<{ ok: boolean; error?: string }>;
  validate(payload: { code: string }): Promise<{ ok: boolean; networkName?: string; expiresAt?: number | null; error?: string }>;
}

export function joinEvents(socket: Socket = getWebSocket()): JoinEvents {
  return {
    create(payload) {
      return emitWithTimeout(socket, 'join:create', payload);
    },
    list() {
      return emitWithTimeout(socket, 'join:list', {});
    },
    revoke(payload) {
      return emitWithTimeout(socket, 'join:revoke', payload);
    },
    validate(payload) {
      return emitWithTimeout(socket, 'join:validate', payload);
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
  publishedNetworkIds: string[];
  unpublishedNetworkIds?: string[];
}

export interface DeviceRuntime {
  name: string;
  adapterKind: string;
  command: string;
  installed: boolean;
}

export interface DeviceEvents {
  list(): Promise<{ ok: boolean; devices?: DeviceInfo[]; error?: string }>;
  get(payload: { id: string }): Promise<{ ok: boolean; device?: any; error?: string }>;
  agentsList(deviceId: string): Promise<{ ok: boolean; agents?: DeviceAgent[]; runtimes?: DeviceRuntime[]; error?: string }>;
  scan(deviceId: string): Promise<{ ok: boolean; error?: string }>;
  selectDirectory(deviceId: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  delete(id: string): Promise<{ ok: boolean; error?: string }>;
  rename(id: string, hostname: string): Promise<{ ok: boolean; error?: string }>;
  onSnapshot(handler: (devices: DeviceInfo[]) => void): () => void;
  onStatus(handler: (device: DeviceInfo) => void): () => void;
  subscribe(): void;
}

export function deviceEvents(socket: Socket = getWebSocket()): DeviceEvents {
  return {
    list() {
      return emitWithTimeout(socket, 'device:list', {});
    },
    get({ id }) {
      return emitWithTimeout(socket, 'device:get', { deviceId: id });
    },
    agentsList(deviceId) {
      return emitWithTimeout(socket, 'device:agents:list', { deviceId });
    },
    scan(deviceId) {
      return emitWithTimeout(socket, 'device:scan', { deviceId });
    },
    selectDirectory(deviceId) {
      return emitWithTimeout(socket, 'device:select-directory', { deviceId }, 35000);
    },
    delete(id) {
      return emitWithTimeout(socket, 'device:delete', { id });
    },
    rename(id, hostname) {
      return emitWithTimeout(socket, 'device:rename', { id, hostname });
    },
    onSnapshot(handler) {
      socket.on('devices:snapshot', handler);
      return () => { socket.off('devices:snapshot', handler); };
    },
    onStatus(handler) {
      socket.on('device:status', handler);
      return () => { socket.off('device:status', handler); };
    },
    subscribe() { socket.emit('devices:subscribe', {}); },
  };
}

export interface TaskEvents {
  create(payload: { title: string; description?: string; status?: string; assigneeId?: string; channelId?: string; tags?: string[] }): Promise<{ ok: boolean; task?: any; error?: string }>;
  list(channelId?: string): Promise<{ ok: boolean; tasks?: any[]; error?: string }>;
  update(payload: { id: string; title?: string; description?: string; status?: string; assigneeId?: string | null; channelId?: string | null; tags?: string[]; sortOrder?: number }): Promise<{ ok: boolean; task?: any; error?: string }>;
  delete(id: string): Promise<{ ok: boolean; error?: string }>;
  reorder(id: string, sortOrder: number): Promise<{ ok: boolean; error?: string }>;
}

export function taskEvents(socket: Socket = getWebSocket()): TaskEvents {
  return {
    create(payload) { return emitWithTimeout(socket, 'task:create', payload); },
    list(channelId) { return emitWithTimeout(socket, 'task:list', { channelId }); },
    update({ id, ...rest }) { return emitWithTimeout(socket, 'task:update', { taskId: id, ...rest }); },
    delete(id) { return emitWithTimeout(socket, 'task:delete', { taskId: id }); },
    reorder(id, sortOrder) { return emitWithTimeout(socket, 'task:reorder', { taskId: id, sortOrder }); },
  };
}

export interface MemberEvents {
  list(): Promise<{ ok: boolean; humans?: { userId: string; role: string; username: string; email?: string | null; description?: string | null; joinedAt?: number; createdAt?: number }[]; agents?: import('./schema').AgentSnapshot[]; error?: string }>;
  updateHuman(payload: { userId: string; description?: string | null }): Promise<{ ok: boolean; human?: { userId: string; role: string; username: string; email?: string | null; description?: string | null; joinedAt?: number; createdAt?: number }; error?: string }>;
  updateRole(payload: { targetUserId: string; role: 'owner' | 'admin' | 'member' }): Promise<{ ok: boolean; member?: { id: string; teamId: string; userId: string; username: string; role: string }; error?: string }>;
  remove(payload: { targetUserId: string }): Promise<{ ok: boolean; userId?: string; error?: string }>;
  transferOwner(payload: { targetUserId: string }): Promise<{ ok: boolean; team?: { id: string; name: string }; member?: { id: string; teamId: string; userId: string; username: string; role: string }; error?: string }>;
}

export function memberEvents(socket: Socket = getWebSocket()): MemberEvents {
  return {
    list() {
      return emitWithTimeout(socket, 'members:list', {});
    },
    updateHuman({ userId, ...rest }) {
      return emitWithTimeout(socket, 'member:update-human', { targetUserId: userId, ...rest });
    },
    updateRole(payload) {
      return emitWithTimeout(socket, 'member:update-role', payload);
    },
    remove(payload) {
      return emitWithTimeout(socket, 'member:remove', payload);
    },
    transferOwner(payload) {
      return emitWithTimeout(socket, 'member:transfer-owner', payload);
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
    start(agentId) { return emitWithTimeout(socket, 'dm:start', { agentId }); },
    list() { return emitWithTimeout(socket, 'dm:list', {}); },
    onSnapshot(handler) {
      socket.on('dms:snapshot', handler);
      return () => { socket.off('dms:snapshot', handler); };
    },
  };
}
