import { mkdirSync, writeFileSync } from 'node:fs';
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
  status?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  files: WorkspaceRunManifestFile[];
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
