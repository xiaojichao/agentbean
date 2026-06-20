'use client';
import { useEffect } from 'react';
import { getResolvedServerUrl, getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export function ConnectionBanner() {
  const conn = useAgentBeanStore((s) => s.conn);
  const setConn = useAgentBeanStore((s) => s.setConn);

  useEffect(() => {
    const socket = getWebSocket();
    const onConnect = () => setConn('open');
    const onDisconnect = () => setConn('lost');
    const onError = () => setConn('lost');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    if (socket.connected) setConn('open');
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
    };
  }, [setConn]);

  if (conn === 'open') return null;

  const label = conn === 'lost' ? '与服务器连接已断开,正在重连…' : '连接中…';
  const serverUrl = getResolvedServerUrl();
  const tone = conn === 'lost'
    ? 'bg-amber-50 text-amber-800 border-amber-200'
    : 'bg-sky-50 text-sky-800 border-sky-200';
  return (
    <div className={`mb-4 rounded border px-4 py-2 text-sm font-medium ${tone}`}>
      {label}
      <span className="ml-2 font-mono text-xs opacity-70">{serverUrl}</span>
    </div>
  );
}
