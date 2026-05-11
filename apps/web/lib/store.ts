'use client';
import { create } from 'zustand';
import type { AgentSnapshot, ChannelSummary, ChatMessage, ConnState, OutboundMessage, DiscoveredAgent, RuntimeInfo, NetworkSummary, AgentMetricsSummary, UserInfo, DeviceInfo } from './schema.js';
import type { DmChannel } from './socket.js';

interface State {
  conn: ConnState;
  agents: Record<string, AgentSnapshot>;
  channels: ChannelSummary[];
  dms: DmChannel[];
  messagesByChannel: Record<string, ChatMessage[]>;
  outbox: Record<string, OutboundMessage>;
  discovered: DiscoveredAgent[];
  runtimes: RuntimeInfo[];
  discovering: boolean;
  networks: NetworkSummary[];
  currentNetworkId: string;
  currentUser: UserInfo | null;
  authToken: string | null;
  agentMetrics: Record<string, AgentMetricsSummary>;
  devices: Record<string, DeviceInfo>;
  setConn(c: ConnState): void;
  applyAgentsSnapshot(list: AgentSnapshot[]): void;
  applyAgentStatus(snap: AgentSnapshot): void;
  addAgent(agent: AgentSnapshot): void;
  updateAgent(id: string, patch: Partial<AgentSnapshot>): void;
  applyChannelsSnapshot(list: ChannelSummary[]): void;
  applyDmsSnapshot(list: DmChannel[]): void;
  applyChannelHistory(channelId: string, msgs: ChatMessage[]): void;
  appendMessage(msg: ChatMessage): void;
  addOutbound(msg: OutboundMessage): void;
  resolveOutbound(id: string, status: 'sent' | 'failed'): void;
  setDiscovered(list: DiscoveredAgent[]): void;
  setRuntimes(list: RuntimeInfo[]): void;
  setDiscovering(v: boolean): void;
  applyNetworksSnapshot(list: NetworkSummary[]): void;
  setCurrentNetworkId(id: string): void;
  setCurrentUser(user: UserInfo | null): void;
  setAuthToken(token: string | null): void;
  addNetwork(n: NetworkSummary): void;
  applyAgentMetrics(list: AgentMetricsSummary[]): void;
  applyDevicesSnapshot(list: DeviceInfo[]): void;
}

export const useAgentBeanStore = create<State>((set) => ({
  conn: 'connecting',
  agents: {},
  channels: [],
  dms: [],
  messagesByChannel: {},
  outbox: {},
  discovered: [],
  runtimes: [],
  discovering: false,
  networks: [],
  currentNetworkId: 'default',
  currentUser: null,
  authToken: null,
  agentMetrics: {},
  devices: {},
  setConn(conn) { set({ conn }); },
  applyAgentsSnapshot(list) {
    const map: Record<string, AgentSnapshot> = {};
    for (const a of list) map[a.id] = a;
    set({ agents: map });
  },
  applyAgentStatus(snap) {
    set((s) => ({ agents: { ...s.agents, [snap.id]: snap } }));
  },
  addAgent(agent) {
    set((s) => ({ agents: { ...s.agents, [agent.id]: agent } }));
  },
  updateAgent(id, patch) {
    set((s) => {
      const cur = s.agents[id];
      if (!cur) return s;
      return { agents: { ...s.agents, [id]: { ...cur, ...patch } } };
    });
  },
  applyChannelsSnapshot(list) { set({ channels: list }); },
  applyDmsSnapshot(list) { set({ dms: list }); },
  applyChannelHistory(channelId, msgs) {
    set((s) => ({ messagesByChannel: { ...s.messagesByChannel, [channelId]: msgs } }));
  },
  appendMessage(msg) {
    set((s) => {
      const list = s.messagesByChannel[msg.channelId] ?? [];
      return { messagesByChannel: { ...s.messagesByChannel, [msg.channelId]: [...list, msg] } };
    });
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
  applyNetworksSnapshot(list) { set({ networks: list }); },
  setCurrentNetworkId(id) { set({ currentNetworkId: id }); },
  setCurrentUser(user) { set({ currentUser: user }); },
  setAuthToken(token) { set({ authToken: token }); },
  addNetwork(n) { set((s) => ({ networks: [...s.networks, n] })); },
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
}));

export function useCurrentNetworkPath(): string {
  const networks = useAgentBeanStore((s) => s.networks);
  const currentNetworkId = useAgentBeanStore((s) => s.currentNetworkId);
  return networks.find((n) => n.id === currentNetworkId)?.path ?? 'default';
}