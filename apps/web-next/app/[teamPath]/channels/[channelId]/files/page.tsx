'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAgentBeanStore } from '@/lib/store';
import { projectEvents } from '@/lib/socket';
import { WorkspaceRevisionPanel } from '@/components/WorkspaceRevisionPanel';
import type { ProjectChannelWorkspaceDto } from '@agentbean/contracts';

export default function ChannelWorkspaceFilesPage() {
  const params = useParams();
  const channelId = params.channelId as string;
  const teamPath = params.teamPath as string;

  const teams = useAgentBeanStore((s) => s.teams);
  const resolvedTeamId = useMemo(
    () => teams.find((team) => team.path === teamPath)?.id,
    [teamPath, teams],
  );

  const [workspace, setWorkspace] = useState<ProjectChannelWorkspaceDto | null | undefined>(undefined);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!resolvedTeamId) return;
    let cancelled = false;
    (async () => {
      setWorkspace(undefined);
      setError(undefined);
      const result = await projectEvents().workspace(channelId);
      if (cancelled) return;
      if (result.ok) {
        setWorkspace(result.workspace ?? null);
      } else {
        setWorkspace(null);
        setError(result.error);
      }
    })();
    return () => { cancelled = true; };
  }, [channelId, resolvedTeamId]);

  return <WorkspaceRevisionPanel workspace={workspace} error={error} />;
}
