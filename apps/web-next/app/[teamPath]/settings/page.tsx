'use client';

import { useState, useEffect, useCallback } from 'react';
import { User, Globe, Server, FileText, LogOut, Check, Copy, Trash2, Bell, Volume2, Keyboard, PanelRight, RotateCcw, Terminal, Database, Bot } from 'lucide-react';
import { ConnectionBanner } from '@/components/connection-banner';
import { authEvents, clearStoredAuth, getWebSocket, joinEvents, teamEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { JoinLinkInfo } from '@/lib/schema';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  DEFAULT_BROWSER_SETTINGS,
  readBrowserSettings,
  resetBrowserSettings,
  writeBrowserSettings,
  type AttachmentOpenMode,
  type BrowserSettings,
} from '@/lib/browser-settings';
import { releases } from '@/lib/releases.generated';
import { formatReleaseVersion, type Release, type ChangeType } from '@/lib/changelog';
import { RunsPanel } from './RunsPanel';
import { ManagementPolicyPanel } from './ManagementPolicyPanel';
import { MemoryGovernancePanel } from './MemoryGovernancePanel';
import { PiManagementPanel } from './PiManagementPanel';
import {
  resolveSettingsTab,
  settingsTabsForRole,
  type SettingsTab,
} from '@/lib/settings-tabs';

type Tab = SettingsTab;

const TAB_META: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'account', label: '账号', icon: <User size={16} /> },
  { id: 'browser', label: '浏览器', icon: <Globe size={16} /> },
  { id: 'server', label: '团队', icon: <Server size={16} /> },
  { id: 'pi', label: 'PI Agent', icon: <Bot size={16} /> },
  { id: 'memory', label: 'Memory 治理', icon: <Database size={16} /> },
  { id: 'runs', label: '执行记录诊断', icon: <Terminal size={16} /> },
  { id: 'releases', label: '更新日志', icon: <FileText size={16} /> },
];
const JOIN_INTERNAL_ERROR_MESSAGE = '创建失败，请稍后重试';

function joinFailureMessage(result: { error?: string; message?: string }): string {
  if (result.error === 'INTERNAL_ERROR') {
    return JOIN_INTERNAL_ERROR_MESSAGE;
  }
  return result.message ?? result.error ?? '创建失败';
}

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const isSystemAdmin = currentUser?.role === 'admin';
  const visibleTabs = TAB_META.filter((t) => settingsTabsForRole(Boolean(isSystemAdmin)).includes(t.id));
  const [tab, setTab] = useState<Tab>(() => resolveSettingsTab(null, Boolean(isSystemAdmin)));

  useEffect(() => {
    setTab(resolveSettingsTab(searchParams.get('tab'), Boolean(isSystemAdmin)));
  }, [searchParams, isSystemAdmin]);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left tab nav — beige background */}
      <div className="flex w-52 shrink-0 flex-col border-r border-neutral-200 bg-[#FFF8E7]">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">设置</div>
        <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {visibleTabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm ${tab === t.id ? 'bg-pink-100 font-medium text-pink-800' : 'text-neutral-600 hover:bg-white/50'}`} data-smoke={`settings-tab-${t.id}`}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex flex-1 flex-col">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">{visibleTabs.find((t) => t.id === tab)?.label ?? '设置'}</div>
        <div className="flex-1 overflow-y-auto p-6">
        <ConnectionBanner />
        {tab === 'account' && <AccountPanel />}
        {tab === 'browser' && <BrowserPanel />}
        {tab === 'server' && <ServerPanel />}
        {tab === 'pi' && isSystemAdmin && <PiManagementPanel isSystemAdmin />}
        {tab === 'memory' && <MemoryGovernancePanel />}
        {tab === 'runs' && <RunsPanel />}
        {tab === 'releases' && <ReleasesPanel />}
        </div>
      </div>
    </div>
  );
}

function AccountPanel() {
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const router = useRouter();
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [changingPw, setChangingPw] = useState(false);

  const changePassword = async () => {
    if (newPw !== confirmPw) {
      setPwMsg({ ok: false, text: '两次输入的新密码不一致' });
      return;
    }
    if (newPw.length < 6) {
      setPwMsg({ ok: false, text: '新密码至少 6 位' });
      return;
    }
    setChangingPw(true);
    setPwMsg(null);
    const res = await authEvents().changePassword({ currentPassword: currentPw, newPassword: newPw });
    setChangingPw(false);
    if (res.ok) {
      setPwMsg({ ok: true, text: '密码修改成功' });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } else {
      setPwMsg({ ok: false, text: res.error ?? '修改失败' });
    }
  };

  const logout = () => {
    clearStoredAuth();
    useAgentBeanStore.getState().setAuthToken(null);
    useAgentBeanStore.getState().setCurrentUser(null);
    getWebSocket().disconnect();
    router.push('/');
  };

  return (
    <div
      className="mx-auto max-w-xl space-y-8"
      data-smoke="settings-account-panel"
      data-settings-username={currentUser?.username ?? ''}
      data-settings-email={currentUser?.email ?? ''}
    >
      <h2 className="text-xl font-semibold">账号</h2>

      {/* User info card */}
      <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-account-profile">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-purple-100 text-lg font-semibold text-purple-700">
            {(currentUser?.username ?? '?')[0].toUpperCase()}
          </div>
          <div>
            <div className="text-lg font-semibold" data-smoke="settings-account-username">{currentUser?.username ?? '—'}</div>
            <div className="text-sm text-neutral-500" data-smoke="settings-account-email">{currentUser?.email ?? '未设置邮箱'}</div>
          </div>
        </div>

        <div className="mt-5 space-y-3 border-t border-neutral-100 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">用户名</div>
              <div className="text-xs text-neutral-500">{currentUser?.username ?? '—'}</div>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">邮箱</div>
              <div className="flex items-center gap-1.5 text-xs text-neutral-500">
                {currentUser?.email ?? '未设置'}
                {currentUser?.email && <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"><Check size={8} /> 已验证</span>}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Connected accounts */}
      <section className="rounded-lg border border-neutral-200 p-5">
        <h3 className="mb-4 text-sm font-semibold text-neutral-700">关联账号</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-neutral-100 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-sm font-bold">G</div>
              <div><div className="text-sm font-medium">Google</div><div className="text-xs text-neutral-400">未关联</div></div>
            </div>
            <button className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50">关联</button>
          </div>
          <div className="flex items-center justify-between rounded-md border border-neutral-100 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-sm font-bold text-white">
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
              </div>
              <div><div className="text-sm font-medium">GitHub</div><div className="text-xs text-neutral-400">未关联</div></div>
            </div>
            <button className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50">关联</button>
          </div>
        </div>
      </section>

      {/* Change password */}
      <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-password-section">
        <h3 className="mb-4 text-sm font-semibold text-neutral-700">修改密码</h3>
        <div className="space-y-3">
          <input type="password" placeholder="当前密码" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-400 placeholder:text-neutral-400" data-smoke="settings-password-current-input" />
          <input type="password" placeholder="新密码（至少 6 位）" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-400 placeholder:text-neutral-400" data-smoke="settings-password-new-input" />
          <input type="password" placeholder="确认新密码" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-400 placeholder:text-neutral-400" data-smoke="settings-password-confirm-input" />
          {pwMsg && <div className={`text-sm ${pwMsg.ok ? 'text-emerald-600' : 'text-red-600'}`} data-smoke="settings-password-message">{pwMsg.text}</div>}
          <button onClick={changePassword} disabled={changingPw || !currentPw || !newPw || !confirmPw} className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50" data-smoke="settings-password-submit-btn">
            {changingPw ? '修改中...' : '修改密码'}
          </button>
        </div>
      </section>

      <section>
        <button onClick={logout} className="inline-flex items-center gap-2 rounded-md border border-red-200 px-4 py-2 text-sm text-red-600 hover:bg-red-50" data-smoke="settings-account-logout">
          <LogOut size={16} /> 退出登录
        </button>
      </section>
    </div>
  );
}

function BrowserPanel() {
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT_BROWSER_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setSettings(readBrowserSettings(typeof window === 'undefined' ? null : window.localStorage));
    setLoaded(true);
  }, []);

  const updateSettings = (patch: Partial<BrowserSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      writeBrowserSettings(typeof window === 'undefined' ? null : window.localStorage, next);
      return next;
    });
  };

  const resetSettings = () => {
    setSettings(resetBrowserSettings(typeof window === 'undefined' ? null : window.localStorage));
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6" data-smoke="settings-browser-panel">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">浏览器</h2>
          <p className="mt-1 text-sm text-neutral-500">这些偏好保存在当前浏览器中。</p>
        </div>
        <button onClick={resetSettings} className="inline-flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50" data-smoke="settings-browser-reset">
          <RotateCcw size={13} />
          恢复默认
        </button>
      </div>

      <section className="rounded-lg border border-neutral-200 bg-white">
        <BrowserSettingSwitch
          icon={<Bell size={16} />}
          title="桌面通知"
          description="新消息到达时显示系统通知。"
          checked={settings.desktopNotifications}
          disabled={!loaded}
          smokeId="settings-browser-desktop-notifications"
          onChange={(checked) => updateSettings({ desktopNotifications: checked })}
        />
        <BrowserSettingSwitch
          icon={<Volume2 size={16} />}
          title="提示音"
          description="频道、私聊和任务更新时播放轻提示音。"
          checked={settings.sound}
          disabled={!loaded}
          smokeId="settings-browser-sound"
          onChange={(checked) => updateSettings({ sound: checked })}
        />
        <BrowserSettingSwitch
          icon={<PanelRight size={16} />}
          title="紧凑布局"
          description="缩小列表行高，让聊天和任务页面显示更多内容。"
          checked={settings.compactMode}
          disabled={!loaded}
          smokeId="settings-browser-compact-mode"
          onChange={(checked) => updateSettings({ compactMode: checked })}
        />
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-neutral-800">
          <Keyboard size={16} className="text-neutral-500" />
          输入与文件
        </div>
        <div className="space-y-5">
          <div>
            <label className="mb-2 block text-xs font-medium text-neutral-500">发送消息</label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <ChoiceButton
                selected={settings.messageSendMode === 'mod-enter'}
                title="⌘ / Ctrl + Enter"
                description="Enter 保留换行。"
                disabled={!loaded}
                smokeId="settings-browser-send-mod-enter"
                onClick={() => updateSettings({ messageSendMode: 'mod-enter' })}
              />
              <ChoiceButton
                selected={settings.messageSendMode === 'enter'}
                title="Enter"
                description="Shift + Enter 换行。"
                disabled={!loaded}
                smokeId="settings-browser-send-enter"
                onClick={() => updateSettings({ messageSendMode: 'enter' })}
              />
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-neutral-500">打开附件</label>
            <select
              value={settings.attachmentOpenMode}
              onChange={(event) => updateSettings({ attachmentOpenMode: event.target.value as AttachmentOpenMode })}
              disabled={!loaded}
              className="h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-neutral-400 disabled:bg-neutral-50"
              data-smoke="settings-browser-attachment-open-mode"
            >
              <option value="inline">在 AgentBean 内预览</option>
              <option value="new-tab">在新标签页打开</option>
              <option value="download">直接下载</option>
            </select>
          </div>
        </div>
      </section>
    </div>
  );
}

function BrowserSettingSwitch({
  icon,
  title,
  description,
  checked,
  disabled,
  smokeId,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  smokeId: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-4 border-b border-neutral-100 px-5 py-4 last:border-b-0" data-smoke={smokeId} data-settings-checked={checked ? 'true' : 'false'}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-600">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-neutral-900">{title}</span>
        <span className="mt-0.5 block text-xs text-neutral-500">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span className="relative h-6 w-11 shrink-0 rounded-full bg-neutral-200 transition peer-checked:bg-neutral-900 peer-disabled:opacity-50">
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${checked ? 'left-5' : 'left-0.5'}`} />
      </span>
    </label>
  );
}

function ChoiceButton({
  selected,
  title,
  description,
  disabled,
  smokeId,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  disabled?: boolean;
  smokeId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-smoke={smokeId}
      data-settings-selected={selected ? 'true' : 'false'}
      className={`min-h-16 rounded-md border px-3 py-2 text-left transition disabled:opacity-50 ${
        selected
          ? 'border-neutral-900 bg-neutral-900 text-white'
          : 'border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50'
      }`}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className={`mt-1 block text-xs ${selected ? 'text-neutral-200' : 'text-neutral-500'}`}>{description}</span>
    </button>
  );
}

function ServerPanel() {
  const params = useParams();
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const teams = useAgentBeanStore((s) => s.teams);
  const visibleAgents = useAgentBeanStore((s) => s.visibleAgents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const setCurrentTeamId = useAgentBeanStore((s) => s.setCurrentTeamId);
  const router = useRouter();

  const [teamName, setTeamName] = useState('');
  const [nameSaved, setNameSaved] = useState(true);
  const [onboardAgent, setOnboardAgent] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Join links state
  const [joinLinks, setJoinLinks] = useState<JoinLinkInfo[]>([]);
  const [maxUses, setMaxUses] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState('');

  const currentTeam = teams.find((n) => n.id === currentTeamId);
  const routeTeamPath = typeof params.teamPath === 'string' ? params.teamPath : '';
  const routeTeam = teams.find((team) => team.path === routeTeamPath || team.id === routeTeamPath);
  const settingsTeam = routeTeam ?? (routeTeamPath === 'default' ? currentTeam : null);
  const settingsTeamId = settingsTeam?.id ?? (routeTeamPath === 'default' ? currentTeamId : '');

  const displayedName = settingsTeam?.name ?? '当前团队';
  useEffect(() => {
    setTeamName(displayedName);
    setNameSaved(true);
  }, [settingsTeamId, displayedName]);

  useEffect(() => {
    setNameMsg(null);
    setDeleteMsg('');
    setShowDeleteConfirm(false);
  }, [settingsTeamId]);

  const agentList = visibleAgents;
  const managementDeviceIds = agentList.flatMap((agent) => agent.deviceId ? [agent.deviceId] : []);
  const canManagePolicy = settingsTeam?.currentUserRole === 'owner' || settingsTeam?.currentUserRole === 'admin';

  const loadLinks = useCallback(async () => {
    if (!settingsTeamId) return;
    const res = await joinEvents().list({ teamId: settingsTeamId });
    if (res.ok && res.links) setJoinLinks(res.links);
  }, [settingsTeamId]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const createJoinLink = async () => {
    setJoinError('');
    const payload: { maxUses?: number; expiresAt?: number } = {};
    if (maxUses) payload.maxUses = parseInt(maxUses, 10);
    if (expiresAt) payload.expiresAt = new Date(expiresAt).getTime();

    if (!settingsTeamId) return;
    const res = await joinEvents().create({ ...payload, teamId: settingsTeamId });
    if (res.ok && res.link) {
      setJoinLinks((prev) => [res.link!, ...prev]);
      setMaxUses('');
      setExpiresAt('');
    } else {
      setJoinError(joinFailureMessage(res));
    }
  };

  const revokeLink = async (code: string) => {
    if (!settingsTeamId) return;
    const res = await joinEvents().revoke({ code, teamId: settingsTeamId });
    if (res.ok) {
      setJoinLinks((prev) => prev.filter((l) => l.code !== code));
    }
  };

  const copyLink = (url: string, id: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleNameChange = (v: string) => {
    setTeamName(v);
    setNameSaved(v === displayedName);
    setNameMsg(null);
  };

  const handleSaveName = async () => {
    if (!settingsTeamId || nameSaved || !teamName.trim()) return;
    setNameSaving(true);
    setNameMsg(null);
    const res = await teamEvents().update({ teamId: settingsTeamId ?? undefined, name: teamName.trim() });
    setNameSaving(false);
    if (res.ok) {
      setNameSaved(true);
      setNameMsg({ ok: true, text: '保存成功' });
    } else {
      setNameMsg({ ok: false, text: res.error ?? '保存失败' });
    }
  };

  const handleDeleteTeam = async () => {
    if (!settingsTeam || deleteSaving) return;
    setDeleteSaving(true);
    setDeleteMsg('');
    const res = await teamEvents().delete(settingsTeam.id);
    setDeleteSaving(false);
    if (!res.ok) {
      setDeleteMsg(res.error ?? '删除失败');
      return;
    }
    setShowDeleteConfirm(false);
    const fallback = res.fallbackTeam ?? teams.find((team) => team.id !== settingsTeam.id) ?? null;
    if (fallback) {
      setCurrentTeamId(fallback.id);
      router.replace(`/${fallback.path ?? 'default'}/settings`);
    } else {
      router.replace('/login');
    }
  };

  const formatExpiry = (ts: number | null) => {
    if (!ts) return '无过期时间';
    return new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h2 className="text-xl font-semibold">团队</h2>

      {/* PROFILE */}
      <section className="rounded-lg border border-neutral-200 p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">团队资料</h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">名称</label>
          <input value={teamName} onChange={(e) => handleNameChange(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" data-smoke="settings-team-name-input" data-team-id={settingsTeamId} />
          </div>
          <button onClick={handleSaveName} disabled={!settingsTeamId || nameSaved || nameSaving} className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-40" data-smoke="settings-team-name-save">
            {nameSaving ? '保存中...' : '保存资料'}
          </button>
          {nameMsg && <div className={`text-sm ${nameMsg.ok ? 'text-emerald-600' : 'text-red-600'}`} data-smoke="settings-team-name-message">{nameMsg.text}</div>}
        </div>
      </section>

      {settingsTeamId && (
        <ManagementPolicyPanel teamId={settingsTeamId} canManage={canManagePolicy} deviceIds={managementDeviceIds} />
      )}

      {/* ADMINS */}
      <section className="rounded-lg border border-neutral-200 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">管理员 ({currentUser ? 1 : 0})</h3>
        </div>
        {currentUser && (
          <div className="flex items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-100 text-xs font-semibold text-purple-700">
              {currentUser.username[0].toUpperCase()}
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium">{currentUser.username}</div>
              <div className="text-xs text-neutral-400">所有者</div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">所有者</span>
          </div>
        )}
      </section>

      {/* PENDING INVITES */}
      <section className="rounded-lg border border-neutral-200 p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">待处理邀请</h3>
        <div className="text-sm text-neutral-400">暂无待处理的邀请。</div>
      </section>

      {/* JOIN LINKS */}
      <section className="rounded-lg border border-neutral-200 p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">加入链接 ({joinLinks.length})</h3>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">最大使用次数</label>
            <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="不限" className="w-28 rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" data-smoke="settings-join-max-uses" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">过期时间</label>
            <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" data-smoke="settings-join-expires-at" />
          </div>
          <button onClick={createJoinLink} disabled={!settingsTeamId} className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50" data-smoke="settings-join-create">
            创建加入链接
          </button>
        </div>

        {joinError && <p className="mb-3 text-sm text-red-600" data-smoke="settings-join-error">{joinError}</p>}

        <div className="space-y-3">
          {joinLinks.map((link) => (
            <div key={link.id} className="rounded-md border border-neutral-100 bg-neutral-50 p-3" data-smoke="settings-join-link" data-join-code={link.code}>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs text-neutral-700">{link.url}</code>
                <button onClick={() => copyLink(link.url, link.id)} className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs hover:bg-neutral-100 flex items-center gap-1">
                  <Copy size={10} /> {copiedId === link.id ? '已复制' : '复制'}
                </button>
                <button onClick={() => revokeLink(link.code)} className="shrink-0 rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-50 flex items-center gap-1" data-smoke="settings-join-revoke" data-join-code={link.code}>
                  <Trash2 size={10} /> 撤销
                </button>
              </div>
              <div className="mt-1.5 text-xs text-neutral-400">
                {link.usesCount} 次使用 · {formatExpiry(link.expiresAt)}
              </div>
            </div>
          ))}
          {joinLinks.length === 0 && <div className="text-sm text-neutral-400" data-smoke="settings-join-empty">暂无加入链接。</div>}
        </div>
      </section>

      {/* ONBOARDING AGENT */}
      <section className="rounded-lg border border-neutral-200 p-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">引导 Agent</h3>
        <p className="mb-3 text-xs text-neutral-500">为新成员指定一个引导 Agent，或关闭自动引导功能。</p>
        <div className="flex items-center gap-3">
          <select value={onboardAgent} onChange={(e) => setOnboardAgent(e.target.value)} className="flex-1 rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400">
            <option value="">选择引导 Agent...</option>
            {agentList.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800">保存</button>
        </div>
      </section>

      {/* DANGER ZONE */}
      <section className="rounded-lg border border-red-200 p-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-500">危险区域</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-red-700">删除团队</div>
            <div className="text-xs text-red-400">永久删除此团队及所有关联数据，此操作不可撤销。</div>
          </div>
          <button onClick={() => setShowDeleteConfirm(true)} disabled={!settingsTeam || settingsTeam.id === 'default'} className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" data-smoke="settings-team-delete-open">
            删除团队
          </button>
        </div>
        {settingsTeam?.id === 'default' && <p className="mt-3 text-xs text-neutral-400">默认团队不能删除。</p>}
        {deleteMsg && <p className="mt-3 text-sm text-red-600">{deleteMsg}</p>}
        {showDeleteConfirm && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4" data-smoke="settings-team-delete-dialog" data-team-id={settingsTeam?.id} data-team-name={settingsTeam?.name}>
            <p className="mb-3 text-sm text-red-700">确定要删除团队 <strong>{settingsTeam?.name ?? '当前团队'}</strong> 吗？此操作不可撤销。</p>
            <div className="flex gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50">取消</button>
              <button onClick={handleDeleteTeam} disabled={deleteSaving} className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50" data-smoke="settings-team-delete-confirm">
                {deleteSaving ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ReleasesPanel() {
  const releaseCount = releases.length;
  const itemCount = releases.reduce(
    (total, release) => total + release.sections.reduce((sum, section) => sum + section.items.length, 0),
    0,
  );

  return (
    <div className="mx-auto max-w-3xl space-y-5" data-smoke="settings-releases-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-neutral-500">
            <FileText size={16} />
            <span>What's New</span>
          </div>
          <h2 className="text-xl font-semibold leading-tight text-neutral-950">更新日志</h2>
        </div>
        <div className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
          {releaseCount} 天 · {itemCount} 条
        </div>
      </div>

      <div className="space-y-4">
        {releases.map((r) => (
          <ReleaseEntry key={r.version} release={r} />
        ))}
      </div>
    </div>
  );
}

const SECTION_STYLE: Record<ChangeType, { label: string; badge: string; item: string }> = {
  Added:      { label: 'NEW', badge: 'bg-emerald-50 text-emerald-700', item: 'text-neutral-900 font-medium' },
  Changed:    { label: 'IMPROVED', badge: 'bg-blue-50 text-blue-700', item: 'text-neutral-700' },
  Deprecated: { label: 'DEPRECATED', badge: 'bg-yellow-50 text-yellow-700', item: 'text-neutral-700' },
  Removed:    { label: 'REMOVED', badge: 'bg-red-50 text-red-700', item: 'text-neutral-900 font-medium' },
  Fixed:      { label: 'FIX', badge: 'bg-orange-50 text-orange-700', item: 'text-neutral-700' },
  Security:   { label: 'SECURITY', badge: 'bg-purple-50 text-purple-700', item: 'text-neutral-900 font-medium' },
};

function ReleaseEntry({ release }: { release: Release }) {
  const sections = release.sections.filter((s) => s.items.length > 0);
  const version = formatReleaseVersion(release.version);
  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-5" data-smoke="settings-release-entry">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-md bg-neutral-100 px-2.5 py-1 font-mono text-sm font-semibold text-neutral-800">
          {release.date}
        </span>
        <span className="font-mono text-xs font-bold text-neutral-400">{version}</span>
      </div>

      <div className="space-y-2.5">
        {sections.flatMap((s) => (
          s.items.map((n, i) => (
            <div key={`${s.type}-${i}`} className="flex items-start gap-2.5">
              <span className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none ${SECTION_STYLE[s.type].badge}`}>
                {SECTION_STYLE[s.type].label}
              </span>
              <span className={`min-w-0 flex-1 text-left text-sm leading-5 ${SECTION_STYLE[s.type].item}`}>{n}</span>
            </div>
          ))
        ))}
      </div>
    </article>
  );
}
