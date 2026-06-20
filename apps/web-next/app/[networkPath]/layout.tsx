'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { agentEvents, channelEvents, deviceEvents, getWebSocket, teamEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export default function NetworkLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const networkPath = params.networkPath as string;

  const conn = useAgentBeanStore((s) => s.conn);
  const teams = useAgentBeanStore((s) => s.teams);
  const setCurrentTeamId = useAgentBeanStore((s) => s.setCurrentTeamId);

  const resolved = teams.find((n) => n.path === networkPath);
  const unresolvedNetworkPath = teams.length > 0 && !resolved;
  const fallbackNetworkPath = teams[0]?.path ?? 'default';

  useEffect(() => {
    if (conn !== 'open' || !resolved) return;

    setCurrentTeamId(resolved.id);
    teamEvents().switch(resolved.id).then(() => {
      const socket = getWebSocket();
      agentEvents(socket).subscribe(resolved.id);
      channelEvents(socket).subscribe(resolved.id);
      deviceEvents(socket).subscribe(resolved.id);
    });
  }, [resolved?.id, conn]);

  useEffect(() => {
    if (!unresolvedNetworkPath) return;
    router.replace(`/${fallbackNetworkPath}/chat`);
  }, [fallbackNetworkPath, router, unresolvedNetworkPath]);

  if (teams.length === 0 && conn === 'connecting') {
    return <div className="flex h-[calc(100vh-40px)] items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" /></div>;
  }

  if (unresolvedNetworkPath) {
    return null;
  }

  return <>{children}</>;
}
