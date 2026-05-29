'use client';

import { useState, useEffect, useCallback } from 'react';
import { User, Globe, Server, FileText, LogOut, Check, Copy, Trash2 } from 'lucide-react';
import { ConnectionBanner } from '@/components/connection-banner';
import { authEvents, getWebSocket, joinEvents, networkEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { JoinLinkInfo } from '@/lib/schema';
import { useRouter } from 'next/navigation';

type Tab = 'account' | 'browser' | 'server' | 'releases';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'account', label: '账号', icon: <User size={16} /> },
  { id: 'browser', label: '浏览器', icon: <Globe size={16} /> },
  { id: 'server', label: '团队', icon: <Server size={16} /> },
  { id: 'releases', label: '更新日志', icon: <FileText size={16} /> },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('account');

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left tab nav — beige background */}
      <div className="flex w-52 shrink-0 flex-col border-r border-neutral-200 bg-[#FFF8E7]">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">设置</div>
        <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm ${tab === t.id ? 'bg-pink-100 font-medium text-pink-800' : 'text-neutral-600 hover:bg-white/50'}`}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex flex-1 flex-col">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">{TABS.find((t) => t.id === tab)?.label ?? '设置'}</div>
        <div className="flex-1 overflow-y-auto p-6">
        <ConnectionBanner />
        {tab === 'account' && <AccountPanel />}
        {tab === 'browser' && <BrowserPanel />}
        {tab === 'server' && <ServerPanel />}
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
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [changing, setChanging] = useState(false);

  const changePassword = async () => {
    if (newPw !== confirmPw) { setMsg({ ok: false, text: '两次密码不一致' }); return; }
    if (newPw.length < 6) { setMsg({ ok: false, text: '密码至少 6 位' }); return; }
    setChanging(true);
    setMsg(null);
    const res = await authEvents().changePassword({ currentPassword: currentPw, newPassword: newPw });
    setChanging(false);
    if (res.ok) {
      setMsg({ ok: true, text: '密码修改成功' });
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } else {
      setMsg({ ok: false, text: res.error ?? '修改失败' });
    }
  };

  const logout = () => {
    localStorage.removeItem('agentbean.token');
    useAgentBeanStore.getState().setAuthToken(null);
    useAgentBeanStore.getState().setCurrentUser(null);
    getWebSocket().disconnect();
    router.push('/');
  };

  return (
    <div className="mx-auto max-w-xl space-y-8">
      <h2 className="text-xl font-semibold">账号</h2>

      {/* User info card */}
      <section className="rounded-lg border border-neutral-200 p-5">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-purple-100 text-lg font-semibold text-purple-700">
            {(currentUser?.username ?? '?')[0].toUpperCase()}
          </div>
          <div>
            <div className="text-lg font-semibold">{currentUser?.username ?? '—'}</div>
            <div className="text-sm text-neutral-500">{currentUser?.email ?? '未设置邮箱'}</div>
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
      <section className="rounded-lg border border-neutral-200 p-5">
        <h3 className="mb-4 text-sm font-semibold text-neutral-700">修改密码</h3>
        <div className="space-y-3">
          <input type="password" placeholder="当前密码" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
          <input type="password" placeholder="新密码" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
          <input type="password" placeholder="确认新密码" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
          {msg && <div className={`text-sm ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.text}</div>}
          <button onClick={changePassword} disabled={changing || !currentPw || !newPw} className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50">
            {changing ? '修改中...' : '修改密码'}
          </button>
        </div>
      </section>

      <section>
        <button onClick={logout} className="inline-flex items-center gap-2 rounded-md border border-red-200 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
          <LogOut size={16} /> 退出登录
        </button>
      </section>
    </div>
  );
}

function BrowserPanel() {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h2 className="text-xl font-semibold">浏览器</h2>
      <section className="rounded-lg border border-neutral-200 p-5">
        <h3 className="mb-3 text-sm font-semibold text-neutral-700">浏览器设置</h3>
        <div className="text-sm text-neutral-500">浏览器相关配置开发中...</div>
      </section>
    </div>
  );
}

function ServerPanel() {
  const currentNetworkId = useAgentBeanStore((s) => s.currentNetworkId);
  const networks = useAgentBeanStore((s) => s.networks);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const setCurrentNetworkId = useAgentBeanStore((s) => s.setCurrentNetworkId);
  const router = useRouter();

  const [networkName, setNetworkName] = useState('');
  const [nameSaved, setNameSaved] = useState(true);
  const [onboardAgent, setOnboardAgent] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState('');

  // Join links state
  const [joinLinks, setJoinLinks] = useState<JoinLinkInfo[]>([]);
  const [maxUses, setMaxUses] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState('');

  const currentNetwork = networks.find((n) => n.id === currentNetworkId);

  const displayedName = currentNetwork?.name ?? '当前团队';
  if (!networkName && displayedName) {
    setNetworkName(displayedName);
  }

  const agentList = Object.values(agents);

  const loadLinks = useCallback(async () => {
    const res = await joinEvents().list();
    if (res.ok && res.links) setJoinLinks(res.links);
  }, []);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const createJoinLink = async () => {
    setJoinError('');
    const payload: { maxUses?: number; expiresAt?: number } = {};
    if (maxUses) payload.maxUses = parseInt(maxUses, 10);
    if (expiresAt) payload.expiresAt = new Date(expiresAt).getTime();

    const res = await joinEvents().create(payload);
    if (res.ok && res.link) {
      setJoinLinks((prev) => [res.link!, ...prev]);
      setMaxUses('');
      setExpiresAt('');
    } else {
      setJoinError(res.error ?? '创建失败');
    }
  };

  const revokeLink = async (code: string) => {
    const res = await joinEvents().revoke({ code });
    if (res.ok) {
      setJoinLinks((prev) => prev.filter((l) => l.code !== code));
    }
  };

  const copyLink = (url: string, id: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const [nameSaving, setNameSaving] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleNameChange = (v: string) => {
    setNetworkName(v);
    setNameSaved(v === displayedName);
    setNameMsg(null);
  };

  const handleSaveName = async () => {
    if (nameSaved || !networkName.trim()) return;
    setNameSaving(true);
    setNameMsg(null);
    const res = await networkEvents().update({ name: networkName.trim() });
    setNameSaving(false);
    if (res.ok) {
      setNameSaved(true);
      setNameMsg({ ok: true, text: '保存成功' });
    } else {
      setNameMsg({ ok: false, text: res.error ?? '保存失败' });
    }
  };

  const handleDeleteNetwork = async () => {
    if (!currentNetwork || deleteSaving) return;
    setDeleteSaving(true);
    setDeleteMsg('');
    const res = await networkEvents().delete(currentNetwork.id);
    setDeleteSaving(false);
    if (!res.ok) {
      setDeleteMsg(res.error ?? '删除失败');
      return;
    }
    setShowDeleteConfirm(false);
    const fallback = res.fallbackNetwork ?? networks.find((network) => network.id !== currentNetwork.id) ?? null;
    if (fallback) {
      setCurrentNetworkId(fallback.id);
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
            <input value={networkName} onChange={(e) => handleNameChange(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
          </div>
          <button onClick={handleSaveName} disabled={nameSaved || nameSaving} className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-40">
            {nameSaving ? '保存中...' : '保存资料'}
          </button>
          {nameMsg && <div className={`text-sm ${nameMsg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{nameMsg.text}</div>}
        </div>
      </section>

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
            <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="不限" className="w-28 rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">过期时间</label>
            <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
          </div>
          <button onClick={createJoinLink} className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">
            创建加入链接
          </button>
        </div>

        {joinError && <p className="mb-3 text-sm text-red-600">{joinError}</p>}

        <div className="space-y-3">
          {joinLinks.map((link) => (
            <div key={link.id} className="rounded-md border border-neutral-100 bg-neutral-50 p-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs text-neutral-700">{link.url}</code>
                <button onClick={() => copyLink(link.url, link.id)} className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs hover:bg-neutral-100 flex items-center gap-1">
                  <Copy size={10} /> {copiedId === link.id ? '已复制' : '复制'}
                </button>
                <button onClick={() => revokeLink(link.code)} className="shrink-0 rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-50 flex items-center gap-1">
                  <Trash2 size={10} /> 撤销
                </button>
              </div>
              <div className="mt-1.5 text-xs text-neutral-400">
                {link.usesCount} 次使用 · {formatExpiry(link.expiresAt)}
              </div>
            </div>
          ))}
          {joinLinks.length === 0 && <div className="text-sm text-neutral-400">暂无加入链接。</div>}
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
          <button onClick={() => setShowDeleteConfirm(true)} disabled={currentNetwork?.id === 'default'} className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50">
            删除团队
          </button>
        </div>
        {currentNetwork?.id === 'default' && <p className="mt-3 text-xs text-neutral-400">默认团队不能删除。</p>}
        {deleteMsg && <p className="mt-3 text-sm text-red-600">{deleteMsg}</p>}
        {showDeleteConfirm && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4">
            <p className="mb-3 text-sm text-red-700">确定要删除团队 <strong>{currentNetwork?.name ?? '当前团队'}</strong> 吗？此操作不可撤销。</p>
            <div className="flex gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50">取消</button>
              <button onClick={handleDeleteNetwork} disabled={deleteSaving} className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50">
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
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h2 className="text-xl font-semibold">更新日志</h2>
      <section className="rounded-lg border border-neutral-200 p-5">
        <div className="space-y-4">
          <ReleaseEntry version="v0.1.0" date="2026-05-05" notes={['初始版本，支持 Agent 管理、设备管理、聊天和任务看板。']} />
        </div>
      </section>
    </div>
  );
}

function ReleaseEntry({ version, date, notes }: { version: string; date: string; notes: string[] }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{version}</span>
        <span className="text-xs text-neutral-400">{date}</span>
      </div>
      <ul className="mt-1.5 space-y-1 pl-4">
        {notes.map((n, i) => (
          <li key={i} className="text-sm text-neutral-600 list-disc">{n}</li>
        ))}
      </ul>
    </div>
  );
}
