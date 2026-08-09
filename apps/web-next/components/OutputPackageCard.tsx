'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, FileText, ShieldCheck, CheckSquare, Square, X } from 'lucide-react';
import type { OutputPackageMeta } from '@/lib/output-package';
import { projectEvents } from '@/lib/socket';
import {
  buildPackageMembersSelection,
  buildPackageProjectionSelection,
  loadPackageProjection,
  type PackageProjectionBlocker,
} from '@/lib/output-package-reference';
import type {
  PackageMemberAvailableActionsDto,
  ProjectReferenceSelectionRequestDto,
} from '@agentbean/contracts';

/**
 * #1060 讨论串最小文件包卡片 + #1061 审核/最终版状态投影(AC11) + #1063 引用入口。
 *
 * 展示 package 身份、来源与冻结成员(短标识 + 文件名);成员是交付时冻结快照,
 * 不与 Server 事实漂移。卡片不承载任何业务状态、不推进 Task。
 *
 * #1061：卡片经 getOutputPackage 读取 Server 计算的 availableActions 投影。
 * 成员行只展示 Server 给出的 reviewState/isFinalVersion 状态标签，不展示审核、最终化
 * 或“基于此修改”动作；修订入口暂时只保留在 Files 等其他 surface。
 * 无 channelId(上下文不可得)时保持纯静态展示,不查询。
 *
 * #1063：整包引用(delivered/current/final 三入口)先经 getOutputPackage projection 预览——
 * ready 才产生 package_projection 选择(携带 expectedMemberRevisions fence);not_ready
 * 展示阻断清单(final 缺失/被拒 current),不产生选择。成员行支持单选(“引用”)、多选
 * ("选择"→ checkbox + 计数)。
 */

const PACKAGE_REVIEW_STATE_LABELS: Record<PackageMemberAvailableActionsDto['reviewState'], string> = {
  pending: '待审核',
  approved: '通过',
  changes_requested: '要求修改',
  rejected: '拒绝',
};

const PACKAGE_REVIEW_STATE_STYLES: Record<PackageMemberAvailableActionsDto['reviewState'], string> = {
  pending: 'border-amber-200 bg-amber-50 text-amber-700',
  approved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  changes_requested: 'border-orange-200 bg-orange-50 text-orange-700',
  rejected: 'border-red-200 bg-red-50 text-red-700',
};

function packageReviewStateStyle(reviewState: PackageMemberAvailableActionsDto['reviewState'], isFinalVersion: boolean): string {
  return reviewState === 'approved' && isFinalVersion
    ? 'border-violet-200 bg-violet-50 text-violet-700'
    : PACKAGE_REVIEW_STATE_STYLES[reviewState];
}

function packageReviewStateLabel(reviewState: PackageMemberAvailableActionsDto['reviewState'], isFinalVersion: boolean): string {
  const label = PACKAGE_REVIEW_STATE_LABELS[reviewState];
  if (!isFinalVersion) return label;
  return reviewState === 'approved' ? '通过并设为最终版' : `${label} · 最终版`;
}

// #1065 AC11：整包投影策略沿用三处 surface 的共享标签。
import { POLICY_LABELS } from '@/lib/delivery-labels';

/** 成员行 file-sub 的时间:当天 HH:MM,跨天 M/D HH:MM(原型「手动修改于 19:41」)。 */
function formatPackageMemberClock(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** #1062 AC1:「基于此修改」回调——成员被 Server 标记可修订时携带冻结 provenance。 */
export interface ReviseVersionRequest {
  collectionId: string;
  collectionName: string;
  filename: string;
  baseVersionId: string;
  sourceVersionId: string;
  basisReviewId?: string;
  /** 包成员修订必填;集合行(无包)缺省——Server 仍以 sourceVersionId 冻结 basis。 */
  packageId?: string;
  deliveryId?: string;
  collectionRevision: number;
}

export function OutputPackageCard({
  packageMeta,
  channelId,
  onAddReference,
  onOpenTask,
  onContinueWithAgent,
  onOpenPreview,
}: {
  packageMeta: OutputPackageMeta;
  channelId?: string;
  /** #1063:父组件注入——把选择加进 composer(chat page 的 onAddPackageReference)。 */
  onAddReference?: (selection: ProjectReferenceSelectionRequestDto) => void;
  /** 暂时不在文件包卡片展示修订入口；保留回调契约供后续恢复，不影响 Files 修订入口。 */
  onReviseVersion?: (request: ReviseVersionRequest) => void;
  /**
   * #1065 AC2:「打开审核 Task」——导航到该 Task 的审核面(Task 详情/面板)。
   * 只导航,不创建业务事实。
   */
  onOpenTask?: (taskId: string) => void;
  /**
   * #1065 AC2:「继续 @Agent」——在关联 Thread composer 预填交付包引用与说明文本
   * 并聚焦;未发送不创建 Message/Offer/claim/Invocation 事实(#1064 同语义)。
   */
  onContinueWithAgent?: (packageId: string, taskTitle?: string) => void;
  /**
   * 原型对齐:「预览/编辑」——打开包内预览/编辑浮窗;versionId 指定聚焦成员
   * (成员行「预览」),省略时聚焦首个成员(包级按钮)。未提供时不渲染入口
   * (纯展示场景,如 channel-message)。
   */
  onOpenPreview?: (versionId?: string) => void;
}) {
  const [memberActions, setMemberActions] = useState<PackageMemberAvailableActionsDto[] | null>(null);
  // #1063 引用交互状态。
  const [referencing, setReferencing] = useState(false);
  const [selectingMembers, setSelectingMembers] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [blockers, setBlockers] = useState<PackageProjectionBlocker[]>([]);
  // 原型对齐:成员行 file-sub 需要 collection 名/current server 版本号/来源与修改时间。
  // 这些数据在 ProjectArtifactLibrary(collections)里,卡片按 channelId 自拉一次。
  const [collectionsById, setCollectionsById] = useState<Map<string, {
    name: string;
    currentVersionNumber?: number;
    currentCreatedAt?: number;
    manualRevision: boolean;
  }> | null>(null);

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const api = projectEvents();
    // 纯展示场景/测试 mock 可能没有该方法——降级为不显示 file-sub,不抛错。
    if (typeof api.artifactCollections !== 'function') return;
    Promise.resolve(api.artifactCollections(channelId))
      .then((result) => {
        if (cancelled || !result.ok || !result.library) return;
        const map = new Map<string, {
          name: string;
          currentVersionNumber?: number;
          currentCreatedAt?: number;
          manualRevision: boolean;
        }>();
        for (const collection of result.library.collections) {
          const current = collection.versions.find((v) => v.id === collection.currentVersionId);
          map.set(collection.id, {
            name: collection.name,
            ...(current ? { currentVersionNumber: current.versionNumber, currentCreatedAt: current.createdAt } : {}),
            // revisionBasis 存在 = 经「基于此修改」/手动编辑产生;否则为 Agent 交付/提升。
            manualRevision: Boolean(current?.revisionBasis),
          });
        }
        setCollectionsById(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [channelId]);

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    projectEvents()
      .getOutputPackage({ channelId, packageId: packageMeta.packageId })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setMemberActions(result.availableActions ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setMemberActions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, packageMeta.packageId]);

  // #1063:整包投影选择(构建逻辑在 lib/output-package-reference,与文件库工具栏共用)。
  // 预览 ready → 产生选择;not_ready → 展示阻断清单。
  const addProjectionReference = useCallback(async (policy: 'delivered' | 'current' | 'final') => {
    if (!channelId || !onAddReference) return;
    setReferencing(true);
    setBlockers([]);
    try {
      const projection = await loadPackageProjection(channelId, packageMeta.packageId, policy);
      if (!projection) return;
      const built = buildPackageProjectionSelection(packageMeta.packageId, policy, projection);
      if (built.selection) onAddReference(built.selection);
      else setBlockers(built.blockers);
    } finally {
      setReferencing(false);
    }
  }, [channelId, packageMeta.packageId, onAddReference]);

  // #1063:成员单选/多选 → package_members 显式选择。
  const addMembersReference = useCallback((members: { collectionId: string; versionId: string }[]) => {
    if (!onAddReference || members.length === 0) return;
    const selection = buildPackageMembersSelection(packageMeta.packageId, members);
    if (!selection) return;
    onAddReference(selection);
    setSelectingMembers(false);
    setSelectedMemberIds(new Set());
  }, [packageMeta.packageId, onAddReference]);

  const memberMetaById = useMemo(() => new Map(
    packageMeta.members.map((member) => [member.artifactVersionId, member]),
  ), [packageMeta.members]);

  const toggleMemberSelection = useCallback((versionId: string) => {
    setSelectedMemberIds((current) => {
      const next = new Set(current);
      if (next.has(versionId)) next.delete(versionId);
      else next.add(versionId);
      return next;
    });
  }, []);

  const selectedVersionIds = Array.from(selectedMemberIds);
  return (
    <div
      className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3"
      data-smoke="output-package-card"
      data-package-id={packageMeta.packageId}
    >
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 text-neutral-600" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-2" data-smoke="output-package-title">
          <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700" data-smoke="output-package-label">
            Agent 交付文件包
          </span>
          {packageMeta.taskTitle ? (
            <>
              <span className="text-sm text-neutral-400" aria-hidden="true">·</span>
              <span className="min-w-0 truncate text-sm font-medium text-neutral-700" data-smoke="output-package-name" title={packageMeta.taskTitle}>
                {packageMeta.taskTitle}
              </span>
            </>
          ) : null}
        </div>
        <span className="ml-auto shrink-0 text-xs text-neutral-500">
          {packageMeta.memberCount} 个文件
        </span>
      </div>
      {/* #1063 整包引用入口 + 原型对齐的「预览/编辑」 */}
      {onAddReference || onOpenPreview ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-smoke="output-package-projection-refs">
          {onOpenPreview ? (
            <button
              type="button"
              onClick={() => onOpenPreview()}
              className="shrink-0 rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100"
              data-smoke="output-package-open-preview"
            >
              预览/编辑
            </button>
          ) : null}
          {onAddReference ? (['current', 'final', 'delivered'] as const).map((policy) => (
            <button
              key={policy}
              type="button"
              disabled={referencing}
              onClick={() => addProjectionReference(policy)}
              className="shrink-0 rounded-md border border-sky-300 bg-white px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50 disabled:opacity-50"
              data-smoke="output-package-projection-ref"
              data-policy={policy}
            >
              引用{POLICY_LABELS[policy]}
            </button>
          )) : null}
          {onAddReference ? (
          <button
            type="button"
            disabled={referencing}
            onClick={() => {
              setSelectingMembers((current) => !current);
              setBlockers([]);
            }}
            className="shrink-0 rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
            data-smoke="output-package-member-select-toggle"
          >
            {selectingMembers ? '取消选择' : '选择成员'}
          </button>
          ) : null}
        </div>
      ) : null}
      {/* #1063 整包投影阻断清单 */}
      {blockers.length > 0 ? (
        <ul className="mt-2 space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" data-smoke="output-package-projection-blockers">
          {blockers.map((blocker, index) => (
            <li key={`${blocker.shortLabel}-${index}`}>
              {blocker.shortLabel} {blocker.filename}:{blocker.code === 'missing_final' ? '尚未设置最终版'
                : blocker.code === 'current_not_formal' ? '当前版被拒绝/需修改,不能作为整包默认输入'
                  : blocker.code === 'collection_unavailable' ? '成员集合不可用'
                    : blocker.code === 'version_not_in_package' ? '版本不属于该文件包'
                      : '整包引用不可用'}
            </li>
          ))}
          <li className="text-amber-700">请为缺失项设置最终版,或改为显式选择具体版本。</li>
        </ul>
      ) : null}
      <ul className="mt-2 space-y-1">
        {packageMeta.members.map((member) => {
          const actions = memberActions?.find(
            (entry) => entry.versionId === member.artifactVersionId,
          );
          const selected = selectedMemberIds.has(member.artifactVersionId);
          return (
            <li
              key={member.artifactVersionId}
              className="flex flex-wrap items-center gap-2 text-sm text-neutral-700"
            >
              {selectingMembers ? (
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`选择 ${member.shortLabel} ${member.filename}`}
                  onClick={() => toggleMemberSelection(member.artifactVersionId)}
                  className="shrink-0 text-neutral-500 hover:text-neutral-800"
                  data-smoke="output-package-member-select"
                  data-version-id={member.artifactVersionId}
                >
                  {selected ? <CheckSquare size={16} /> : <Square size={16} />}
                </button>
              ) : null}
              <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden="true" />
              <span className="w-8 shrink-0 text-xs font-medium text-neutral-500">{member.shortLabel}</span>
              <div className="min-w-0 flex-1">
                <span className="block truncate">{member.filename}</span>
                {/* 原型 file-sub:collection 名 · current server 版本 · 来源与修改时间 */}
                {(() => {
                  const info = collectionsById?.get(member.collectionId);
                  if (!info) return null;
                  const parts = [`collection: ${info.name}`];
                  if (info.currentVersionNumber) parts.push(`current server v${info.currentVersionNumber}`);
                  const clock = formatPackageMemberClock(info.currentCreatedAt);
                  parts.push(info.manualRevision ? `手动修改${clock ? `于 ${clock}` : ''}` : `Agent 交付${clock ? ` · ${clock}` : ''}`);
                  return (
                    <span className="block truncate text-[11px] text-neutral-400" data-smoke="package-member-sub">
                      {parts.join(' · ')}
                    </span>
                  );
                })()}
              </div>
              {actions ? (
                <span
                  className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-xs ${packageReviewStateStyle(actions.reviewState, actions.isFinalVersion)}`}
                  data-smoke="package-review-state"
                >
                  {packageReviewStateLabel(actions.reviewState, actions.isFinalVersion)}
                </span>
              ) : null}
              {/* 原型对齐:成员行「预览」→ 包内预览/编辑浮窗(聚焦该成员) */}
              {onOpenPreview && !selectingMembers ? (
                <button
                  type="button"
                  onClick={() => onOpenPreview(member.artifactVersionId)}
                  className="shrink-0 rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100"
                  data-smoke="output-package-member-preview"
                  data-version-id={member.artifactVersionId}
                >
                  预览
                </button>
              ) : null}
              {/* #1063 单文件引用 */}
              {onAddReference && !selectingMembers ? (
                <button
                  type="button"
                  disabled={referencing}
                  onClick={() => addMembersReference([{ collectionId: member.collectionId, versionId: member.artifactVersionId }])}
                  className="shrink-0 rounded-md border border-sky-300 bg-white px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50 disabled:opacity-50"
                  data-smoke="output-package-member-ref"
                  data-version-id={member.artifactVersionId}
                >
                  引用
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {/* #1063 多选提交条 */}
      {selectingMembers && (
        <div className="mt-2 flex items-center gap-2 border-t border-neutral-200 pt-2 text-xs text-neutral-600" data-smoke="output-package-member-select-bar">
          <span>已选 {selectedVersionIds.length} 个文件</span>
          <button
            type="button"
            disabled={referencing}
            onClick={() => {
              const members = selectedVersionIds
                .map((versionId) => memberMetaById.get(versionId))
                .filter((meta): meta is NonNullable<typeof meta> => Boolean(meta))
                .map((meta) => ({ collectionId: meta.collectionId, versionId: meta.artifactVersionId }));
              addMembersReference(members);
            }}
            className="shrink-0 rounded-md border border-sky-300 bg-sky-50 px-2 py-0.5 text-sky-700 hover:bg-sky-100 disabled:opacity-50"
            data-smoke="output-package-member-select-confirm"
          >
            引用所选
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedMemberIds(new Set());
              setSelectingMembers(false);
            }}
            className="shrink-0 rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-neutral-600 hover:bg-neutral-100"
            data-smoke="output-package-member-select-cancel"
          >
            取消
          </button>
        </div>
      )}
      {packageMeta.agentName ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-neutral-500">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          交付 Agent：{packageMeta.agentName}
        </p>
      ) : null}
      {/* #1065 AC2：入口只导航/预填,不创建业务事实;command 提交时 Server 仍完整复验。 */}
      {(onOpenTask || onContinueWithAgent) ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-neutral-200 pt-2" data-smoke="output-package-entries">
          {onOpenTask && packageMeta.taskId ? (
            <button
              type="button"
              onClick={() => onOpenTask(packageMeta.taskId!)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
              data-smoke="output-package-open-task"
            >
              打开审核 Task
            </button>
          ) : null}
          {onContinueWithAgent ? (
            <button
              type="button"
              disabled={!packageMeta.taskId}
              onClick={() => onContinueWithAgent(packageMeta.packageId, packageMeta.taskTitle)}
              title={packageMeta.taskId ? undefined : '未关联 Task,无法交接给 Agent'}
              className="rounded-md border border-violet-300 bg-white px-2 py-1 text-xs text-violet-700 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-40"
              data-smoke="output-package-continue-agent"
            >
              继续 @Agent
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
