'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Activity, Bell, BookOpen, Check, CircleHelp, ClipboardList, ExternalLink, Globe, Lock, MessagesSquare, Monitor, Plus, Search, Settings, Users } from 'lucide-react';
import { agentEvents, channelEvents, deviceEvents, getWebSocket, piProviderEvents, teamEvents } from '@/lib/socket';
import type { PiConfigurationReadinessDto } from '@agentbean/contracts';
import { useAgentBeanStore } from '@/lib/store';
import { writeStoredTeamPath } from '@/lib/team-path';
import { PI_CONFIGURATION_READINESS_CHANGED_EVENT } from '@/lib/pi-configuration-readiness';
import type { TeamSummary } from '@/lib/schema';

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const conn = useAgentBeanStore((s) => s.conn);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const teams = useAgentBeanStore((s) => s.teams);
  const addTeam = useAgentBeanStore((s) => s.addTeam);
  const setCurrentTeamId = useAgentBeanStore((s) => s.setCurrentTeamId);
  const applyTeamsSnapshot = useAgentBeanStore((s) => s.applyTeamsSnapshot);
  const [showTeams, setShowTeams] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [piReadiness, setPiReadiness] = useState<PiConfigurationReadinessDto | null>(null);

  useEffect(() => {
    if (conn !== 'open') return;
    const socket = getWebSocket();
    const nets = teamEvents(socket);
    nets.list().then((res) => {
      if (res.ok && res.teams) applyTeamsSnapshot(res.teams);
    });
    const unsub = nets.onSnapshot((list) => applyTeamsSnapshot(list));
    return () => { unsub(); };
  }, [conn, applyTeamsSnapshot]);

  useEffect(() => {
    if (conn !== 'open' || currentUser?.role !== 'admin') {
      setPiReadiness(null);
      return;
    }
    let active = true;
    const refresh = () => {
      void piProviderEvents().getActiveModel().then((result) => {
        if (active) setPiReadiness(result.ok ? result.readiness ?? null : null);
      });
    };
    refresh();
    window.addEventListener(PI_CONFIGURATION_READINESS_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(PI_CONFIGURATION_READINESS_CHANGED_EVENT, refresh);
    };
  }, [conn, currentUser?.id, currentUser?.role]);

  // 点击侧栏外部时关闭浮层，保持三个入口互斥。
  useEffect(() => {
    if (!showTeams && !showNotifications && !showHelp) return;
    const handler = () => {
      setShowTeams(false);
      setShowNotifications(false);
      setShowHelp(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showHelp, showNotifications, showTeams]);

  const currentTeam = teams.find((n) => n.id === currentTeamId);
  const np = currentTeam?.path ?? 'default';
  const isAdmin = currentUser?.role === 'admin';

  const handleSwitch = async (teamId: string) => {
    const res = await teamEvents().switch(teamId);
    if (res.ok) {
      setCurrentTeamId(teamId);
      setShowTeams(false);
      const target = teams.find((n) => n.id === teamId);
      if (target) {
        writeStoredTeamPath(localStorage, target.path);
        const segments = pathname.split('/');
        const subPath = segments.length > 2 ? segments.slice(2).join('/') : 'chat';
        router.push(`/${target.path}/${subPath}`);
      }
      const socket = getWebSocket();
      agentEvents(socket).subscribe(teamId);
      channelEvents(socket).subscribe(teamId);
      deviceEvents(socket).subscribe(teamId);
    }
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <aside className="relative z-20 flex w-16 shrink-0 flex-col border-r border-neutral-900/20 bg-[#F4D24F]" data-smoke="app-sidebar">
      {/* Team switcher */}
      <div className="relative flex h-16 items-center justify-center border-b border-neutral-900/20 px-2">
          <button
            onClick={(event) => {
              event.stopPropagation();
              setShowTeams((value) => !value);
              setShowNotifications(false);
              setShowHelp(false);
            }}
            className="flex h-10 w-10 items-center justify-center border-2 border-neutral-900 bg-neutral-900 text-sm font-bold text-[#F4D24F] shadow-[2px_2px_0_0_#171717] transition-transform hover:-translate-y-0.5"
            aria-label={`切换团队，当前团队：${currentTeam?.name ?? '当前团队'}`}
            title={currentTeam?.name ?? '切换团队'}
            aria-expanded={showTeams}
            data-smoke="team-switcher"
          >
            <span aria-hidden="true">{currentTeam?.name?.trim().charAt(0).toUpperCase() || '团'}</span>
          </button>
          {showTeams && (
            <div
              className="absolute left-full top-2 z-50 ml-2 w-64 overflow-hidden border-2 border-neutral-900 bg-white shadow-[4px_4px_0_0_#171717]"
              onClick={(e) => e.stopPropagation()}
              data-smoke="team-switcher-menu"
            >
              <div className="max-h-72 overflow-y-auto p-2">
                {teams.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-neutral-400">没有可用团队</div>
                ) : (
                  teams.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleSwitch(n.id)}
                      className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs transition-colors hover:bg-amber-50"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-neutral-900 font-bold text-[#F4D24F]">{n.name.trim().charAt(0).toUpperCase() || '团'}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate ${n.id === currentTeamId ? 'font-semibold text-neutral-900' : 'text-neutral-700'}`}>{n.name}</span>
                        <span className="block truncate text-[10px] text-neutral-400">/{n.path}</span>
                      </span>
                      {n.type === 'public' ? (
                        <Globe size={12} className="shrink-0 text-neutral-400" />
                      ) : (
                        <Lock size={12} className="shrink-0 text-neutral-400" />
                      )}
                      {n.id === currentTeamId && <Check size={14} className="shrink-0 text-neutral-900" />}
                    </button>
                  ))
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowTeams(false);
                  setShowCreateDialog(true);
                }}
                className="flex w-full items-center gap-2 border-t-2 border-neutral-900 px-3 py-2.5 text-xs font-semibold text-neutral-800 hover:bg-[#F4D24F]"
              >
                <Plus size={14} />
                切换或创建团队
              </button>
            </div>
          )}
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col items-center gap-1 overflow-visible px-2 py-3" aria-label="主导航">
        <NavItem href={`/${np}/search`} icon={<Search size={19} />} label="搜索" active={isActive(`/${np}/search`)} />
        <NavItem href={`/${np}/chat`} icon={<MessagesSquare size={19} />} label="聊天" active={isActive(`/${np}/chat`) || isActive(`/${np}/channel`) || isActive(`/${np}/dm`)} />
        <NavItem href={`/${np}/activity`} icon={<Activity size={19} />} label="活动" active={isActive(`/${np}/activity`)} />
        <NavItem href={`/${np}/tasks`} icon={<ClipboardList size={19} />} label="任务" active={isActive(`/${np}/tasks`)} />
        <NavItem href={`/${np}/members`} icon={<Users size={19} />} label="成员" active={isActive(`/${np}/members`)} />
        <NavItem href={`/${np}/devices`} icon={<Monitor size={19} />} label="设备" active={isActive(`/${np}/devices`)} />
      </nav>

      {/* Bottom utilities */}
      <div className="relative flex flex-col items-center gap-1 border-t border-neutral-900/20 px-2 py-3">
        <RailButton
          icon={<Bell size={19} />}
          label="提醒"
          active={showNotifications}
          badge={isAdmin && piReadiness?.status === 'attention_required'}
          onClick={(event) => {
            event.stopPropagation();
            setShowNotifications((value) => !value);
            setShowTeams(false);
            setShowHelp(false);
          }}
        />
        {showNotifications && (
          <div className="absolute bottom-24 left-full z-50 ml-2 w-72 border-2 border-neutral-900 bg-white shadow-[4px_4px_0_0_#171717]" onClick={(event) => event.stopPropagation()} data-smoke="notifications-menu">
            <div className="border-b-2 border-neutral-900 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">提醒</div>
            {isAdmin && piReadiness?.status === 'attention_required' ? (
              <Link href={`/${np}/dashboard/pi`} className="flex items-center gap-2 px-3 py-3 text-sm font-medium text-amber-900 hover:bg-amber-50" data-smoke="pi-configuration-readiness-alert">
                <Bell size={15} />
                PI 需要处理
              </Link>
            ) : (
              <div className="px-3 py-5 text-center text-xs text-neutral-400">暂无提醒</div>
            )}
          </div>
        )}
        <RailButton
          icon={<CircleHelp size={19} />}
          label="帮助和资源"
          active={showHelp}
          onClick={(event) => {
            event.stopPropagation();
            setShowHelp((value) => !value);
            setShowTeams(false);
            setShowNotifications(false);
          }}
        />
        {showHelp && (
          <div className="absolute bottom-12 left-full z-50 ml-2 w-72 border-2 border-neutral-900 bg-white shadow-[4px_4px_0_0_#171717]" onClick={(event) => event.stopPropagation()} data-smoke="help-resources-menu">
            <div className="border-b-2 border-neutral-900 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">帮助和资源</div>
            <a href="https://github.com/xiaojichao/agentbean#readme" target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-700 hover:bg-amber-50">
              <BookOpen size={15} />
              AgentBean 文档
              <ExternalLink size={12} className="ml-auto text-neutral-400" />
            </a>
            <a href="https://github.com/xiaojichao/agentbean/issues" target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-700 hover:bg-amber-50">
              <CircleHelp size={15} />
              提交反馈
              <ExternalLink size={12} className="ml-auto text-neutral-400" />
            </a>
          </div>
        )}
        <NavItem href={`/${np}/settings`} icon={<Settings size={19} />} label="设置" active={isActive(`/${np}/settings`)} />
      </div>

      {/* Create Team Dialog */}
      {showCreateDialog && (
        <CreateTeamDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={(team) => {
            addTeam(team);
            setCurrentTeamId(team.id);
            writeStoredTeamPath(localStorage, team.path);
            const segments = pathname.split('/');
            const subPath = segments.length > 2 ? segments.slice(2).join('/') : 'chat';
            router.push(`/${team.path}/${subPath}`);
            const socket = getWebSocket();
            agentEvents(socket).subscribe(team.id);
            channelEvents(socket).subscribe(team.id);
            deviceEvents(socket).subscribe(team.id);
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
      title={label}
      aria-label={label}
      className={`group relative flex h-10 w-10 items-center justify-center border-2 text-sm transition-colors ${
        active ? 'border-neutral-900 bg-white text-neutral-900 shadow-[2px_2px_0_0_#171717]' : 'border-transparent text-neutral-900 hover:border-neutral-900/30 hover:bg-white/40'
      }`}
    >
      {icon}
      <span className="sr-only">{label}</span>
      <RailTooltip label={label} />
    </Link>
  );
}

function RailButton({
  icon,
  label,
  active,
  badge = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-expanded={active}
      className={`group relative flex h-10 w-10 items-center justify-center border-2 transition-colors ${
        active ? 'border-neutral-900 bg-white text-neutral-900 shadow-[2px_2px_0_0_#171717]' : 'border-transparent text-neutral-900 hover:border-neutral-900/30 hover:bg-white/40'
      }`}
    >
      {icon}
      {badge && <span className="absolute right-1 top-1 h-2 w-2 rounded-full border border-neutral-900 bg-pink-500" aria-label="有新提醒" />}
      <RailTooltip label={label} />
    </button>
  );
}

function RailTooltip({ label }: { label: string }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute left-full z-[60] ml-2 whitespace-nowrap border border-neutral-900 bg-neutral-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
      {label}
    </span>
  );
}

function CreateTeamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (team: TeamSummary) => void }) {
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
      if (res.ok && res.team) {
        onClose();
        onCreated(res.team);
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
