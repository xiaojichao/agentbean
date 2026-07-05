import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspaceRunDir {
  cwd: string;
  runId: string;
  runDir: string;
  inputDir: string;
  outputDir: string;
  logsDir: string;
  manifestPath: string;
  responsePath: string;
}

export interface WorkspaceRunManifestFile {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
}

export interface WorkspaceRunManifest {
  runId: string;
  agentId?: string;
  channelId?: string;
  status?: string;
  cwd?: string;
  command?: string;
  logExcerpt?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  artifactIds?: string[];
  reportedAt?: number;
  files: WorkspaceRunManifestFile[];
}

export interface RecoverableWorkspaceRun {
  runId: string;
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
      if (!manifest || !isRecoverableStatus(manifest.status) || manifest.reportedAt !== undefined) {
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
      runs.push({
        runId: manifest.runId || entry.name,
        agentId: manifest.agentId,
        channelId: manifest.channelId,
        body,
        manifestPath,
        manifest,
        workspaceRun: {
          status: manifest.status,
          cwd: manifest.cwd ?? cwd,
          ...(manifest.command ? { command: manifest.command } : {}),
          ...(manifest.logExcerpt ? { logExcerpt: manifest.logExcerpt } : {}),
          ...(typeof manifest.exitCode === 'number' ? { exitCode: manifest.exitCode } : {}),
          ...(typeof manifest.startedAt === 'number' ? { startedAt: manifest.startedAt } : {}),
          ...(typeof manifest.completedAt === 'number' ? { completedAt: manifest.completedAt } : {}),
        },
        ...(artifactIds.length > 0 ? { artifactIds } : {}),
      });
    }
  }
  return runs;
}

export function markWorkspaceRunReported(run: RecoverableWorkspaceRun, reportedAt: number): void {
  writeFileSync(run.manifestPath, `${JSON.stringify({ ...run.manifest, reportedAt }, null, 2)}\n`);
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

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function isRecoverableStatus(status: unknown): status is string {
  return status === 'succeeded' || status === 'failed';
}
