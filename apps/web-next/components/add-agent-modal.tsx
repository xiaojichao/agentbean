'use client';

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { agentEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { AdapterKind, AgentCategory } from '@/lib/schema';

interface Props {
  open: boolean;
  onClose: () => void;
}

const RUNTIME_ADAPTERS: Record<AgentCategory, { value: AdapterKind; label: string }[]> = {
  'executor-hosted': [
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'codex', label: 'Kimi' },
  ],
  'agentos-hosted': [
    { value: 'openclaw', label: 'OpenClaw' },
    { value: 'hermes', label: 'Hermes' },
  ],
};

const CATEGORY_ADAPTER_DEFAULT: Partial<Record<AgentCategory, AdapterKind>> = {
  'executor-hosted': 'claude-code',
  'agentos-hosted': 'openclaw',
};

const CATEGORY_OPTIONS: { value: AgentCategory; label: string }[] = [
  { value: 'executor-hosted', label: '自定义 Agent' },
  { value: 'agentos-hosted', label: 'AgentOS 托管型 Agent' },
];

export function AddAgentModal({ open, onClose }: Props) {
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [adapterKind, setAdapterKind] = useState<AdapterKind | ''>('claude-code');
  const [category, setCategory] = useState<AgentCategory>('executor-hosted');
  const [teamId, setTeamId] = useState(currentTeamId ?? 'default');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [command, setCommand] = useState('');
  const [argsStr, setArgsStr] = useState('');
  const [cwd, setCwd] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setError('');
      setCommand('');
      setArgsStr('');
      setCwd('');
      setOwnerId('');
      setTeamId(currentTeamId ?? 'default');
    }
  }, [open, currentTeamId]);

  if (!open) return null;

  const handleCategoryChange = (cat: AgentCategory) => {
    setCategory(cat);
    setAdapterKind(CATEGORY_ADAPTER_DEFAULT[cat] ?? '');
  };

  const currentAdapters = RUNTIME_ADAPTERS[category];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('名称不能为空');
      return;
    }
    setSubmitting(true);
    setError('');

    const parsedArgs = argsStr.trim().split(/\s+/).filter(Boolean);
    const effectiveAdapter = adapterKind || 'claude-code';
    agentEvents().create({
      teamId,
      name: trimmed,
      adapterKind: effectiveAdapter,
      category,
      command: command.trim() || 'codex',
      args: parsedArgs.length > 0 ? parsedArgs : undefined,
      cwd: cwd.trim() || undefined,
    }).then((res) => {
        setSubmitting(false);
        if (res.ok) {
          setName('');
          setRole('');
          setAdapterKind('claude-code');
          setCategory('executor-hosted');
          setTeamId(currentTeamId ?? 'default');
          setVisibility('private');
          setCommand('');
          setArgsStr('');
          setCwd('');
          setOwnerId('');
          onClose();
        } else {
          setError(res.error ?? '创建失败');
        }
    }).catch((error: unknown) => {
      setSubmitting(false);
      setError(error instanceof Error ? error.message : '创建失败');
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg max-h-[90vh] overflow-y-auto">
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
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
              placeholder="例如：Codex-肖"
              required
            />
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
            <label className="mb-1 block text-sm font-medium">创建者</label>
            <input
              type="text"
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
              placeholder="例如：shaw"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Category</label>
            <select
              value={category}
              onChange={(e) => handleCategoryChange(e.target.value as AgentCategory)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
            >
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {currentAdapters.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium">Runtime（执行器）</label>
              <select
                value={adapterKind}
                onChange={(e) => setAdapterKind(e.target.value as AdapterKind)}
                className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
              >
                {currentAdapters.map((o, i) => (
                  <option key={`${o.value}-${i}`} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium">Command</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-500 focus:outline-none"
              placeholder="例如：/usr/local/bin/my-agent"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Args</label>
            <input
              type="text"
              value={argsStr}
              onChange={(e) => setArgsStr(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-500 focus:outline-none"
              placeholder="空格分隔，例如：--verbose --port 8080"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Working Dir</label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-500 focus:outline-none"
              placeholder="例如：/home/user/projects"
            />
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
              {submitting ? '创建中...' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
