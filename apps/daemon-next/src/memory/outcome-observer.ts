import type { LocalMemoryStore } from './local-memory-store.js';
import { recordWorkspaceRunLearning } from './local-learning-rules.js';
import type { AutoAccumulatedMemorySummary } from './types.js';

export interface ObserveDispatchOutcomeInput {
  readonly store: LocalMemoryStore;
  readonly request: {
    readonly id: string;
    readonly agentId: string;
    readonly customAgent?: {
      readonly cwd?: string;
      readonly adapterKind?: string;
    };
  };
  readonly result: {
    readonly workspaceRun?: {
      readonly status?: string;
      readonly cwd?: string;
      readonly command?: string;
      readonly logExcerpt?: string;
      readonly exitCode?: number;
    };
  };
}

/** Dispatch completion entrypoint. Runtime wiring is deliberately owned by Task 10. */
export async function observeDispatchOutcome(
  input: ObserveDispatchOutcomeInput,
): Promise<AutoAccumulatedMemorySummary[]> {
  const workspaceRun = input.result.workspaceRun;
  const cwd = workspaceRun?.cwd ?? input.request.customAgent?.cwd;
  if (!workspaceRun || !cwd) return [];
  return recordWorkspaceRunLearning({
    store: input.store,
    cwd,
    agentId: input.request.agentId,
    runId: input.request.id,
    adapterKind: input.request.customAgent?.adapterKind,
    workspaceRun,
  });
}
