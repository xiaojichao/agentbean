'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { agentEvents } from '@/lib/socket';
import type { AdapterKind } from '@/lib/schema';

interface Props {
  open: boolean;
  teamId: string;
  deviceId: string;
  onClose: () => void;
}

const RUNTIME_ADAPTERS: { value: AdapterKind; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'codex', label: 'Kimi' },
];

export function AddAgentModal({ open, teamId, deviceId, onClose }: Props) {
  const [name, setName] = useState('');
  const [adapterKind, setAdapterKind] = useState<AdapterKind>('claude-code');
  const [command, setCommand] = useState('');
  const [argsStr, setArgsStr] = useState('');
  const [cwd, setCwd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setCommand('');
    setArgsStr('');
    setCwd('');
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('名称不能为空');
      return;
    }

    const parsedArgs = argsStr.trim().split(/\s+/).filter(Boolean);
    const trimmedCommand = command.trim();
    setSubmitting(true);
    setError('');
    try {
      const res = await agentEvents().create({
        teamId,
        deviceId,
        name: trimmedName,
        adapterKind,
        ...(trimmedCommand ? { command: trimmedCommand } : {}),
        ...(parsedArgs.length > 0 ? { args: parsedArgs } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error ?? '创建失败');
        return;
      }
      setName('');
      setAdapterKind('claude-code');
      setCommand('');
      setArgsStr('');
      setCwd('');
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">添加 Agent</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">名称 *</label>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
              placeholder="例如：Codex-肖"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Runtime（执行器）</label>
            <select
              value={adapterKind}
              onChange={(event) => setAdapterKind(event.target.value as AdapterKind)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
            >
              {RUNTIME_ADAPTERS.map((option, index) => (
                <option key={`${option.value}-${index}`} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Command（可选）</label>
            <input
              type="text"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm focus:border-neutral-500 focus:outline-none"
              placeholder="留空时由服务端按运行时解析"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Args</label>
            <input
              type="text"
              value={argsStr}
              onChange={(event) => setArgsStr(event.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm focus:border-neutral-500 focus:outline-none"
              placeholder="空格分隔，例如：--verbose --port 8080"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Working Dir</label>
            <input
              type="text"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm focus:border-neutral-500 focus:outline-none"
              placeholder="例如：/home/user/projects"
            />
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">
              取消
            </button>
            <button type="submit" disabled={submitting} className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50">
              {submitting ? '创建中...' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
