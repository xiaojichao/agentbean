import type { WorkspaceArtifact, WorkspaceRunDetail } from './schema';

export interface WorkspaceRunDetailBundle {
  workspaceRun: WorkspaceRunDetail;
  artifacts: WorkspaceArtifact[];
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
