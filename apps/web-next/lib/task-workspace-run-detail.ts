import type { WorkspaceArtifact, WorkspaceRunDetail } from './schema';

export interface WorkspaceRunDetailBundle {
  workspaceRun: WorkspaceRunDetail;
  artifacts: WorkspaceArtifact[];
}

export interface WorkspaceRunHistoryItem {
  workspaceRun: WorkspaceRunDetail;
  isLatest: boolean;
}

export function matchingWorkspaceRunDetail(
  detail: WorkspaceRunDetailBundle | null,
  expectedTeamId: string | null | undefined,
  expectedRunId: string | null | undefined,
): WorkspaceRunDetailBundle | null {
  if (!detail || !expectedTeamId || !expectedRunId) return null;
  if (detail.workspaceRun.teamId !== expectedTeamId) return null;
  if (detail.workspaceRun.id !== expectedRunId) return null;
  return detail;
}

export function workspaceRunHistoryItems(
  runs: WorkspaceRunDetail[],
  latestRunId: string | null | undefined,
): WorkspaceRunHistoryItem[] {
  return runs.map((workspaceRun) => ({
    workspaceRun,
    isLatest: Boolean(latestRunId && workspaceRun.id === latestRunId),
  }));
}
