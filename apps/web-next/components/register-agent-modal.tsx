'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { agentEvents } from '@/lib/socket';
import type { DiscoveredAgent } from '@/lib/schema';

interface Props {
  open: boolean;
  teamId: string;
  scanDeviceId: string;
  onClose: () => void;
  discoveredAgent: DiscoveredAgent | null;
  mode?: 'create' | 'update';
  registeredAgentId?: string;
  initiallyVisible?: boolean;
}

export function RegisterAgentModal({
  open,
  teamId,
  scanDeviceId,
  onClose,
  discoveredAgent,
  mode = 'create',
  registeredAgentId,
  initiallyVisible = false,
}: Props) {
  const [name, setName] = useState('');
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!discoveredAgent) return;
    setName(discoveredAgent.name);
    setVisible(initiallyVisible);
    setError('');
  }, [discoveredAgent, initiallyVisible]);

  if (!open || !discoveredAgent) return null;

  if (discoveredAgent.category === 'agentos-hosted') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">AgentOS Agent</h2>
            <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700"><X size={18} /></button>
          </div>
          <p className="text-sm text-neutral-600">AgentOS Agent 已由设备自动注册，无需再创建自定义 Agent。</p>
          <div className="mt-5 flex justify-end">
            <button type="button" onClick={onClose} className="rounded border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">关闭</button>
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (discoveredAgent.category !== 'executor-hosted') {
      setError('该 Agent 由设备自动注册，不能创建为自定义 Agent');
      return;
    }

    const trimmedName = name.trim();
    if (mode === 'create' && !trimmedName) {
      setError('名称不能为空');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      if (mode === 'update') {
        if (!registeredAgentId) {
          setError('未找到已注册 Agent');
          return;
        }
        const res = await agentEvents().setVisibility(registeredAgentId, teamId, visible);
        if (!res.ok) setError(res.error ?? '更新失败');
        else onClose();
        return;
      }

      const command = discoveredAgent.command.trim();
      const res = await agentEvents().create({
        teamId,
        deviceId: scanDeviceId,
        name: trimmedName,
        adapterKind: discoveredAgent.adapterKind,
        ...(command ? { command } : {}),
        ...(discoveredAgent.args?.length ? { args: discoveredAgent.args } : {}),
        ...(discoveredAgent.cwd?.trim() ? { cwd: discoveredAgent.cwd.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error ?? '注册失败');
        return;
      }
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : mode === 'update' ? '更新失败' : '注册失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{mode === 'update' ? '编辑 Agent 可见性' : '注册 Agent'}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">名称</label>
            {mode === 'update' ? (
              <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">{name}</div>
            ) : (
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
                placeholder="例如：Codex-肖"
                required
              />
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Adapter</label>
            <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">{discoveredAgent.adapterKind}</div>
          </div>

          {mode === 'update' && (
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
              在当前团队中可见
            </label>
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">取消</button>
            <button type="submit" disabled={submitting} className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50">
              {submitting ? '处理中...' : mode === 'update' ? '保存' : '注册'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
