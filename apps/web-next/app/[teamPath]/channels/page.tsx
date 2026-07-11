'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { agentEvents, channelEvents, getWebSocket } from '@/lib/socket';
import { useAgentBeanStore, useCurrentTeamPath } from '@/lib/store';
import { NewChannelDialog } from '@/components/new-channel-dialog';

export default function ChannelsPage() {
  const params = useParams();
  const channels = useAgentBeanStore((s) => s.channels);
  const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const setConn = useAgentBeanStore((s) => s.setConn);
  const teams = useAgentBeanStore((s) => s.teams);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const fallbackTeamPath = useCurrentTeamPath();
  const routeTeamPath = typeof params.teamPath === 'string' ? params.teamPath : fallbackTeamPath;
  const routeTeam = teams.find((team) => team.path === routeTeamPath || team.id === routeTeamPath);
  const channelTeamId = routeTeam?.id ?? (routeTeamPath === 'default' ? currentTeamId : '');
  const np = routeTeamPath || fallbackTeamPath;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const socket = getWebSocket();
    setConn(socket.connected ? 'open' : 'connecting');
    const onConnect = () => setConn('open');
    const onDisconnect = () => setConn('lost');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    if (!channelTeamId) {
      return () => {
        socket.off('connect', onConnect);
        socket.off('disconnect', onDisconnect);
      };
    }

    const ag = agentEvents(socket);
    const offSnap = ag.onSnapshot(applyAgentsSnapshot);
    const offStatus = ag.onStatus(applyAgentStatus);
    ag.subscribe(channelTeamId);

    socket.on('channels:snapshot', applyChannelsSnapshot);
    channelEvents(socket).subscribe(channelTeamId);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      offSnap(); offStatus();
      socket.off('channels:snapshot', applyChannelsSnapshot);
    };
  }, [setConn, channelTeamId, applyAgentsSnapshot, applyAgentStatus, applyChannelsSnapshot]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
        <span className="text-sm font-semibold">频道</span>
        <button
          onClick={() => setOpen(true)}
          disabled={!channelTeamId}
          data-smoke="channel-create-open"
          data-team-id={channelTeamId}
          className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
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
                data-smoke="channel-list-item"
                data-channel-id={c.id}
                data-channel-name={c.name}
              >{c.name}</Link>
            </li>
          ))}
        </ul>
      )}
      </div>
      {open && channelTeamId && <NewChannelDialog onClose={() => setOpen(false)} teamId={channelTeamId} teamPath={np} />}
    </div>
  );
}
