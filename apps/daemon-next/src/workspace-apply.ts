import { createHash } from 'node:crypto';
import { mkdir, opendir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { WorkspaceApplyConflictDto, WorkspaceApplyFileEntryDto } from '../../../packages/contracts/src/index.js';
import { computeWorkspaceApplyPlan } from '../../../packages/domain/src/index.js';

/**
 * #968 把一份已发布 Workspace revision 安全应用回本地目录（server→device，#964 导入的镜像）。
 *
 * 安全不变量（#960 规格 / issue #968 AC）：
 * - 冲突即全有或全无：任一 revision 路径在目标目录已存在同名本地文件 → 整个 apply 拒绝，
 *   写零字节，返回冲突清单（不做自动合并 / 覆盖）。
 * - 失败不留部分写入：两阶段——先把所有文件下载 + size/SHA-256 校验到 staging 区，
 *   全部就绪再统一 rename 进目标目录；任一阶段失败回滚（清理 staging + 已 rename 的文件）。
 * - 路径不逃逸：revision 路径经 normalizeWorkspacePath 重校验（domain），只允许相对路径。
 * - 来源 Device 无关：本函数只接收 revision 清单 + 本地目录，不涉及 provenance。
 *
 * 范式直接沿用 materializeProjectDocumentInputSet（HTTP 下载 + staging→rename 原子写），
 * 区别在于目标是用户**已有**目录，故用「全部下载校验 → 逐文件 rename 进 targetDir」两阶段
 * （冲突预检保证 rename 均为新路径、非覆盖）。
 */
export type WorkspaceApplyError =
  | 'INVALID_PATH'
  | 'CONFLICT'
  | 'DOWNLOAD_FAILED'
  | 'SIZE_MISMATCH'
  | 'SHA_MISMATCH'
  | 'PERMISSION'
  | 'WRITE_FAILED';

export interface WorkspaceApplyRevision {
  readonly files: ReadonlyArray<WorkspaceApplyFileEntryDto>;
}

export interface PreviewWorkspaceApplyInput {
  readonly revision: WorkspaceApplyRevision;
  /** 本地用户显式选择的目标目录（绝对路径）。 */
  readonly targetDir: string;
  /** 列出目标目录下既有相对路径；默认真实递归遍历（仅文件，POSIX 相对路径）。 */
  readonly listLocalEntries?: (dir: string) => Promise<readonly string[]>;
}

export interface MaterializeWorkspaceRevisionInput extends PreviewWorkspaceApplyInput {
  readonly serverUrl: string;
  readonly token: string;
  readonly teamId: string;
  /** 注入 fetch（测试用）；生产用全局 fetch。 */
  readonly fetch?: typeof fetch;
}

export type MaterializeWorkspaceRevisionResult =
  | { readonly ok: true; readonly written: readonly string[] }
  | { readonly ok: false; readonly error: WorkspaceApplyError; readonly conflicts?: readonly WorkspaceApplyConflictDto[] };

/** 默认本地条目列出器：递归遍历，仅文件，返回相对 targetDir 的 POSIX 路径。 */
async function listLocalEntriesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let directory;
    try {
      directory = await opendir(current);
    } catch {
      // 不可读子目录直接跳过（不阻塞其余条目）。
      continue;
    }
    for await (const entry of directory) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(relative(dir, full).split(sep).join('/'));
      }
    }
  }
  return out;
}

/**
 * #968 预览（只读）：列出目标目录 + 计算应用计划，不写任何文件。
 * 本地用户据此看到「受影响文件 + 冲突」后决定是否继续（取消 = 不调用 materialize）。
 */
export async function previewWorkspaceApply(
  input: PreviewWorkspaceApplyInput,
): Promise<ReturnType<typeof computeWorkspaceApplyPlan>> {
  const list = input.listLocalEntries ?? listLocalEntriesRecursive;
  const localRelativePaths = await list(resolve(input.targetDir));
  return computeWorkspaceApplyPlan({ revisionFiles: input.revision.files, localRelativePaths });
}

class WorkspaceDownloadError extends Error {
  constructor(readonly code: Exclude<WorkspaceApplyError, 'INVALID_PATH' | 'CONFLICT' | 'PERMISSION' | 'WRITE_FAILED'>) {
    super(`WORKSPACE_APPLY_${code}`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * #968 应用：下载并原子写入 revision 文件到本地目标目录。
 * 成功返回写入的相对路径；失败返回对应 error（冲突时附 conflicts），且目标目录无残留。
 */
export async function materializeProjectChannelWorkspaceRevision(
  input: MaterializeWorkspaceRevisionInput,
): Promise<MaterializeWorkspaceRevisionResult> {
  const targetDir = resolve(input.targetDir);
  const list = input.listLocalEntries ?? listLocalEntriesRecursive;
  const fetchFn = input.fetch ?? fetch;

  // 阶段 0：冲突预检（AC#2/#4-冲突）——有冲突则写零。
  const localRelativePaths = await list(targetDir);
  const plan = computeWorkspaceApplyPlan({ revisionFiles: input.revision.files, localRelativePaths });
  if (!plan.ok) return { ok: false, error: 'INVALID_PATH' };
  if (plan.plan.conflicts.length > 0) {
    return { ok: false, error: 'CONFLICT', conflicts: plan.plan.conflicts };
  }

  // 阶段 1：下载 + size/SHA-256 校验到 staging 区（targetDir 的兄弟目录）。
  const stagingDir = `${targetDir}.agentbean-apply-staging`;
  await rm(stagingDir, { recursive: true, force: true });
  try {
    await mkdir(stagingDir, { recursive: true });
  } catch (error) {
    return { ok: false, error: isPermissionError(error) ? 'PERMISSION' : 'WRITE_FAILED' };
  }

  try {
    for (const file of input.revision.files) {
      const url = `${trimTrailingSlash(input.serverUrl)}/api/teams/${encodeURIComponent(input.teamId)}/artifacts/${encodeURIComponent(file.artifactId)}/download`;
      let response: Response;
      try {
        response = await fetchFn(url, { headers: { Authorization: `Bearer ${input.token}` } });
      } catch {
        throw new WorkspaceDownloadError('DOWNLOAD_FAILED');
      }
      if (!response.ok) throw new WorkspaceDownloadError('DOWNLOAD_FAILED');
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await response.arrayBuffer());
      } catch {
        throw new WorkspaceDownloadError('DOWNLOAD_FAILED');
      }
      if (bytes.byteLength !== file.sizeBytes) throw new WorkspaceDownloadError('SIZE_MISMATCH');
      if (file.sha256) {
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== file.sha256) throw new WorkspaceDownloadError('SHA_MISMATCH');
      }
      const stagingPath = join(stagingDir, file.path);
      await mkdir(dirname(stagingPath), { recursive: true });
      await writeFile(stagingPath, bytes);
    }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    if (error instanceof WorkspaceDownloadError) return { ok: false, error: error.code };
    return { ok: false, error: 'WRITE_FAILED' };
  }

  // 阶段 2：提交——逐文件 rename 进 targetDir（均为新路径，非覆盖）。任一失败回滚已写入。
  const written: string[] = [];
  try {
    for (const file of input.revision.files) {
      const finalPath = join(targetDir, file.path);
      await mkdir(dirname(finalPath), { recursive: true });
      await rename(join(stagingDir, file.path), finalPath);
      written.push(file.path);
    }
  } catch (error) {
    await Promise.all(written.map((path) => rm(join(targetDir, path), { force: true }).catch(() => undefined)));
    await rm(stagingDir, { recursive: true, force: true });
    return { ok: false, error: isPermissionError(error) ? 'PERMISSION' : 'WRITE_FAILED' };
  }

  await rm(stagingDir, { recursive: true, force: true });
  return { ok: true, written };
}
