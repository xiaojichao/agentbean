'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createInviteSocket, authEvents, resetWebSocket, setStoredDeviceId, resolveDeviceLoginDeviceId } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import { readStoredTeamPath } from '@/lib/team-path';

export default function DeviceLoginPage() {
  const params = useParams();
  const router = useRouter();
  const inviteCode = params.code as string;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [hasStoredToken, setHasStoredToken] = useState(false);

  useEffect(() => {
    setHasStoredToken(Boolean(localStorage.getItem('agentbean.token')));
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const existingToken = localStorage.getItem('agentbean.token');
      if (existingToken && !username.trim() && !password) {
        // 已登录：直接用现有 token 完成 invite（不需再输密码），关联本机设备。
        // 否则 web 不知道哪个是本机设备 → device.isLocal 恒 false → runtime/项目目录只读。
        const complete = await authEvents().completeDeviceInvite({ code: inviteCode });
        if (!complete.ok) {
          setHasStoredToken(false);
          setError(`${complete.error ?? 'COMPLETE_FAILED'}，请使用用户名和密码重试。`);
          return;
        }
        const deviceId = resolveDeviceLoginDeviceId(complete);
        if (deviceId) setStoredDeviceId(deviceId);
        resetWebSocket();
        const np = complete.team?.path ?? complete.team?.id ?? readStoredTeamPath(localStorage) ?? 'default';
        router.push(`/${np}/devices`);
        return;
      }
      if (!username.trim() || !password) {
        setError('请输入用户名和密码');
        return;
      }
      const socket = createInviteSocket();
      try {
        await new Promise<void>((resolve, reject) => {
          socket.on('connect', () => resolve());
          socket.on('connect_error', (err) => reject(err));
        });
        const res = await authEvents(socket).deviceLogin({ inviteCode, username, password });
        if (!res.ok || !res.token) {
          setError(res.error ?? 'LOGIN_FAILED');
          return;
        }
        localStorage.setItem('agentbean.token', res.token);
        if (res.deviceId) setStoredDeviceId(res.deviceId);
        useAgentBeanStore.getState().setAuthToken(res.token);
        useAgentBeanStore.getState().setCurrentTeamId(res.teamId ?? 'default');
        useAgentBeanStore.getState().setCurrentUser({
          id: res.userId!,
          username: res.username ?? username,
          email: null,
          role: res.role ?? 'user',
        });
        resetWebSocket();
        const savedNp = readStoredTeamPath(localStorage);
        const np = savedNp || res.teamPath || 'default';
        router.push(`/${np}/devices`);
      } finally {
        socket.close();
      }
    } catch (err: any) {
      setError(err?.message ?? 'LOGIN_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="mb-2 text-2xl font-semibold">添加设备到 AgentBean</h1>
      <p className="mb-6 text-sm text-neutral-500">
        {hasStoredToken ? '已检测到当前登录状态，可直接完成本机设备关联。' : '使用已有账号登录，将此设备添加到您的私有团队。'}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm text-neutral-600">用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className="w-full rounded border border-neutral-300 px-3 py-2" required={!hasStoredToken} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-neutral-600">密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded border border-neutral-300 px-3 py-2" required={!hasStoredToken} />
        </label>
        {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <button disabled={submitting} className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {submitting ? '处理中...' : hasStoredToken ? '完成设备关联' : '登录并添加设备'}
        </button>
      </form>
    </main>
  );
}
