import { constants } from 'node:fs';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { LocalMemoryStore } from './local-memory-store.js';
import { containsSensitiveMemoryText } from './sensitive-memory.js';
import type { AutoAccumulatedMemorySummary, LocalMemoryItem, LocalMemoryUpsertInput } from './types.js';
import { workspaceCwdHash } from './workspace-identity.js';

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export interface ScanWorkspaceMemoryInput {
  readonly store: LocalMemoryStore;
  readonly cwd: string;
  readonly agentId?: string;
}

export async function scanWorkspaceMemory(
  input: ScanWorkspaceMemoryInput,
): Promise<AutoAccumulatedMemorySummary[]> {
  const cwd = resolve(input.cwd);
  const cwdHash = workspaceCwdHash(cwd);
  const packageJson = await readPackageJson(join(cwd, 'package.json'));
  const techStack = await detectTechStack(cwd, packageJson);
  const scripts = safePackageScripts(packageJson);
  const layout = await topLevelLayout(cwd);
  const candidates: LocalMemoryUpsertInput[] = [];

  if (techStack.length > 0) {
    candidates.push(workspaceInput({
      cwd, cwdHash, agentId: input.agentId, dedupeKey: 'scan:tech-stack', kind: 'semantic',
      content: `项目技术栈：${techStack.join('、')}`,
      summary: `识别到 ${techStack.join('、')}`,
      structured: { techStack, tags: ['workspace-scan', 'tech-stack'] },
    }));
  }
  if (scripts.length > 0) {
    candidates.push(workspaceInput({
      cwd, cwdHash, agentId: input.agentId, dedupeKey: 'scan:scripts', kind: 'procedural',
      content: `可用项目命令：${scripts.join('；')}`,
      summary: `识别到 ${scripts.length} 个 package script`,
      structured: { commands: scripts, tags: ['workspace-scan', 'scripts'] },
    }));
  }
  if (layout.length > 0) {
    candidates.push(workspaceInput({
      cwd, cwdHash, agentId: input.agentId, dedupeKey: 'scan:layout', kind: 'semantic',
      content: `项目顶层结构：${layout.join('、')}`,
      summary: `识别到 ${layout.length} 个顶层目录`,
      structured: { paths: layout, tags: ['workspace-scan', 'layout'] },
    }));
  }

  const summaries: AutoAccumulatedMemorySummary[] = [];
  for (const candidate of candidates) {
    const mutation = await input.store.upsert(candidate);
    summaries.push(toSummary(mutation.item, mutation.action));
    summaries.push(...mutation.expired.map((item) => toSummary(item, 'expired')));
  }
  return summaries;
}

function workspaceInput(
  input: Omit<LocalMemoryUpsertInput, 'scopeType' | 'sourceKind'>,
): LocalMemoryUpsertInput {
  return { ...input, scopeType: 'local-workspace', sourceKind: 'scan' };
}

async function readPackageJson(path: string): Promise<Record<string, unknown> | undefined> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_PACKAGE_JSON_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_PACKAGE_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (offset > MAX_PACKAGE_JSON_BYTES || finalMetadata.size > MAX_PACKAGE_JSON_BYTES) return undefined;
    const raw = buffer.subarray(0, offset).toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function detectTechStack(
  cwd: string,
  packageJson: Record<string, unknown> | undefined,
): Promise<string[]> {
  const values = new Set<string>();
  if (packageJson) {
    values.add('Node.js');
    const dependencies = {
      ...asRecord(packageJson.dependencies),
      ...asRecord(packageJson.devDependencies),
    };
    if ('typescript' in dependencies || await regularFileExists(join(cwd, 'tsconfig.json'))) values.add('TypeScript');
    if ('react' in dependencies) values.add('React');
    if ('next' in dependencies) values.add('Next.js');
    if ('vitest' in dependencies) values.add('Vitest');
  }
  if (await regularFileExists(join(cwd, 'package-lock.json'))) values.add('npm');
  else if (await regularFileExists(join(cwd, 'pnpm-lock.yaml'))) values.add('pnpm');
  else if (await regularFileExists(join(cwd, 'yarn.lock'))) values.add('Yarn');
  else if (await regularFileExists(join(cwd, 'bun.lock'))
    || await regularFileExists(join(cwd, 'bun.lockb'))) values.add('Bun');
  if (await regularFileExists(join(cwd, 'Cargo.toml'))) values.add('Rust');
  if (await regularFileExists(join(cwd, 'go.mod'))) values.add('Go');
  if (await regularFileExists(join(cwd, 'pyproject.toml'))
    || await regularFileExists(join(cwd, 'requirements.txt'))) values.add('Python');
  return [...values];
}

function safePackageScripts(packageJson: Record<string, unknown> | undefined): string[] {
  const scripts = asRecord(packageJson?.scripts);
  return Object.entries(scripts)
    .filter(([name, command]) => name.trim() && typeof command === 'string'
      && command.trim() && !containsSensitiveMemoryText(command))
    .map(([name, command]) => `npm run ${name} (${String(command).trim().slice(0, 200)})`)
    .slice(0, 20);
}

async function topLevelLayout(cwd: string): Promise<string[]> {
  try {
    const directory = await opendir(cwd);
    const entries: string[] = [];
    let visited = 0;
    for await (const entry of directory) {
      visited += 1;
      if (visited > 200) break;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        entries.push(entry.name);
      }
    }
    return entries.sort().slice(0, 30);
  } catch {
    return [];
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toSummary(
  item: LocalMemoryItem,
  action: AutoAccumulatedMemorySummary['action'],
): AutoAccumulatedMemorySummary {
  return {
    id: item.id,
    kind: item.kind,
    scopeType: item.scopeType,
    sourceKind: item.sourceKind,
    summary: item.summary ?? item.content.slice(0, 160),
    action,
  };
}
