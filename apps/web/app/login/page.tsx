'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import { createInviteSocket, authEvents, resetWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import { readStoredTeamPath } from '@/lib/team-path';

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

      const user = res.user;
      if (res.ok && res.token && user) {
        localStorage.setItem('agentbean.token', res.token);
        useAgentBeanStore.getState().setAuthToken(res.token);
        if (res.currentTeam?.id) {
          useAgentBeanStore.getState().setCurrentTeamId(res.currentTeam.id);
        }
        useAgentBeanStore.getState().setCurrentUser({
          id: user.id,
          username: user.username,
          email: user.email ?? null,
          role: user.role ?? 'user',
        });
        resetWebSocket();
        const savedTeamPath = readStoredTeamPath();
        const teamPath = res.currentTeam?.path || savedTeamPath || user.primaryTeamId || 'default';
        router.replace(`/${teamPath}/chat`);
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
    <div className="flex min-h-screen bg-white">
      {/* 左侧 — 表单 */}
      <div className="flex flex-1 flex-col justify-center px-8 sm:px-16 lg:px-24">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white">
              <Bot size={18} />
            </div>
            <span className="text-lg font-semibold tracking-tight text-neutral-900">AgentBean</span>
          </div>

          <h1 className="text-2xl font-bold text-neutral-900">登录</h1>
          <p className="mt-2 text-sm text-neutral-500">
            欢迎回来，输入凭据继续。
          </p>

          <form onSubmit={handleLogin} className="mt-8 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-600">用户名</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-neutral-400 placeholder:text-neutral-400"
                placeholder="输入用户名"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-neutral-600">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-neutral-400 placeholder:text-neutral-400"
                placeholder="输入密码"
              />
            </div>

            {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full rounded-lg bg-neutral-900 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50 transition-colors"
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-neutral-500">
            还没有账号？{' '}
            <Link href="/signup" className="text-neutral-700 hover:text-neutral-900 font-medium">立即注册</Link>
          </p>
        </div>
      </div>

      {/* 右侧 — 装饰 */}
      <div className="hidden flex-1 items-center justify-center bg-gradient-to-br from-purple-50 via-neutral-50 to-amber-50 lg:flex">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-neutral-900">
            <Bot size={40} className="text-white" />
          </div>
          <h2 className="text-xl font-semibold text-neutral-900">欢迎回来</h2>
          <p className="mt-3 text-sm leading-relaxed text-neutral-500">
            你的 Agent 和设备正在私有团队中运行。
            登录继续对话、管理任务、编排工作流。
          </p>
        </div>
      </div>
    </div>
  );
}
