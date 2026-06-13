'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Bot, MessagesSquare, ClipboardList, Users, ChevronDown, Settings, Monitor, LayoutDashboard, Plus, Check, Globe, Lock } from 'lucide-react';
import { getWebSocket, teamEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const conn = useAgentBeanStore((s) => s.conn);
  const currentNetworkId = useAgentBeanStore((s) => s.currentNetworkId);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const networks = useAgentBeanStore((s) => s.networks);
  const setCurrentNetworkId = useAgentBeanStore((s) => s.setCurrentNetworkId);
  const applyNetworksSnapshot = useAgentBeanStore((s) => s.applyNetworksSnapshot);
  const [showNetworks, setShowNetworks] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  useEffect(() => {
    if (conn !== 'open') return;
    const socket = getWebSocket();
    const nets = teamEvents(socket);
    nets.list().then((res) => {
      if (res.ok && res.networks) applyNetworksSnapshot(res.networks);
    });
    const unsub = nets.onSnapshot((list) => applyNetworksSnapshot(list));
    return () => { unsub(); };
  }, [conn, applyNetworksSnapshot]);

  // Close popover on outside click
  useEffect(() => {
    if (!showNetworks) return;
    const handler = (e: MouseEvent) => setShowNetworks(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showNetworks]);

  const currentNetwork = networks.find((n) => n.id === currentNetworkId);
  const np = currentNetwork?.path ?? 'default';
  const isAdmin = currentUser?.role === 'admin';

  const handleSwitch = async (networkId: string) => {
    const res = await teamEvents().switch(networkId);
    if (res.ok) {
      setCurrentNetworkId(networkId);
      setShowNetworks(false);
      const target = networks.find((n) => n.id === networkId);
      if (target) {
        localStorage.setItem('agentbean.networkPath', target.path);
        const segments = pathname.split('/');
        const subPath = segments.length > 2 ? segments.slice(2).join('/') : 'chat';
        router.push(`/${target.path}/${subPath}`);
      }
      getWebSocket().emit('agents:subscribe', {});
      getWebSocket().emit('channels:subscribe', {});
      getWebSocket().emit('devices:subscribe', {});
    }
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2.5 border-b border-neutral-200 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-white">
          <Bot size={16} />
        </div>
        <span className="text-sm font-semibold tracking-tight">AgentBean</span>
      </div>

      {/* Team Switcher + Add */}
      <div className="px-3 py-2 flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <button
            onClick={() => { setShowNetworks((v) => !v); }}
            className="flex w-full items-center justify-between gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs hover:bg-neutral-50 transition-colors"
          >
            <span className="truncate font-medium">{currentNetwork?.name ?? '当前团队'}</span>
            <ChevronDown size={12} className={`shrink-0 text-neutral-400 transition-transform ${showNetworks ? 'rotate-180' : ''}`} />
          </button>
          {showNetworks && (
            <div
              className="absolute top-full left-0 mt-1 rounded-lg border border-neutral-200 bg-white shadow-xl z-30 w-52 overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-1.5">
                {networks.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-neutral-400">没有可用团队</div>
                ) : (
                  networks.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleSwitch(n.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs hover:bg-neutral-50 transition-colors"
                    >
                      {n.id === currentNetworkId ? (
                        <Check size={14} className="shrink-0 text-neutral-900" />
                      ) : (
                        <span className="w-3.5" />
                      )}
                      <span className={`truncate ${n.id === currentNetworkId ? 'font-medium text-neutral-900' : 'text-neutral-600'}`}>
                        {n.name}
                      </span>
                      {n.type === 'public' ? (
                        <Globe size={10} className="shrink-0 text-neutral-400 ml-auto" />
                      ) : (
                        <Lock size={10} className="shrink-0 text-neutral-400 ml-auto" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 transition-colors"
          title="创建团队"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto border-t border-neutral-200 px-2 py-3 space-y-0.5">
        <NavItem href={`/${np}/chat`} icon={<MessagesSquare size={16} />} label="聊天" active={isActive(`/${np}/chat`)} />
        <NavItem href={`/${np}/tasks`} icon={<ClipboardList size={16} />} label="任务" active={isActive(`/${np}/tasks`)} />
        <NavItem href={`/${np}/members`} icon={<Users size={16} />} label="成员" active={isActive(`/${np}/members`)} />
        <NavItem href={`/${np}/devices`} icon={<Monitor size={16} />} label="设备" active={isActive(`/${np}/devices`)} />
        {isAdmin && (
          <NavItem href={`/${np}/dashboard`} icon={<LayoutDashboard size={16} />} label="仪表盘" active={isActive(`/${np}/dashboard`)} />
        )}
      </nav>

      {/* Bottom: settings */}
      <div className="border-t border-neutral-200 px-2 py-2">
        <NavItem href={`/${np}/settings`} icon={<Settings size={16} />} label="设置" active={isActive(`/${np}/settings`)} />
      </div>

      {/* Create Team Dialog */}
      {showCreateDialog && (
        <CreateNetworkDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={(networkId, networkPath) => {
            setCurrentNetworkId(networkId);
            const segments = pathname.split('/');
            const subPath = segments.length > 2 ? segments.slice(2).join('/') : 'chat';
            router.push(`/${networkPath}/${subPath}`);
            getWebSocket().emit('agents:subscribe', {});
            getWebSocket().emit('channels:subscribe', {});
            getWebSocket().emit('devices:subscribe', {});
          }}
        />
      )}
    </aside>
  );
}

function NavItem({ href, icon, label, active }: { href: string; icon: React.ReactNode; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        active ? 'bg-neutral-200/70 font-medium text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'
      }`}
    >
      {icon}
      {label}
    </Link>
  );
}

function CreateNetworkDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (networkId: string, networkPath: string) => void }) {
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const isAdmin = currentUser?.role === 'admin';

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handlePathChange = (value: string) => {
    setPath(value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError('请输入团队名称'); return; }
    const trimmedPath = path.trim();
    if (trimmedPath && !/^[a-z][a-z0-9-]*$/.test(trimmedPath)) { setError('路径必须以英文字母开头，只能包含小写字母、数字和连字符'); return; }
    setPending(true);
    setError('');
    try {
      const res = await teamEvents().create({ name: trimmedName, path: trimmedPath || undefined, visibility });
      if (res.ok && res.network) {
        onClose();
        onCreated(res.network.id, res.network.path ?? 'default');
      } else {
        setError(res.error === 'RESERVED_PATH' ? '该路径为系统保留路径，请使用其他名称' : (res.error ?? '创建失败'));
      }
    } catch (e: any) {
      setError(e?.message ?? '连接超时，请重试');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">创建团队</h2>
        <p className="mt-1 text-sm text-neutral-500">{isAdmin ? '创建一个新的团队。创建后将自动切换到该团队。' : '创建一个本地团队。创建后将自动切换到该团队。'}</p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-500">团队名称</label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="例如：My Team"
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 placeholder:text-neutral-400"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-500">URL 路径</label>
            <div className="flex items-center rounded-lg border border-neutral-300 overflow-hidden focus-within:border-neutral-500">
              <span className="shrink-0 bg-neutral-50 px-2.5 py-2 text-xs text-neutral-400 border-r border-neutral-300">/</span>
              <input
                value={path}
                onChange={(e) => handlePathChange(e.target.value)}
                placeholder="例如：my-team"
                className="flex-1 px-3 py-2 text-sm outline-none placeholder:text-neutral-400"
              />
            </div>
            <p className="mt-1 text-[11px] text-neutral-400">只能使用小写英文字母、数字和连字符。留空则自动生成。</p>
          </div>
          {isAdmin && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-500">可见性</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setVisibility('private')}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${visibility === 'private' ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
                >
                  <Lock size={14} /> 私有
                </button>
                <button
                  type="button"
                  onClick={() => setVisibility('public')}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${visibility === 'public' ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
                >
                  <Globe size={14} /> 公有
                </button>
              </div>
              <p className="mt-1 text-[11px] text-neutral-400">{visibility === 'public' ? '所有注册用户均可查看和使用该团队' : '仅已加入的成员可查看该团队'}</p>
            </div>
          )}
        </div>

        {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">取消</button>
          <button
            onClick={handleCreate}
            disabled={pending || !name.trim()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {pending ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
