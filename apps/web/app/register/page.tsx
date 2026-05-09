'use client';

import { useEffect, useState } from 'react';
import { Search, Bot } from 'lucide-react';
import { useAgentBeanStore } from '@/lib/store';
import { getWebSocket, agentEvents } from '@/lib/socket';
import type { DiscoveredAgent, AgentCategory } from '@/lib/schema';
import { RegisterAgentModal } from '@/components/register-agent-modal';

const CATEGORY_LABEL: Record<AgentCategory, string> = {
  'executor-hosted': '执行器托管',
  'agentos-hosted': 'AgentOS 托管',
  'standalone-cli': '独立 CLI',
};

const CATEGORY_ORDER: AgentCategory[] = ['executor-hosted', 'agentos-hosted', 'standalone-cli'];

const SOURCE_LABEL: Record<DiscoveredAgent['source'], string> = {
  gateway: 'gateway',
  filesystem: 'filesystem',
};

const SOURCE_STYLE: Record<DiscoveredAgent['source'], string> = {
  gateway: 'bg-purple-50 text-purple-600 border-purple-100',
  filesystem: 'bg-amber-50 text-amber-600 border-amber-100',
};

function generateAgentId(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export default function RegisterPage() {
  const discovered = useAgentBeanStore((s) => s.discovered);
  const existingAgents = useAgentBeanStore((s) => s.agents);
  const discovering = useAgentBeanStore((s) => s.discovering);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<DiscoveredAgent | null>(null);
  const [modalMode, setModalMode] = useState<'create' | 'update'>('create');

  useEffect(() => {
    const socket = getWebSocket();
    const ev = agentEvents(socket);

    const unsubDiscovered = ev.onDiscovered((payload) => {
      useAgentBeanStore.getState().setDiscovered(payload.agents ?? []);
      useAgentBeanStore.getState().setRuntimes(payload.runtimes ?? []);
      useAgentBeanStore.getState().setDiscovering(false);
    });

    return () => {
      unsubDiscovered();
    };
  }, []);

  const handleDiscover = () => {
    useAgentBeanStore.getState().setDiscovering(true);
    useAgentBeanStore.getState().setDiscovered([]);
    const socket = getWebSocket();
    socket.emit('agents:discover');
  };

  const handleRegister = (agent: DiscoveredAgent) => {
    const id = generateAgentId(agent.name);
    const exists = id in existingAgents;
    setModalMode(exists ? 'update' : 'create');
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
          <p className="mt-1 text-sm text-neutral-500">扫描本机已安装的 Agent 并注册到 Mesh</p>
        </div>
        <button
          onClick={handleDiscover}
          disabled={discovering}
          className="inline-flex items-center gap-1.5 rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          <Search size={16} />
          {discovering ? '扫描中...' : '扫描本机 Agent'}
        </button>
      </div>

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
                        const id = generateAgentId(agent.name);
                        const exists = id in existingAgents;
                        return exists ? (
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
        onClose={() => {
          setModalOpen(false);
          setSelectedAgent(null);
        }}
        discoveredAgent={selectedAgent}
        mode={modalMode}
      />
    </div>
  );
}
