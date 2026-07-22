'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  FormalMemoryDetailDto,
  FormalMemoryDto,
  FormalMemoryKind,
  FormalMemoryListDto,
  FormalMemoryScopeType,
  LocalMemoryGovernanceSummaryDto,
  MemoryGovernanceSnapshotDto,
  MemoryKind,
  MemoryScopeType,
} from '@agentbean/contracts';
import { AlertTriangle, Check, Database, KeyRound, Laptop, Loader2, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { getWebSocket, memoryEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import {
  FORMAL_KIND_OPTIONS,
  FORMAL_SCOPE_OPTIONS,
  formalStatusLabel,
  validateCorrectionForm,
  validateFormalMemoryForm,
} from '@/lib/formal-memory-form';

type MemoryTab = 'formal' | 'memories' | 'candidates' | 'grants' | 'capsules' | 'local';
type LoadState = 'loading' | 'ready' | 'permission-denied' | 'error';

const TABS: Array<{ id: MemoryTab; label: string }> = [
  { id: 'formal', label: 'Formal Memory' },
  { id: 'memories', label: '协作 Memory' },
  { id: 'candidates', label: 'Candidate / 冲突' },
  { id: 'grants', label: '授权' },
  { id: 'capsules', label: 'Capsule / Invocation' },
  { id: 'local', label: '当前 Device' },
];
const KINDS: MemoryKind[] = ['semantic', 'episodic', 'procedural', 'preference', 'decision', 'artifact-summary'];
const SCOPES: MemoryScopeType[] = ['team', 'channel', 'dm', 'task', 'agent', 'user'];

export function MemoryGovernancePanel() {
  const teamId = useAgentBeanStore((state) => state.currentTeamId);
  const agents = useAgentBeanStore((state) => state.agents);
  const [tab, setTab] = useState<MemoryTab>('memories');
  const [snapshot, setSnapshot] = useState<MemoryGovernanceSnapshotDto | null>(null);
  const [local, setLocal] = useState<readonly LocalMemoryGovernanceSummaryDto[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [localState, setLocalState] = useState<'idle' | 'loading' | 'ready' | 'offline' | 'attestation-required' | 'denied' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!teamId) return;
    if (!quiet) setState('loading');
    const result = await memoryEvents().snapshot(teamId);
    if (result.ok && result.snapshot) {
      setSnapshot(result.snapshot);
      setState('ready');
      setMessage('');
      return;
    }
    const error = result.error ?? result.message ?? '加载失败';
    setMessage(error);
    setState(error.includes('PERMISSION') || error === 'FORBIDDEN' ? 'permission-denied' : 'error');
    setSnapshot(null);
  }, [teamId]);

  const loadLocal = useCallback(async () => {
    if (!teamId) return;
    setLocalState('loading');
    const result = await memoryEvents().localSummaries(teamId);
    if (result.ok) {
      setLocal(result.summaries ?? []);
      setLocalState('ready');
      return;
    }
    if (result.error === 'DEVICE_OFFLINE') setLocalState('offline');
    else if (result.error === 'DEVICE_ATTESTATION_REQUIRED') setLocalState('attestation-required');
    else if (result.error === 'PERMISSION_DENIED') setLocalState('denied');
    else setLocalState('error');
    setLocal([]);
  }, [teamId]);

  useEffect(() => {
    void load();
    const socket = getWebSocket();
    setConnected(socket.connected);
    const api = memoryEvents(socket);
    const onConnect = () => { setConnected(true); void load(true); };
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    const offChanged = api.onChanged((payload) => {
      if (payload.teamId === teamId) void load(true);
    });
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      offChanged();
    };
  }, [load, teamId]);

  useEffect(() => {
    if (tab === 'local' && localState === 'idle') void loadLocal();
  }, [loadLocal, localState, tab]);

  const mutate = async (operation: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    setMessage('');
    const result = await operation();
    if (!result.ok) {
      setMessage(friendlyError(result.error ?? result.message));
      return false;
    }
    await load(true);
    return true;
  };

  if (state === 'loading') return <StateCard icon={<Loader2 className="animate-spin" size={20} />} title="正在加载 Memory 治理数据" />;
  if (state === 'permission-denied') return <StateCard icon={<ShieldAlert size={20} />} title="无权查看该 Team 的 Memory" detail="权限变化后已 fail closed；重新获得 Team/Channel/DM/Task 访问权后会自动刷新。" />;
  if (state === 'error' || !snapshot) return <StateCard icon={<AlertTriangle size={20} />} title="Memory 治理数据加载失败" detail={message} action={<button onClick={() => void load()} className="rounded-md border px-3 py-1.5 text-xs">重试</button>} />;

  return (
    <div className="mx-auto max-w-5xl space-y-5" data-smoke="memory-governance-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><Database size={20} /><h2 className="text-xl font-semibold">Memory 治理</h2></div>
          <p className="mt-1 text-sm text-neutral-500">协作内容由 Server 按当前权限过滤；本地正文始终留在当前 Device。</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          {connected ? '实时同步' : '正在重连'}
          <button onClick={() => void load()} className="ml-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-neutral-50"><RefreshCw size={12} />刷新</button>
        </div>
      </div>

      {!connected && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">连接已断开。当前数据只读，重连后会重新按权限加载。</div>}
      {message && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-smoke="memory-governance-error">{message}</div>}

      <div className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === item.id ? 'border-neutral-900 font-medium' : 'border-transparent text-neutral-500'}`} data-smoke={`memory-tab-${item.id}`}>{item.label}</button>)}
      </div>

      {tab === 'formal' && <FormalMemorySection teamId={teamId!} />}
      {tab === 'memories' && <MemoriesSection snapshot={snapshot} teamId={teamId!} mutate={mutate} />}
      {tab === 'candidates' && <CandidatesSection snapshot={snapshot} teamId={teamId!} mutate={mutate} />}
      {tab === 'grants' && <GrantsSection snapshot={snapshot} teamId={teamId!} agents={agents} mutate={mutate} />}
      {tab === 'capsules' && <CapsulesSection snapshot={snapshot} agents={agents} />}
      {tab === 'local' && <LocalSection state={localState} items={local} reload={loadLocal} />}
    </div>
  );
}

function MemoriesSection({ snapshot, teamId, mutate }: { snapshot: MemoryGovernanceSnapshotDto; teamId: string; mutate: Mutation }) {
  const [creating, setCreating] = useState(false);
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [kind, setKind] = useState<MemoryKind>('semantic');
  const [scopeType, setScopeType] = useState<MemoryScopeType>('team');
  const [scopeRef, setScopeRef] = useState(teamId);
  const create = async () => {
    if (!content.trim()) return;
    const ok = await mutate(() => memoryEvents().create({ teamId, kind, scopeType, scopeRef: scopeType === 'team' ? teamId : scopeRef.trim(), content: content.trim(), ...(summary.trim() ? { summary: summary.trim() } : {}) }));
    if (ok) { setContent(''); setSummary(''); setCreating(false); }
  };
  return <div className="space-y-3">
    <div className="flex justify-between"><p className="text-sm text-neutral-500">{snapshot.memories.length} 条可见记录</p><button onClick={() => setCreating((value) => !value)} className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white" data-smoke="memory-create-toggle"><Plus size={13} />新增</button></div>
    {creating && <section className="grid gap-3 rounded-lg border bg-neutral-50 p-4 md:grid-cols-2" data-smoke="memory-create-form">
      <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} className="rounded-md border bg-white px-3 py-2 text-sm">{KINDS.map((value) => <option key={value}>{value}</option>)}</select>
      <div className="flex gap-2"><select value={scopeType} onChange={(event) => setScopeType(event.target.value as MemoryScopeType)} className="rounded-md border bg-white px-3 py-2 text-sm">{SCOPES.map((value) => <option key={value}>{value}</option>)}</select><input value={scopeType === 'team' ? teamId : scopeRef} disabled={scopeType === 'team'} onChange={(event) => setScopeRef(event.target.value)} placeholder="scope ID" className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm" /></div>
      <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Memory 正文" className="min-h-24 rounded-md border px-3 py-2 text-sm md:col-span-2" data-smoke="memory-create-content" />
      <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="可选摘要" className="rounded-md border px-3 py-2 text-sm" />
      <button onClick={() => void create()} disabled={!content.trim()} className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-40" data-smoke="memory-create-submit">创建 Memory</button>
    </section>}
    {snapshot.memories.length === 0 ? <Empty title="暂无协作 Memory" /> : snapshot.memories.map((item) => <article key={item.id} className="rounded-lg border p-4" data-smoke="memory-record">
      <div className="flex flex-wrap items-center gap-2"><Status value={item.status} /><span className="text-xs text-neutral-500">{item.kind} · {item.scopeType}:{short(item.scopeRef)}</span>{item.sourceState === 'source-invalid' && <Status value="source-invalid" warn />}</div>
      <p className="mt-3 whitespace-pre-wrap text-sm">{item.content}</p>{item.summary && <p className="mt-1 text-xs text-neutral-500">摘要：{item.summary}</p>}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">{item.sourceRefs.map((source) => <span key={`${source.sourceKind}:${source.sourceId}`} className="rounded bg-neutral-100 px-2 py-1">{source.sourceKind}:{short(source.sourceId)}</span>)}</div>
      {(item.status === 'active' || item.status === 'candidate') && <div className="mt-4 flex flex-wrap gap-2">
        <Action label="编辑" onClick={() => { const content = window.prompt('编辑 Memory 正文', item.content); if (content !== null && content.trim()) void mutate(() => memoryEvents().update({ teamId, memoryId: item.id, expectedUpdatedAt: item.updatedAt, content: content.trim() })); }} />
        {item.status === 'active' && <Action label="停用" onClick={() => void mutate(() => memoryEvents().expire(teamId, item.id))} />}
        {item.status === 'active' && <Action label="替代" onClick={() => { const content = window.prompt('新 Memory 正文'); if (content?.trim()) void mutate(() => memoryEvents().supersede({ teamId, memoryId: item.id, content: content.trim() })); }} />}
        <Action label="软删除" danger onClick={() => void mutate(() => memoryEvents().delete(teamId, item.id))} />
      </div>}
    </article>)}
  </div>;
}

function CandidatesSection({ snapshot, teamId, mutate }: { snapshot: MemoryGovernanceSnapshotDto; teamId: string; mutate: Mutation }) {
  return <div className="space-y-3">{snapshot.candidates.length === 0 ? <Empty title="暂无待治理 Candidate" /> : snapshot.candidates.map((candidate) => <article key={candidate.id} className="rounded-lg border p-4" data-smoke="memory-candidate">
    <div className="flex flex-wrap items-center gap-2"><Status value={candidate.status} warn={candidate.status === 'conflict'} />{candidate.sourceState === 'source-invalid' && <Status value="source-invalid" warn />}<span className="text-xs text-neutral-500">影响：{candidate.scopeType}:{short(candidate.scopeRef)}</span></div>
    <p className="mt-3 text-sm">{candidate.proposedContent}</p>
    <p className="mt-2 text-xs text-neutral-500">来源 Invocation：{short(candidate.sourceInvocationId)} · projection {short(candidate.projectionHash)}</p>
    {candidate.conflictMemoryIds.length > 0 && <p className="mt-2 text-xs text-amber-700">冲突：{candidate.conflictMemoryIds.map(short).join('、')}</p>}
    {(candidate.status === 'candidate' || candidate.status === 'conflict') && <div className="mt-4 flex gap-2">
      {candidate.status === 'candidate' && <Action label="接受" onClick={() => void mutate(() => memoryEvents().acceptCandidate({ teamId, candidateId: candidate.id, kind: candidateKind(candidate.contentKind) }))} />}
      <Action label="拒绝" danger onClick={() => void mutate(() => memoryEvents().rejectCandidate(teamId, candidate.id))} />
      {candidate.status === 'conflict' && candidate.conflictMemoryIds.map((memoryId) => <Action key={memoryId} label={`合并到 ${short(memoryId)}`} onClick={() => void mutate(() => memoryEvents().mergeCandidate(teamId, candidate.id, memoryId))} />)}
    </div>}
  </article>)}</div>;
}

function GrantsSection({ snapshot, teamId, agents, mutate }: { snapshot: MemoryGovernanceSnapshotDto; teamId: string; agents: Record<string, { name?: string }>; mutate: Mutation }) {
  const [scopeRef, setScopeRef] = useState(teamId);
  const [targetAgentId, setTargetAgentId] = useState('');
  const issue = () => mutate(() => memoryEvents().issueGrant({ teamId, sourceScopeType: 'team', sourceScopeRef: scopeRef, targetAgentId, authorizedContentKind: 'summary', authorizedRedactionLevel: 'summary-only', expiresAt: Date.now() + 7 * 86400000 }));
  return <div className="space-y-3">
    <section className="flex flex-wrap gap-2 rounded-lg border bg-neutral-50 p-3" data-smoke="memory-grant-form"><input value={scopeRef} onChange={(event) => setScopeRef(event.target.value)} className="min-w-48 flex-1 rounded-md border px-3 py-2 text-sm" placeholder="来源 scope ID" /><select value={targetAgentId} onChange={(event) => setTargetAgentId(event.target.value)} className="min-w-48 rounded-md border bg-white px-3 py-2 text-sm"><option value="">选择目标 Agent</option>{Object.entries(agents).map(([id, agent]) => <option key={id} value={id}>{agent.name ?? id}</option>)}</select><button disabled={!targetAgentId || !scopeRef} onClick={() => void issue()} className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-40"><KeyRound size={14} className="mr-1 inline" />签发 7 天 grant</button></section>
    {snapshot.grants.length === 0 ? <Empty title="暂无显式 grant" /> : snapshot.grants.map((grant) => <article key={grant.id} className="rounded-lg border p-4"><div className="flex items-center gap-2"><Status value={grant.status} warn={grant.status !== 'active'} /><span className="text-xs text-neutral-500">v{grant.version} · 到期 {new Date(grant.expiresAt).toLocaleString()}</span></div><p className="mt-2 text-sm">{grant.sourceScopeType}:{short(grant.sourceScopeRef)} → {agents[grant.targetAgentId]?.name ?? short(grant.targetAgentId)}</p>{grant.status === 'active' && <div className="mt-3"><Action label="撤销" danger onClick={() => void mutate(() => memoryEvents().revokeGrant(teamId, grant.id))} /></div>}</article>)}
  </div>;
}

function CapsulesSection({ snapshot, agents }: { snapshot: MemoryGovernanceSnapshotDto; agents: Record<string, { name?: string }> }) {
  return <div className="space-y-3">{snapshot.capsules.length === 0 ? <Empty title="暂无 Capsule / Invocation" /> : snapshot.capsules.map((capsule) => {
    const invocations = snapshot.invocations.filter((invocation) => invocation.capsuleRef?.id === capsule.id);
    return <article key={capsule.id} className="rounded-lg border p-4" data-smoke="memory-capsule"><div className="flex flex-wrap items-center gap-2"><Status value={capsule.state} warn={capsule.state !== 'active'} /><span className="text-xs text-neutral-500">Capsule {short(capsule.id)} · {agents[capsule.targetAgentId]?.name ?? short(capsule.targetAgentId)}</span></div><p className="mt-2 text-xs text-neutral-500">授权决策 {short(capsule.authorizationDecisionId)} · 到期 {new Date(capsule.expiresAt).toLocaleString()}{capsule.deniedAt ? ' · 拒绝理由：授权已撤销或事实已漂移' : ''}</p><div className="mt-3 space-y-2">{capsule.items.map((item) => <div key={`${item.position}:${item.memoryId}`} className="rounded bg-neutral-50 px-3 py-2 text-xs"><span>{item.position + 1}. {short(item.memoryId)} · {item.scopeType}:{short(item.scopeRef)}</span><span className="ml-2 text-neutral-500">policy v{item.authorization.policyVersion}{item.authorization.grantVersion ? ` / grant v${item.authorization.grantVersion}` : ''} · {item.redactionLevel}</span></div>)}</div>{invocations.map((invocation) => <div key={invocation.id} className="mt-3 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">Invocation {short(invocation.id)} · Run {short(invocation.managementRunId)}{invocation.taskId ? ` · Task ${short(invocation.taskId)}` : ''}</div>)}</article>;
  })}</div>;
}

function LocalSection({ state, items, reload }: { state: string; items: readonly LocalMemoryGovernanceSummaryDto[]; reload(): Promise<void> }) {
  if (state === 'loading') return <StateCard icon={<Loader2 className="animate-spin" size={20} />} title="正在向当前 Device 请求治理摘要" />;
  if (state === 'offline') return <StateCard icon={<Laptop size={20} />} title="当前 Device 离线" detail="重连 daemon 后再试；Server 没有本地 Memory 正文副本。" action={<button onClick={() => void reload()} className="rounded-md border px-3 py-1.5 text-xs">重试</button>} />;
  if (state === 'attestation-required') return <StateCard icon={<KeyRound size={20} />} title="需要重新关联当前 Device" detail="升级后的本地摘要需要 Device 凭证。请从当前 daemon 的 onboarding link 重新完成设备关联。" action={<a href="./devices" className="rounded-md border px-3 py-1.5 text-xs">前往设备页</a>} />;
  if (state === 'denied') return <StateCard icon={<ShieldAlert size={20} />} title="当前 Device 未授权" detail="只允许浏览器查看自身已保存 Device identity 对应的治理摘要。" />;
  if (state === 'error') return <StateCard icon={<AlertTriangle size={20} />} title="本地 Memory 摘要不可用" action={<button onClick={() => void reload()} className="rounded-md border px-3 py-1.5 text-xs">重试</button>} />;
  return <div className="space-y-3"><div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"><Check size={14} className="mr-1 inline" />仅展示 daemon 明确返回的摘要；正文、结构化内容与完整路径未回传。</div>{items.length === 0 ? <Empty title="当前 Device 暂无可治理摘要" /> : items.map((item) => <article key={item.id} className="rounded-lg border p-4" data-smoke="local-memory-summary"><div className="flex items-center gap-2"><Status value={item.status} warn={item.status !== 'active'} /><span className="text-xs text-neutral-500">{item.kind} · {item.scopeType} · {item.sourceKind}</span></div><p className="mt-2 text-sm">{item.summary}</p>{item.workspaceLabel && <p className="mt-1 text-xs text-neutral-400">Workspace：{item.workspaceLabel}</p>}</article>)}</div>;
}

/** Formal Memory Center（issue #716）：Team/Channel 正式记忆的产品入口。 */
function FormalMemorySection({ teamId }: { teamId: string }) {
  const [scopeType, setScopeType] = useState<FormalMemoryScopeType>('team');
  const [scopeRef, setScopeRef] = useState(teamId);
  const [list, setList] = useState<FormalMemoryListDto | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<FormalMemoryKind>('fact');
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [detail, setDetail] = useState<FormalMemoryDetailDto | null>(null);

  const ref = scopeType === 'team' ? teamId : scopeRef.trim();

  const load = useCallback(async () => {
    if (!ref) return;
    setState('loading');
    const res = await memoryEvents().formalList({ teamId, scopeType, scopeRef: ref });
    if (res.ok && res.list) { setList(res.list); setState('ready'); setMessage(''); return; }
    const error = res.error ?? res.message ?? '加载失败';
    setMessage(error);
    setState(error === 'FORBIDDEN' ? 'denied' : 'error');
    setList(null);
  }, [teamId, scopeType, ref]);

  useEffect(() => {
    void load();
    const api = memoryEvents();
    const off = api.onChanged((payload) => { if (payload.teamId === teamId) void load(); });
    return () => { off(); };
  }, [load, teamId]);

  const openDetail = async (memoryId: string) => {
    const res = await memoryEvents().formalDetail({ teamId, memoryId });
    if (res.ok && res.memory) setDetail(res.memory);
  };

  const canManage = list?.canManage ?? false;
  const canPropose = list?.canProposeCorrection ?? false;

  const create = async () => {
    const err = validateFormalMemoryForm({ kind, content, summary, changeReason });
    if (err) { setMessage(err); return; }
    const res = await memoryEvents().formalCreate({
      teamId, kind, scopeType, scopeRef: ref, content: content.trim(),
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      ...(changeReason.trim() ? { changeReason: changeReason.trim() } : {}),
    });
    if (!res.ok) { setMessage(res.error ?? res.message ?? '创建失败'); return; }
    setContent(''); setSummary(''); setChangeReason(''); setCreating(false); setMessage('');
    void load();
  };

  const revise = async (item: FormalMemoryDto) => {
    const next = window.prompt('修订 Formal Memory 正文', item.content);
    if (next === null || !next.trim()) return;
    const reason = window.prompt('修订原因（必填，AC#4）') ?? '';
    if (!reason.trim()) { setMessage('修订必须填写原因'); return; }
    const res = await memoryEvents().formalRevise({ teamId, memoryId: item.id, content: next.trim(), changeReason: reason.trim() });
    if (!res.ok) setMessage(res.error ?? res.message ?? '修订失败');
    else { setMessage(''); void load(); }
  };

  const deactivate = async (item: FormalMemoryDto) => {
    const reason = window.prompt('停用原因（必填，与「时间过期」区分）') ?? '';
    if (!reason.trim()) { setMessage('停用必须填写原因'); return; }
    const res = await memoryEvents().formalDeactivate({ teamId, memoryId: item.id, changeReason: reason.trim() });
    if (!res.ok) setMessage(res.error ?? res.message ?? '停用失败');
    else { setMessage(''); void load(); }
  };

  const remove = async (item: FormalMemoryDto) => {
    if (!window.confirm('确认删除该 Formal Memory？')) return;
    const res = await memoryEvents().formalDelete({ teamId, memoryId: item.id });
    if (!res.ok) setMessage(res.error ?? res.message ?? '删除失败');
    else { setMessage(''); void load(); }
  };

  const submitCorrection = async (item: FormalMemoryDto) => {
    const reason = window.prompt('纠错理由（必填）') ?? '';
    if (!reason.trim()) { setMessage('纠错必须填写理由'); return; }
    const next = window.prompt('正确的 Formal Memory 正文', item.content) ?? '';
    const err = validateCorrectionForm({ content: next, reason });
    if (err) { setMessage(err); return; }
    const res = await memoryEvents().proposeCorrection({
      teamId, scopeType, scopeRef: ref, targetMemoryId: item.id,
      correctionType: 'revise', kind: item.kind, content: next.trim(), reason: reason.trim(),
    });
    if (!res.ok) setMessage(res.error ?? res.message ?? '提交失败');
    else setMessage('纠错已提交，待 Owner/Admin 审批');
  };

  const accept = async (item: FormalMemoryDto) => {
    const res = await memoryEvents().formalAccept({ teamId, memoryId: item.id });
    if (!res.ok) setMessage(res.error ?? res.message ?? '接受失败');
    else { setMessage(''); void load(); }
  };

  const rejectCorrection = async (item: FormalMemoryDto) => {
    const reason = window.prompt('驳回理由（可选）');
    const res = await memoryEvents().formalReject({ teamId, memoryId: item.id, ...(reason?.trim() ? { changeReason: reason.trim() } : {}) });
    if (!res.ok) setMessage(res.error ?? res.message ?? '驳回失败');
    else { setMessage(''); void load(); }
  };

  if (state === 'loading') return <StateCard icon={<Loader2 className="animate-spin" size={20} />} title="正在加载 Formal Memory" />;
  if (state === 'denied') return <StateCard icon={<ShieldAlert size={20} />} title="无权查看该作用域的 Formal Memory" detail="Channel Memory 仅对当前频道成员可见（AC#5）。" />;
  if (state === 'error' || !list) return <StateCard icon={<AlertTriangle size={20} />} title="Formal Memory 加载失败" detail={message} action={<button onClick={() => void load()} className="rounded-md border px-3 py-1.5 text-xs">重试</button>} />;

  return (
    <div className="space-y-4" data-smoke="formal-memory-section">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-neutral-500">作用域：</span>
        <select value={scopeType} onChange={(event) => { setScopeType(event.target.value as FormalMemoryScopeType); setScopeRef(teamId); }} className="rounded-md border bg-white px-2 py-1 text-sm" data-smoke="formal-scope">
          {FORMAL_SCOPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
        {scopeType === 'channel' && <input value={scopeRef} onChange={(event) => setScopeRef(event.target.value)} placeholder="频道 ID" className="min-w-48 flex-1 rounded-md border px-2 py-1 text-sm" data-smoke="formal-channel-id" />}
        <span className="ml-auto text-xs text-neutral-500">{list.items.length} 条 · {canManage ? '可管理' : '只读'}</span>
        <button onClick={() => void load()} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-neutral-50"><RefreshCw size={12} />刷新</button>
      </div>

      {message && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-smoke="formal-memory-error">{message}</div>}

      {canManage && (creating ? (
        <section className="grid gap-3 rounded-lg border bg-neutral-50 p-4" data-smoke="formal-create-form">
          <select value={kind} onChange={(event) => setKind(event.target.value as FormalMemoryKind)} className="rounded-md border bg-white px-3 py-2 text-sm">
            {FORMAL_KIND_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Formal Memory 正文" className="min-h-24 rounded-md border px-3 py-2 text-sm" data-smoke="formal-create-content" />
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="可选摘要" className="rounded-md border px-3 py-2 text-sm" />
          <input value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder="变更原因（AC#4，可选）" className="rounded-md border px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button onClick={() => void create()} className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white" data-smoke="formal-create-submit">创建</button>
            <button onClick={() => setCreating(false)} className="rounded-md border px-3 py-2 text-sm">取消</button>
          </div>
        </section>
      ) : (
        <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white" data-smoke="formal-create-toggle"><Plus size={13} />新建 Formal Memory</button>
      ))}

      {list.items.length === 0 ? <Empty title="暂无 Formal Memory" /> : list.items.map((item) => (
        <article key={item.id} className="rounded-lg border p-4" data-smoke="formal-memory-item">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800">{FORMAL_KIND_OPTIONS.find((o) => o.value === item.kind)?.label ?? item.kind}</span>
            <Status value={formalStatusLabel(item.status, item.changeReason)} warn={item.status !== 'active' && item.status !== 'candidate'} />
            <span className="text-xs text-neutral-500">{item.scopeType}:{short(item.scopeRef)}</span>
            {item.changeReason && <span className="text-xs text-neutral-400">原因：{item.changeReason}</span>}
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm">{item.content}</p>
          {item.summary && <p className="mt-1 text-xs text-neutral-500">摘要：{item.summary}</p>}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">{item.sourceRefs.map((s) => <span key={`${s.sourceKind}:${s.sourceId}`} className="rounded bg-neutral-100 px-2 py-1">{s.sourceKind}:{short(s.sourceId)}</span>)}</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Action label="版本历史" onClick={() => { if (detailFor === item.id) { setDetailFor(null); setDetail(null); } else { setDetailFor(item.id); void openDetail(item.id); } }} />
            {canManage && item.status === 'candidate' && <>
              <Action label="接受纠错" onClick={() => void accept(item)} />
              <Action label="驳回纠错" danger onClick={() => void rejectCorrection(item)} />
            </>}
            {canManage && item.status === 'active' && <>
              <Action label="修订" onClick={() => void revise(item)} />
              <Action label="停用" onClick={() => void deactivate(item)} />
            </>}
            {canManage && (item.status === 'active' || item.status === 'candidate') && <Action label="删除" danger onClick={() => void remove(item)} />}
            {canPropose && !canManage && item.status === 'active' && <Action label="提交纠错" onClick={() => void submitCorrection(item)} />}
          </div>
          {detailFor === item.id && detail && (
            <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs" data-smoke="formal-memory-versions">
              <p className="mb-2 font-medium text-neutral-700">版本历史（{detail.versions.length}）</p>
              {detail.versions.map((v) => (
                <div key={v.versionId} className="mb-2 border-l-2 border-neutral-300 pl-2">
                  <div className="flex flex-wrap gap-2"><Status value={formalStatusLabel(v.status)} warn={v.status !== 'active'} /><span className="text-neutral-500">{new Date(v.createdAt).toLocaleString()}</span>{v.actorUserId && <span className="text-neutral-400">by {short(v.actorUserId)}</span>}</div>
                  <p className="mt-1">{v.content}</p>
                  {v.changeReason && <p className="text-neutral-400">原因：{v.changeReason}</p>}
                </div>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

type Mutation = (operation: () => Promise<{ ok: boolean; error?: string; message?: string }>) => Promise<boolean>;
function Action({ label, onClick, danger = false }: { label: string; onClick(): void; danger?: boolean }) { return <button onClick={onClick} className={`rounded-md border px-2.5 py-1 text-xs ${danger ? 'border-red-200 text-red-600 hover:bg-red-50' : 'hover:bg-neutral-50'}`}>{label}</button>; }
function Status({ value, warn = false }: { value: string; warn?: boolean }) { return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${warn ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>{value}</span>; }
function Empty({ title }: { title: string }) { return <div className="rounded-lg border border-dashed p-10 text-center text-sm text-neutral-400">{title}</div>; }
function StateCard({ icon, title, detail, action }: { icon: React.ReactNode; title: string; detail?: string; action?: React.ReactNode }) { return <div className="mx-auto mt-16 max-w-xl rounded-lg border p-6"><div className="flex items-center gap-2 font-medium">{icon}{title}</div>{detail && <p className="mt-2 text-sm text-neutral-500">{detail}</p>}{action && <div className="mt-4">{action}</div>}</div>; }
function short(value: string) { return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value; }
function friendlyError(value?: string) { if (!value) return '操作失败'; if (value.includes('SOURCE')) return '来源已失效，操作已 fail closed'; if (value.includes('PERMISSION') || value === 'FORBIDDEN') return '权限已变化，操作被拒绝'; if (value.includes('UPDATE_CONFLICT')) return '数据已更新，请刷新后重试'; return value; }
function candidateKind(contentKind: string): MemoryKind { if (contentKind === 'decision' || contentKind === 'preference' || contentKind === 'procedure') return contentKind === 'procedure' ? 'procedural' : contentKind; return contentKind === 'summary' ? 'episodic' : 'semantic'; }
