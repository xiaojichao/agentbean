'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import { createInviteSocket, authEvents, resetWebSocket, joinEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import { writeStoredTeamPath } from '@/lib/team-path';

type Mode = 'login' | 'register';

export default function JoinPage() {
  const params = useParams();
  const router = useRouter();
  const code = params.token as string;

  const [mode, setMode] = useState<Mode>('register');
  const [teamName, setTeamName] = useState<string | null>(null);
  const [validating, setValidating] = useState(true);
  const [validateError, setValidateError] = useState('');

  // Register fields
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  // Login fields
  const [loginUser, setLoginUser] = useState('');
  const [loginPw, setLoginPw] = useState('');

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Validate the join code on mount
  useEffect(() => {
    if (!code) { setValidateError('无效的邀请链接'); setValidating(false); return; }
    const socket = createInviteSocket();
    socket.on('connect', async () => {
      const res = await joinEvents(socket).validate({ code });
      socket.disconnect();
      setValidating(false);
      if (res.ok) {
        setTeamName(res.teamName ?? '团队');
      } else {
        setValidateError(
          res.error === 'INVALID_CODE' ? '无效的邀请链接' :
          res.error === 'ALREADY_USED' ? '此邀请链接已被使用' :
          res.error === 'EXPIRED' ? '此邀请链接已过期' :
          res.error === 'MAX_USES_REACHED' ? '此邀请链接已达到最大使用次数' :
          '验证失败'
        );
      }
    });
    socket.on('connect_error', () => {
      setValidating(false);
      setValidateError('无法连接服务器');
    });
  }, [code]);

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError('两次密码不一致'); return; }
    if (password.length < 6) { setError('密码至少 6 位'); return; }
    if (!username) { setError('请输入用户名'); return; }
    setLoading(true);
    setError('');

    try {
      const socket = createInviteSocket();
      await new Promise<void>((resolve) => {
        if (socket.connected) { resolve(); return; }
        socket.on('connect', () => resolve());
      });

      const res = await authEvents(socket).register({ username, password, email: email || undefined, joinCode: code });
      socket.disconnect();

      const user = res.user;
      if (res.ok && res.token && user) {
        localStorage.setItem('agentbean.token', res.token);
        useAgentBeanStore.getState().setAuthToken(res.token);
        if (res.currentTeam?.id) useAgentBeanStore.getState().setCurrentTeamId(res.currentTeam.id);
        useAgentBeanStore.getState().setCurrentUser({
          id: user.id,
          username: user.username,
          email: user.email ?? null,
          role: user.role ?? 'user',
        });
        resetWebSocket();
        const np = res.currentTeam?.path || 'default';
        writeStoredTeamPath(localStorage, np);
        router.replace(`/${np}/chat`);
      } else {
        setError(res.error ?? '注册失败');
      }
    } catch {
      setError('连接服务器失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!loginUser || !loginPw) return;
    setLoading(true);
    setError('');

    try {
      const socket = createInviteSocket();
      await new Promise<void>((resolve) => {
        if (socket.connected) { resolve(); return; }
        socket.on('connect', () => resolve());
      });

      const res = await authEvents(socket).login({ username: loginUser, password: loginPw, joinCode: code });
      socket.disconnect();

      const user = res.user;
      if (res.ok && res.token && user) {
        localStorage.setItem('agentbean.token', res.token);
        useAgentBeanStore.getState().setAuthToken(res.token);
        if (res.currentTeam?.id) useAgentBeanStore.getState().setCurrentTeamId(res.currentTeam.id);
        useAgentBeanStore.getState().setCurrentUser({
          id: user.id,
          username: user.username,
          email: user.email ?? null,
          role: user.role ?? 'user',
        });
        resetWebSocket();
        const np = res.currentTeam?.path || 'default';
        writeStoredTeamPath(localStorage, np);
        router.replace(`/${np}/chat`);
      } else {
        setError(res.error ?? '登录失败');
      }
    } catch {
      setError('连接服务器失败');
    } finally {
      setLoading(false);
    }
  };

  // Validating state
  if (validating) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900" />
          <div className="text-sm text-neutral-600">正在验证邀请链接...</div>
        </div>
      </div>
    );
  }

  // Error state
  if (validateError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-6">
        <div className="mx-auto max-w-sm rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
          <div className="mb-4 flex h-12 w-12 mx-auto items-center justify-center rounded-xl bg-red-50">
            <Bot size={24} className="text-red-500" />
          </div>
          <h1 className="text-xl font-semibold text-neutral-950">无法加入</h1>
          <p className="mt-2 text-sm text-neutral-600">{validateError}</p>
          <button onClick={() => router.replace('/')} className="mt-6 rounded-md bg-neutral-950 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800">
            返回首页
          </button>
        </div>
      </div>
    );
  }

  // Main join page
  return (
    <div className="flex min-h-screen bg-neutral-50">
      {/* Left — Form */}
      <div className="flex flex-1 flex-col justify-center px-8 sm:px-16 lg:px-24">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-950 text-white">
              <Bot size={18} />
            </div>
            <span className="text-lg font-semibold tracking-tight text-neutral-950">AgentBean</span>
          </div>

          <h1 className="text-2xl font-bold text-neutral-950">加入团队</h1>
          <p className="mt-2 text-sm text-neutral-600">
            你已被邀请加入 <span className="font-medium text-neutral-950">{teamName}</span>。登录或注册账号即可加入。
          </p>

          {/* Mode switcher */}
          <div className="mt-6 flex rounded-lg border border-neutral-200 bg-white p-1 shadow-sm">
            <button onClick={() => { setMode('register'); setError(''); }} className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'register' ? 'bg-neutral-950 text-white' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950'}`}>
              注册
            </button>
            <button onClick={() => { setMode('login'); setError(''); }} className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'login' ? 'bg-neutral-950 text-white' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950'}`}>
              登录
            </button>
          </div>

          {mode === 'register' ? (
            <form onSubmit={handleRegister} className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-600">用户名</label>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none transition focus:border-neutral-900 placeholder:text-neutral-400" placeholder="选择用户名" autoFocus />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-600">邮箱（可选）</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none transition focus:border-neutral-900 placeholder:text-neutral-400" placeholder="you@example.com" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-600">密码</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none transition focus:border-neutral-900 placeholder:text-neutral-400" placeholder="至少 6 位" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-600">确认密码</label>
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none transition focus:border-neutral-900 placeholder:text-neutral-400" placeholder="再次输入密码" />
              </div>
              {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
              <button type="submit" disabled={loading || !username || !password} className="w-full rounded-lg bg-neutral-950 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50">
                {loading ? '创建中...' : '创建账号并加入'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-600">用户名</label>
                <input type="text" value={loginUser} onChange={(e) => setLoginUser(e.target.value)} className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none transition focus:border-neutral-900 placeholder:text-neutral-400" placeholder="输入用户名" autoFocus />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-600">密码</label>
                <input type="password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)} className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none transition focus:border-neutral-900 placeholder:text-neutral-400" placeholder="输入密码" />
              </div>
              {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
              <button type="submit" disabled={loading || !loginUser || !loginPw} className="w-full rounded-lg bg-neutral-950 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50">
                {loading ? '登录中...' : '登录并加入'}
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Right — Decoration */}
      <div className="hidden flex-1 items-center justify-center border-l border-neutral-200 bg-gradient-to-br from-emerald-50 via-white to-amber-50 lg:flex">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border border-neutral-200 bg-white shadow-sm">
            <Bot size={40} className="text-neutral-950" />
          </div>
          <h2 className="text-xl font-semibold text-neutral-950">加入 {teamName}</h2>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
            注册或登录后，你将自动加入此团队，开始与 Agent 协作。
          </p>
        </div>
      </div>
    </div>
  );
}
