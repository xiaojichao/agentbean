'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getWebSocket, teamEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export default function NetworkLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const networkPath = params.networkPath as string;

  const conn = useAgentBeanStore((s) => s.conn);
  const networks = useAgentBeanStore((s) => s.networks);
  const setCurrentNetworkId = useAgentBeanStore((s) => s.setCurrentNetworkId);

  const resolved = networks.find((n) => n.path === networkPath);

  useEffect(() => {
    if (conn !== 'open' || !resolved) return;

    setCurrentNetworkId(resolved.id);
    teamEvents().switch(resolved.id).then(() => {
      getWebSocket().emit('agents:subscribe', {});
      getWebSocket().emit('channels:subscribe', {});
      getWebSocket().emit('devices:subscribe', {});
    });
  }, [resolved?.id, conn]);

  if (networks.length === 0 && conn === 'connecting') {
    return <div className="flex h-[calc(100vh-40px)] items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" /></div>;
  }

  if (networks.length > 0 && !resolved) {
    router.replace('/default/chat');
    return null;
  }

  return <>{children}</>;
}
