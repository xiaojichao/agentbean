/**
 * #1044 run output → `outputs/<publishIdentity>` 本机待发布批次。
 *
 * publish manifest 是本机权威传输批次记录：baseline revision、文件相对路径、
 * hash、长度、上传进度与 Server 返回身份都持久化在这里。manifest 只使用相对
 * 路径与稳定身份，不含任何外部绝对路径——它不是跨 Device 合同之外的私有状态，
 * 可以被安全检查、备份与诊断。
 *
 * 恢复语义：网络中断、daemon 重启或进程退出后，discovery 扫描各 Channel
 * projection 的 outputs/ 找回 status=pending 的批次，按同一 publish identity
 * 续传或收敛；committed/abandoned 批次不再参与自动恢复。
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mimeTypeForFilename } from './workspace-publish-delivery.js';
import type {
  LocalWorkspacePublishRecord,
  WorkspacePublishRecoveryStore,
} from './workspace-publish-recovery.js';
import {
  prepareChannelWorkspaceOutput,
  readDeviceProjectionManifest,
} from './workspace-run.js';

export type WorkspacePublishOutputStatus = 'pending' | 'committed' | 'abandoned';

export interface WorkspacePublishOutputFileEntry {
  readonly relativePath: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** 本机上传进度镜像；Server staging 的 receivedBytes 仍是权威。 */
  readonly uploadedBytes: number;
  readonly complete: boolean;
}

export interface WorkspacePublishOutputManifest {
  readonly schemaVersion: 2;
  readonly publishIdentity: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly deviceId: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly taskAttempt?: number;
  readonly workspaceRunId?: string;
  readonly baselineRevisionId: string;
  readonly status: WorkspacePublishOutputStatus;
  readonly files: readonly WorkspacePublishOutputFileEntry[];
  /** Server commit 成功后写入：同一 publish identity 幂等查询的最终 revision。 */
  readonly committedRevisionId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** run 结果（含本次发布的 artifactIds）已送达 Server 的稳定标记。 */
  readonly reportedAt?: number;
}

export interface StagedWorkspacePublishOutput {
  readonly outputDir: string;
  readonly manifest: WorkspacePublishOutputManifest;
}

const PUBLISH_OUTPUT_MANIFEST = 'manifest.json';

/** 与 workspace-run.ts 相同的单段安全约束（projection 内所有身份段共用）。 */
function isSafeSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

function safeDirectoryEntries(path: string): Dirent<string>[] {
  try {
    return readdirSync(path, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeManifestAtomic(outputDir: string, manifest: WorkspacePublishOutputManifest): void {
  const target = join(outputDir, PUBLISH_OUTPUT_MANIFEST);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(temp, target);
}

export function readWorkspacePublishOutputManifest(outputDir: string): WorkspacePublishOutputManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(outputDir, PUBLISH_OUTPUT_MANIFEST), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const candidate = parsed as Partial<WorkspacePublishOutputManifest>;
    if (candidate.schemaVersion !== 2
      || typeof candidate.publishIdentity !== 'string'
      || typeof candidate.teamId !== 'string'
      || typeof candidate.channelId !== 'string'
      || typeof candidate.deviceId !== 'string'
      || typeof candidate.baselineRevisionId !== 'string'
      || (candidate.status !== 'pending' && candidate.status !== 'committed' && candidate.status !== 'abandoned')
      || !Array.isArray(candidate.files)
      || typeof candidate.createdAt !== 'number'
      || typeof candidate.updatedAt !== 'number') {
      return undefined;
    }
    // 文件条目形状校验:篡改/截断的 manifest 不得流入恢复流程。
    for (const file of candidate.files as Array<Partial<WorkspacePublishOutputFileEntry>>) {
      if (!file || typeof file !== 'object'
        || typeof file.relativePath !== 'string'
        || typeof file.filename !== 'string'
        || typeof file.mimeType !== 'string'
        || typeof file.sha256 !== 'string'
        || typeof file.sizeBytes !== 'number'
        || typeof file.uploadedBytes !== 'number'
        || typeof file.complete !== 'boolean') {
        return undefined;
      }
    }
    return candidate as WorkspacePublishOutputManifest;
  } catch {
    return undefined;
  }
}

/**
 * 把本次 WorkspaceRun 确认的输出登记/复制到 `outputs/<publishIdentity>`。
 * 复制后逐文件复核 size+sha256，保证 manifest 与 staged 内容一致。
 * 同一 identity 重复调用：plan（baseline + 文件清单 hash/size）一致则保留已有
 * 上传进度幂等返回；plan 漂移说明 identity 被复用，直接拒绝。
 */
export function stageRunOutputsToPublishOutput(input: {
  readonly agentBeanHome: string;
  readonly deviceId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly publishIdentity: string;
  readonly baselineRevisionId: string;
  readonly now: number;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly taskAttempt?: number;
  readonly workspaceRunId?: string;
  readonly collected: readonly {
    absolutePath: string;
    relativePath: string;
    sha256: string;
    sizeBytes: number;
    filename: string;
  }[];
}): StagedWorkspacePublishOutput {
  const outputDir = prepareChannelWorkspaceOutput({
    agentBeanHome: input.agentBeanHome,
    deviceId: input.deviceId,
    teamId: input.teamId,
    channelId: input.channelId,
    publishIdentity: input.publishIdentity,
  });
  const root = resolve(outputDir);

  const planned = input.collected.map((artifact) => {
    const relativePath = artifact.relativePath.replaceAll('\\', '/');
    if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '..' || !part)) {
      throw new Error('WORKSPACE_PROJECTION_INVALID_PROVENANCE');
    }
    return {
      relativePath,
      filename: artifact.filename,
      mimeType: mimeTypeForFilename(artifact.filename),
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      source: artifact.absolutePath,
    };
  });

  const existing = readWorkspacePublishOutputManifest(outputDir);
  if (existing) {
    const samePlan = existing.baselineRevisionId === input.baselineRevisionId
      && existing.files.length === planned.length
      && existing.files.every((file) => planned.some((entry) => entry.relativePath === file.relativePath
        && entry.sha256 === file.sha256
        && entry.sizeBytes === file.sizeBytes));
    if (!samePlan) throw new Error('WORKSPACE_PUBLISH_OUTPUT_PLAN_MISMATCH');
    // 补齐缺失的 staged copy（例如上次进程在复制途中退出）；已存在的 copy 不动。
    for (const entry of planned) {
      const destination = join(root, ...entry.relativePath.split('/'));
      if (existsSync(destination)) continue;
      copyVerified(entry.source, destination, entry, root);
    }
    return { outputDir, manifest: existing };
  }

  for (const entry of planned) {
    const destination = join(root, ...entry.relativePath.split('/'));
    copyVerified(entry.source, destination, entry, root);
  }
  const manifest: WorkspacePublishOutputManifest = {
    schemaVersion: 2,
    publishIdentity: input.publishIdentity,
    teamId: input.teamId,
    channelId: input.channelId,
    deviceId: input.deviceId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.taskAttempt !== undefined ? { taskAttempt: input.taskAttempt } : {}),
    ...(input.workspaceRunId ? { workspaceRunId: input.workspaceRunId } : {}),
    baselineRevisionId: input.baselineRevisionId,
    status: 'pending',
    files: planned.map((entry) => ({
      relativePath: entry.relativePath,
      filename: entry.filename,
      mimeType: entry.mimeType,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      uploadedBytes: 0,
      complete: false,
    })),
    createdAt: input.now,
    updatedAt: input.now,
  };
  writeManifestAtomic(outputDir, manifest);
  return { outputDir, manifest };
}

function copyVerified(
  source: string,
  destination: string,
  entry: { relativePath: string; sha256: string; sizeBytes: number },
  root: string,
): void {
  const resolvedDestination = resolve(destination);
  if (resolvedDestination !== root && !resolvedDestination.startsWith(`${root}/`)) {
    throw new Error('WORKSPACE_PROJECTION_PATH_ESCAPE');
  }
  const parent = dirname(resolvedDestination);
  // 逐段落盘并拒绝 symlink 逃逸（与 workspace-run.ts ensureDirectoryNoSymlink 同约束）。
  const segments = parent.slice(root.length).split('/').filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('WORKSPACE_PROJECTION_SYMLINK_ESCAPE');
      if (!stat.isDirectory()) throw new Error('WORKSPACE_PROJECTION_NOT_DIRECTORY');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      mkdirSync(current);
    }
  }
  copyFileSync(source, resolvedDestination);
  const stagedStat = statSync(resolvedDestination);
  if (stagedStat.size !== entry.sizeBytes || sha256File(resolvedDestination) !== entry.sha256) {
    rmSync(resolvedDestination, { force: true });
    throw new Error('WORKSPACE_PUBLISH_OUTPUT_COPY_MISMATCH');
  }
}

export interface DiscoveredWorkspacePublishOutput {
  readonly outputDir: string;
  readonly manifest: WorkspacePublishOutputManifest;
}

/**
 * 恢复发现：扫描本机所有 Channel projection 的 outputs/，返回属于当前 Device 的批次。
 * device.json 与 manifest.deviceId 双重校验，恢复出来的其他 Device 数据不会被本机认领。
 */
export function discoverWorkspacePublishOutputs(input: {
  readonly agentBeanHome: string;
  readonly deviceId: string;
  readonly status?: WorkspacePublishOutputStatus;
}): DiscoveredWorkspacePublishOutput[] {
  const home = resolve(input.agentBeanHome);
  const device = readDeviceProjectionManifest(join(home, 'device.json'));
  if (!device || device.deviceId !== input.deviceId) return [];
  const found: DiscoveredWorkspacePublishOutput[] = [];
  const workspacesRoot = join(home, 'workspaces');
  for (const teamEntry of safeDirectoryEntries(workspacesRoot)) {
    if (!teamEntry.isDirectory() || !isSafeSegment(teamEntry.name)) continue;
    const channelsRoot = join(workspacesRoot, teamEntry.name, 'channels');
    for (const channelEntry of safeDirectoryEntries(channelsRoot)) {
      if (!channelEntry.isDirectory() || !isSafeSegment(channelEntry.name)) continue;
      const outputsRoot = join(channelsRoot, channelEntry.name, 'outputs');
      for (const outputEntry of safeDirectoryEntries(outputsRoot)) {
        if (!outputEntry.isDirectory() || !isSafeSegment(outputEntry.name)) continue;
        const outputDir = join(outputsRoot, outputEntry.name);
        const manifest = readWorkspacePublishOutputManifest(outputDir);
        if (!manifest
          || manifest.publishIdentity !== outputEntry.name
          || manifest.deviceId !== input.deviceId
          || manifest.teamId !== teamEntry.name
          || manifest.channelId !== channelEntry.name) {
          continue;
        }
        if (input.status && manifest.status !== input.status) continue;
        found.push({ outputDir, manifest });
      }
    }
  }
  return found.sort((a, b) => a.manifest.createdAt - b.manifest.createdAt);
}

function toLocalRecord(outputDir: string, manifest: WorkspacePublishOutputManifest): LocalWorkspacePublishRecord {
  return {
    publishId: manifest.publishIdentity,
    teamId: manifest.teamId,
    channelId: manifest.channelId,
    baselineRevisionId: manifest.baselineRevisionId,
    files: manifest.files.map((file) => ({
      path: file.relativePath,
      // staged copy 是本机幂等传输源；绝对路径只存在于运行时,不落盘、不跨 Device。
      absolutePath: join(outputDir, ...file.relativePath.split('/')),
      filename: file.filename,
      mimeType: file.mimeType,
      expectedSizeBytes: file.sizeBytes,
      expectedSha256: file.sha256,
      uploadedBytes: file.uploadedBytes,
      complete: file.complete,
    })),
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    ...(manifest.committedRevisionId ? { committedRevisionId: manifest.committedRevisionId } : {}),
    ...(manifest.agentId && manifest.taskId && manifest.taskAttempt !== undefined
      ? {
          provenance: {
            agentId: manifest.agentId,
            taskId: manifest.taskId,
            taskAttempt: manifest.taskAttempt,
            ...(manifest.workspaceRunId ? { workspaceRunId: manifest.workspaceRunId } : {}),
            deviceId: manifest.deviceId,
          },
        }
      : {}),
  };
}

/**
 * 以 `outputs/<publishIdentity>/manifest.json` 为存储的 WorkspacePublishRecoveryStore。
 * 新发布一律走这里；旧的扁平 workspace-publish-pending store 只做只读兼容恢复。
 */
export function createWorkspacePublishOutputStore(input: {
  readonly agentBeanHome: string;
  readonly deviceId: string;
}): WorkspacePublishRecoveryStore {
  const locate = (publishId: string): DiscoveredWorkspacePublishOutput | null => {
    if (!isSafeSegment(publishId)) return null;
    for (const candidate of discoverWorkspacePublishOutputs(input)) {
      if (candidate.manifest.publishIdentity === publishId) return candidate;
    }
    return null;
  };
  const rewrite = (
    publishId: string,
    mutate: (manifest: WorkspacePublishOutputManifest) => WorkspacePublishOutputManifest,
  ): void => {
    const located = locate(publishId);
    if (!located) return;
    writeManifestAtomic(located.outputDir, mutate(located.manifest));
  };

  return {
    save(record) {
      const located = locate(record.publishId);
      if (!located) {
        // manifest 丢失但 staged copy 可能仍在：从 record 重建批次记录（进度归零,
        // 下次 resume 以 Server 进度为准重新同步）。绝不因簿记缺失让 dispatch 失败。
        const outputDir = prepareChannelWorkspaceOutput({
          agentBeanHome: input.agentBeanHome,
          deviceId: input.deviceId,
          teamId: record.teamId,
          channelId: record.channelId,
          publishIdentity: record.publishId,
        });
        writeManifestAtomic(outputDir, {
          schemaVersion: 2,
          publishIdentity: record.publishId,
          teamId: record.teamId,
          channelId: record.channelId,
          deviceId: record.provenance?.deviceId ?? input.deviceId,
          ...(record.provenance?.agentId ? { agentId: record.provenance.agentId } : {}),
          ...(record.provenance?.taskId ? { taskId: record.provenance.taskId } : {}),
          ...(record.provenance?.taskAttempt !== undefined ? { taskAttempt: record.provenance.taskAttempt } : {}),
          ...(record.provenance?.workspaceRunId ? { workspaceRunId: record.provenance.workspaceRunId } : {}),
          baselineRevisionId: record.baselineRevisionId,
          status: record.status === 'committed' ? 'committed' : record.status === 'abandoned' ? 'abandoned' : 'pending',
          files: record.files.map((file) => ({
            relativePath: file.path,
            filename: file.filename,
            mimeType: file.mimeType,
            sha256: file.expectedSha256,
            sizeBytes: file.expectedSizeBytes,
            uploadedBytes: file.uploadedBytes ?? 0,
            complete: file.complete ?? false,
          })),
          ...(record.committedRevisionId ? { committedRevisionId: record.committedRevisionId } : {}),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
        return;
      }
      // 保留已有上传进度与状态：save 只刷新计划元数据（delivery 每次调用都会 save）。
      const progressByPath = new Map(located.manifest.files.map((file) => [file.relativePath, file]));
      writeManifestAtomic(located.outputDir, {
        ...located.manifest,
        files: record.files.map((file) => {
          const progress = progressByPath.get(file.path);
          return {
            relativePath: file.path,
            filename: file.filename,
            mimeType: file.mimeType,
            sha256: file.expectedSha256,
            sizeBytes: file.expectedSizeBytes,
            uploadedBytes: progress?.uploadedBytes ?? file.uploadedBytes ?? 0,
            complete: progress?.complete ?? file.complete ?? false,
          };
        }),
        updatedAt: record.updatedAt,
      });
    },
    get(publishId) {
      const located = locate(publishId);
      return located ? toLocalRecord(located.outputDir, located.manifest) : null;
    },
    listPending() {
      return discoverWorkspacePublishOutputs({ ...input, status: 'pending' })
        .map((candidate) => toLocalRecord(candidate.outputDir, candidate.manifest));
    },
    markCommitted(publishId, committedRevisionId, now) {
      rewrite(publishId, (manifest) => ({
        ...manifest,
        status: 'committed',
        committedRevisionId,
        files: manifest.files.map((file) => ({ ...file, uploadedBytes: file.sizeBytes, complete: true })),
        updatedAt: now,
      }));
    },
    markProgress(publishId, path, uploadedBytes, complete, now) {
      rewrite(publishId, (manifest) => ({
        ...manifest,
        files: manifest.files.map((file) => file.relativePath === path
          ? { ...file, uploadedBytes, complete }
          : file),
        updatedAt: now,
      }));
    },
    markAbandoned(publishId, now) {
      rewrite(publishId, (manifest) => manifest.status === 'committed'
        ? manifest
        : { ...manifest, status: 'abandoned', updatedAt: now });
    },
    remove(publishId) {
      const located = locate(publishId);
      if (!located) return;
      // 只摘 manifest（批次记录）；staged 文件保留在 outputs/ 供人工诊断/清理。
      rmSync(join(located.outputDir, PUBLISH_OUTPUT_MANIFEST), { force: true });
    },
  };
}

/** run 结果已送达 Server 时写稳定标记（独立于 store 接口,避免扩散既有实现）。 */
export function markWorkspacePublishOutputReported(input: {
  readonly agentBeanHome: string;
  readonly deviceId: string;
  readonly publishId: string;
  readonly now: number;
}): void {
  const located = discoverWorkspacePublishOutputs({
    agentBeanHome: input.agentBeanHome,
    deviceId: input.deviceId,
  }).find((candidate) => candidate.manifest.publishIdentity === input.publishId);
  if (!located) return;
  writeManifestAtomic(located.outputDir, {
    ...located.manifest,
    reportedAt: input.now,
    updatedAt: input.now,
  });
}
