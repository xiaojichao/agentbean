'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import { createInviteSocket, authEvents, resetWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    setError('');

    try {
      const socket = createInviteSocket();
      await new Promise<void>((resolve) => {
        if (socket.connected) { resolve(); return; }
        socket.on('connect', () => resolve());
      });

      const res = await authEvents(socket).login({ username, password });
      socket.disconnect();

      if (res.ok && res.token) {
        localStorage.setItem('agentbean.token', res.token);
        useAgentBeanStore.getState().setAuthToken(res.token);
        useAgentBeanStore.getState().setCurrentNetworkId(res.networkId ?? 'default');
        if (res.username) {
          useAgentBeanStore.getState().setCurrentUser({
            id: res.userId ?? '',
            username: res.username,
            email: res.email ?? null,
            role: res.role ?? 'user',
          });
        }
        resetWebSocket();
        const np = res.networkPath ?? 'default';
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

          <h1 className="text-2xl font-bold text-white">登录</h1>
          <p className="mt-2 text-sm text-neutral-400">
            欢迎回来，输入凭据继续。
          </p>

          <form onSubmit={handleLogin} className="mt-8 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-400">用户名</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600"
                placeholder="输入用户名"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-400">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600"
                placeholder="输入密码"
              />
            </div>

            {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full rounded-lg bg-white py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 transition-colors"
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-neutral-500">
            还没有账号？{' '}
            <Link href="/signup" className="text-neutral-300 hover:text-white">立即注册</Link>
          </p>
        </div>
      </div>

      {/* 右侧 — 装饰 */}
      <div className="hidden flex-1 items-center justify-center bg-gradient-to-br from-purple-900/30 via-neutral-900 to-amber-900/20 lg:flex">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-white/10 backdrop-blur">
            <Bot size={40} className="text-white" />
          </div>
          <h2 className="text-xl font-semibold text-white">管理你的 AI Agent</h2>
          <p className="mt-3 text-sm leading-relaxed text-neutral-400">
            与 Agent 对话、管理任务、编排工作流——一个平台搞定。
          </p>
        </div>
      </div>
    </div>
  );
}
