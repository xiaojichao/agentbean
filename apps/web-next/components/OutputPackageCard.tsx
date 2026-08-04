'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Package, FileText, ShieldCheck } from 'lucide-react';
import type { OutputPackageMeta } from '@/lib/output-package';
import { projectEvents } from '@/lib/socket';
import type {
  PackageMemberAvailableActionsDto,
  PackageReviewAction,
} from '@agentbean/contracts';

/**
 * #1060 讨论串最小文件包卡片 + #1061 审核/最终版状态投影(AC11)。
 *
 * 展示 package 身份、来源与冻结成员(短标识 + 文件名);成员是交付时冻结快照,
 * 不与 Server 事实漂移。卡片不承载任何业务状态、不推进 Task。
 *
 * #1061：卡片经 getOutputPackage 读取 Server 计算的 availableActions(当前用户可执行动作),
 * 按钮可见性完全由 Server 动作清单决定——客户端绝不依据角色名称或按钮存在自行推断权限。
 * 无 channelId(上下文不可得)时保持纯静态展示,不查询。
 */

const ACTION_LABELS: Record<PackageReviewAction, string> = {
  'review-approved': '通过',
  'review-changes-requested': '要求修改',
  'review-rejected': '拒绝',
  'review-and-finalize': '通过并设为最终版',
  'review-and-reject-delivery': '退回交付',
  'set-final': '设为最终版',
};

const REVIEW_STATE_LABELS: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  changes_requested: '要求修改',
  rejected: '已拒绝',
};

export function OutputPackageCard({
  packageMeta,
  channelId,
}: {
  packageMeta: OutputPackageMeta;
  channelId?: string;
}) {
  const [memberActions, setMemberActions] = useState<PackageMemberAvailableActionsDto[] | null>(null);
  const [frozenTaskRevision, setFrozenTaskRevision] = useState<number | undefined>(undefined);
  const [frozenTaskAttempt, setFrozenTaskAttempt] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!channelId) return;
    const result = await projectEvents()
      .getOutputPackage({ channelId, packageId: packageMeta.packageId });
    if (result.ok) {
      setMemberActions(result.availableActions ?? []);
      setFrozenTaskRevision(result.package?.taskRevision);
      setFrozenTaskAttempt(result.package?.taskAttempt);
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
        }
      })
      .catch(() => {
        if (!cancelled) setMemberActions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, packageMeta.packageId]);

  const runAction = useCallback(async (member: PackageMemberAvailableActionsDto, action: PackageReviewAction) => {
    if (!channelId) return;
    setBusy(true);
    try {
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
  }, [channelId, packageMeta.packageId, frozenTaskRevision, frozenTaskAttempt, refresh]);

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
      <ul className="mt-2 space-y-1">
        {packageMeta.members.map((member) => {
          const actions = memberActions?.find(
            (entry) => entry.versionId === member.artifactVersionId,
          );
          return (
            <li
              key={member.artifactVersionId}
              className="flex flex-wrap items-center gap-2 text-sm text-neutral-700"
            >
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
                  {actions.actions.map((action) => (
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
            </li>
          );
        })}
      </ul>
      {packageMeta.agentName ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-neutral-500">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          交付 Agent：{packageMeta.agentName}
        </p>
      ) : null}
    </div>
  );
}
