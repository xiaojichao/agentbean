import type { ID } from './common.js';
import type { ProjectArtifactVersionReviewState } from './project.js';

/**
 * #1064：冻结的项目输入（frozen inputs）。
 *
 * 消息发送时刻把 current/final/package 指针解析为具体 `artifactVersionId` 后，
 * 该事实随 Offer 与 Invocation intent 一起冻结：
 *
 * - Offer 发布时冻结——是 acceptance 复验的 package/version basis（#1064 AC6），
 *   且只在 `objective.inputs` 里披露文件名摘要（最小 preview，AC4）；
 * - Invocation 创建时随 immutable intent 写入（AC7）——执行期间不重新解析
 *   current/final，上游版本变化不改变本事实。
 *
 * 本 DTO 只保存稳定身份与解析当刻的快照字段，不携带动态指针。
 */
export interface FrozenProjectInputItemDto {
  readonly collectionId: ID;
  readonly artifactVersionId: ID;
  readonly versionNumber: number;
  readonly artifactId: ID;
  readonly filename: string;
  /** 解析当刻该版本是否为 final（finalization basis 快照，不随后续 final 移动）。 */
  readonly isFinal: boolean;
  /** 解析当刻该版本的 ArtifactReview 聚合（review basis 快照）。 */
  readonly reviewState: ProjectArtifactVersionReviewState;
}
