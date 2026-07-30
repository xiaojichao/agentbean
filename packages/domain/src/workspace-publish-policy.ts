/**
 * #966 Project Channel Workspace 原子发布与冲突反馈 —— 纯规则。
 *
 * 职责：基于「基线 revision」判定一次 publish 应整体创建下一 revision，还是因基线已落后
 * 报告冲突（返回当前版本 + 冲突路径范围）。首版不自动合并、不静默覆盖（#960 Implementation
 * Decisions：冲突/权限撤销/校验失败不得产生部分 revision；冲突返回当前版本和路径范围，交由
 * 人类或新 Task 显式处理）。
 *
 * 关键不变量：
 * - 基线 revisionId 与当前 revisionId 不一致 → conflict；不写、不合 publish。
 * - conflictingPaths = 提交清单与当前 revision 的「不一致路径」升序——同路径 artifactId 不同、
 *   或仅一方持有该路径。这是真正的调和面，供人类对照当前版本重做。
 * - current.revision 达 MAX_SAFE_INTEGER → rejected（revision-overflow），不再 +1。
 * - 路径合法性（empty/duplicate/invalid）由调用方先用 validateWorkspaceImportFiles 校验；
 *   本函数只做空清单兜底（empty-files）。
 *
 * 无 server 依赖、无 IO。调用方（usecase）据此决策，repo 在事务内对 current_revision_id
 * 做 CAS 终判（消除 read→commit 间竞态）。
 */

export interface WorkspacePublishFileEntry {
  readonly path: string;
  readonly artifactId: string;
}

export interface EvaluateWorkspacePublishInput {
  /** 当前 workspace 头部 revision（含其完整文件清单，用于计算冲突路径）。 */
  readonly current: {
    readonly revisionId: string;
    readonly revision: number;
    readonly files: readonly WorkspacePublishFileEntry[];
  };
  /** 调用方声称所基于的基线 revisionId（执行 Agent 读取的固定输入版本）。 */
  readonly baselineRevisionId: string;
  /** 已路径校验的提交文件清单（完整新 manifest）。 */
  readonly files: readonly WorkspacePublishFileEntry[];
}

export type WorkspacePublishDecision =
  | { readonly kind: 'publish'; readonly nextRevision: number }
  | {
      readonly kind: 'conflict';
      readonly currentRevisionId: string;
      readonly currentRevision: number;
      readonly submittedBaselineRevisionId: string;
      readonly conflictingPaths: readonly string[];
    }
  | { readonly kind: 'rejected'; readonly reason: 'empty-files' | 'revision-overflow' };

/** 提交清单与当前清单的「不一致路径」升序（artifactId 不同或仅一方持有）。 */
function computeConflictingPaths(
  submitted: readonly WorkspacePublishFileEntry[],
  current: readonly WorkspacePublishFileEntry[],
): string[] {
  const currentByPath = new Map(current.map((entry) => [entry.path, entry.artifactId]));
  const submittedByPath = new Map(submitted.map((entry) => [entry.path, entry.artifactId]));
  const allPaths = new Set<string>([...submittedByPath.keys(), ...currentByPath.keys()]);
  return [...allPaths]
    .filter((path) => submittedByPath.get(path) !== currentByPath.get(path))
    .sort();
}

/**
 * 判定 publish 结果。
 * - 空清单 → rejected empty-files。
 * - 基线 ≠ 当前 → conflict（附当前版本 + 冲突路径）。
 * - current.revision 已达上限 → rejected revision-overflow。
 * - 否则 → publish，nextRevision = current.revision + 1。
 */
export function evaluateWorkspacePublish(input: EvaluateWorkspacePublishInput): WorkspacePublishDecision {
  if (input.files.length === 0) {
    return { kind: 'rejected', reason: 'empty-files' };
  }
  if (input.baselineRevisionId !== input.current.revisionId) {
    return {
      kind: 'conflict',
      currentRevisionId: input.current.revisionId,
      currentRevision: input.current.revision,
      submittedBaselineRevisionId: input.baselineRevisionId,
      conflictingPaths: computeConflictingPaths(input.files, input.current.files),
    };
  }
  if (input.current.revision === Number.MAX_SAFE_INTEGER) {
    return { kind: 'rejected', reason: 'revision-overflow' };
  }
  return { kind: 'publish', nextRevision: input.current.revision + 1 };
}
