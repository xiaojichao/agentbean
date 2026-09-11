'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { OutputPackageProjectionResultV1, ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';
import type { OutputPackageMeta } from '@/lib/output-package';
import { buildPackageMembersSelection, buildPackageProjectionSelection, loadPackageProjection, type PackageProjectionPolicy } from '@/lib/output-package-reference';

const labels = { current: '当前版', final: '最终版', delivered: '本次交付版' };
const descriptions = {
  current: '使用每个文件最新保存的版本',
  final: '使用明确设置的最终版本，缺少最终版时不可引用',
  delivered: '使用这个包最初交付时的版本，不包含后续修改',
};
const reviewLabels = { pending: '待审核', approved: '已通过', changes_requested: '要求修改', rejected: '已拒绝' };

function blockerLabel(code: string): string {
  if (code === 'missing_final') return '尚未设置最终版';
  if (code === 'current_not_formal') return '当前版已被拒绝或要求修改，请在预览中处理';
  return '此版本暂不可引用';
}

/** 选择范围与版本后一次加入输入框；始终使用屏幕上已解析的版本，不静默换版。 */
export function OutputPackageReferencePicker({ packageMeta, channelId, dataRevision, onAddReference, onOpenPreview }: {
  packageMeta: OutputPackageMeta;
  channelId?: string;
  dataRevision: number;
  onAddReference: (selection: ProjectReferenceSelectionRequestDto) => void;
  onOpenPreview?: (versionId?: string, exactVersion?: boolean) => void;
}) {
  const [policy, setPolicy] = useState<PackageProjectionPolicy>('current');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<{ policy: PackageProjectionPolicy; revision: number; projection: OutputPackageProjectionResultV1 } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState('');
  const allCheckbox = useRef<HTMLInputElement>(null);
  const selected = packageMeta.members.filter((member) => !excluded.has(member.collectionId));
  const allSelected = selected.length === packageMeta.members.length && selected.length > 0;
  const projection = loaded?.policy === policy && loaded.revision === dataRevision ? loaded.projection : null;

  useEffect(() => {
    if (allCheckbox.current) allCheckbox.current.indeterminate = selected.length > 0 && !allSelected;
  }, [selected.length, allSelected]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError('');
    setNotice('');
    if (!channelId) {
      setError('无法读取文件版本：缺少频道信息');
      return;
    }
    loadPackageProjection(channelId, packageMeta.packageId, policy).then((result) => {
      if (cancelled) return;
      if (!result) setError('文件版本加载失败，请重试');
      else setLoaded({ policy, revision: dataRevision, projection: result });
    }).catch(() => { if (!cancelled) setError('文件版本加载失败，请重试'); });
    return () => { cancelled = true; };
  }, [channelId, packageMeta.packageId, policy, dataRevision, retry]);

  const unavailable = selected.some((member) => !projection?.members.some((version) => version.collectionId === member.collectionId)
    || projection.blockers.some((blocker) => blocker.collectionId === member.collectionId));
  const canReference = Boolean(projection) && selected.length > 0 && !unavailable
    && (!allSelected || projection?.status === 'ready');

  function addReference() {
    if (!canReference || !projection) return;
    const selection = allSelected
      ? buildPackageProjectionSelection(packageMeta.packageId, policy, projection).selection
      : buildPackageMembersSelection(packageMeta.packageId, selected.map((member) => {
        const version = projection.members.find((entry) => entry.collectionId === member.collectionId)!;
        return { collectionId: member.collectionId, versionId: version.versionId };
      }));
    if (selection) {
      onAddReference(selection);
      setNotice('已加入输入框');
    }
  }

  return (
    <div className="mt-3" data-smoke="output-package-reference-picker">
      <div className="flex items-center justify-between text-xs text-neutral-600">
        <label className="flex cursor-pointer items-center gap-2">
          <input ref={allCheckbox} type="checkbox" checked={allSelected} aria-label="全选文件"
            onChange={() => { setExcluded(allSelected ? new Set(packageMeta.members.map((member) => member.collectionId)) : new Set()); setNotice(''); }}
            className="accent-violet-600" />
          全选
        </label>
        <span>已选 {selected.length} 项</span>
      </div>
      <ul className="mt-2 divide-y divide-neutral-200">
        {packageMeta.members.map((member) => {
          const version = projection?.members.find((entry) => entry.collectionId === member.collectionId);
          const blocker = projection?.blockers.find((entry) => entry.collectionId === member.collectionId);
          const missing = projection && !version;
          return (
            <li key={member.collectionId} className="flex items-start gap-2 py-2 text-sm" data-smoke="output-package-reference-file">
              <input type="checkbox" checked={!excluded.has(member.collectionId)} aria-label={`选择 ${member.shortLabel} ${member.filename}`}
                onChange={() => { setExcluded((current) => { const next = new Set(current); if (next.has(member.collectionId)) next.delete(member.collectionId); else next.add(member.collectionId); return next; }); setNotice(''); }}
                className="mt-1 shrink-0 accent-violet-600" />
              <span className="mt-0.5 shrink-0 text-xs text-neutral-500">{member.shortLabel}</span>
              <div className="min-w-0 flex-1">
                <span className="block break-words text-neutral-800">{version?.filename ?? member.filename}</span>
                <span className="block text-xs text-neutral-500">
                  {version ? `${labels[policy]} v${version.versionNumber} · ${reviewLabels[version.reviewState]}${version.isFinalVersion ? ' · 最终版' : ''}` : projection ? '' : error ? '版本不可用' : '正在读取版本…'}
                </span>
                {blocker || missing ? <span className="block text-xs text-amber-700">{blocker ? blockerLabel(blocker.code) : policy === 'final' ? '尚未设置最终版' : '此版本暂不可引用'}</span> : null}
              </div>
              {onOpenPreview ? <button type="button" disabled={!version} onClick={() => onOpenPreview(version!.versionId, true)}
                className="shrink-0 rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 disabled:opacity-40">预览</button> : null}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 border-t border-neutral-200 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-neutral-600">引用版本
            <select aria-label="引用版本" value={policy} onChange={(event) => { setPolicy(event.target.value as PackageProjectionPolicy); setNotice(''); setError(''); }}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700">
              <option value="current">当前版</option><option value="final">最终版</option><option value="delivered">本次交付版</option>
            </select>
          </label>
          <button type="button" disabled={!canReference} onClick={addReference} data-smoke="output-package-reference-confirm"
            className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40">
            {allSelected ? `引用全部 ${selected.length} 个文件` : `引用所选 ${selected.length} 个文件`}
          </button>
        </div>
        <p className="mt-2 text-xs text-neutral-500">{descriptions[policy]}</p>
        <p role="status" className="mt-1 text-xs text-neutral-600">{notice || (selected.length === 0 ? '请选择文件' : projection && unavailable ? '所选文件中有不可引用的版本，请处理或取消勾选对应文件' : '')}</p>
        {error ? <div role="alert" className="mt-1 text-xs text-amber-700">{error}{channelId ? <button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 underline">重试</button> : null}</div> : null}
      </div>
    </div>
  );
}
