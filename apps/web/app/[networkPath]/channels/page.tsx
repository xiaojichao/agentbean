'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { agentEvents, channelEvents, getWebSocket } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { NewChannelDialog } from '@/components/new-channel-dialog';

export default function ChannelsPage() {
  const channels = useAgentBeanStore((s) => s.channels);
  const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const setConn = useAgentBeanStore((s) => s.setConn);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const np = useCurrentNetworkPath();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const socket = getWebSocket();
    setConn(socket.connected ? 'open' : 'connecting');
    const onConnect = () => setConn('open');
    const onDisconnect = () => setConn('lost');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    if (!currentTeamId) {
      return () => {
        socket.off('connect', onConnect);
        socket.off('disconnect', onDisconnect);
      };
    }

    const ag = agentEvents(socket);
    const offSnap = ag.onSnapshot(applyAgentsSnapshot);
    const offStatus = ag.onStatus(applyAgentStatus);
    ag.subscribe(currentTeamId);

    socket.on('channels:snapshot', applyChannelsSnapshot);
    channelEvents(socket).subscribe(currentTeamId);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      offSnap(); offStatus();
      socket.off('channels:snapshot', applyChannelsSnapshot);
    };
  }, [setConn, currentTeamId, applyAgentsSnapshot, applyAgentStatus, applyChannelsSnapshot]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
        <span className="text-sm font-semibold">频道</span>
        <button
          onClick={() => setOpen(true)}
          className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5"
        >新建频道</button>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
      {channels.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-neutral-500">
          还没有频道。点击「新建频道」开始。
        </div>
      ) : (
        <ul className="space-y-1">
          {channels.map((c) => (
            <li key={c.id}>
              <Link
                href={`/${np}/channel/${c.id}`}
                className="block px-3 py-2 rounded border border-neutral-200 hover:bg-neutral-50"
              >{c.name}</Link>
            </li>
          ))}
        </ul>
      )}
      </div>
      {open && <NewChannelDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
