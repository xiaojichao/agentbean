'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, FileText, ShieldCheck, CheckSquare, Square, X } from 'lucide-react';
import type { OutputPackageMeta } from '@/lib/output-package';
import { projectEvents } from '@/lib/socket';
import type {
  OutputPackageProjectionMemberDto,
  PackageMemberAvailableActionsDto,
  PackageReviewAction,
  ProjectReferenceSelectionRequestDto,
  ArtifactRevisionAction,
} from '@agentbean/contracts';

/**
 * #1060 讨论串最小文件包卡片 + #1061 审核/最终版状态投影(AC11) + #1063 引用入口。
 *
 * 展示 package 身份、来源与冻结成员(短标识 + 文件名);成员是交付时冻结快照,
 * 不与 Server 事实漂移。卡片不承载任何业务状态、不推进 Task。
 *
 * #1061：卡片经 getOutputPackage 读取 Server 计算的 availableActions(当前用户可执行动作),
 * 按钮可见性完全由 Server 动作清单决定——客户端绝不依据角色名称或按钮存在自行推断权限。
 * 无 channelId(上下文不可得)时保持纯静态展示,不查询。
 *
 * #1063：整包引用(delivered/current/final 三入口)先经 getOutputPackage projection 预览——
 * ready 才产生 package_projection 选择(携带 expectedMemberRevisions fence);not_ready
 * 展示阻断清单(final 缺失/被拒 current),不产生选择。成员行支持单选(“引用”)、多选
 * (“选择”→ checkbox + 计数)与“基于此修改”(显式选择 rejected/changes_requested 版本)。
 */

const ACTION_LABELS: Record<PackageReviewAction | ArtifactRevisionAction, string> = {
  'review-approved': '通过',
  'review-changes-requested': '要求修改',
  'review-rejected': '拒绝',
  'review-and-finalize': '通过并设为最终版',
  'review-and-reject-delivery': '退回交付',
  'set-final': '设为最终版',
  'revise-version': '基于此修改',
};

const REVIEW_STATE_LABELS: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  changes_requested: '要求修改',
  rejected: '已拒绝',
};

const POLICY_LABELS: Record<string, string> = {
  delivered: '交付版',
  current: '当前版',
  final: '最终版',
};

/** #1062 AC1:「基于此修改」回调——成员被 Server 标记可修订时携带冻结 provenance。 */
export interface ReviseVersionRequest {
  collectionId: string;
  collectionName: string;
  filename: string;
  baseVersionId: string;
  sourceVersionId: string;
  basisReviewId?: string;
  packageId: string;
  deliveryId?: string;
  collectionRevision: number;
}

export function OutputPackageCard({
  packageMeta,
  channelId,
  onAddReference,
  onReviseVersion,
}: {
  packageMeta: OutputPackageMeta;
  channelId?: string;
  /** #1063:父组件注入——把选择加进 composer(chat page 的 onAddPackageReference)。 */
  onAddReference?: (selection: ProjectReferenceSelectionRequestDto) => void;
  /** #1062 AC1:「基于此修改」——成员可修订时打开修订编辑器(Server 动作驱动)。 */
  onReviseVersion?: (request: ReviseVersionRequest) => void;
}) {
  const [memberActions, setMemberActions] = useState<PackageMemberAvailableActionsDto[] | null>(null);
  const [frozenTaskRevision, setFrozenTaskRevision] = useState<number | undefined>(undefined);
  const [frozenTaskAttempt, setFrozenTaskAttempt] = useState<number | undefined>(undefined);
  // #1062 AC1:来源 delivery(冻结修订 provenance 的成对字段;web 从 package DTO 读取,不猜测)。
  const [frozenDeliveryId, setFrozenDeliveryId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // #1063 引用交互状态。
  const [referencing, setReferencing] = useState(false);
  const [selectingMembers, setSelectingMembers] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [blockers, setBlockers] = useState<{ shortLabel: string; filename: string; code: string }[]>([]);

  const refresh = useCallback(async () => {
    if (!channelId) return;
    const result = await projectEvents()
      .getOutputPackage({ channelId, packageId: packageMeta.packageId });
    if (result.ok) {
      setMemberActions(result.availableActions ?? []);
      setFrozenTaskRevision(result.package?.taskRevision);
      setFrozenTaskAttempt(result.package?.taskAttempt);
      setFrozenDeliveryId(result.package?.deliveryId);
    }
  }, [channelId, packageMeta.packageId]);

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    projectEvents()
      .getOutputPackage({ channelId, packageId: packageMeta.packageId })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setMemberActions(result.availableActions ?? []);
          setFrozenTaskRevision(result.package?.taskRevision);
          setFrozenTaskAttempt(result.package?.taskAttempt);
          setFrozenDeliveryId(result.package?.deliveryId);
        }
      })
      .catch(() => {
        if (!cancelled) setMemberActions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, packageMeta.packageId]);

  const runAction = useCallback(async (member: PackageMemberAvailableActionsDto, action: PackageReviewAction | ArtifactRevisionAction) => {
    if (!channelId) return;
    setBusy(true);
    try {
      if (action === 'revise-version') {
        // #1062 AC1:交给上层打开修订编辑器(冻结 sourceVersion/review basis/package/delivery)。
        const memberMeta = packageMeta.members.find((m) => m.artifactVersionId === member.versionId);
        if (!frozenDeliveryId) {
          // delivery 是 package 冻结事实;取不到(未加载/包异常)则不伪造,刷新后重试。
          await refresh();
          return;
        }
        onReviseVersion?.({
          collectionId: member.collectionId,
          collectionName: memberMeta?.filename ?? member.collectionId,
          filename: memberMeta?.filename ?? 'document.md',
          baseVersionId: member.versionId,
          sourceVersionId: member.versionId,
          ...(member.latestReviewId ? { basisReviewId: member.latestReviewId } : {}),
          packageId: packageMeta.packageId,
          deliveryId: frozenDeliveryId,
          collectionRevision: member.collectionRevision,
        });
        return;
      }
      const base = {
        channelId,
        packageId: packageMeta.packageId,
        collectionId: member.collectionId,
        versionId: member.versionId,
        idempotencyKey: `pkg-review:${packageMeta.packageId}:${member.versionId}:${action}`,
      };
      if (action === 'review-approved' || action === 'review-changes-requested' || action === 'review-rejected') {
        await projectEvents().submitPackageArtifactReview({
          ...base,
          decision: action === 'review-approved' ? 'approved'
            : action === 'review-changes-requested' ? 'changes_requested' : 'rejected',
          comment: ACTION_LABELS[action],
        });
      } else if (action === 'review-and-finalize') {
        await projectEvents().submitPackageReviewAndFinalize({
          ...base,
          decision: 'approved',
          comment: ACTION_LABELS[action],
          expectedCollectionRevision: member.collectionRevision,
        });
      } else if (action === 'review-and-reject-delivery') {
        // revision/attempt 用 package 冻结值;漂移时 Server 返回 conflict,刷新重试。
        await projectEvents().submitPackageReviewAndRejectDelivery({
          ...base,
          decision: 'changes_requested',
          comment: ACTION_LABELS[action],
          expectedTaskRevision: frozenTaskRevision ?? 1,
          expectedTaskAttempt: frozenTaskAttempt,
          rejectReason: '需要修改后重新交付',
        });
      } else if (action === 'set-final') {
        // #824 最终化命令:复用既有 setArtifactFinalVersion(集合 revision fence 来自 Server)。
        await projectEvents().setArtifactFinalVersion({
          channelId,
          collectionId: member.collectionId,
          versionId: member.versionId,
          idempotencyKey: `pkg-final:${packageMeta.packageId}:${member.versionId}`,
          expectedCollectionRevision: member.collectionRevision,
        });
      }
      // 提交后刷新 Server 计算的动作清单(按钮可见性始终由 Server 决定)。
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [channelId, packageMeta.packageId, packageMeta.members, frozenDeliveryId, frozenTaskRevision, frozenTaskAttempt, refresh, onReviseVersion]);

  // #1063:整包投影选择。预览 ready → 产生选择;not_ready → 展示阻断清单。
  const addProjectionReference = useCallback(async (policy: 'delivered' | 'current' | 'final') => {
    if (!channelId || !onAddReference) return;
    setReferencing(true);
    setBlockers([]);
    try {
      const result = await projectEvents().getOutputPackage({
        channelId,
        packageId: packageMeta.packageId,
        projection: { policy },
      });
      if (!result.ok || !result.projection) return;
      if (result.projection.status !== 'ready') {
        setBlockers(result.projection.blockers.map((blocker) => ({
          shortLabel: blocker.shortLabel ?? '',
          filename: blocker.filename ?? '',
          code: blocker.code,
        })));
        return;
      }
      const expectedMemberRevisions = policy === 'delivered'
        ? undefined
        : result.projection.members.map((member) => ({
          collectionId: member.collectionId,
          revision: member.collectionRevision,
        }));
      onAddReference({
        kind: 'package_projection',
        packageId: packageMeta.packageId,
        policy,
        ...(expectedMemberRevisions ? { expectedMemberRevisions } : {}),
      });
    } finally {
      setReferencing(false);
    }
  }, [channelId, packageMeta.packageId, onAddReference]);

  // #1063:成员单选/多选/基于此修改 → package_members 显式选择。
  const addMembersReference = useCallback((members: { collectionId: string; versionId: string }[]) => {
    if (!onAddReference || members.length === 0) return;
    onAddReference({
      kind: 'package_members',
      packageId: packageMeta.packageId,
      members,
    });
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
  const title = packageMeta.taskTitle ? `任务「${packageMeta.taskTitle}」交付文件包` : 'Agent 交付文件包';

  return (
    <div
      className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3"
      data-smoke="output-package-card"
      data-package-id={packageMeta.packageId}
    >
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 text-neutral-600" aria-hidden="true" />
        <span className="text-sm font-medium text-neutral-800">{title}</span>
        <span className="ml-auto text-xs text-neutral-500">
          {packageMeta.memberCount} 个文件
        </span>
      </div>
      {/* #1063 整包引用入口 */}
      {onAddReference ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-smoke="output-package-projection-refs">
          {(['current', 'final', 'delivered'] as const).map((policy) => (
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
          ))}
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
          const isBlocked = actions?.reviewState === 'rejected' || actions?.reviewState === 'changes_requested';
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
              <span className="truncate">{member.filename}</span>
              {actions ? (
                <>
                  <span
                    className="ml-auto shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600"
                    data-smoke="package-review-state"
                  >
                    {REVIEW_STATE_LABELS[actions.reviewState] ?? actions.reviewState}
                    {actions.isFinalVersion ? ' · 最终版' : ''}
                  </span>
                  {actions.actions
                    // #1062:无 onReviseVersion(纯展示场景,如 channel-message)时不渲染
                    // revise-version 按钮——Server 下发动作但客户端无法执行时不得静默 no-op。
                    .filter((action) => action !== 'revise-version' || Boolean(onReviseVersion))
                    .map((action) => (
                      <button
                        key={action}
                        type="button"
                        disabled={busy}
                        onClick={() => runAction(actions, action)}
                        className="shrink-0 rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
                        data-smoke="package-review-action"
                        data-action={action}
                      >
                        {ACTION_LABELS[action]}
                      </button>
                    ))}
                </>
              ) : null}
              {/* #1063 单文件引用与“基于此修改” */}
              {onAddReference && !selectingMembers ? (
                <>
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
                  {isBlocked ? (
                    <button
                      type="button"
                      disabled={referencing}
                      onClick={() => addMembersReference([{ collectionId: member.collectionId, versionId: member.artifactVersionId }])}
                      className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                      data-smoke="output-package-member-based-on"
                      data-version-id={member.artifactVersionId}
                    >
                      基于此修改
                    </button>
                  ) : null}
                </>
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
    </div>
  );
}
