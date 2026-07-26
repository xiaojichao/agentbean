/**
 * #830：历史 Markdown 输出的保守回填分组判定。
 *
 * 这里只回答一个问题：一次 Workspace Run 的 Markdown 产出，是否**可以被证明**构成
 * 一个完整、无歧义的文档包。判定是纯函数，不读库、不做 IO，也不看文件名、目录、
 * mime、TaskStatus 或聊天文字 —— 唯一依据是 ChannelDocument revision 的
 * derivationSource 指向哪一次 Run。
 *
 * 与 #825 交互路径的分工：本模块决定「哪些文档属于这一次输出」，
 * evaluateBundleComposition 决定「这些文档是否够格入包」。回填必须两步都过。
 */

import type { ProjectDocumentBundleMemberRejectionCode } from './project-document-bundle-policy.js';

/**
 * 回填只对「多份」Markdown 分组。单份输出本身就是完整的交付物，为它建包不增加任何
 * 历史信息，却要凭空替用户造一个包名与包边界 —— 那正是本 Issue 要避免的猜测。
 */
export const MINIMUM_BACKFILLED_BUNDLE_MEMBERS = 2;

/** 分组层面的拒绝原因，区别于 #825 的逐成员资格原因。 */
export type ProjectDocumentBundleBackfillGroupingCode =
  /**
   * 有文档曾派生自这次 Run，但当前 revision 已不再是它的原样产物（被人工编辑、恢复，
   * 或改由另一次 Run 派生）：这次输出到底是什么已不可证。
   */
  | 'member_drifted'
  /** 有文档声称派生自这次 Run，却不在 Run 所属频道内：来源事实自相矛盾。 */
  | 'cross_channel_member'
  /** 可证成员不足以构成「多份输出」。 */
  | 'single_document'
  /** 没有任何可证成员。 */
  | 'no_provable_member';

/**
 * 回填流程可能给出的全部原因码：分组层 + 运行/频道层 + 复用 #825 的逐成员资格码。
 * 成员码直接复用而不另起一套词汇，避免「不可见文档」在两处有两个名字。
 */
export type ProjectDocumentBundleBackfillReasonCode =
  | ProjectDocumentBundleBackfillGroupingCode
  | ProjectDocumentBundleMemberRejectionCode
  /** 频道已归档：归档后写入不安全，候选保持未分组。 */
  | 'channel_archived'
  /** 频道已不存在（或跨 Team 读不到）。 */
  | 'channel_unavailable'
  /** Workspace Run 记录缺失，来源无法证明。 */
  | 'run_unavailable'
  /** Run 输出经 handoff 未 deliver_to_root：属于内部 Invocation，不公开。 */
  | 'run_not_public'
  /** 来源 Invocation 绑定的 Task revision 已被取代。 */
  | 'invocation_stale'
  /** 回填找不到可代表频道执行建包的既有身份。 */
  | 'actor_unavailable'
  /** 写入时与并发编辑或既有幂等键冲突，下一轮可安全重试。 */
  | 'write_conflict'
  /** 未预期错误；游标不推进，下一轮从同一位置重试。 */
  | 'unexpected_error';

const MEMBER_REJECTION_CODES = [
  'not_markdown', 'run_log', 'preview_derivative', 'not_visible',
  'scope_mismatch', 'source_mismatch', 'duplicate', 'not_found',
] as const;

/**
 * 编译期穷尽性护栏：#825 若新增成员原因码而这里漏登记，这一行立刻报错。
 * 手工同步的字符串清单迟早会漂移，靠类型钉死比靠纪律可靠。
 */
type UncoveredMemberRejectionCode =
  Exclude<ProjectDocumentBundleMemberRejectionCode, (typeof MEMBER_REJECTION_CODES)[number]>;
const _memberRejectionCodesAreExhaustive: [UncoveredMemberRejectionCode] extends [never]
  ? true
  : never = true;
void _memberRejectionCodesAreExhaustive;

/** 判断一个原因码是否来自 #825 的逐成员资格判定，用于把它安全并入回填原因码。 */
export function isProjectDocumentBundleMemberRejectionCode(
  value: string | undefined,
): value is ProjectDocumentBundleMemberRejectionCode {
  return value !== undefined
    && (MEMBER_REJECTION_CODES as readonly string[]).includes(value);
}

/**
 * 一份「曾派生自目标 Run」的频道文档。调用方查询时已按「任一 revision 派生自该 Run」
 * 过滤，因此 derivedFromRunEver 是构造前提，不再作为字段传入。
 */
export interface ProjectDocumentBundleBackfillDocumentFact {
  readonly documentId: string;
  readonly channelId: string;
  readonly createdAt: number;
  /**
   * 当前 revision 是否**仍是这一次 Run 的原样产物**。
   *
   * 注意这不等于「当前 revision 的 derivationSource 指向该 Run」：derivationSource
   * 会被后续 revision 继承，人工编辑过的文档同样带着原始 Run 的来源。调用方必须把
   * 「revision 由该 Run 产生」这一条也算进来，否则漂移永远检测不到。
   */
  readonly derivesFromRunNow: boolean;
}

export interface ProjectDocumentBundleBackfillScope {
  readonly channelId: string;
  readonly minimumMembers?: number;
}

export type ProjectDocumentBundleBackfillGrouping =
  | { readonly groupable: true; readonly documentIds: readonly string[] }
  | { readonly groupable: false; readonly code: ProjectDocumentBundleBackfillGroupingCode };

/**
 * 判定顺序即原因优先级：先排除「来源事实矛盾」和「成员集不可证」，最后才谈数量。
 * 漂移优先于数量，是因为漂移意味着我们根本不知道这次 Run 到底产出了几份 —— 报
 * single_document 会把「不可知」误报成「已知只有一份」。
 */
export function evaluateBundleBackfillGrouping(
  facts: readonly ProjectDocumentBundleBackfillDocumentFact[],
  scope: ProjectDocumentBundleBackfillScope,
): ProjectDocumentBundleBackfillGrouping {
  if (facts.some((fact) => fact.channelId !== scope.channelId)) {
    return { groupable: false, code: 'cross_channel_member' };
  }
  if (facts.some((fact) => !fact.derivesFromRunNow)) {
    return { groupable: false, code: 'member_drifted' };
  }
  if (facts.length === 0) {
    return { groupable: false, code: 'no_provable_member' };
  }
  const minimumMembers = scope.minimumMembers ?? MINIMUM_BACKFILLED_BUNDLE_MEMBERS;
  if (facts.length < minimumMembers) {
    return { groupable: false, code: 'single_document' };
  }
  // 成员顺序按文档创建时间取稳定序，而不是按文件名或路径排序 —— 顺序不得成为
  // 从命名反推结构的入口，同时必须可重放，否则幂等指纹会在重试之间漂移。
  const documentIds = facts
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt || left.documentId.localeCompare(right.documentId))
    .map((fact) => fact.documentId);
  return { groupable: true, documentIds };
}
