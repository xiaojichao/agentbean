'use client';

import { useEffect, useState } from 'react';
import { Search, Bot } from 'lucide-react';
import { useAgentBeanStore } from '@/lib/store';
import { getWebSocket, agentEvents, deviceEvents } from '@/lib/socket';
import type { AgentSnapshot, DiscoveredAgent } from '@/lib/schema';
import { findRegisteredExecutor } from '@/lib/agent-registration';
import { RegisterAgentModal } from '@/components/register-agent-modal';

const CATEGORY_LABEL: Record<string, string> = {
  'executor-hosted': '执行器托管',
  'agentos-hosted': 'AgentOS 托管',
};

const CATEGORY_ORDER = ['executor-hosted', 'agentos-hosted'];

const SOURCE_LABEL: Record<DiscoveredAgent['source'], string> = {
  gateway: 'gateway',
  filesystem: 'filesystem',
};

const SOURCE_STYLE: Record<DiscoveredAgent['source'], string> = {
  gateway: 'bg-purple-50 text-purple-600 border-purple-100',
  filesystem: 'bg-amber-50 text-amber-600 border-amber-100',
};

export default function RegisterPage() {
  const discovered = useAgentBeanStore((s) => s.discovered);
  const existingAgents = useAgentBeanStore((s) => s.agents);
  const discovering = useAgentBeanStore((s) => s.discovering);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<DiscoveredAgent | null>(null);
  const [modalMode, setModalMode] = useState<'create' | 'update'>('create');
  const [registeredAgent, setRegisteredAgent] = useState<AgentSnapshot | null>(null);
  const [scanDeviceId, setScanDeviceId] = useState<string | null>(null);
  const [scanError, setScanError] = useState('');

  useEffect(() => {
    const socket = getWebSocket();
    const ev = agentEvents(socket);

    const unsubDiscovered = ev.onDiscovered((payload) => {
      useAgentBeanStore.getState().setDiscovered(payload.agents ?? []);
      useAgentBeanStore.getState().setRuntimes(payload.runtimes ?? []);
      useAgentBeanStore.getState().setDiscovering(false);
      setScanError('');
    });

    return () => {
      unsubDiscovered();
    };
  }, []);

  useEffect(() => {
    if (!currentTeamId || currentTeamId === 'default') {
      setScanDeviceId(null);
      return;
    }
    let cancelled = false;
    deviceEvents().list(currentTeamId).then((res) => {
      if (cancelled) return;
      const devices = res.ok ? (res.devices ?? []) : [];
      const device = devices.find((item) => item.status === 'online') ?? devices[0] ?? null;
      setScanDeviceId(device?.id ?? null);
      setScanError(device ? '' : '未找到可扫描的在线设备');
    });
    return () => {
      cancelled = true;
    };
  }, [currentTeamId]);

  const handleDiscover = async () => {
    if (!scanDeviceId) {
      setScanError('未找到可扫描的在线设备');
      return;
    }
    setScanError('');
    useAgentBeanStore.getState().setDiscovering(true);
    useAgentBeanStore.getState().setDiscovered([]);
    const res = await deviceEvents().scan(scanDeviceId);
    if (!res.ok) {
      useAgentBeanStore.getState().setDiscovering(false);
      setScanError(res.error ?? '扫描请求发送失败');
    }
  };

  const handleRegister = (agent: DiscoveredAgent) => {
    if (agent.category === 'agentos-hosted') return;
    if (!currentTeamId || !scanDeviceId) {
      setScanError('当前扫描设备或团队不可用');
      return;
    }
    const existingAgent = findRegisteredExecutor(agent, Object.values(existingAgents), scanDeviceId);
    setRegisteredAgent(existingAgent);
    setModalMode(existingAgent ? 'update' : 'create');
    setSelectedAgent(agent);
    setModalOpen(true);
  };

  const grouped = discovered.reduce<Record<string, DiscoveredAgent[]>>((acc, a) => {
    if (!acc[a.category]) acc[a.category] = [];
    acc[a.category].push(a);
    return acc;
  }, {});

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">注册 Agent</h1>
          <p className="mt-1 text-sm text-neutral-500">扫描设备上的 Agent，并将可创建的执行器注册到当前团队</p>
        </div>
        <button
          onClick={handleDiscover}
          disabled={discovering || !scanDeviceId}
          className="inline-flex items-center gap-1.5 rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          <Search size={16} />
          {discovering ? '扫描中...' : '扫描本机 Agent'}
        </button>
      </div>
      {scanError && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          {scanError}
        </div>
      )}

      {discovering && discovered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-neutral-400">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
          <p className="text-sm">正在扫描本机 Agent...</p>
        </div>
      )}

      {!discovering && discovered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-neutral-400">
          <Bot size={48} className="mb-4 opacity-30" />
          <p className="text-sm">尚未发现 Agent，点击上方按钮开始扫描</p>
        </div>
      )}

      {discovered.length > 0 && (
        <div className="space-y-8">
          {CATEGORY_ORDER.filter((cat) => grouped[cat]?.length).map((cat) => (
            <section key={cat}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
                {CATEGORY_LABEL[cat]}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {grouped[cat].map((agent, idx) => (
                  <div
                    key={`${agent.name}-${idx}`}
                    className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 text-lg font-bold text-neutral-600">
                          {agent.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-semibold text-sm">{agent.name}</div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-neutral-100 text-neutral-600 border border-neutral-200">
                              {agent.adapterKind}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${SOURCE_STYLE[agent.source]}`}
                            >
                              {SOURCE_LABEL[agent.source]}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 text-xs text-neutral-500">
                      命令: <span className="font-mono text-neutral-700">{agent.command}</span>
                    </div>

                    <div className="mt-3 flex justify-end items-center gap-2">
                      {(() => {
                        const existingAgent = scanDeviceId
                          ? findRegisteredExecutor(agent, Object.values(existingAgents), scanDeviceId)
                          : null;
                        if (agent.category === 'agentos-hosted') {
                          return <span className="text-xs font-medium text-emerald-600">已由设备自动注册</span>;
                        }
                        return existingAgent ? (
                          <>
                            <span className="text-xs text-emerald-600 font-medium">已注册</span>
                            <button
                              onClick={() => handleRegister(agent)}
                              className="rounded border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50"
                            >
                              编辑配置
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => handleRegister(agent)}
                            className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-800"
                          >
                            注册
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <RegisterAgentModal
        open={modalOpen}
        teamId={currentTeamId ?? ''}
        scanDeviceId={scanDeviceId ?? ''}
        onClose={() => {
          setModalOpen(false);
          setSelectedAgent(null);
          setRegisteredAgent(null);
        }}
        discoveredAgent={selectedAgent}
        mode={modalMode}
        registeredAgentId={registeredAgent?.id}
        initiallyVisible={registeredAgent?.visibleTeamIds.includes(currentTeamId ?? '') ?? false}
      />
    </div>
  );
}
