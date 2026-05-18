'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import { createInviteSocket, authEvents, resetWebSocket, joinEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

type Mode = 'login' | 'register';

export default function JoinPage() {
  const params = useParams();
  const router = useRouter();
  const code = params.token as string;

  const [mode, setMode] = useState<Mode>('register');
  const [networkName, setNetworkName] = useState<string | null>(null);
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
        setNetworkName(res.networkName ?? '团队');
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

      const res = await authEvents(socket).register({ username, password, email: email || undefined, inviteToken: code });
      socket.disconnect();

      if (res.ok && res.token) {
        localStorage.setItem('agentbean.token', res.token);
        useAgentBeanStore.getState().setAuthToken(res.token);
        if (res.username) {
          useAgentBeanStore.getState().setCurrentUser({
            id: res.userId ?? '',
            username: res.username,
            email: res.email ?? null,
            role: res.role ?? 'user',
          });
        }
        resetWebSocket();
        const savedNp = localStorage.getItem('agentbean.networkPath');
        const np = savedNp || res.networkPath || 'default';
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

      if (res.ok && res.token) {
        localStorage.setItem('agentbean.token', res.token);
        useAgentBeanStore.getState().setAuthToken(res.token);
        if (res.username) {
          useAgentBeanStore.getState().setCurrentUser({
            id: res.userId ?? '',
            username: res.username,
            email: res.email ?? null,
            role: res.role ?? 'user',
          });
        }
        resetWebSocket();
        const savedNp = localStorage.getItem('agentbean.networkPath');
        const np = savedNp || res.networkPath || 'default';
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
      <div className="flex min-h-screen items-center justify-center bg-neutral-950">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-600 border-t-white" />
          <div className="text-sm text-neutral-400">正在验证邀请链接...</div>
        </div>
      </div>
    );
  }

  // Error state
  if (validateError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950">
        <div className="mx-auto max-w-sm text-center">
          <div className="mb-4 flex h-12 w-12 mx-auto items-center justify-center rounded-xl bg-red-500/10">
            <Bot size={24} className="text-red-400" />
          </div>
          <h1 className="text-xl font-semibold text-white">无法加入</h1>
          <p className="mt-2 text-sm text-neutral-400">{validateError}</p>
          <button onClick={() => router.replace('/')} className="mt-6 rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100">
            返回首页
          </button>
        </div>
      </div>
    );
  }

  // Main join page
  return (
    <div className="flex min-h-screen bg-neutral-950">
      {/* Left — Form */}
      <div className="flex flex-1 flex-col justify-center px-8 sm:px-16 lg:px-24">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-neutral-900">
              <Bot size={18} />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">AgentBean</span>
          </div>

          <h1 className="text-2xl font-bold text-white">加入团队</h1>
          <p className="mt-2 text-sm text-neutral-400">
            你已被邀请加入 <span className="text-white font-medium">{networkName}</span>。登录或注册账号即可加入。
          </p>

          {/* Mode switcher */}
          <div className="mt-6 flex rounded-lg border border-neutral-700 p-1">
            <button onClick={() => { setMode('register'); setError(''); }} className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'register' ? 'bg-white text-neutral-900' : 'text-neutral-400 hover:text-white'}`}>
              注册
            </button>
            <button onClick={() => { setMode('login'); setError(''); }} className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'login' ? 'bg-white text-neutral-900' : 'text-neutral-400 hover:text-white'}`}>
              登录
            </button>
          </div>

          {mode === 'register' ? (
            <form onSubmit={handleRegister} className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-400">用户名</label>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600" placeholder="选择用户名" autoFocus />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-400">邮箱（可选）</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600" placeholder="you@example.com" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-400">密码</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600" placeholder="至少 6 位" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-400">确认密码</label>
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600" placeholder="再次输入密码" />
              </div>
              {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}
              <button type="submit" disabled={loading || !username || !password} className="w-full rounded-lg bg-white py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 transition-colors">
                {loading ? '创建中...' : '创建账号并加入'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-400">用户名</label>
                <input type="text" value={loginUser} onChange={(e) => setLoginUser(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600" placeholder="输入用户名" autoFocus />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-neutral-400">密码</label>
                <input type="password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600" placeholder="输入密码" />
              </div>
              {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}
              <button type="submit" disabled={loading || !loginUser || !loginPw} className="w-full rounded-lg bg-white py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 transition-colors">
                {loading ? '登录中...' : '登录并加入'}
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Right — Decoration */}
      <div className="hidden flex-1 items-center justify-center bg-gradient-to-br from-purple-900/30 via-neutral-900 to-amber-900/20 lg:flex">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-white/10 backdrop-blur">
            <Bot size={40} className="text-white" />
          </div>
          <h2 className="text-xl font-semibold text-white">加入 {networkName}</h2>
          <p className="mt-3 text-sm leading-relaxed text-neutral-400">
            注册或登录后，你将自动加入此团队，开始与 Agent 协作。
          </p>
        </div>
      </div>
    </div>
  );
}
