'use client';

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { agentEvents, deviceEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { DiscoveredAgent } from '@/lib/schema';

interface Props {
  open: boolean;
  onClose: () => void;
  discoveredAgent: DiscoveredAgent | null;
  mode?: 'create' | 'update';
}

export function RegisterAgentModal({ open, onClose, discoveredAgent, mode = 'create' }: Props) {
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [teamId, setTeamId] = useState(currentTeamId ?? 'default');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (discoveredAgent) {
      setName(discoveredAgent.name);
      setRole('');
      setTeamId(currentTeamId ?? 'default');
      setVisibility('private');
      setError('');
    }
  }, [discoveredAgent, currentTeamId]);

  if (!open || !discoveredAgent) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (mode === 'create' && !trimmed) {
      setError('名称不能为空');
      return;
    }
    setSubmitting(true);
    setError('');

    const agentId = discoveredAgent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    if (mode === 'update') {
      agentEvents().setVisibility(agentId, teamId, visibility === 'public').then((res) => {
          setSubmitting(false);
          if (res.ok) {
            onClose();
            alert('配置更新成功');
          } else {
            setError(res.error ?? '更新失败');
          }
        }).catch((error: unknown) => {
          setSubmitting(false);
          setError(error instanceof Error ? error.message : '更新失败');
        });
      return;
    }

    const devicesResult = await deviceEvents().list(teamId);
    const device = devicesResult.ok
      ? (devicesResult.devices ?? []).find((candidate) => candidate.status === 'online') ?? devicesResult.devices?.[0]
      : undefined;
    if (!device) {
      setSubmitting(false);
      setError(devicesResult.error ?? '未找到可注册的设备');
      return;
    }
    agentEvents().create({
      teamId,
      name: trimmed,
      adapterKind: discoveredAgent.adapterKind,
      category: discoveredAgent.category,
      command: discoveredAgent.command,
      args: discoveredAgent.args,
      cwd: discoveredAgent.cwd,
      deviceId: device.id,
    }).then((res) => {
        setSubmitting(false);
        if (res.ok) {
          setName('');
          setRole('');
          setTeamId(currentTeamId ?? 'default');
          setVisibility('private');
          onClose();
          alert('Agent 注册成功');
        } else {
          setError(res.error ?? '注册失败');
        }
    }).catch((error: unknown) => {
      setSubmitting(false);
      setError(error instanceof Error ? error.message : '注册失败');
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{mode === 'update' ? '编辑 Agent 配置' : '注册 Agent'}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
            <X size={18} />
          </button>
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
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
                placeholder="例如：Codex-肖"
                required
              />
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">角色</label>
            <input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
              placeholder="例如：全栈开发助手"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Adapter</label>
            <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
              {discoveredAgent.adapterKind}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Category</label>
            <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
              {discoveredAgent.category}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">团队</label>
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
            >
              <option value="default">默认团队</option>
              <option value="public">公开团队</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">可见性</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === 'public'}
                  onChange={() => setVisibility('public')}
                />
                公开
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === 'private'}
                  onChange={() => setVisibility('private')}
                />
                私有
              </label>
            </div>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {submitting ? '注册中...' : '注册'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
