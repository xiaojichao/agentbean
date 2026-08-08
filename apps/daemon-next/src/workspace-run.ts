import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import {
  parseAgentCollaborationProposalV1,
  type AgentCollaborationProposalV1,
  type ProjectDocumentInputSetResultProposalV1,
} from '../../../packages/contracts/src/index.js';

export interface WorkspaceRunDir {
  cwd: string;
  runId: string;
  runDir: string;
  inputDir: string;
  outputDir: string;
  logsDir: string;
  manifestPath: string;
  responsePath: string;
  projection?: WorkspaceProjectionIdentity;
}

export interface WorkspaceProjectionIdentity {
  agentBeanHome: string;
  deviceId: string;
  teamId: string;
  channelId: string;
  agentId: string;
  taskId: string;
  taskAttempt: number;
  workspaceRunId: string;
  workspaceRevisionId?: string;
}

export interface ChannelProjectionOptions {
  agentBeanHome: string;
  deviceId: string;
  teamId: string;
  channelId: string;
  agentId: string;
  taskId: string;
  taskAttempt: number;
  workspaceRunId: string;
  workspaceRevisionId?: string;
}

export interface DeviceProjectionManifest {
  schemaVersion: 1;
  deviceId: string;
  teamId: string;
  updatedAt: number;
}

export interface ChannelWorkspaceOutputOptions extends Pick<ChannelProjectionOptions, 'agentBeanHome' | 'deviceId' | 'teamId' | 'channelId'> {
  publishIdentity: string;
}

export interface WorkspaceRunManifestFile {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
}

export interface WorkspaceRunManifestArtifact {
  id: string;
  filename: string;
  mimeType?: string;
  relativePath?: string;
  pathKind?: string;
  contentBase64?: string;
  storagePath?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface WorkspaceRunManifest {
  runId: string;
  /**
   * #1053：原始 dispatch 身份。Channel run 的 runId 是 workspaceRunId（运行与产物
   * provenance），恢复回报 Server 时必须使用原始 dispatchId；旧 manifest 没有此
   * 字段时回退 runId（等价于旧行为），无法确认身份被 Server 拒绝后写
   * unreportableAt 终结标记，不无限重试。
   */
  dispatchId?: string;
  agentId?: string;
  channelId?: string;
  status?: string;
  cwd?: string;
  command?: string;
  logExcerpt?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  /** 最近一次已提交的 workspace publish identity，供重启后继续补偿回报。 */
  publishId?: string;
  artifactIds?: string[];
  artifacts?: WorkspaceRunManifestArtifact[];
  collaborationProposals?: readonly AgentCollaborationProposalV1[];
  projectDocumentInputSetResult?: ProjectDocumentInputSetResultProposalV1;
  reportedAt?: number;
  /** 恢复回报被 Server 终态拒绝（如 Dispatch not found）后的 fail-closed 标记。 */
  unreportableAt?: number;
  unreportableReason?: string;
  deviceId?: string;
  teamId?: string;
  taskId?: string;
  taskAttempt?: number;
  workspaceRunId?: string;
  workspaceRevisionId?: string;
  workspaceSnapshotId?: string;
  provenance?: {
    relativePath: string;
    source: 'run-output' | 'snapshot' | 'response' | 'log';
  }[];
  files: WorkspaceRunManifestFile[];
}

export interface RecoverableWorkspaceRun {
  runId: string;
  /** 原始 dispatch 身份（#1053）；旧 manifest 缺失时由调用方回退 runId。 */
  dispatchId?: string;
  agentId: string;
  channelId: string;
  body: string;
  manifestPath: string;
  manifest: WorkspaceRunManifest;
  workspaceRun: {
    status: string;
    cwd: string;
    command?: string;
    logExcerpt?: string;
    exitCode?: number;
    startedAt?: number;
    completedAt?: number;
  };
  artifactIds?: string[];
  artifacts?: WorkspaceRunManifestArtifact[];
  collaborationProposals?: readonly AgentCollaborationProposalV1[];
  projectDocumentInputSetResult?: ProjectDocumentInputSetResultProposalV1;
}

export function workspaceRunPath(cwd: string, runId: string): string {
  return join(cwd, '.agentbean', 'runs', runId);
}

export function prepareWorkspaceRun(cwd: string, runId: string): WorkspaceRunDir {
  const runDir = workspaceRunPath(cwd, runId);
  const inputDir = join(runDir, 'inputs');
  const outputDir = join(runDir, 'outputs');
  const logsDir = join(runDir, 'logs');
  for (const dir of [inputDir, outputDir, logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    cwd,
    runId,
    runDir,
    inputDir,
    outputDir,
    logsDir,
    manifestPath: join(runDir, 'manifest.json'),
    responsePath: join(runDir, 'response.md'),
  };
}

/**
 * 为一次 dispatch 创建 Channel-first 受管执行目录。
 * 旧的 prepareWorkspaceRun(cwd, runId) 保留给历史恢复/兼容调用；新的
 * dispatch 必须使用本函数，避免 custom Agent cwd 成为项目协作状态根。
 */
export function prepareChannelWorkspaceRun(options: ChannelProjectionOptions): WorkspaceRunDir {
  const projection = normalizeProjectionOptions(options);
  const channelRoot = channelProjectionRoot(projection);
  const runDir = join(
    channelRoot,
    'runs',
    projection.agentId,
    projection.taskId,
    String(projection.taskAttempt),
    projection.workspaceRunId,
  );
  const inputDir = join(runDir, 'inputs');
  const outputDir = join(runDir, 'outputs');
  const logsDir = join(runDir, 'logs');
  ensureDirectoryNoSymlink(runDir, projection.agentBeanHome);
  for (const dir of [inputDir, outputDir, logsDir, join(runDir, 'intermediates'), join(channelRoot, 'outputs'), join(channelRoot, 'cache', 'blobs')]) {
    ensureDirectoryNoSymlink(dir, projection.agentBeanHome);
  }
  if (projection.workspaceRevisionId) {
    const snapshotDir = join(channelRoot, 'snapshots', projection.workspaceRevisionId);
    ensureDirectoryNoSymlink(snapshotDir, projection.agentBeanHome);
    const snapshotManifest = join(snapshotDir, 'manifest.json');
    if (!existsSync(snapshotManifest)) {
      writeFileSync(snapshotManifest, `${JSON.stringify({
        schemaVersion: 1,
        deviceId: projection.deviceId,
        teamId: projection.teamId,
        channelId: projection.channelId,
        workspaceRevisionId: projection.workspaceRevisionId,
      }, null, 2)}\n`, { flag: 'wx' });
    }
  }
  return {
    cwd: runDir,
    runId: projection.workspaceRunId,
    runDir,
    inputDir,
    outputDir,
    logsDir,
    manifestPath: join(runDir, 'manifest.json'),
    responsePath: join(runDir, 'response.md'),
    projection,
  };
}

export function prepareChannelWorkspaceOutput(options: ChannelWorkspaceOutputOptions): string {
  const root = channelProjectionRoot(options);
  assertSafeSegment(options.deviceId, 'deviceId');
  assertSafeSegment(options.publishIdentity, 'publishIdentity');
  const outputDir = join(root, 'outputs', options.publishIdentity);
  ensureDirectoryNoSymlink(outputDir, resolve(options.agentBeanHome));
  return outputDir;
}

export function channelProjectionRoot(options: Pick<ChannelProjectionOptions, 'agentBeanHome' | 'teamId' | 'channelId'>): string {
  const home = resolve(options.agentBeanHome);
  assertSafeSegment(options.teamId, 'teamId');
  assertSafeSegment(options.channelId, 'channelId');
  return join(home, 'workspaces', options.teamId, 'channels', options.channelId);
}

/**
 * #1084 计算某 channel revision 的 materialize 目标目录：channelProjectionRoot/snapshots/<revisionId>/。
 * 注意：绝不复用 outputs/<publishId>/——那是 outgoing publish 待发布批次扫描根
 * （resumePendingWorkspacePublishes 会扫到，复用会污染/回环）。snapshots 是只读镜像侧。
 */
export function prepareChannelWorkspaceRevisionSnapshot(options: {
  agentBeanHome: string;
  teamId: string;
  channelId: string;
  revisionId: string;
}): string {
  const root = channelProjectionRoot(options);
  assertSafeSegment(options.revisionId, 'revisionId');
  const snapshotDir = join(root, 'snapshots', options.revisionId);
  ensureDirectoryNoSymlink(snapshotDir, resolve(options.agentBeanHome));
  return snapshotDir;
}

export function persistDeviceProjectionManifest(
  agentBeanHome: string,
  manifest: DeviceProjectionManifest,
): string {
  ensureDirectoryNoSymlink(agentBeanHome, resolve(agentBeanHome));
  const path = join(resolve(agentBeanHome), 'device.json');
  const existing = readDeviceProjectionManifest(path);
  if (existing && existing.deviceId !== manifest.deviceId) {
    // 设备身份切换不能把旧设备目录当作当前投影；旧 runs 仍保留供显式迁移处理。
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (!existing) {
    try {
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      // 两个 daemon client 并发启动时都可能在 read→create 窗口观察到文件不存在。
      // EEXIST 表示另一方已创建；按既有 identity 切换语义收敛为当前 manifest。
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  } else {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return path;
}

export function readDeviceProjectionManifest(path: string): DeviceProjectionManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeviceProjectionManifest>;
    if (parsed.schemaVersion !== 1 || typeof parsed.deviceId !== 'string' || typeof parsed.teamId !== 'string') return undefined;
    return parsed as DeviceProjectionManifest;
  } catch {
    return undefined;
  }
}

export function workspaceRunEnv(ws: WorkspaceRunDir): Record<string, string> {
  return {
    AGENTBEAN_RUN_ID: ws.runId,
    AGENTBEAN_WORKSPACE: ws.runDir,
    AGENTBEAN_INPUT_DIR: ws.inputDir,
    AGENTBEAN_OUTPUT_DIR: ws.outputDir,
  };
}

export function persistWorkspaceRunManifest(ws: WorkspaceRunDir, manifest: WorkspaceRunManifest): void {
  writeFileSync(ws.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function persistWorkspaceRunResponse(ws: WorkspaceRunDir, body: string): void {
  writeFileSync(ws.responsePath, body);
}

export function relativeWorkspacePath(ws: WorkspaceRunDir, path: string): string {
  const value = relative(ws.runDir, path);
  return value && !value.startsWith('..') ? value : '.';
}

export function discoverRecoverableWorkspaceRuns(cwds: string[]): RecoverableWorkspaceRun[] {
  const runs: RecoverableWorkspaceRun[] = [];
  const seenCwds = new Set(cwds.filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0));
  for (const cwd of seenCwds) {
    const runsRoot = join(cwd, '.agentbean', 'runs');
    let entries;
    try {
      entries = readdirSync(runsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const runDir = join(runsRoot, entry.name);
      const manifestPath = join(runDir, 'manifest.json');
      const responsePath = join(runDir, 'response.md');
      const manifest = readWorkspaceRunManifest(manifestPath);
      const status = normalizeRecoverableStatus(manifest?.status);
      if (!manifest || !status || manifest.reportedAt !== undefined || manifest.unreportableAt !== undefined) {
        continue;
      }
      if (typeof manifest.agentId !== 'string' || typeof manifest.channelId !== 'string') {
        continue;
      }
      if (!existsSync(responsePath)) {
        continue;
      }
      const body = readTextFile(responsePath);
      if (body === undefined) {
        continue;
      }
      const artifactIds = Array.isArray(manifest.artifactIds)
        ? manifest.artifactIds.filter((id): id is string => typeof id === 'string')
        : [];
      const artifacts = Array.isArray(manifest.artifacts)
        ? manifest.artifacts.filter(isWorkspaceRunManifestArtifact)
        : [];
      const collaborationProposals = Array.isArray(manifest.collaborationProposals)
        ? manifest.collaborationProposals.flatMap((proposal) => {
            try {
              return [parseAgentCollaborationProposalV1(proposal)];
            } catch {
              return [];
            }
          })
        : [];
      const projectDocumentInputSetResult = parseProjectDocumentInputSetResultProposal(
        manifest.projectDocumentInputSetResult,
      );
      runs.push({
        runId: manifest.runId || entry.name,
        ...(typeof manifest.dispatchId === 'string' ? { dispatchId: manifest.dispatchId } : {}),
        agentId: manifest.agentId,
        channelId: manifest.channelId,
        body,
        manifestPath,
        manifest,
        workspaceRun: {
          status,
          cwd: manifest.cwd ?? cwd,
          ...(manifest.command ? { command: manifest.command } : {}),
          ...(manifest.logExcerpt ? { logExcerpt: manifest.logExcerpt } : {}),
          ...(typeof manifest.exitCode === 'number' ? { exitCode: manifest.exitCode } : {}),
          ...(typeof manifest.startedAt === 'number' ? { startedAt: manifest.startedAt } : {}),
          ...(typeof manifest.completedAt === 'number' ? { completedAt: manifest.completedAt } : {}),
          ...(typeof manifest.publishId === 'string' ? { publishId: manifest.publishId } : {}),
        },
        ...(artifactIds.length > 0 ? { artifactIds } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(collaborationProposals.length > 0 ? { collaborationProposals } : {}),
        ...(projectDocumentInputSetResult ? { projectDocumentInputSetResult } : {}),
      });
    }
  }
  return runs;
}

export function discoverRecoverableChannelWorkspaceRuns(options: {
  agentBeanHome: string;
  deviceId: string;
}): RecoverableWorkspaceRun[] {
  const home = resolve(options.agentBeanHome);
  const device = readDeviceProjectionManifest(join(home, 'device.json'));
  if (!device || device.deviceId !== options.deviceId) return [];
  const runs: RecoverableWorkspaceRun[] = [];
  const workspacesRoot = join(home, 'workspaces');
  for (const teamEntry of safeDirectoryEntries(workspacesRoot)) {
    if (!teamEntry.isDirectory() || !isSafeSegment(teamEntry.name)) continue;
    const channelsRoot = join(workspacesRoot, teamEntry.name, 'channels');
    for (const channelEntry of safeDirectoryEntries(channelsRoot)) {
      if (!channelEntry.isDirectory() || !isSafeSegment(channelEntry.name)) continue;
      const runsRoot = join(channelsRoot, channelEntry.name, 'runs');
      walkChannelRuns(runsRoot, options.deviceId, teamEntry.name, channelEntry.name, runs);
    }
  }
  return runs;
}

export function markWorkspaceRunReported(run: RecoverableWorkspaceRun, reportedAt: number): void {
  markWorkspaceRunManifestReported(run.manifestPath, reportedAt);
}

export function markWorkspaceRunManifestReported(manifestPath: string, reportedAt: number): void {
  const manifest = readWorkspaceRunManifest(manifestPath);
  if (!manifest) {
    return;
  }
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, reportedAt }, null, 2)}\n`);
}

/**
 * #1053：恢复回报被 Server 终态拒绝（无法确认 dispatch 身份）时写 fail-closed
 * 标记。manifest 全部数据保留供诊断（unreportableReason + 路径即诊断状态），
 * discovery 跳过它，不再每轮重启/重连无限重试一个注定失败的回报。
 */
export function markWorkspaceRunUnreportable(run: RecoverableWorkspaceRun, reason: string, at: number): void {
  const manifest = readWorkspaceRunManifest(run.manifestPath);
  if (!manifest || manifest.reportedAt !== undefined) {
    return;
  }
  writeFileSync(run.manifestPath, `${JSON.stringify({ ...manifest, unreportableAt: at, unreportableReason: reason }, null, 2)}\n`);
}

function readWorkspaceRunManifest(path: string): WorkspaceRunManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    const manifest = parsed as Partial<WorkspaceRunManifest>;
    if (typeof manifest.runId !== 'string') {
      return undefined;
    }
    return { ...manifest, files: Array.isArray(manifest.files) ? manifest.files : [] } as WorkspaceRunManifest;
  } catch {
    return undefined;
  }
}

function normalizeProjectionOptions(options: ChannelProjectionOptions): ChannelProjectionOptions {
  const taskAttempt = Number.isInteger(options.taskAttempt) && options.taskAttempt > 0
    ? options.taskAttempt
    : (() => { throw new Error('WORKSPACE_PROJECTION_INVALID_TASK_ATTEMPT'); })();
  for (const [name, value] of Object.entries({
    deviceId: options.deviceId,
    teamId: options.teamId,
    channelId: options.channelId,
    agentId: options.agentId,
    taskId: options.taskId,
    workspaceRunId: options.workspaceRunId,
    workspaceRevisionId: options.workspaceRevisionId,
  })) {
    if (value !== undefined) assertSafeSegment(value, name);
  }
  const agentBeanHome = resolve(options.agentBeanHome);
  ensureDirectoryNoSymlink(agentBeanHome, agentBeanHome);
  return { ...options, agentBeanHome, taskAttempt };
}

function assertSafeSegment(value: string, label: string): void {
  if (!isSafeSegment(value)) throw new Error(`WORKSPACE_PROJECTION_INVALID_${label.toUpperCase()}`);
}

function isSafeSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

function ensureDirectoryNoSymlink(target: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || rel === resolvedRoot || rel.includes('\0')) {
    if (resolvedTarget !== resolvedRoot) throw new Error('WORKSPACE_PROJECTION_PATH_ESCAPE');
  }
  mkdirSync(resolvedRoot, { recursive: true });
  try {
    const rootStat = lstatSync(resolvedRoot);
    if (rootStat.isSymbolicLink()) throw new Error('WORKSPACE_PROJECTION_SYMLINK_ESCAPE');
    if (!rootStat.isDirectory()) throw new Error('WORKSPACE_PROJECTION_NOT_DIRECTORY');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    mkdirSync(resolvedRoot, { recursive: true });
  }
  const parts = resolvedTarget === resolvedRoot ? [] : relative(resolvedRoot, resolvedTarget).split('/');
  let current = resolvedRoot;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('WORKSPACE_PROJECTION_SYMLINK_ESCAPE');
      if (!stat.isDirectory()) throw new Error('WORKSPACE_PROJECTION_NOT_DIRECTORY');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      mkdirSync(current);
    }
  }
}

function safeDirectoryEntries(path: string): Dirent<string>[] {
  try {
    return readdirSync(path, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }
}

function walkChannelRuns(
  runsRoot: string,
  deviceId: string,
  teamId: string,
  channelId: string,
  output: RecoverableWorkspaceRun[],
): void {
  const entries = safeDirectoryEntries(runsRoot);
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
    const child = join(runsRoot, entry.name);
    let stat;
    try { stat = lstatSync(child); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    const manifestPath = join(child, 'manifest.json');
    const responsePath = join(child, 'response.md');
    const manifest = readWorkspaceRunManifest(manifestPath);
    if (manifest?.deviceId !== deviceId || !manifest || manifest.reportedAt !== undefined
      || manifest.unreportableAt !== undefined) {
      const nested = safeDirectoryEntries(child);
      if (nested.some((item) => item.isDirectory())) walkChannelRuns(child, deviceId, teamId, channelId, output);
      continue;
    }
    const status = normalizeRecoverableStatus(manifest.status);
    if (!status || manifest.teamId !== teamId || manifest.channelId !== channelId || typeof manifest.agentId !== 'string') continue;
    if (!existsSync(responsePath)) continue;
    const body = readTextFile(responsePath);
    if (body === undefined) continue;
    // #1053：Channel run 恢复同样还原协作结果（对齐 legacy 路径），重启后
    // collaboration proposal 与 InputSet result 不丢。
    const collaborationProposals = Array.isArray(manifest.collaborationProposals)
      ? manifest.collaborationProposals.flatMap((proposal) => {
          try {
            return [parseAgentCollaborationProposalV1(proposal)];
          } catch {
            return [];
          }
        })
      : [];
    const projectDocumentInputSetResult = parseProjectDocumentInputSetResultProposal(
      manifest.projectDocumentInputSetResult,
    );
    output.push({
      runId: manifest.runId || basename(child),
      ...(typeof manifest.dispatchId === 'string' ? { dispatchId: manifest.dispatchId } : {}),
      agentId: manifest.agentId,
      channelId: manifest.channelId,
      body,
      manifestPath,
      manifest,
      workspaceRun: {
        status,
        cwd: manifest.cwd ?? '.',
        ...(manifest.command ? { command: manifest.command } : {}),
        ...(manifest.logExcerpt ? { logExcerpt: manifest.logExcerpt } : {}),
        ...(typeof manifest.exitCode === 'number' ? { exitCode: manifest.exitCode } : {}),
        ...(typeof manifest.startedAt === 'number' ? { startedAt: manifest.startedAt } : {}),
        ...(typeof manifest.completedAt === 'number' ? { completedAt: manifest.completedAt } : {}),
        ...(typeof manifest.publishId === 'string' ? { publishId: manifest.publishId } : {}),
      },
      ...(Array.isArray(manifest.artifactIds) && manifest.artifactIds.length > 0 ? { artifactIds: manifest.artifactIds } : {}),
      ...(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0 ? { artifacts: manifest.artifacts.filter(isWorkspaceRunManifestArtifact) } : {}),
      ...(collaborationProposals.length > 0 ? { collaborationProposals } : {}),
      ...(projectDocumentInputSetResult ? { projectDocumentInputSetResult } : {}),
    });
  }
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function normalizeRecoverableStatus(status: unknown): 'succeeded' | 'failed' | 'cancelled' | undefined {
  if (status === undefined) {
    return 'succeeded';
  }
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  return undefined;
}

function isWorkspaceRunManifestArtifact(artifact: unknown): artifact is WorkspaceRunManifestArtifact {
  if (!artifact || typeof artifact !== 'object') {
    return false;
  }
  const candidate = artifact as { id?: unknown; filename?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.filename === 'string';
}

function parseProjectDocumentInputSetResultProposal(
  value: unknown,
): ProjectDocumentInputSetResultProposalV1 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ProjectDocumentInputSetResultProposalV1>;
  if (candidate.contractVersion !== 1
    || typeof candidate.inputSetId !== 'string'
    || typeof candidate.invocationId !== 'string'
    || !Array.isArray(candidate.items)
    || candidate.items.length === 0) {
    return undefined;
  }
  for (const item of candidate.items) {
    if (!item || typeof item !== 'object'
      || typeof item.documentId !== 'string'
      || typeof item.baseRevisionId !== 'string') {
      return undefined;
    }
    if (item.status === 'unchanged') {
      if (typeof item.sha256 !== 'string') return undefined;
      continue;
    }
    if (item.status === 'changed') {
      if (typeof item.sha256 !== 'string' || typeof item.artifactId !== 'string') return undefined;
      continue;
    }
    if (item.status === 'failed') {
      if (typeof item.error !== 'string') return undefined;
      continue;
    }
    return undefined;
  }
  return candidate as ProjectDocumentInputSetResultProposalV1;
}
