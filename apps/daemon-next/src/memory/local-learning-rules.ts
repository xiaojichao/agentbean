import type { LocalMemoryStore } from './local-memory-store.js';
import { containsSensitiveMemoryText } from './sensitive-memory.js';
import type { AutoAccumulatedMemorySummary, LocalMemoryItem } from './types.js';
import { localMemoryDedupeHash, workspaceCwdHash } from './workspace-identity.js';

export type WorkspaceRunFailureCategory =
  | 'missing-file'
  | 'permission-denied'
  | 'missing-module'
  | 'type-error'
  | 'npm-error'
  | 'typescript-build'
  | 'test-failure';

export interface WorkspaceRunLearningInput {
  readonly store: LocalMemoryStore;
  readonly cwd: string;
  readonly agentId?: string;
  readonly runId: string;
  readonly adapterKind?: string;
  readonly workspaceRun: {
    readonly status?: string;
    readonly command?: string;
    readonly logExcerpt?: string;
    readonly exitCode?: number;
  };
}

export function classifyWorkspaceRunFailure(logExcerpt: string | undefined): WorkspaceRunFailureCategory | null {
  if (!logExcerpt) return null;
  if (/\bENOENT\b/i.test(logExcerpt)) return 'missing-file';
  if (/\bEACCES\b|permission denied/i.test(logExcerpt)) return 'permission-denied';
  if (/\bMODULE_NOT_FOUND\b|cannot find module/i.test(logExcerpt)) return 'missing-module';
  if (/\bTypeError\b/.test(logExcerpt)) return 'type-error';
  if (/\bnpm ERR!/i.test(logExcerpt)) return 'npm-error';
  if (/\btsc\b.*(?:error|failed)|TS\d{4}:/i.test(logExcerpt)) return 'typescript-build';
  if (/(?:test|tests|vitest|jest).*(?:failed|failure)|\bFAIL\b.*(?:test|spec)/i.test(logExcerpt)) return 'test-failure';
  return null;
}

export async function recordWorkspaceRunLearning(
  input: WorkspaceRunLearningInput,
): Promise<AutoAccumulatedMemorySummary[]> {
  const command = input.workspaceRun.command?.trim();
  if (!command || command.length > 4_096 || containsSensitiveMemoryText(command)) return [];
  const cwdHash = workspaceCwdHash(input.cwd);
  const succeeded = input.workspaceRun.status === 'succeeded'
    || (input.workspaceRun.status === undefined && input.workspaceRun.exitCode === 0);
  const failed = input.workspaceRun.status === 'failed'
    || (input.workspaceRun.exitCode !== undefined && input.workspaceRun.exitCode !== 0);
  if (!succeeded && !failed) return [];

  const category = failed ? classifyWorkspaceRunFailure(input.workspaceRun.logExcerpt) : null;
  if (failed && !category) return [];
  const dedupeKey = succeeded
    ? `run-ok:${localMemoryDedupeHash(`${command}\n${cwdHash}`)}`
    : `run-fail:${localMemoryDedupeHash(`${category}\n${command}`)}`;
  const safeCommand = command.slice(0, 1_000);
  const summary = succeeded
    ? `已验证成功：${safeCommand.slice(0, 140)}`
    : `已确认失败（${failureLabel(category!)}）：${safeCommand.slice(0, 100)}`;
  const content = succeeded
    ? `命令已在当前 Workspace 成功执行：${safeCommand}`
    : `命令在当前 Workspace 失败；确定性类别为 ${failureLabel(category!)}。下次先检查对应前置条件：${safeCommand}`;
  const mutation = await input.store.upsert({
    agentId: input.agentId,
    cwd: input.cwd,
    cwdHash,
    dedupeKey,
    kind: 'procedural',
    scopeType: 'local-workspace',
    content,
    summary,
    structured: {
      commands: [safeCommand],
      tags: ['workspace-run', succeeded ? 'verified-success' : category!],
      sourceRunIds: [input.runId],
    },
    sourceKind: 'workspace_run',
  });
  return [toSummary(mutation.item, mutation.action),
    ...mutation.expired.map((item) => toSummary(item, 'expired'))];
}

function failureLabel(category: WorkspaceRunFailureCategory): string {
  const labels: Record<WorkspaceRunFailureCategory, string> = {
    'missing-file': '文件不存在',
    'permission-denied': '权限不足',
    'missing-module': '模块缺失',
    'type-error': '运行时类型错误',
    'npm-error': 'npm 失败',
    'typescript-build': 'TypeScript 构建失败',
    'test-failure': '测试失败',
  };
  return labels[category];
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
