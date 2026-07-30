/**
 * #966 Workspace revision provenance 的展示逻辑（纯函数）。
 *
 * 把判别联合 provenance（#964 设备导入 / #966 Agent 原子发布）归类为面向成员的来源描述，
 * 供未来的 Project Channel Workspace revision 面板消费（频道文件浏览尚无 workspace 面板，
 * 本模块为其预先沉淀展示逻辑，避免 UI 落地时重复实现）。
 */
import type { WorkspaceRevisionProvenanceDto } from '@agentbean/contracts';

export type WorkspaceRevisionProvenanceViewKind = 'import' | 'publish' | 'unknown';

export interface WorkspaceRevisionProvenanceView {
  readonly kind: WorkspaceRevisionProvenanceViewKind;
  /** 面向成员的来源描述（不含内部 id 细节，由调用方按需追加）。 */
  readonly label: string;
  /** publish 来源的 Agent/Task attempt（kind!=='publish' 时为 undefined）。 */
  readonly agentId?: string;
  readonly taskId?: string;
  readonly taskAttempt?: number;
  /** 基线 revisionId（Agent 读取的固定输入版本）。 */
  readonly baselineRevisionId?: string;
}

/**
 * 把 provenance 投影为展示视图。undefined → unknown。
 * 不在此处解析 Agent/Task 显示名（由 UI 层按团队上下文解析），仅携带 id 供解析。
 *
 * 兼容性：#964 早期 import revision 的 provenance 无 kind 判别字段（{sourceDeviceId, importedAt}）。
 * 因历史上只有 import 一种 provenance，凡非 publish 一律按 import 渲染，避免误判为 Agent 发布。
 */
export function describeWorkspaceRevisionProvenance(
  provenance: WorkspaceRevisionProvenanceDto | undefined,
): WorkspaceRevisionProvenanceView {
  if (!provenance) return { kind: 'unknown', label: '来源未知' };
  if (provenance.kind === 'publish') {
    return {
      kind: 'publish',
      label: '由 Agent 发布',
      agentId: provenance.agentId,
      taskId: provenance.taskId,
      taskAttempt: provenance.taskAttempt,
      baselineRevisionId: provenance.baselineRevisionId,
    };
  }
  // kind === 'import'，或缺失 kind 的 legacy import provenance。
  return { kind: 'import', label: '由设备导入' };
}
