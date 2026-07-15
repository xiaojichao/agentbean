import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { LocalMemoryStore } from './local-memory-store.js';
import { containsSensitiveMemoryText } from './sensitive-memory.js';
import type { AutoAccumulatedMemorySummary, LocalMemoryItem, LocalMemoryUpsertInput } from './types.js';
import { workspaceCwdHash } from './workspace-identity.js';

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
  const packageJson = readPackageJson(join(cwd, 'package.json'));
  const techStack = detectTechStack(cwd, packageJson);
  const scripts = safePackageScripts(packageJson);
  const layout = topLevelLayout(cwd);
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

function readPackageJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function detectTechStack(cwd: string, packageJson: Record<string, unknown> | undefined): string[] {
  const values = new Set<string>();
  if (packageJson) {
    values.add('Node.js');
    const dependencies = {
      ...asRecord(packageJson.dependencies),
      ...asRecord(packageJson.devDependencies),
    };
    if ('typescript' in dependencies || existsSync(join(cwd, 'tsconfig.json'))) values.add('TypeScript');
    if ('react' in dependencies) values.add('React');
    if ('next' in dependencies) values.add('Next.js');
    if ('vitest' in dependencies) values.add('Vitest');
  }
  if (existsSync(join(cwd, 'package-lock.json'))) values.add('npm');
  else if (existsSync(join(cwd, 'pnpm-lock.yaml'))) values.add('pnpm');
  else if (existsSync(join(cwd, 'yarn.lock'))) values.add('Yarn');
  else if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) values.add('Bun');
  if (existsSync(join(cwd, 'Cargo.toml'))) values.add('Rust');
  if (existsSync(join(cwd, 'go.mod'))) values.add('Go');
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'requirements.txt'))) values.add('Python');
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

function topLevelLayout(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && !entry.name.startsWith('.')
        && entry.name !== 'node_modules')
      .map((entry) => basename(entry.name))
      .sort()
      .slice(0, 30);
  } catch {
    return [];
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
