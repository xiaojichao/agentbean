'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormalMemoryKind } from '@agentbean/contracts';
import {
  DEFAULT_USER_MEMORY_KIND,
  SYSTEM_USER_KIND_OPTIONS,
  assessUserMemoryContentFit,
  isInactiveForRetrieval,
  systemUserStatusLabel,
  validateSystemUserMemoryForm,
} from '@/lib/system-user-memory-form';

interface SystemUserMemoryItem {
  readonly id: string;
  readonly kind: FormalMemoryKind;
  readonly status: string;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason?: string;
  readonly scope: 'system' | 'user';
}

interface PanelEvents {
  list(): Promise<{ ok: boolean; list?: { items: readonly SystemUserMemoryItem[] }; message?: string; error?: string }>;
  detail(memoryId: string): Promise<{ ok: boolean; memory?: { versions: readonly { versionId: string; content: string; status: string; changeReason?: string; createdAt: number }[] } }>;
  create(payload: { kind: FormalMemoryKind; content: string; summary?: string; changeReason?: string }): Promise<{ ok: boolean; memory?: SystemUserMemoryItem; message?: string; error?: string }>;
  revise(payload: { memoryId: string; content: string; summary?: string; changeReason: string }): Promise<{ ok: boolean; memory?: SystemUserMemoryItem; message?: string; error?: string }>;
  deactivate(payload: { memoryId: string; changeReason: string }): Promise<{ ok: boolean; memory?: SystemUserMemoryItem; message?: string; error?: string }>;
  delete(memoryId: string, changeReason?: string): Promise<{ ok: boolean; message?: string; error?: string }>;
}

interface Props {
  readonly scope: 'system' | 'user';
  readonly events: PanelEvents;
  readonly title: string;
  readonly description: string;
  readonly dataSmoke: string;
  /** user scope 启用 AC#4 内容引导。 */
  readonly enableContentGuidance?: boolean;
}

export function SystemUserMemoryPanel({ scope, events, title, description, dataSmoke, enableContentGuidance }: Props) {
  const [items, setItems] = useState<SystemUserMemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<FormalMemoryKind>(scope === 'user' ? DEFAULT_USER_MEMORY_KIND : 'fact');
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'revise' | 'deactivate' | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editReason, setEditReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const result = await events.list();
    setLoading(false);
    if (result.ok && result.list) {
      setItems([...result.list.items]);
    } else {
      setError(result.message ?? result.error ?? '加载失败');
    }
  }, [events]);

  useEffect(() => {
    void load();
  }, [load]);

  // AC#4：user scope 实时评估内容是否像业务事实，给出引导（不阻塞）。
  const assessment = enableContentGuidance ? assessUserMemoryContentFit(content) : undefined;

  const submit = async () => {
    const validationError = validateSystemUserMemoryForm({ kind, content });
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    const result = await events.create({
      kind,
      content,
      summary: summary || undefined,
      changeReason: changeReason || undefined,
    });
    if (!result.ok || !result.memory) {
      setError(result.message ?? result.error ?? '创建失败');
      return;
    }
    setContent('');
    setSummary('');
    setChangeReason('');
    await load();
  };

  const startRevise = (item: SystemUserMemoryItem) => {
    setError(null);
    setEditingId(item.id);
    setEditMode('revise');
    setEditContent(item.content);
    setEditReason('');
  };

  const startDeactivate = (item: SystemUserMemoryItem) => {
    setError(null);
    setEditingId(item.id);
    setEditMode('deactivate');
    setEditReason('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditMode(null);
    setEditContent('');
    setEditReason('');
  };

  const submitEdit = async () => {
    if (!editingId || !editMode) return;
    if (!editReason.trim()) {
      setError('请填写变更原因');
      return;
    }
    if (editMode === 'revise' && !editContent.trim()) {
      setError('请填写正文');
      return;
    }
    setError(null);
    const result = editMode === 'revise'
      ? await events.revise({ memoryId: editingId, content: editContent, changeReason: editReason })
      : await events.deactivate({ memoryId: editingId, changeReason: editReason });
    if (!result.ok) {
      setError(result.message ?? result.error ?? `${editMode === 'revise' ? '修订' : '停用'}失败`);
      return;
    }
    cancelEdit();
    await load();
  };

  const remove = async (item: SystemUserMemoryItem) => {
    if (!window.confirm('确认删除？删除后不可恢复。')) return;
    const result = await events.delete(item.id);
    if (!result.ok) {
      setError(result.message ?? result.error ?? '删除失败');
      return;
    }
    await load();
  };

  return (
    <section
      className="rounded-lg border border-neutral-200 p-5"
      data-smoke={dataSmoke}
      data-scope={scope}
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-neutral-700">{title}</h3>
        <p className="mt-1 text-xs text-neutral-500">{description}</p>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-neutral-500">
          类型
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as FormalMemoryKind)}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            data-smoke={`${dataSmoke}-kind`}
          >
            {SYSTEM_USER_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-neutral-500 sm:col-span-2">
          正文
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            data-smoke={`${dataSmoke}-content`}
          />
        </label>
        <label className="block text-xs text-neutral-500 sm:col-span-2">
          摘要（可选）
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            data-smoke={`${dataSmoke}-summary`}
          />
        </label>
        <label className="block text-xs text-neutral-500 sm:col-span-2">
          变更原因（可选）
          <input
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            data-smoke={`${dataSmoke}-reason`}
          />
        </label>
      </div>

      {assessment?.hint && (
        <p className="mb-3 text-xs text-neutral-500" data-smoke={`${dataSmoke}-guidance`}>
          {assessment.hint}
        </p>
      )}
      {error && (
        <p className="mb-3 text-sm text-red-600" data-smoke={`${dataSmoke}-error`}>{error}</p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={loading}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
        data-smoke={`${dataSmoke}-create`}
      >
        创建
      </button>

      <div className="mt-4 space-y-2" data-smoke={`${dataSmoke}-list`}>
        {items.length === 0 && !loading ? (
          <p className="text-sm text-neutral-500">暂无记录。</p>
        ) : items.map((item) => (
          <div
            key={item.id}
            className={`rounded-md border px-3 py-2 ${isInactiveForRetrieval(item.status) ? 'border-neutral-100 opacity-60' : 'border-neutral-200'}`}
            data-smoke={`${dataSmoke}-row`}
          >
            <div className="flex items-start justify-between">
              <div className="pr-3">
                <div className="text-sm font-medium">{item.content}</div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {SYSTEM_USER_KIND_OPTIONS.find((o) => o.value === item.kind)?.label ?? item.kind}
                  {' · '}
                  {systemUserStatusLabel(item.status, item.changeReason)}
                  {item.summary ? ` · ${item.summary}` : ''}
                </div>
              </div>
              {editingId !== item.id && (
                <div className="flex flex-shrink-0 gap-2">
                  <button type="button" onClick={() => startRevise(item)} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50">修订</button>
                  <button type="button" onClick={() => startDeactivate(item)} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50">停用</button>
                  <button type="button" onClick={() => void remove(item)} className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50">删除</button>
                </div>
              )}
            </div>
            {editingId === item.id && (
              <div className="mt-3 space-y-2 border-t border-neutral-100 pt-3" data-smoke={`${dataSmoke}-edit`}>
                {editMode === 'revise' && (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    data-smoke={`${dataSmoke}-edit-content`}
                  />
                )}
                <input
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder={`${editMode === 'revise' ? '修订' : '停用'}原因（必填）`}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                  data-smoke={`${dataSmoke}-edit-reason`}
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void submitEdit()} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-800" data-smoke={`${dataSmoke}-edit-submit`}>
                    确认{editMode === 'revise' ? '修订' : '停用'}
                  </button>
                  <button type="button" onClick={cancelEdit} className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50">取消</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
