'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, Copy, Check, Monitor, Settings, Terminal, Trash2, User, X } from 'lucide-react';
import { agentEvents, fetchAgentWorkspace } from '@/lib/socket';
import { useAgentBeanStore, useCurrentTeamPath } from '@/lib/store';
import { AgentStatusBadge } from '@/components/agent-status-badge';
import { formatRelative } from '@/lib/format-time';
import type { AgentSnapshot, AgentWorkspaceRun } from '@/lib/schema';
import { AgentWorkspaceSection } from '@/components/agent-workspace-section';

export default function AgentDetailPage() {
  const params = useParams<{ teamPath: string; agentId: string }>();
  const router = useRouter();
  const agent = useAgentBeanStore((s) => s.agents[params.agentId] ?? null);
  const agentMap = useAgentBeanStore((s) => s.agents);
  const setAgents = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const upsert = useAgentBeanStore((s) => s.applyAgentStatus);
  const np = useCurrentTeamPath();
  const [copied, setCopied] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState('');
  const [configName, setConfigName] = useState('');
  const [configDescription, setConfigDescription] = useState('');
  const [configCommand, setConfigCommand] = useState('');
  const [configCwd, setConfigCwd] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const teams = useAgentBeanStore((s) => s.teams);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const routeTeamPath = typeof params.teamPath === 'string' ? params.teamPath : np;
  const routeTeam = teams.find((team) => team.path === routeTeamPath || team.id === routeTeamPath);
  const agentTeamId = agent?.networkId ?? routeTeam?.id ?? currentTeamId;
  const [workspaceRuns, setWorkspaceRuns] = useState<AgentWorkspaceRun[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  useEffect(() => {
    if (!agentTeamId) return;
    const ev = agentEvents();
    const unsubSnapshot = ev.onSnapshot(setAgents);
    const unsubStatus = ev.onStatus(upsert);
    ev.subscribe(agentTeamId);
    return () => {
      unsubSnapshot();
      unsubStatus();
    };
  }, [agentTeamId, setAgents, upsert]);

  useEffect(() => {
    if (!agent?.id || !agentTeamId) return;
    let cancelled = false;
    setWorkspaceLoading(true);
    fetchAgentWorkspace(agentTeamId, agent.id)
      .then((res) => {
        if (!cancelled && res.ok) setWorkspaceRuns(res.runs ?? []);
      })
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false);
      });
    return () => { cancelled = true; };
  }, [agent?.id, agentTeamId]);

  const openConfig = () => {
    if (!agent) return;
    setConfigName(agent.name ?? '');
    setConfigDescription(agent.description ?? '');
    setConfigCommand(agent.command ?? '');
    setConfigCwd(agent.cwd ?? '');
    setConfigError('');
    setConfigOpen(true);
  };

  const handleSaveConfig = async () => {
    if (!agent || configSaving) return;
    const name = configName.trim();
    if (!name) {
      setConfigError('名称为必填项');
      return;
    }
    if (/\s/.test(name)) {
      setConfigError('名称不能包含空格，请使用连字符（-）');
      return;
    }
    const isCustom = agent.source === 'custom';
    setConfigSaving(true);
    setConfigError('');
    const res = await agentEvents().updateConfig({
      id: agent.id,
      teamId: agentTeamId,
      name,
      adapterKind: agent.adapterKind,
      description: configDescription.trim() || null,
      ...(isCustom ? {
        command: configCommand.trim() || agent.command || 'codex',
        cwd: configCwd.trim() || null,
      } : {}),
    });
    setConfigSaving(false);
    if (res.ok) {
      upsert(res.agent ?? {
        ...agent,
        name,
        description: configDescription.trim() || undefined,
        ...(isCustom ? {
          command: configCommand.trim() || agent.command,
          cwd: configCwd.trim() || undefined,
        } : {}),
      });
      setConfigOpen(false);
      return;
    }
    setConfigError(res.error === 'NAME_HAS_SPACE' ? '名称不能包含空格，请使用连字符（-）' : res.error ?? '保存失败');
  };

  const handleDeleteAgent = async () => {
    if (!agent || deleteSaving || agent.source !== 'custom') return;
    setDeleteSaving(true);
    setDeleteError('');
    const res = await agentEvents().delete(agent.id, agentTeamId);
    setDeleteSaving(false);
    if (res.ok) {
      setAgents(Object.values(agentMap).filter((candidate) => candidate.id !== agent.id));
      setDeleteOpen(false);
      router.replace(`/${routeTeamPath || np}/agents`);
      return;
    }
    setDeleteError(res.error ?? '删除失败');
  };

  const handleCopyCommand = () => {
    if (!agent?.connectCommand) return;
    navigator.clipboard.writeText(agent.connectCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!agent) {
    return (
      <div className="p-6 text-sm text-neutral-400">
        正在加载 Agent 信息或该 Agent 还未上线。
      </div>
    );
  }

  const categoryColor: Record<string, string> = {
    coding: 'bg-blue-50 text-blue-600 border-blue-100',
    'agentos-hosted': 'bg-purple-50 text-purple-600 border-purple-100',
    'executor-hosted': 'bg-violet-50 text-violet-600 border-violet-100',
  };
  const categoryLabel: Record<string, string> = {
    coding: '编程助手',
    'agentos-hosted': 'AgentOS 托管',
    'executor-hosted': '自定义 Agent',
  };
  const canConfigureAgent = agent.source === 'custom' || agent.category === 'agentos-hosted';
  const canDeleteAgent = agent.source === 'custom';

  return (
    <div className="space-y-4 p-6" data-smoke="agent-detail" data-agent-id={agent.id} data-agent-name={agent.name}>
      <Link href={`/${np}/agents`} className="inline-flex items-center text-sm text-neutral-500 hover:text-neutral-900">
        <ArrowLeft className="mr-1 h-4 w-4" />返回 Agent 列表
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-xl font-semibold">{agent.name}</div>
            {agent.category && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${categoryColor[agent.category] ?? categoryColor['standalone-cli']}`}>
                {categoryLabel[agent.category] ?? agent.category}
              </span>
            )}
          </div>
          <div className="text-sm text-neutral-500">{agent.role || '未填写角色'}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {canConfigureAgent && (
            <button
              type="button"
              onClick={openConfig}
              data-smoke="agent-config-open"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              <Settings size={14} />
              编辑配置
            </button>
          )}
          {canDeleteAgent && (
            <button
              type="button"
              onClick={() => { setDeleteError(''); setDeleteOpen(true); }}
              data-smoke="agent-delete-open"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rose-200 px-2.5 text-sm text-rose-700 hover:bg-rose-50"
            >
              <Trash2 size={14} />
              删除
            </button>
          )}
          <AgentStatusBadge status={agent.status} />
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-6 text-sm">
        <div>
          <dt className="text-neutral-500">最近活跃</dt>
          <dd>{formatRelative(agent.lastSeenAt)}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Adapter</dt>
          <dd className="font-mono text-xs">{agent.adapterKind}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">团队</dt>
          <dd>{teams.find((net) => net.id === agent.networkId)?.name ?? '默认团队'}</dd>
        </div>
        {agent.source && (
          <div>
            <dt className="text-neutral-500">来源</dt>
            <dd>
              <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                agent.source === 'custom' ? 'bg-violet-50 text-violet-600' :
                agent.source === 'scanned' ? 'bg-cyan-50 text-cyan-600' :
                'bg-amber-50 text-amber-600'
              }`}>
                {agent.source === 'custom' ? '自定义' : agent.source === 'scanned' ? '自动扫描' : '自注册'}
              </span>
            </dd>
          </div>
        )}
      </dl>

      {/* 设备信息 */}
      <section className="rounded-lg border border-neutral-200 p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
          <Monitor size={14} />设备信息
        </h3>
        {agent.deviceId ? (
          <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-6 text-sm">
            <div>
              <dt className="text-neutral-500">设备</dt>
              <dd>
                <Link href={`/${np}/devices`} className="text-blue-600 hover:underline">
                  查看关联设备
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">设备状态</dt>
              <dd>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  agent.status === 'online' || agent.status === 'busy' ? 'bg-emerald-50 text-emerald-600' :
                  agent.status === 'error' ? 'bg-red-50 text-red-600' :
                  'bg-neutral-100 text-neutral-500'
                }`}>
                  {agent.status === 'online' ? '在线' : agent.status === 'busy' ? '忙碌' : agent.status === 'error' ? '错误' : '离线'}
                </span>
              </dd>
            </div>
          </dl>
        ) : (
          <div className="text-xs text-neutral-400">此 Agent 未绑定设备（可能为自定义或虚拟 Agent）。</div>
        )}
      </section>

      {/* 运行时配置 */}
      {(agent.command || agent.ownerId) && (
        <section className="rounded-lg border border-neutral-200 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
            <Terminal size={14} />运行时配置
          </h3>
          <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-6 text-sm">
            {agent.ownerId && (
              <div>
                <dt className="text-neutral-500 flex items-center gap-1"><User size={12} />创建者</dt>
                <dd>{agent.ownerName ?? '未知'}</dd>
              </div>
            )}
            {agent.command && (
              <div className="sm:col-span-2">
                <dt className="text-neutral-500">命令</dt>
                <dd className="font-mono text-xs break-all">{agent.command}</dd>
              </div>
            )}
            {agent.args && agent.args.length > 0 && (
              <div className="sm:col-span-2">
                <dt className="text-neutral-500">参数</dt>
                <dd className="font-mono text-xs break-all">{agent.args.join(' ')}</dd>
              </div>
            )}
            {agent.cwd && (
              <div>
                <dt className="text-neutral-500">工作目录</dt>
                <dd className="font-mono text-xs break-all">{agent.cwd}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {agent.lastError && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">
          <div className="mb-1 inline-flex items-center text-red-700">
            <AlertTriangle className="mr-1 h-4 w-4" />连接错误
          </div>
          <div className="font-mono text-xs whitespace-pre-wrap break-all">{agent.lastError}</div>
        </div>
      )}

      <AgentWorkspaceSection runs={workspaceRuns} loading={workspaceLoading} />

      <section>
        <div className="mb-1 text-sm text-neutral-700 font-medium">接入命令</div>
        <div className="relative">
          <pre className="rounded bg-neutral-900 text-neutral-100 p-3 pr-10 font-mono text-xs whitespace-pre-wrap">
{agent.connectCommand}
          </pre>
          <button
            onClick={handleCopyCommand}
            className="absolute right-2 top-2 text-neutral-400 hover:text-white"
            title="复制"
          >
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
        </div>
        <div className="mt-1 text-xs text-neutral-500">
          复制该命令到本机终端，即可启动这个 Agent 的本地客户端。
        </div>
      </section>

      {configOpen && (
        <AgentConfigDialog
          agent={agent}
          name={configName}
          description={configDescription}
          command={configCommand}
          cwd={configCwd}
          saving={configSaving}
          error={configError}
          onNameChange={setConfigName}
          onDescriptionChange={setConfigDescription}
          onCommandChange={setConfigCommand}
          onCwdChange={setConfigCwd}
          onCancel={() => setConfigOpen(false)}
          onSave={handleSaveConfig}
        />
      )}

      {deleteOpen && (
        <DeleteAgentDialog
          agent={agent}
          saving={deleteSaving}
          error={deleteError}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={handleDeleteAgent}
        />
      )}
    </div>
  );
}

function AgentConfigDialog({
  agent,
  name,
  description,
  command,
  cwd,
  saving,
  error,
  onNameChange,
  onDescriptionChange,
  onCommandChange,
  onCwdChange,
  onCancel,
  onSave,
}: {
  agent: AgentSnapshot;
  name: string;
  description: string;
  command: string;
  cwd: string;
  saving: boolean;
  error: string;
  onNameChange(value: string): void;
  onDescriptionChange(value: string): void;
  onCommandChange(value: string): void;
  onCwdChange(value: string): void;
  onCancel(): void;
  onSave(): void;
}) {
  const isCustom = agent.source === 'custom';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="mx-4 w-full max-w-lg rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()} data-smoke="agent-config-dialog">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{isCustom ? '自定义 Agent 配置' : 'AgentOS Agent 配置'}</h2>
          <button type="button" onClick={onCancel} className="rounded-md p-1 hover:bg-neutral-100" aria-label="关闭配置">
            <X size={16} />
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="agent-config-name">名称</label>
            <input
              id="agent-config-name"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              data-smoke="agent-config-name"
              className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400"
            />
            <p className="mt-1 text-[11px] text-neutral-400">名称不能包含空格，可使用连字符（-）。</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="agent-config-description">功能介绍</label>
            <textarea
              id="agent-config-description"
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              data-smoke="agent-config-description"
              rows={3}
              className="w-full resize-none rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400"
              placeholder="描述这个 Agent 的用途和能力"
            />
          </div>
          {isCustom && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="agent-config-command">命令</label>
                <input
                  id="agent-config-command"
                  value={command}
                  onChange={(event) => onCommandChange(event.target.value)}
                  data-smoke="agent-config-command"
                  className="w-full rounded-md border border-neutral-200 px-3 py-1.5 font-mono text-sm outline-none focus:border-neutral-400"
                  placeholder="codex"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="agent-config-cwd">项目目录</label>
                <input
                  id="agent-config-cwd"
                  value={cwd}
                  onChange={(event) => onCwdChange(event.target.value)}
                  data-smoke="agent-config-cwd"
                  className="w-full rounded-md border border-neutral-200 px-3 py-1.5 font-mono text-sm outline-none focus:border-neutral-400"
                  placeholder="/path/to/project（可选）"
                />
              </div>
            </>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-600" data-smoke="agent-config-error">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50">取消</button>
          <button type="button" onClick={onSave} disabled={saving} data-smoke="agent-config-save" className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteAgentDialog({ agent, saving, error, onCancel, onConfirm }: {
  agent: AgentSnapshot;
  saving: boolean;
  error: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()} data-smoke="agent-delete-dialog">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-rose-50 text-rose-600">
            <Trash2 size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-neutral-950">删除 {agent.name}</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              这会删除自定义 Agent 配置，并从已发布团队和频道成员中移除；不会删除设备本身。
            </p>
          </div>
        </div>
        {error && <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" data-smoke="agent-delete-error">{error}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50">取消</button>
          <button type="button" onClick={onConfirm} disabled={saving} data-smoke="agent-delete-confirm" className="rounded-md bg-rose-600 px-4 py-2 text-sm text-white hover:bg-rose-700 disabled:opacity-50">
            {saving ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}
