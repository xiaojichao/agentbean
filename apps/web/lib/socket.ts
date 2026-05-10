'use client';
import { io, type Socket } from 'socket.io-client';
import type { AgentSnapshot, DiscoveredAgent, RuntimeInfo, NetworkSummary, AgentMetricsSummary, InviteInfo, UserInfo, DeviceInfo } from './schema.js';

const configuredUrl = process.env.NEXT_PUBLIC_AGENT_BEAN_SERVER_URL ?? 'http://localhost:4000';
const TOKEN_STORAGE_KEY = 'agentbean.token';

let webSocket: Socket | null = null;
const webToken = process.env.NEXT_PUBLIC_AGENT_BEAN_WEB_TOKEN ?? process.env.NEXT_PUBLIC_AGENT_BEAN_AGENT_TOKEN ?? '';

function getStoredToken(): string {
  if (typeof window === 'undefined') return webToken;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? webToken;
}

function getServerUrl(): string {
  if (typeof window === 'undefined') return configuredUrl;
  const current = new URL(window.location.href);
  const configured = new URL(configuredUrl);
  configured.hostname = current.hostname;
  return configured.toString().replace(/\/$/, '');
}

export function getResolvedServerUrl(): string {
  return getServerUrl();
}

export function getWebSocket(): Socket {
  if (webSocket) return webSocket;
  let retriedWithWebToken = false;
  webSocket = io(`${getServerUrl()}/web`, { transports: ['websocket'], autoConnect: true, auth: { token: getStoredToken() } });
  webSocket.on('connect_error', () => {
    if (typeof window === 'undefined' || retriedWithWebToken || !webToken) return;
    const storedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!storedToken || storedToken === webToken) return;
    retriedWithWebToken = true;
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    webSocket?.disconnect();
    webSocket!.auth = { token: webToken };
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
  create(payload: { name: string; adapterKind: string; command: string; args?: string[]; category?: string }): Promise<{ ok: boolean; agent?: any; error?: string }>;
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
    publish(agentId, networkId) {
      return emitWithTimeout(socket, 'agent:publish', { agentId, networkId });
    },
    unpublish(agentId, networkId) {
      return emitWithTimeout(socket, 'agent:unpublish', { agentId, networkId });
    },
  };
}

export interface NetworkEvents {
  list(): Promise<{ ok: boolean; networks?: NetworkSummary[]; error?: string }>;
  create(payload: { name: string; path?: string; description?: string; visibility?: 'public' | 'private' }): Promise<{ ok: boolean; network?: NetworkSummary; error?: string }>;
  switch(networkId: string): Promise<{ ok: boolean; network?: NetworkSummary; error?: string }>;
  update(payload: { name?: string }): Promise<{ ok: boolean; network?: NetworkSummary; error?: string }>;
  onSnapshot(handler: (nets: NetworkSummary[]) => void): () => void;
  subscribe(): void;
}

export function networkEvents(socket: Socket = getWebSocket()): NetworkEvents {
  return {
    list() {
      return emitWithTimeout(socket, 'network:list', {});
    },
    create(payload) {
      return emitWithTimeout(socket, 'network:create', payload);
    },
    switch(networkId) {
      return emitWithTimeout(socket, 'network:switch', { networkId });
    },
    update(payload) {
      return emitWithTimeout(socket, 'network:update', payload);
    },
    onSnapshot(handler) {
      socket.on('networks:snapshot', handler);
      return () => { socket.off('networks:snapshot', handler); };
    },
    subscribe() { socket.emit('network:list', {}); },
  };
}

export interface AuthEvents {
  register(payload: { username: string; password: string; email?: string; inviteToken?: string; sessionId?: string }): Promise<{ ok: boolean; token?: string; userId?: string; username?: string; email?: string | null; role?: 'admin' | 'user'; networkId?: string; networkPath?: string; error?: string }>;
  login(payload: { username: string; password: string; joinCode?: string }): Promise<{ ok: boolean; token?: string; userId?: string; username?: string; email?: string | null; role?: 'admin' | 'user'; networkId?: string; networkPath?: string; error?: string }>;
  whoami(): Promise<{ ok: boolean; user?: UserInfo; error?: string }>;
  inviteCreate(payload?: { networkId?: string; purpose?: 'user' | 'device' }): Promise<{ ok: boolean; invite?: InviteInfo; error?: string }>;
  deviceLogin(payload: { inviteCode: string; username: string; password: string }): Promise<{ ok: boolean; token?: string; networkId?: string; networkPath?: string; userId?: string; username?: string; role?: 'admin' | 'user'; error?: string }>;
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
      return emitWithTimeout(socket, 'auth:whoami', {});
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
      return emitWithTimeout(socket, 'auth:join:validate', payload);
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
  deviceId: string;
  status: string;
  publishedNetworkIds: string[];
}

export interface DeviceEvents {
  list(): Promise<{ ok: boolean; devices?: DeviceInfo[]; error?: string }>;
  get(payload: { id: string }): Promise<{ ok: boolean; device?: any; error?: string }>;
  agentsList(deviceId: string): Promise<{ ok: boolean; agents?: DeviceAgent[]; error?: string }>;
  scan(deviceId: string): Promise<{ ok: boolean; error?: string }>;
  onSnapshot(handler: (devices: DeviceInfo[]) => void): () => void;
  onStatus(handler: (device: DeviceInfo) => void): () => void;
  subscribe(): void;
}

export function deviceEvents(socket: Socket = getWebSocket()): DeviceEvents {
  return {
    list() {
      return emitWithTimeout(socket, 'devices:list', {});
    },
    get(payload) {
      return emitWithTimeout(socket, 'device:get', payload);
    },
    agentsList(deviceId) {
      return emitWithTimeout(socket, 'device:agents:list', { deviceId });
    },
    scan(deviceId) {
      return emitWithTimeout(socket, 'device:scan', { deviceId });
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
  update(payload: { id: string; title?: string; description?: string; status?: string; assigneeId?: string | null; channelId?: string | null; tags?: string[] }): Promise<{ ok: boolean; task?: any; error?: string }>;
  delete(id: string): Promise<{ ok: boolean; error?: string }>;
  reorder(id: string, sortOrder: number): Promise<{ ok: boolean; error?: string }>;
}

export function taskEvents(socket: Socket = getWebSocket()): TaskEvents {
  return {
    create(payload) { return emitWithTimeout(socket, 'task:create', payload); },
    list(channelId) { return emitWithTimeout(socket, 'task:list', { channelId }); },
    update(payload) { return emitWithTimeout(socket, 'task:update', payload); },
    delete(id) { return emitWithTimeout(socket, 'task:delete', { id }); },
    reorder(id, sortOrder) { return emitWithTimeout(socket, 'task:reorder', { id, sortOrder }); },
  };
}

export interface MemberEvents {
  list(): Promise<{ ok: boolean; humans?: { userId: string; role: string; username: string }[]; agents?: import('./schema').AgentSnapshot[]; error?: string }>;
}

export function memberEvents(socket: Socket = getWebSocket()): MemberEvents {
  return {
    list() {
      return emitWithTimeout(socket, 'members:list', {});
    },
  };
}
