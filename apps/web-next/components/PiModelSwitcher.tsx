'use client';

import { useState } from 'react';
import { ArrowRight, CheckCircle2, SlidersHorizontal } from 'lucide-react';
import type { ActivePiModelDto, PiConfigurationReadinessDto, PiProviderCardDto } from '@agentbean/contracts';

export function PiModelSwitcher({ cards, activeModel, history, readiness, disabled, loading, unavailable, onActivate }: {
  cards: PiProviderCardDto[];
  activeModel: ActivePiModelDto | null;
  history: ActivePiModelDto[];
  readiness: PiConfigurationReadinessDto | null;
  disabled: boolean;
  loading: boolean;
  unavailable: boolean;
  onActivate: (revisionId: string) => Promise<boolean>;
}) {
  const [cardId, setCardId] = useState('');
  const [revisionId, setRevisionId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const activeCard = cards.find((card) => card.id === activeModel?.cardId);
  const activeRevision = (activeCard?.publishedRevisions ?? (activeCard?.publishedRevision ? [activeCard.publishedRevision] : []))
    .find((revision) => revision.id === activeModel?.revisionId);
  const activeProviderName = activeRevision?.displayName ?? activeCard?.displayName;
  const selectedCard = cards.find((card) => card.id === cardId);
  const revisions = selectedCard?.publishedRevisions ?? (selectedCard?.publishedRevision ? [selectedCard.publishedRevision] : []);
  const selectedRevision = revisions.find((revision) => revision.id === revisionId);
  const canSwitch = Boolean(selectedRevision && revisionId !== activeModel?.revisionId && !disabled && !unavailable);

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white" data-smoke="settings-pi-active-model">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-100 bg-neutral-50/70 p-6">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-neutral-500"><SlidersHorizontal size={15} />全系统当前模型</div>
          <h3 className="break-all text-2xl font-semibold tracking-tight">{loading ? '正在读取当前配置…' : unavailable ? '当前配置加载失败' : activeModel?.modelId ?? '尚未启用模型'}</h3>
          <p className="mt-2 text-sm text-neutral-500">{activeProviderName ?? (activeModel ? activeModel.cardId : '添加 Provider 并发布模型后，即可在此启用。')}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${!unavailable && readiness?.status === 'ready' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
          {loading ? '读取中' : !unavailable && readiness?.status === 'ready' ? '配置就绪' : unavailable ? '状态未知' : '需要配置'}
        </span>
        {readiness?.diagnosticCode && !unavailable && <p className="w-full break-all text-xs text-amber-800">诊断：{readiness.diagnosticCode}</p>}
      </div>

      <div className="space-y-4 p-6">
        <div><h3 className="text-sm font-semibold">切换 Provider 与模型</h3><p className="mt-1 text-xs leading-5 text-neutral-500">选择已发布版本，确认后对所有团队的新消息协调与新任务编排生效。进行中的任务继续使用原版本。</p></div>
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="min-w-0 text-xs font-medium text-neutral-600">Provider
            <select aria-label="切换 Provider" value={cardId} disabled={disabled || unavailable} onChange={(event) => { setCardId(event.target.value); setRevisionId(''); setConfirming(false); }} className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm disabled:opacity-50">
              <option value="">选择 Provider 配置</option>
              {cards.map((card) => <option key={card.id} value={card.id}>{card.displayName}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-xs font-medium text-neutral-600">模型 / 已发布版本
            <select aria-label="切换模型版本" value={revisionId} disabled={disabled || !selectedCard || unavailable} onChange={(event) => { setRevisionId(event.target.value); setConfirming(false); }} className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm disabled:opacity-50">
              <option value="">{selectedCard && revisions.length === 0 ? '尚无已发布模型' : '选择模型版本'}</option>
              {revisions.map((revision) => <option key={revision.id} value={revision.id}>{revision.config.modelId} · {new Date(revision.createdAt).toLocaleString()} · {revision.id}{activeModel?.revisionId === revision.id ? '（当前）' : ''}</option>)}
            </select>
          </label>
          <button type="button" disabled={!canSwitch} onClick={() => setConfirming(true)} className="flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40">预览切换<ArrowRight size={15} /></button>
        </div>
        {selectedCard && revisions.length === 0 && <p className="text-xs text-amber-800">此 Provider 还没有可切换的版本。请在下方编辑配置，保存草稿、运行测试并发布。</p>}
        {selectedRevision && <p className="break-all text-xs text-neutral-500">目标地址：{selectedRevision.config.baseUrl}</p>}
        {confirming && selectedRevision && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4" role="region" aria-label="确认模型切换">
            <h4 className="text-sm font-semibold">确认全系统切换</h4>
            <p className="mt-2 break-words text-sm">{activeProviderName ?? '当前'} / {activeModel?.modelId ?? '未配置'} → {selectedRevision.displayName} / {selectedRevision.config.modelId}</p>
            <p className="mt-2 text-xs leading-5 text-amber-900">服务器将校验该版本的测试与凭据。切换失败时保留当前配置；系统不会自动切换到其他模型。</p>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={!canSwitch} onClick={async () => { if (await onActivate(revisionId)) setConfirming(false); }} className="rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">{disabled ? '切换中…' : '确认切换'}</button>
              <button type="button" disabled={disabled} onClick={() => setConfirming(false)} className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs">取消</button>
            </div>
          </div>
        )}
        <p className="flex items-center gap-1.5 text-xs text-neutral-500"><CheckCircle2 size={13} />可切换回已发布的历史版本，启用时会重新校验。</p>
        {history.length > 0 && <details className="border-t border-neutral-100 pt-4"><summary className="cursor-pointer text-xs font-medium text-neutral-600">切换历史（{history.length}）</summary><ol className="mt-3 space-y-2">{history.map((entry, index) => <li key={`${entry.changedAt}-${index}`} className="flex flex-wrap justify-between gap-2 text-xs text-neutral-500"><span>{cards.find((card) => card.id === entry.cardId)?.displayName ?? entry.cardId} / {entry.modelId}</span><time>{new Date(entry.changedAt).toLocaleString()}</time></li>)}</ol></details>}
      </div>
    </section>
  );
}
