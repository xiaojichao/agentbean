import type {
  WorkspaceApplyConflictDto,
  WorkspaceApplyFileEntryDto,
  WorkspaceApplyPlanDto,
} from '@agentbean/contracts';

import { normalizeWorkspacePath } from './workspace-import-policy.js';

/**
 * #968 Project Channel Workspace 本地应用策略。
 *
 * 纯函数：把一份已发布 revision 的文件清单与目标目录下既有相对路径做比对，
 * 产出「待写入文件 + 同名冲突」预览。不触碰文件系统、不接收设备 provenance，
 * 因此对来源 Device 完全无关（#960 规格：provenance 不决定读取/应用授权）。
 *
 * 路径安全（AC#3）：每个 revision 路径都经 normalizeWorkspacePath 防御性重校验，
 * 拒绝绝对路径 / 盘符 / 遍历 / 控制字符。revision 在发布时已校验过，此处二次校验
 * 是纵深防御——确保即便清单被篡改也不会逃出目标目录。
 */
export type ComputeWorkspaceApplyPlanOutput =
  | { readonly ok: true; readonly plan: WorkspaceApplyPlanDto }
  | { readonly ok: false; readonly error: 'INVALID_PATH' };

export interface ComputeWorkspaceApplyPlanInput {
  /** 已发布 revision 的文件清单（相对路径）。 */
  readonly revisionFiles: ReadonlyArray<
    Pick<WorkspaceApplyFileEntryDto, 'path' | 'artifactId' | 'filename' | 'sizeBytes' | 'sha256'>
  >;
  /** 目标目录下既有的相对路径（由调用方列出，仅作同名冲突比对）。 */
  readonly localRelativePaths: ReadonlyArray<string>;
}

/**
 * 计算把 revision 应用到本地目录的预览计划。
 * 返回 `{ ok: true, plan }`：toWrite 为全部待写入文件，conflicts 为与本地同名的子集。
 * 任一 revision 路径非法 → `{ ok: false, error: 'INVALID_PATH' }`。
 */
export function computeWorkspaceApplyPlan(
  input: ComputeWorkspaceApplyPlanInput,
): ComputeWorkspaceApplyPlanOutput {
  const localSet = new Set<string>();
  for (const raw of input.localRelativePaths) {
    const normalized = normalizeWorkspacePath(raw);
    if (normalized) localSet.add(normalized);
  }

  const toWrite: WorkspaceApplyFileEntryDto[] = [];
  const conflicts: WorkspaceApplyConflictDto[] = [];
  for (const file of input.revisionFiles) {
    const path = normalizeWorkspacePath(file.path);
    if (!path) return { ok: false, error: 'INVALID_PATH' };
    toWrite.push({
      path,
      artifactId: file.artifactId,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    });
    if (localSet.has(path)) {
      conflicts.push({ path, reason: 'LOCAL_FILE_EXISTS' });
    }
  }

  return { ok: true, plan: { toWrite, conflicts } };
}
