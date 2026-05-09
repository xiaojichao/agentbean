'use client';

import { useEffect } from 'react';
import { getWebSocket, agentEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export function SocketProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const socket = getWebSocket();
    const ev = agentEvents(socket);
    const setConn = useAgentBeanStore.getState().setConn;

    const onConnect = () => setConn('open');
    const onDisconnect = () => setConn('lost');
    const onConnectError = () => setConn('lost');

    const unsubSnapshot = ev.onSnapshot((list) => {
      useAgentBeanStore.getState().applyAgentsSnapshot(list);
    });
    const unsubStatus = ev.onStatus((snap) => {
      useAgentBeanStore.getState().applyAgentStatus(snap);
    });
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    setConn(socket.connected ? 'open' : 'connecting');
    ev.subscribe();

    return () => {
      unsubSnapshot();
      unsubStatus();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
    };
  }, []);

  return <>{children}</>;
}
