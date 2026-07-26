'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ChannelExperienceAttachmentDto, ExperiencePackDto } from '@agentbean/contracts';
import { Archive, Bookmark, Check, ExternalLink, Loader2, Package, Plus, RefreshCw, X } from 'lucide-react';
import { experiencePackEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

type ViewTab = 'library' | 'detail';
type LoadState = 'loading' | 'ready' | 'permission-denied' | 'error';

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-amber-100 text-amber-700' },
  approved: { label: '已批准', className: 'bg-emerald-100 text-emerald-700' },
  source_invalid: { label: '来源失效', className: 'bg-red-100 text-red-700' },
  withdrawn: { label: '已撤回', className: 'bg-neutral-100 text-neutral-500' },
};

const ATTACHMENT_LABELS: Record<string, string> = {
  pending: '待确认',
  attached: '已关联',
  revoked: '已撤销',
};

/**
 * Experience Pack 治理面板（#722/#723，US 76-79）。
 *
 * - Library：列出当前 Team 所有 Experience Pack，支持审批/撤回/列表。
 * - Detail：查看单个 Pack 详情、来源快照摘要和频道 attachment 状态，支持
 *   推荐到频道、确认 attachment、撤销 attachment。
 *
 * 权限模型（AC#3/AC#5）：
 * - Team Owner/Admin 可审批/撤回 Pack，推荐到频道。
 * - 频道成员可确认/撤销自己频道的 attachment。
 * - 不跨 Team 可见（AC#9）。
 */
export function ExperiencePackPanel() {
  const teamId = useAgentBeanStore((state) => state.currentTeamId);
  const channels = useAgentBeanStore((state) => state.channels);
  const [tab, setTab] = useState<ViewTab>('library');
  const [state, setState] = useState<LoadState>('loading');
  const [packs, setPacks] = useState<readonly ExperiencePackDto[]>([]);
  const [selectedPack, setSelectedPack] = useState<ExperiencePackDto | null>(null);
  const [attachments, setAttachments] = useState<readonly ChannelExperienceAttachmentDto[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  // ── load library ──────────────────────────────────────────────────────────

  const loadLibrary = useCallback(async () => {
    if (!teamId) return;
    setState('loading');
    setMessage('');
    const result = await experiencePackEvents().listByTeam(teamId);
    if (result.ok && result.packs) {
      setPacks(result.packs);
      setState('ready');
      return;
    }
    setMessage(result.error ?? '加载失败');
    setState(result.error?.includes('PERMISSION') ? 'permission-denied' : 'error');
  }, [teamId]);

  useEffect(() => { void loadLibrary(); }, [loadLibrary]);

  // ── load detail ───────────────────────────────────────────────────────────

  const openDetail = useCallback(async (pack: ExperiencePackDto) => {
    setSelectedPack(pack);
    setTab('detail');
    const result = await experiencePackEvents().getById(pack.teamId, pack.id);
    if (result.ok) {
      if (result.pack) setSelectedPack(result.pack);
      if (result.attachments) setAttachments(result.attachments);
    }
  }, []);

  const backToLibrary = useCallback(() => {
    setTab('library');
    setSelectedPack(null);
    setAttachments([]);
  }, []);

  // ── actions ────────────────────────────────────────────────────────────────

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try { await fn(); } catch { /* ignore */ }
    setBusy(false);
  };

  const handleApprove = (pack: ExperiencePackDto) => withBusy(async () => {
    const result = await experiencePackEvents().approve(pack.teamId, 'user', pack.id);
    if (result.ok && result.pack) {
      setPacks((prev) => prev.map((p) => (p.id === pack.id ? result.pack! : p)));
      if (selectedPack?.id === pack.id) setSelectedPack(result.pack);
      setMessage('已批准 Experience Pack');
    } else {
      setMessage(result.error ?? '审批失败');
    }
  });

  const handleWithdraw = (pack: ExperiencePackDto) => withBusy(async () => {
    const result = await experiencePackEvents().withdraw(pack.teamId, 'user', pack.id);
    if (result.ok && result.pack) {
      setPacks((prev) => prev.map((p) => (p.id === pack.id ? result.pack! : p)));
      if (selectedPack?.id === pack.id) setSelectedPack(result.pack);
      setMessage('已撤回 Experience Pack');
    } else {
      setMessage(result.error ?? '撤回失败');
    }
  });

  const handleMarkSourceInvalid = (pack: ExperiencePackDto) => withBusy(async () => {
    const reason = window.prompt('来源失效原因：');
    if (!reason) return;
    const result = await experiencePackEvents().markSourceInvalid(pack.teamId, 'user', pack.id, reason);
    if (result.ok && result.pack) {
      setPacks((prev) => prev.map((p) => (p.id === pack.id ? result.pack! : p)));
      if (selectedPack?.id === pack.id) setSelectedPack(result.pack);
      setMessage('已标记来源失效');
    } else {
      setMessage(result.error ?? '操作失败');
    }
  });

  const handleRecommend = (pack: ExperiencePackDto, channelId: string) => withBusy(async () => {
    const result = await experiencePackEvents().recommendToChannel(pack.teamId, 'user', pack.id, channelId);
    if (result.ok && result.attachment) {
      setAttachments((prev) => [...prev, result.attachment!]);
      setMessage('已推荐到频道');
    } else {
      setMessage(result.error ?? '推荐失败');
    }
  });

  const handleConfirmAttachment = (pack: ExperiencePackDto, channelId: string) => withBusy(async () => {
    const result = await experiencePackEvents().confirmAttachment(pack.teamId, 'user', pack.id, channelId);
    if (result.ok && result.attachment) {
      setAttachments((prev) => prev.map((a) => (a.channelId === channelId && a.packId === pack.id ? result.attachment! : a)));
      setMessage('已确认关联');
    } else {
      setMessage(result.error ?? '确认失败');
    }
  });

  const handleRevokeAttachment = (pack: ExperiencePackDto, channelId: string) => withBusy(async () => {
    const result = await experiencePackEvents().revokeAttachment(pack.teamId, 'user', pack.id, channelId);
    if (result.ok && result.attachment) {
      setAttachments((prev) => prev.filter((a) => !(a.channelId === channelId && a.packId === pack.id)));
      setMessage('已撤销关联');
    } else {
      setMessage(result.error ?? '撤销失败');
    }
  });

  // ── render helpers ─────────────────────────────────────────────────────────

  const channelName = (channelId: string) => channels.find((c) => c.id === channelId)?.name ?? channelId.slice(0, 8);

  const renderStatusBadge = (status: string) => {
    const s = STATUS_LABELS[status] ?? { label: status, className: 'bg-neutral-100 text-neutral-600' };
    return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${s.className}`}>{s.label}</span>;
  };

  const renderAttachmentStatus = (attachment: ChannelExperienceAttachmentDto) => {
    const label = ATTACHMENT_LABELS[attachment.status] ?? attachment.status;
    const color = attachment.status === 'attached' ? 'text-emerald-600' : attachment.status === 'pending' ? 'text-amber-600' : 'text-neutral-400';
    return <span className={`text-xs ${color}`}>{label}</span>;
  };

  // ── library view ──────────────────────────────────────────────────────────

  if (tab === 'library') {
    return (
      <section className="rounded-lg border border-neutral-200 p-5" data-smoke="experience-pack-panel">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Experience Pack 库</h3>
          <button onClick={loadLibrary} disabled={busy} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" title="刷新">
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          </button>
        </div>

        {message && (
          <p className={`mb-3 rounded px-3 py-1.5 text-xs ${message.includes('失败') || message.includes('PERMISSION') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>{message}</p>
        )}

        {state === 'loading' ? (
          <p className="flex items-center gap-2 text-sm text-neutral-400"><Loader2 size={14} className="animate-spin" />加载中…</p>
        ) : state === 'permission-denied' ? (
          <p className="text-sm text-red-600">权限不足</p>
        ) : state === 'error' ? (
          <p className="text-sm text-red-600">{message || '加载失败'}</p>
        ) : packs.length === 0 ? (
          <p className="text-sm text-neutral-400">当前 Team 暂无 Experience Pack。频道归档后可提议生成可复用的经验包。</p>
        ) : (
          <div className="space-y-2">
            {packs.map((pack) => (
              <button
                key={pack.id}
                onClick={() => openDetail(pack)}
                className="flex w-full items-center justify-between rounded border border-neutral-100 p-3 text-left hover:bg-neutral-50"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Package size={16} className="shrink-0 text-neutral-400" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-800 truncate">{pack.title}</p>
                    <p className="text-xs text-neutral-400">{channelName(pack.sourceChannelId)} · {new Date(pack.createdAt).toLocaleDateString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {renderStatusBadge(pack.status)}
                  <ExternalLink size={14} className="text-neutral-300" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    );
  }

  // ── detail view ────────────────────────────────────────────────────────────

  if (!selectedPack) return null;

  const channelList = channels.filter((c) => c.id !== selectedPack.sourceChannelId);

  return (
    <section className="rounded-lg border border-neutral-200 p-5" data-smoke="experience-pack-detail">
      {/* header */}
      <div className="mb-4 flex items-center justify-between">
        <button onClick={backToLibrary} className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700">
          <span>←</span> 返回库
        </button>
        {renderStatusBadge(selectedPack.status)}
      </div>

      {message && (
        <p className={`mb-3 rounded px-3 py-1.5 text-xs ${message.includes('失败') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>{message}</p>
      )}

      {/* title & summary */}
      <h2 className="text-base font-semibold text-neutral-900">{selectedPack.title}</h2>
      {selectedPack.summary && <p className="mt-1 text-sm text-neutral-600">{selectedPack.summary}</p>}

      {/* meta grid */}
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="text-neutral-400">来源频道</span>
          <p className="font-medium text-neutral-700">{channelName(selectedPack.sourceChannelId)}</p>
        </div>
        <div>
          <span className="text-neutral-400">创建时间</span>
          <p className="font-medium text-neutral-700">{new Date(selectedPack.createdAt).toLocaleString()}</p>
        </div>
        {selectedPack.applicabilityConditions && (
          <div className="col-span-2">
            <span className="text-neutral-400">适用条件</span>
            <p className="mt-0.5 rounded bg-neutral-50 p-2 text-neutral-700 whitespace-pre-wrap">{selectedPack.applicabilityConditions}</p>
          </div>
        )}
        {selectedPack.exclusionConditions && (
          <div className="col-span-2">
            <span className="text-neutral-400">排除条件</span>
            <p className="mt-0.5 rounded bg-neutral-50 p-2 text-neutral-700 whitespace-pre-wrap">{selectedPack.exclusionConditions}</p>
          </div>
        )}
        {selectedPack.conclusions && (
          <div className="col-span-2">
            <span className="text-neutral-400">结论</span>
            <p className="mt-0.5 rounded bg-neutral-50 p-2 text-neutral-700 whitespace-pre-wrap">{selectedPack.conclusions}</p>
          </div>
        )}
        {selectedPack.limitations && (
          <div className="col-span-2">
            <span className="text-neutral-400">限制</span>
            <p className="mt-0.5 rounded bg-neutral-50 p-2 text-neutral-700 whitespace-pre-wrap">{selectedPack.limitations}</p>
          </div>
        )}
      </div>

      {/* actions for draft/approved packs */}
      {(selectedPack.status === 'draft' || selectedPack.status === 'approved') && (
        <div className="mt-4 flex flex-wrap gap-2">
          {selectedPack.status === 'draft' && (
            <button onClick={() => handleApprove(selectedPack)} disabled={busy} className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              <Check size={14} /> 批准
            </button>
          )}
          {(selectedPack.status === 'draft' || selectedPack.status === 'approved') && (
            <button onClick={() => handleWithdraw(selectedPack)} disabled={busy} className="inline-flex items-center gap-1.5 rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">
              <X size={14} /> 撤回
            </button>
          )}
          {selectedPack.status === 'approved' && (
            <button onClick={() => handleMarkSourceInvalid(selectedPack)} disabled={busy} className="inline-flex items-center gap-1.5 rounded border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
              <Archive size={14} /> 标记来源失效
            </button>
          )}
        </div>
      )}

      {/* channel attachments (#723) */}
      <div className="mt-5 border-t border-neutral-100 pt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          频道关联
          <span className="ml-1 font-normal normal-case">（attachments）</span>
        </h4>

        {attachments.length === 0 ? (
          <p className="text-xs text-neutral-400">尚未关联到任何频道。</p>
        ) : (
          <div className="space-y-2">
            {attachments.map((att) => (
              <div key={`${att.packId}-${att.channelId}`} className="flex items-center justify-between rounded border border-neutral-100 p-2.5">
                <div className="flex items-center gap-2">
                  <Bookmark size={14} className="text-neutral-300" />
                  <span className="text-sm text-neutral-700">{channelName(att.channelId)}</span>
                  {renderAttachmentStatus(att)}
                </div>
                <div className="flex gap-1.5">
                  {att.status === 'pending' && (
                    <>
                      <button onClick={() => handleConfirmAttachment(selectedPack, att.channelId)} disabled={busy} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-50">
                        确认
                      </button>
                      <button onClick={() => handleRevokeAttachment(selectedPack, att.channelId)} disabled={busy} className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50">
                        拒绝
                      </button>
                    </>
                  )}
                  {att.status === 'attached' && (
                    <button onClick={() => handleRevokeAttachment(selectedPack, att.channelId)} disabled={busy} className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">
                      撤销
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* recommend to channel (only for approved packs) */}
        {selectedPack.status === 'approved' && channelList.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-400">推荐到频道：</span>
            {channelList.map((ch) => {
              const hasAttachment = attachments.some((a) => a.channelId === ch.id);
              if (hasAttachment) return null;
              return (
                <button
                  key={ch.id}
                  onClick={() => handleRecommend(selectedPack, ch.id)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                >
                  <Plus size={12} /> {ch.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
