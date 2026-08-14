import type { ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';

import { buildPackageMembersSelection } from '@/lib/output-package-reference';

export type PackageReturnDecision = 'changes_requested' | 'rejected';
export type PackageReturnAgentChoice = 'original' | 'select';

export interface PackageReturnHandoff {
  readonly packageId: string;
  readonly taskId: string;
  readonly taskTitle?: string;
  readonly originalAgentId: string;
  readonly originalAgentName?: string;
  readonly collectionId: string;
  readonly versionId: string;
  readonly filename: string;
  readonly versionNumber: number;
  readonly decision: PackageReturnDecision;
  readonly comment: string;
  readonly agentChoice: PackageReturnAgentChoice;
  readonly taskRevision: number;
  readonly taskAttempt: number;
}

export interface PackageReturnComposerDraft {
  readonly text: string;
  readonly selection: ProjectReferenceSelectionRequestDto;
}

/**
 * 审核退回成功后的纯本地 composer 草稿。
 *
 * 被退回版本必须走 package_members 显式引用：rejected/changes_requested 版本不能成为
 * current/default 正式输入，但允许用户有意识地把它钉为修改 basis。这里不发送消息，
 * 也不创建 Offer/claim/Invocation。
 */
export function buildPackageReturnComposerDraft(
  handoff: PackageReturnHandoff,
  resolvedOriginalAgentName?: string,
): PackageReturnComposerDraft {
  const selection = buildPackageMembersSelection(handoff.packageId, [{
    collectionId: handoff.collectionId,
    versionId: handoff.versionId,
  }]);
  if (!selection) throw new Error('PACKAGE_RETURN_SELECTION_EMPTY');

  const decisionLabel = handoff.decision === 'rejected' ? '拒绝' : '要求修改';
  const taskContext = handoff.taskTitle?.trim()
    ? `原任务：${handoff.taskTitle.trim()}。`
    : `原任务：${handoff.taskId}。`;
  const instruction = `请基于被退回的 ${handoff.filename} v${handoff.versionNumber} 继续处理。`
    + `审核结论：${decisionLabel}。审核意见：${handoff.comment.trim()}。${taskContext}`;

  if (handoff.agentChoice === 'original') {
    const agentName = resolvedOriginalAgentName?.trim()
      || handoff.originalAgentName?.trim()
      || handoff.originalAgentId;
    return { text: `@${agentName} ${instruction}`, selection };
  }
  return { text: `${instruction}处理智能体：@`, selection };
}
