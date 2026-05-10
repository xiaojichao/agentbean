'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import { createInviteSocket, authEvents, resetWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export default function SignupPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignup = async (e: React.FormEvent) => {
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

      const res = await authEvents(socket).register({ username, password, email: email || undefined });
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

  return (
    <div className="flex min-h-screen bg-neutral-950">
      {/* 左侧 — 表单 */}
      <div className="flex flex-1 flex-col justify-center px-8 sm:px-16 lg:px-24">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-neutral-900">
              <Bot size={18} />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">AgentBean</span>
          </div>

          <h1 className="text-2xl font-bold text-white">创建账号</h1>
          <p className="mt-2 text-sm text-neutral-400">
            免费注册，即刻开始使用 AgentBean。
          </p>

          <form onSubmit={handleSignup} className="mt-8 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-400">用户名</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600"
                placeholder="选择用户名"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-400">邮箱（可选）</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-400">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600"
                placeholder="至少 6 位"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-400">确认密码</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600"
                placeholder="再次输入密码"
              />
            </div>

            {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full rounded-lg bg-white py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 transition-colors"
            >
              {loading ? '创建中...' : '创建账号'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-neutral-500">
            已有账号？{' '}
            <Link href="/login" className="text-neutral-300 hover:text-white">去登录</Link>
          </p>
        </div>
      </div>

      {/* 右侧 — 装饰 */}
      <div className="hidden flex-1 items-center justify-center bg-gradient-to-br from-purple-900/30 via-neutral-900 to-amber-900/20 lg:flex">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-white/10 backdrop-blur">
            <Bot size={40} className="text-white" />
          </div>
          <h2 className="text-xl font-semibold text-white">你的私有 AI 网络</h2>
          <p className="mt-3 text-sm leading-relaxed text-neutral-400">
            注册即可获得独立隔离网络。连接设备、部署 Agent、开始协作。
          </p>
        </div>
      </div>
    </div>
  );
}
