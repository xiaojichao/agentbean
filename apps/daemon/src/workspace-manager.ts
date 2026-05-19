import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface AgentWorkspaceRun {
  teamId: string;
  agentId: string;
  runId: string;
  agentDir: string;
  runDir: string;
  outputDir: string;
  intermediateDir: string;
  logDir: string;
}

export interface ArchivedWorkspaceFile {
  originalPath: string;
  archivedPath: string;
  relativePath: string;
  pathKind: 'output';
  sha256: string;
  sizeBytes: number;
}

function rootDir(): string {
  return resolve(process.env.AGENTBEAN_HOME ?? join(homedir(), '.agentbean'));
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAgentWorkspaceDir(teamId: string, agentId: string): string {
  return ensureDir(join(rootDir(), 'teams', safeSegment(teamId), 'agents', safeSegment(agentId)));
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function uniqueDestination(dir: string, filename: string): string {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = join(dir, filename);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

export function beginAgentWorkspaceRun(input: {
  teamId: string;
  teamName?: string | null;
  agentId: string;
  agentName?: string | null;
  runId: string;
  prompt: string;
  projectDir?: string | null;
}): AgentWorkspaceRun {
  const teamId = safeSegment(input.teamId);
  const agentId = safeSegment(input.agentId);
  const runId = safeSegment(input.runId);
  const teamDir = ensureDir(join(rootDir(), 'teams', teamId));
  const agentDir = ensureDir(join(teamDir, 'agents', agentId));
  const runDir = ensureDir(join(agentDir, 'runs', runId));
  const outputDir = ensureDir(join(runDir, 'outputs'));
  const intermediateDir = ensureDir(join(runDir, 'intermediates'));
  const logDir = ensureDir(join(runDir, 'logs'));

  writeJson(join(teamDir, 'team.json'), {
    id: input.teamId,
    name: input.teamName ?? input.teamId,
    updatedAt: new Date().toISOString(),
  });
  writeJson(join(agentDir, 'agent.json'), {
    id: input.agentId,
    name: input.agentName ?? input.agentId,
    projectDir: input.projectDir ?? null,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(join(runDir, 'prompt.md'), input.prompt);
  writeJson(join(runDir, 'manifest.json'), {
    teamId: input.teamId,
    agentId: input.agentId,
    runId: input.runId,
    status: 'running',
    createdAt: new Date().toISOString(),
    files: [],
  });

  return { teamId: input.teamId, agentId: input.agentId, runId: input.runId, agentDir, runDir, outputDir, intermediateDir, logDir };
}

export function workspaceEnv(run: AgentWorkspaceRun): Record<string, string> {
  return {
    AGENTBEAN_TEAM_ID: run.teamId,
    AGENTBEAN_AGENT_ID: run.agentId,
    AGENTBEAN_RUN_ID: run.runId,
    AGENTBEAN_WORKSPACE: run.agentDir,
    AGENTBEAN_OUTPUT_DIR: run.outputDir,
    AGENTBEAN_INTERMEDIATE_DIR: run.intermediateDir,
    AGENT_BEAN_OUTPUT_DIRS: [run.outputDir, run.intermediateDir].join(','),
  };
}

export function archiveOutputFiles(run: AgentWorkspaceRun, files: string[]): ArchivedWorkspaceFile[] {
  const archived: ArchivedWorkspaceFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const abs = isAbsolute(file) ? file : resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let st;
    try {
      st = statSync(abs);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }

    const alreadyInRun = relative(run.runDir, abs);
    const archivedPath = alreadyInRun && !alreadyInRun.startsWith('..') && !isAbsolute(alreadyInRun)
      ? abs
      : uniqueDestination(run.outputDir, basename(abs));
    if (archivedPath !== abs) copyFileSync(abs, archivedPath);
    const sizeBytes = statSync(archivedPath).size;
    archived.push({
      originalPath: abs,
      archivedPath,
      relativePath: relative(run.agentDir, archivedPath),
      pathKind: 'output',
      sha256: fileHash(archivedPath),
      sizeBytes,
    });
  }
  return archived;
}

export function finishAgentWorkspaceRun(run: AgentWorkspaceRun, input: {
  replyText?: string;
  files: ArchivedWorkspaceFile[];
  status: 'completed' | 'failed';
  error?: string;
}): void {
  if (input.replyText !== undefined) {
    writeFileSync(join(run.runDir, 'response.md'), input.replyText);
  }
  writeJson(join(run.runDir, 'manifest.json'), {
    teamId: run.teamId,
    agentId: run.agentId,
    runId: run.runId,
    status: input.status,
    updatedAt: new Date().toISOString(),
    error: input.error,
    files: input.files.map((file) => ({
      path: file.relativePath,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      kind: file.pathKind,
      originalPath: file.originalPath,
    })),
  });
}
