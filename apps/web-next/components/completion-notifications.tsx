'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { completionNotificationPath, type CompletionNotificationDto } from '@agentbean/contracts';
import { notificationEvents } from '@/lib/socket';
import { BrowserPushSettings, useBrowserPush } from './browser-push-settings';

export const completionNotificationHref = completionNotificationPath;

export function CompletionNotifications({ teamId, teamPath, userId, connected, open, onToggle, onClose, piAttention }: {
  teamId: string | null;
  teamPath: string;
  userId?: string;
  connected: boolean;
  open: boolean;
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
  piAttention: boolean;
}) {
  const router = useRouter();
  const pushSettings = useBrowserPush({ userId, connected });
  const [state, setState] = useState<{ scope: string; items: CompletionNotificationDto[] }>({ scope: '', items: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<CompletionNotificationDto | null>(null);
  const scope = teamId + ':' + userId;
  const items = state.scope === scope ? state.items : [];
  const unread = items.filter((item) => item.readAt === null).length;

  useEffect(() => {
    setToast(null);
    setError('');
    if (!teamId || !userId || !connected) { setLoading(false); return; }
    let active = true;
    let running = false;
    let rerun = false;
    const startedAt = Date.now();
    const announced = new Set<string>();
    const events = notificationEvents();
    const showOnce = (item: CompletionNotificationDto) => {
      if (item.readAt !== null || item.createdAt < startedAt || announced.has(item.id)) return;
      announced.add(item.id);
      const show = () => {
        if (!active || document.visibilityState !== 'visible') return;
        const key = 'agentbean.notification-presented:' + scope + ':' + item.id;
        try {
          if (localStorage.getItem(key)) return;
          localStorage.setItem(key, String(Date.now()));
        } catch { /* Storage disabled: the in-session set still deduplicates. */ }
        setToast(item);
      };
      if (navigator.locks) void navigator.locks.request('agentbean-notification:' + item.id, show);
      else show();
    };
    const refresh = async () => {
      if (running) { rerun = true; return; }
      running = true;
      try {
        do {
          rerun = false;
          const result = await events.list({ teamId });
          if (!active) return;
          if (!result.ok || !result.items) { setError('提醒加载失败，请稍后重试'); return; }
          const nextItems = result.items.filter((item) => item.teamId === teamId && item.recipientId === userId);
          // OS notification clicks use the same read command as the sidebar.
          const location = new URL(window.location.href);
          const noticeId = location.searchParams.get('notice');
          if (location.searchParams.get('noticeTeam') === teamId && nextItems.some((item) => item.id === noticeId)) {
            const read = await events.markRead({ teamId, id: noticeId! });
            if (!active) return;
            if (read.ok) {
              const clicked = nextItems.findIndex((item) => item.id === noticeId);
              nextItems[clicked] = { ...nextItems[clicked], readAt: Date.now() };
              location.searchParams.delete('notice'); location.searchParams.delete('noticeTeam');
              window.history.replaceState(null, '', location.pathname + location.search + location.hash);
            }
          }
          setState({ scope, items: nextItems });
          setError('');
          nextItems.slice().reverse().forEach(showOnce);
        } while (rerun && active);
      } catch {
        if (active) setError('提醒加载失败，请稍后重试');
      } finally {
        running = false;
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    const unsubscribe = events.onChanged((wake) => {
      if (wake.teamId === teamId && wake.recipientId === userId) void refresh();
    });
    const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
    const changedInAnotherTab = (event: StorageEvent) => {
      if (event.key === 'agentbean.notification-read:' + scope) void refresh();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('storage', changedInAnotherTab);
    // Reconcile a lost wake without resetting read state or replaying old popups.
    const interval = window.setInterval(() => { void refresh(); }, 15_000);
    void refresh();
    return () => {
      active = false; unsubscribe(); window.clearInterval(interval);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('storage', changedInAnotherTab);
    };
  }, [teamId, userId, connected, scope]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const view = async (item: CompletionNotificationDto) => {
    if (!teamId || item.teamId !== teamId || item.recipientId !== userId) return;
    onClose(); setToast(null);
    router.push(completionNotificationHref(teamPath, item));
    try {
      const result = await notificationEvents().markRead({ teamId, id: item.id });
      if (result.ok) {
        setState((current) => current.scope === scope ? {
          ...current, items: current.items.map((row) => row.id === item.id ? { ...row, readAt: Date.now() } : row),
        } : current);
        try { localStorage.setItem('agentbean.notification-read:' + scope, String(Date.now())); } catch {}
      }
    } catch { /* Keep unread on failure; the next fetch reconciles it. */ }
  };

  return <>
    <button type="button" title="提醒" aria-label={unread ? '提醒，' + unread + '条未读' : '提醒'}
      aria-expanded={open} onClick={onToggle} data-smoke="notifications-toggle"
      className={'relative flex h-10 w-10 items-center justify-center rounded-lg border ' +
        (open ? 'border-neutral-200 bg-white text-neutral-900 shadow-sm' : 'border-transparent text-neutral-500 hover:bg-neutral-200/70')}>
      <Bell size={19} />
      {unread > 0 ? <span data-smoke="notifications-unread-count" className="absolute -right-1 -top-1 min-w-4 rounded-full bg-pink-600 px-1 text-center text-[10px] leading-4 text-white">{unread > 99 ? '99+' : unread}</span>
        : piAttention ? <span aria-label="有新提醒" className="absolute right-1 top-1 h-2 w-2 rounded-full border border-white bg-pink-500" /> : null}
    </button>
    {open && <div className="absolute bottom-24 left-full z-50 ml-2 w-80 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg"
      onClick={(event) => event.stopPropagation()} data-smoke="notifications-menu">
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-3 text-sm font-semibold">
        <span>提醒</span><span className="text-xs font-normal text-neutral-500">{unread} 条未读</span>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {piAttention && <Link href={'/' + teamPath + '/dashboard/pi'} onClick={onClose}
          className="flex items-center gap-2 px-3 py-3 text-sm text-amber-900 hover:bg-amber-50" data-smoke="pi-configuration-readiness-alert">
          <Bell size={15} />PI 需要处理
        </Link>}
        {items.map((item) => <button key={item.id} type="button" data-smoke="completion-notification-item"
          onClick={() => { void view(item); }} className={'flex w-full gap-2 border-b border-neutral-100 px-3 py-3 text-left hover:bg-neutral-50 ' + (item.readAt === null ? 'bg-pink-50/40' : '')}>
          <span className={'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ' + (item.readAt === null ? 'bg-pink-600' : 'bg-transparent')} />
          <span className="min-w-0"><span className="block break-words text-sm text-neutral-900">{item.title}</span>
            <span className="mt-1 block text-xs text-neutral-500">{item.taskId ? '查看交付' : '查看结果'} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span></span>
        </button>)}
        {error ? <p role="status" className="px-3 py-4 text-xs text-amber-700">{error}</p>
          : items.length === 0 && !piAttention && <p className="px-3 py-5 text-center text-xs text-neutral-400">{loading ? '正在加载提醒…' : !connected ? '连接恢复后同步提醒' : '暂无提醒'}</p>}
      </div>
      <BrowserPushSettings state={pushSettings} />
    </div>}
    {toast && toast.teamId === teamId && toast.recipientId === userId && <div role="status" data-smoke="completion-notification-toast"
      className="fixed right-6 top-6 z-[80] flex w-80 items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-xl">
      <Bell size={18} className="mt-0.5 shrink-0 text-pink-600" />
      <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium text-neutral-900">{toast.title}</p>
        <button type="button" onClick={() => { void view(toast); }} className="mt-2 text-sm font-medium text-pink-700">{toast.taskId ? '查看交付' : '查看结果'}</button></div>
      <button type="button" aria-label="关闭提示" onClick={() => setToast(null)} className="text-neutral-400 hover:text-neutral-700"><X size={16} /></button>
    </div>}
  </>;
}
