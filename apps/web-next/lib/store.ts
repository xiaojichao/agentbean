'use client';
import { create } from 'zustand';
import type { AgentSnapshot, ChannelSummary, ChatMessage, ConnState, DispatchStatus, OutboundMessage, DiscoveredAgent, RuntimeInfo, TeamSummary, AgentMetricsSummary, UserInfo, DeviceInfo, HumanMember } from './schema.js';
import type { DmChannel } from './socket.js';
import { agentVisibleInTeam } from './agent-scope';
import { mergeChannelHistory } from './chat-scope';

function normalizeKind(value?: string | null): string {
  const normalized = (value ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'claude' || normalized === 'claude-code') return 'claude-code';
  if (normalized === 'codex' || normalized === 'codex-cli') return 'codex';
  return normalized;
}

function normalizeLogicalAgentName(name?: string | null): string {
  return (name ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function normalizeRuntimePath(value?: string | null): string {
  return (value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function dirnameFromCommand(command?: string | null): string {
  const normalized = normalizeRuntimePath(command);
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : '';
}

function normalizeAgentArgs(args?: string[] | null): string {
  return (args ?? []).map((arg) => String(arg).trim()).filter(Boolean).join('\u001f').toLowerCase();
}

function runtimeLocationKey(agent: Pick<AgentSnapshot, 'cwd' | 'command'>): string {
  return normalizeRuntimePath(agent.cwd) || dirnameFromCommand(agent.command);
}

function agentNameLogicalKey(agent: AgentSnapshot, teamId: string): string | null {
  if (!agent.deviceId) return null;
  const adapterKind = normalizeKind(agent.adapterKind);
  const name = normalizeLogicalAgentName(agent.name);
  if (!adapterKind || !name) return null;
  return [teamId, agent.deviceId, adapterKind, 'name', name].join('\u0000');
}

function agentRuntimeLogicalKey(agent: AgentSnapshot, teamId: string): string | null {
  if (!agent.deviceId) return null;
  const adapterKind = normalizeKind(agent.adapterKind);
  const location = runtimeLocationKey(agent);
  if (!adapterKind || !location) return null;
  return [teamId, agent.deviceId, adapterKind, 'runtime', location, normalizeAgentArgs(agent.args)].join('\u0000');
}

function agentGatewayLogicalKey(agent: AgentSnapshot, teamId: string): string | null {
  if (!agent.deviceId || agent.category !== 'agentos-hosted' || agent.source === 'custom') return null;
  const adapterKind = normalizeKind(agent.adapterKind);
  if (adapterKind !== 'hermes' && adapterKind !== 'openclaw') return null;
  return [teamId, agent.deviceId, adapterKind, 'gateway'].join('\u0000');
}

function visibleAgentLogicalKeys(agent: AgentSnapshot, teamId: string): string[] {
  const keys = new Set<string>();
  const gatewayKey = agentGatewayLogicalKey(agent, teamId);
  if (gatewayKey) keys.add(gatewayKey);
  const runtimeKey = agentRuntimeLogicalKey(agent, teamId);
  if (runtimeKey) keys.add(runtimeKey);
  if (agent.category === 'agentos-hosted') {
    const nameKey = agentNameLogicalKey(agent, teamId);
    if (nameKey) keys.add(nameKey);
  }
  return [...keys];
}

function agentStatusRank(status?: string | null): number {
  if (status === 'busy') return 5;
  if (status === 'online') return 4;
  if (status === 'connecting') return 3;
  if (status === 'error') return 2;
  return 1;
}

function agentSourceRank(source?: string | null): number {
  if (source === 'custom') return 3;
  if (source === 'self-register') return 2;
  return 1;
}

function agentIdHasNameSlug(agentId: string, name?: string | null): boolean {
  const normalized = normalizeLogicalAgentName(name);
  return Boolean(normalized && agentId.toLowerCase().endsWith(`-${normalized}`));
}

function isGenericGatewayName(agent: AgentSnapshot): boolean {
  const kind = normalizeKind(agent.adapterKind);
  const name = normalizeLogicalAgentName(agent.name);
  return (kind === 'hermes' && name === 'hermes-agent') ||
    (kind === 'openclaw' && name === 'openclaw-agent');
}

function agentDisplayRank(agent: AgentSnapshot): number {
  if (agent.source === 'custom') return 4;
  if (agent.source === 'self-register') return 3;
  if (agent.category === 'agentos-hosted' && agent.name && !isGenericGatewayName(agent)) return 2;
  if (agent.category === 'agentos-hosted' && agent.name && !agentGatewayLogicalKey(agent, agent.primaryTeamId) && !agentIdHasNameSlug(agent.id, agent.name)) return 2;
  return 1;
}

function mergeAgentSnapshot(display: AgentSnapshot, status: AgentSnapshot): AgentSnapshot {
  const lastSeenAt = Math.max(display.lastSeenAt ?? 0, status.lastSeenAt ?? 0);
  return {
    ...display,
    status: status.status,
    lastSeenAt: lastSeenAt || (display.lastSeenAt ?? status.lastSeenAt),
    lastError: status.lastError,
  };
}

function preferAgentSnapshot(candidate: AgentSnapshot, current: AgentSnapshot): AgentSnapshot {
  const displayDelta = agentDisplayRank(candidate) - agentDisplayRank(current);
  const statusDelta = agentStatusRank(candidate.status) - agentStatusRank(current.status);
  if (displayDelta !== 0) {
    const display = displayDelta > 0 ? candidate : current;
    const status = statusDelta > 0 ? candidate : current;
    return mergeAgentSnapshot(display, status);
  }
  if (statusDelta !== 0) return statusDelta > 0 ? candidate : current;
  const sourceDelta = agentSourceRank(candidate.source) - agentSourceRank(current.source);
  if (sourceDelta !== 0) return sourceDelta > 0 ? candidate : current;
  return (candidate.lastSeenAt ?? 0) > (current.lastSeenAt ?? 0) ? candidate : current;
}

// 去重产出两份视图：
//  - visibleAgents：去重赢家数组（供成员列表/选择器遍历，不重复）
//  - agents：别名 map，每个输入 id → 其所属去重组的赢家（输家 id 也指向赢家）
// agents 别名 map 保证：消息 senderId 即使命中被去重丢弃的输家 id，也能解析到赢家
// 的最新 name（同一物理 agent 改名后，输家发的旧消息也应显示新名）。
function buildAgentMaps(list: AgentSnapshot[], teamId: string): {
  agents: Record<string, AgentSnapshot>;
  visibleAgents: AgentSnapshot[];
} {
  const winners: AgentSnapshot[] = [];
  const indexByKey = new Map<string, number>();
  for (const agent of list) {
    const keys = visibleAgentLogicalKeys(agent, teamId);
    const existingIndex = keys
      .map((key) => indexByKey.get(key))
      .find((index): index is number => index !== undefined);
    if (existingIndex === undefined) {
      for (const key of keys) indexByKey.set(key, winners.length);
      winners.push(agent);
      continue;
    }
    winners[existingIndex] = preferAgentSnapshot(agent, winners[existingIndex]!);
    for (const key of visibleAgentLogicalKeys(winners[existingIndex]!, teamId)) {
      indexByKey.set(key, existingIndex);
    }
    for (const key of keys) indexByKey.set(key, existingIndex);
  }
  const agents: Record<string, AgentSnapshot> = {};
  for (const agent of list) {
    const keys = visibleAgentLogicalKeys(agent, teamId);
    const winnerIndex = keys
      .map((key) => indexByKey.get(key))
      .find((index): index is number => index !== undefined);
    agents[agent.id] = winnerIndex !== undefined ? winners[winnerIndex]! : agent;
  }
  return { agents, visibleAgents: winners };
}

function indexAgentsById(list: AgentSnapshot[]): Record<string, AgentSnapshot> {
  const records: Record<string, AgentSnapshot> = {};
  for (const agent of list) records[agent.id] = agent;
  return records;
}

interface State {
  conn: ConnState;
  agents: Record<string, AgentSnapshot>;
  agentRecords: Record<string, AgentSnapshot>;
  visibleAgents: AgentSnapshot[];
  channels: ChannelSummary[];
  dms: DmChannel[];
  messagesByChannel: Record<string, ChatMessage[]>;
  activityMessages: ChatMessage[];
  outbox: Record<string, OutboundMessage>;
  discovered: DiscoveredAgent[];
  runtimes: RuntimeInfo[];
  discovering: boolean;
  teams: TeamSummary[];
  currentTeamId: string;
  currentUser: UserInfo | null;
  authToken: string | null;
  agentMetrics: Record<string, AgentMetricsSummary>;
  devices: Record<string, DeviceInfo>;
  humans: HumanMember[];
  setConn(c: ConnState): void;
  applyAgentsSnapshot(list: AgentSnapshot[]): void;
  applyAgentStatus(snap: AgentSnapshot): void;
  addAgent(agent: AgentSnapshot): void;
  updateAgent(id: string, patch: Partial<AgentSnapshot>): void;
  applyChannelsSnapshot(list: ChannelSummary[]): void;
  applyDmsSnapshot(list: DmChannel[]): void;
  applyChannelHistory(channelId: string, msgs: ChatMessage[]): void;
  appendMessage(msg: ChatMessage): void;
  applyDispatchStatus(channelId: string, messageId: string, dispatchStatus: DispatchStatus, dispatchId?: string): void;
  upsertMessages(msgs: ChatMessage[]): void;
  upsertActivityMessages(msgs: ChatMessage[]): void;
  addOutbound(msg: OutboundMessage): void;
  resolveOutbound(id: string, status: 'sent' | 'failed'): void;
  setDiscovered(list: DiscoveredAgent[]): void;
  setRuntimes(list: RuntimeInfo[]): void;
  setDiscovering(v: boolean): void;
  applyTeamsSnapshot(list: TeamSummary[]): void;
  setCurrentTeamId(id: string): void;
  setCurrentUser(user: UserInfo | null): void;
  setAuthToken(token: string | null): void;
  addTeam(n: TeamSummary): void;
  applyAgentMetrics(list: AgentMetricsSummary[]): void;
  applyDevicesSnapshot(list: DeviceInfo[]): void;
  upsertDevice(device: DeviceInfo): void;
  applyDeviceStatus(device: DeviceInfo): void;
  applyHumansSnapshot(list: HumanMember[], teamId?: string): void;
  upsertHuman(human: HumanMember): void;
  removeHuman(userId: string): void;
}

export function mergeMessagesByChannel(
  existing: Record<string, ChatMessage[]>,
  msgs: ChatMessage[],
): Record<string, ChatMessage[]> {
  if (msgs.length === 0) return existing;
  const next: Record<string, ChatMessage[]> = { ...existing };
  let changed = false;
  for (const msg of msgs) {
    const list = next[msg.channelId] ?? [];
    const existingIndex = list.findIndex((m) => m.id === msg.id);
    const existing = existingIndex >= 0 ? list[existingIndex] : undefined;
    const updated = existing ? { ...existing, ...msg } : msg;
    if (existing && sameChatMessage(existing, updated)) continue;
    const merged = existingIndex >= 0
      ? list.map((item, index) => index === existingIndex ? updated : item)
      : [...list, updated];
    if (merged.every((message) => typeof message.createdAt === 'number')) {
      merged.sort((a, b) => a.createdAt - b.createdAt);
    }
    next[msg.channelId] = merged;
    changed = true;
  }
  return changed ? next : existing;
}

function sameChatMessage(left: ChatMessage, right: ChatMessage): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.is(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

export function mergeActivityMessages(
  existing: ChatMessage[],
  msgs: ChatMessage[],
): ChatMessage[] {
  if (msgs.length === 0) return existing;
  const byId = new Map(existing.map((m) => [m.id, m]));
  let changed = false;
  for (const msg of msgs) {
    const cur = byId.get(msg.id);
    if (cur === msg) continue;
    byId.set(msg.id, cur ? { ...cur, ...msg } : msg);
    changed = true;
  }
  return changed ? [...byId.values()] : existing;
}

export const useAgentBeanStore = create<State>((set) => ({
  conn: 'connecting',
  agents: {},
  agentRecords: {},
  visibleAgents: [],
  channels: [],
  dms: [],
  messagesByChannel: {},
  activityMessages: [],
  outbox: {},
  discovered: [],
  runtimes: [],
  discovering: false,
  teams: [],
  currentTeamId: 'default',
  currentUser: null,
  authToken: null,
  agentMetrics: {},
  devices: {},
  humans: [],
  setConn(conn) { set({ conn }); },
  applyAgentsSnapshot(list) {
    set((s) => {
      const records = indexAgentsById(list);
      const { agents, visibleAgents } = buildAgentMaps(list, s.currentTeamId);
      return { agentRecords: records, agents, visibleAgents };
    });
  },
  applyAgentStatus(snap) {
    set((s) => {
      const records = { ...s.agentRecords };
      if (!agentVisibleInTeam(snap, s.currentTeamId)) {
        if (!records[snap.id]) return s;
        delete records[snap.id];
      } else {
        records[snap.id] = { ...records[snap.id], ...snap };
      }
      const { agents, visibleAgents } = buildAgentMaps(Object.values(records), s.currentTeamId);
      return { agentRecords: records, agents, visibleAgents };
    });
  },
  addAgent(agent) {
    set((s) => {
      const records = { ...s.agentRecords, [agent.id]: agent };
      const { agents, visibleAgents } = buildAgentMaps(Object.values(records), s.currentTeamId);
      return { agentRecords: records, agents, visibleAgents };
    });
  },
  updateAgent(id, patch) {
    set((s) => {
      const cur = s.agentRecords[id];
      if (!cur) return s;
      const records = { ...s.agentRecords, [id]: { ...cur, ...patch } };
      const { agents, visibleAgents } = buildAgentMaps(Object.values(records), s.currentTeamId);
      return { agentRecords: records, agents, visibleAgents };
    });
  },
  applyChannelsSnapshot(list) { set({ channels: list }); },
  applyDmsSnapshot(list) { set({ dms: list }); },
  applyChannelHistory(channelId, msgs) {
    set((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [channelId]: mergeChannelHistory(msgs, s.messagesByChannel[channelId] ?? []),
      },
    }));
  },
  appendMessage(msg) {
    set((s) => {
      const list = s.messagesByChannel[msg.channelId] ?? [];
      const activityMessages = mergeActivityMessages(s.activityMessages, [msg]);
      const existingIndex = list.findIndex((item) => item.id === msg.id);
      if (existingIndex >= 0) {
        const next = list.map((item, index) => index === existingIndex
          ? {
              ...item,
              ...msg,
              dispatchStatus: msg.dispatchStatus ?? item.dispatchStatus,
              dispatchId: msg.dispatchId ?? item.dispatchId,
            }
          : item);
        return { messagesByChannel: { ...s.messagesByChannel, [msg.channelId]: next }, activityMessages };
      }
      return { messagesByChannel: { ...s.messagesByChannel, [msg.channelId]: [...list, msg] }, activityMessages };
    });
  },
  applyDispatchStatus(channelId, messageId, dispatchStatus, dispatchId) {
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return s;
      let changed = false;
      const next = list.map((msg) => {
        if (msg.id !== messageId) return msg;
        changed = true;
        return {
          ...msg,
          dispatchStatus,
          ...(dispatchId !== undefined ? { dispatchId } : {}),
        };
      });
      if (!changed) return s;
      return { messagesByChannel: { ...s.messagesByChannel, [channelId]: next } };
    });
  },
  upsertMessages(msgs) {
    set((s) => ({ messagesByChannel: mergeMessagesByChannel(s.messagesByChannel, msgs) }));
  },
  upsertActivityMessages(msgs) {
    set((s) => ({ activityMessages: mergeActivityMessages(s.activityMessages, msgs) }));
  },
  addOutbound(msg) { set((s) => ({ outbox: { ...s.outbox, [msg.id]: msg } })); },
  resolveOutbound(id, status) {
    set((s) => {
      const cur = s.outbox[id];
      if (!cur) return s;
      return { outbox: { ...s.outbox, [id]: { ...cur, status } } };
    });
  },
  setDiscovered(list) { set({ discovered: list }); },
  setRuntimes(list) { set({ runtimes: list }); },
  setDiscovering(v) { set({ discovering: v }); },
  applyTeamsSnapshot(list) { set({ teams: list }); },
  setCurrentTeamId(id) {
    set((s) => {
      if (s.currentTeamId === id) return s;
      return {
        currentTeamId: id,
        agents: {},
        agentRecords: {},
        visibleAgents: [],
        channels: [],
        dms: [],
        messagesByChannel: {},
        activityMessages: [],
        outbox: {},
        agentMetrics: {},
        devices: {},
        humans: [],
      };
    });
  },
  setCurrentUser(user) { set({ currentUser: user }); },
  setAuthToken(token) { set({ authToken: token }); },
  addTeam(n) { set((s) => ({ teams: [...s.teams, n] })); },
  applyAgentMetrics(list) {
    const map: Record<string, AgentMetricsSummary> = {};
    for (const m of list) map[m.agentId] = m;
    set({ agentMetrics: map });
  },
  applyDevicesSnapshot(list) {
    const map: Record<string, DeviceInfo> = {};
    for (const d of list) map[d.id] = d;
    set({ devices: map });
  },
  upsertDevice(device) {
    set((s) => {
      if (device.teamId && device.teamId !== s.currentTeamId) return s;
      return { devices: { ...s.devices, [device.id]: { ...s.devices[device.id], ...device } } };
    });
  },
  applyDeviceStatus(device) {
    set((s) => {
      if (device.teamId && device.teamId !== s.currentTeamId) {
        const existing = s.devices[device.id];
        if (!existing) return s;
        return { devices: { ...s.devices, [device.id]: { ...existing, ...device } } };
      }
      return { devices: { ...s.devices, [device.id]: { ...s.devices[device.id], ...device } } };
    });
  },
  applyHumansSnapshot(list, teamId) {
    set((s) => {
      if (teamId && s.currentTeamId !== teamId) return s;
      return { humans: list };
    });
  },
  upsertHuman(human) {
    set((s) => {
      const idx = s.humans.findIndex((h) => h.userId === human.userId);
      if (idx === -1) return { humans: [...s.humans, human] };
      const next = [...s.humans];
      next[idx] = { ...next[idx], ...human };
      return { humans: next };
    });
  },
  removeHuman(userId) {
    set((s) => ({ humans: s.humans.filter((h) => h.userId !== userId) }));
  },
}));

export function useCurrentTeamPath(): string {
  const teams = useAgentBeanStore((s) => s.teams);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  return teams.find((n) => n.id === currentTeamId)?.path ?? 'default';
}
