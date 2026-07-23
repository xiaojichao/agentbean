'use client';

import { useEffect, useState } from 'react';
import { agentMemoryProjectionEvents } from '@/lib/socket';
import {
  EMPTY_PROJECTION_DRAFT_FORM,
  PROJECTION_KIND_LABELS,
  draftFormFromProjection,
  normalizeTagInput,
  validateProjectionDraftForm,
  type ProjectionDraftFormState,
} from '@/lib/agent-memory-projection-form';
import type { AgentMemoryProjectionDto, FormalMemoryKind, TeamAgentMemoryOptInDto } from '@agentbean/contracts';

const KIND_OPTIONS: readonly FormalMemoryKind[] = ['fact', 'decision', 'rule', 'preference'];

/**
 * #718 Agent Memory 投影管理面板（AC#6）。
 * 嵌入 Agent 详情页：Agent owner（canManage）可发布/撤回投影；Team owner/admin（canOptIn）
 * 可启用/停用本 Team 对投影的使用（默认 opted-out）。revision fence 失效时显式提示需重新确认。
 */
export function AgentMemoryProjectionPanel({
  teamId,
  agentId,
  canManage,
  canOptIn,
}: {
  teamId: string;
  agentId: string;
  canManage: boolean;
  canOptIn: boolean;
}) {
  const [active, setActive] = useState<AgentMemoryProjectionDto | null>(null);
  const [optIn, setOptIn] = useState<TeamAgentMemoryOptInDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ProjectionDraftFormState>(EMPTY_PROJECTION_DRAFT_FORM);
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = async () => {
    const list = await agentMemoryProjectionEvents().listRevisions(teamId, agentId);
    if (!list.ok) return;
    const revisions = list.revisions ?? [];
    setActive(revisions.find((r) => r.status === 'active') ?? null);
    setOptIn(list.activeOptIn ?? null);
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    agentMemoryProjectionEvents().listRevisions(teamId, agentId).then((list) => {
      if (!live) return;
      if (list.ok) {
        const revisions = list.revisions ?? [];
        const current = revisions.find((r) => r.status === 'active') ?? null;
        setActive(current);
        setOptIn(list.activeOptIn ?? null);
        setDraft(draftFormFromProjection(current));
      }
      setLoading(false);
    });
    return () => { live = false; };
  }, [teamId, agentId]);

  const publish = async () => {
    const error = validateProjectionDraftForm(draft);
    if (error) { setMessage({ ok: false, text: error }); return; }
    setBusy(true);
    setMessage(null);
    const created = await agentMemoryProjectionEvents().createDraft({
      teamId, agentId, kind: draft.kind, content: draft.content.trim(),
      summary: draft.summary.trim() || undefined,
      tags: draft.tags.length ? [...draft.tags] : undefined,
    });
    if (!created.ok || !created.projection) {
      setBusy(false);
      setMessage({ ok: false, text: created.error ?? created.message ?? '创建草稿失败' });
      return;
    }
    const result = await agentMemoryProjectionEvents().publish({ teamId, projectionId: created.projection.id });
    setBusy(false);
    if (result.ok && result.projection) {
      setMessage({ ok: true, text: `已发布 revision ${result.projection.revision}` });
      await reload();
    } else {
      setMessage({ ok: false, text: result.error ?? result.message ?? '发布失败' });
    }
  };

  const withdraw = async () => {
    setBusy(true);
    const result = await agentMemoryProjectionEvents().withdraw({ teamId, agentId });
    setBusy(false);
    if (result.ok && result.withdrawn) {
      setMessage({ ok: true, text: '已撤回当前投影' });
      await reload();
    } else if (result.ok) {
      setMessage({ ok: true, text: '无生效投影可撤回' });
    } else {
      setMessage({ ok: false, text: result.error ?? result.message ?? '撤回失败' });
    }
  };

  const toggleOptIn = async (enabled: boolean) => {
    setBusy(true);
    const result = await agentMemoryProjectionEvents().upsertOptIn({ teamId, agentId, enabled });
    setBusy(false);
    if (result.ok && result.optIn) {
      setOptIn(result.optIn);
      setMessage({ ok: true, text: enabled ? '已启用本 Team 使用该 Agent 投影' : '已停用本 Team 使用该 Agent 投影' });
    } else {
      setMessage({ ok: false, text: result.error ?? result.message ?? '更新失败' });
    }
  };

  const addTag = () => {
    const tag = normalizeTagInput(tagInput);
    setTagInput('');
    if (!tag || draft.tags.includes(tag)) return;
    setDraft({ ...draft, tags: [...draft.tags, tag] });
  };

  const fenceBroken = !!optIn && !!active && optIn.projectionId !== active.id;

  return (
    <section className="rounded-lg border border-neutral-200 p-5" data-smoke="agent-memory-projection-panel">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">Agent Memory 投影</h3>

      {loading ? (
        <p className="text-sm text-neutral-400">读取中…</p>
      ) : active ? (
        <div className="mb-4 space-y-2">
          <div className="text-xs text-neutral-500">
            当前 revision <span className="font-medium text-neutral-800">{active.revision}</span>
            {' · '}
            <span>{PROJECTION_KIND_LABELS[active.kind]}</span>
            {active.validUntil ? ` · 有效至 ${new Date(active.validUntil).toLocaleDateString()}` : ' · 长期有效'}
          </div>
          <div className="whitespace-pre-wrap text-sm text-neutral-800">{active.content}</div>
          {active.summary && <div className="text-xs text-neutral-500">{active.summary}</div>}
          {active.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {active.tags.map((tag) => (
                <span key={tag} className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">{tag}</span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="mb-4 text-sm text-neutral-400">尚未发布 Agent Memory 投影。投影是 Agent owner 主动公开给本 Team 的最小化记忆。</p>
      )}

      {canOptIn && (
        <div className="mb-4 border-t border-neutral-200 pt-3">
          <div className="mb-1 text-xs font-medium text-neutral-600">Team 使用开关</div>
          <div className="flex items-center gap-2 text-xs text-neutral-600">
            <span>当前：{optIn?.enabled ? '已启用' : optIn ? '已停用' : '未启用'}</span>
            {fenceBroken && optIn.enabled && (
              <span className="text-amber-600">（投影已更新，需重新确认）</span>
            )}
            <button
              type="button"
              disabled={busy || !active}
              onClick={() => toggleOptIn(!(optIn?.enabled ?? false))}
              className="rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-50"
            >
              {optIn?.enabled ? '停用' : '启用'}
            </button>
          </div>
          {!active && <p className="text-xs text-neutral-400">Agent owner 发布投影后可启用。</p>}
        </div>
      )}
      {!canOptIn && <p className="mb-4 text-xs text-neutral-400">Team owner/admin 可启用/停用本 Team 对投影的使用。</p>}

      {canManage && (
        <div className="mt-2 border-t border-neutral-200 pt-4">
          <div className="mb-2 text-xs font-medium text-neutral-600">发布新版本</div>
          <div className="mb-2">
            <label className="text-xs text-neutral-500">类型</label>
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as FormalMemoryKind })}
              className="ml-2 rounded border border-neutral-300 px-2 py-1 text-xs"
            >
              {KIND_OPTIONS.map((k) => <option key={k} value={k}>{PROJECTION_KIND_LABELS[k]}</option>)}
            </select>
          </div>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="投影内容（面向本 Team 的公开最小化记忆）"
            className="mb-2 w-full rounded border border-neutral-300 px-2 py-1 text-xs"
            rows={3}
          />
          <input
            value={draft.summary}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            placeholder="摘要（可选）"
            className="mb-2 w-full rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {draft.tags.map((tag) => (
              <span key={tag} className="flex items-center gap-1 rounded bg-neutral-100 px-2 py-0.5 text-xs">
                {tag}
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, tags: draft.tags.filter((t) => t !== tag) })}
                  className="text-neutral-400"
                >✕</button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
              placeholder="标签（回车添加）"
              className="rounded border border-neutral-300 px-2 py-0.5 text-xs"
            />
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={publish}
              disabled={busy}
              className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? '处理中…' : '发布'}
            </button>
            {active && (
              <button
                type="button"
                onClick={withdraw}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-50"
              >
                撤回当前
              </button>
            )}
          </div>
        </div>
      )}
      {!canManage && <p className="text-xs text-neutral-400">仅 Agent 拥有者可发布或撤回投影。</p>}

      {message && (
        <div className={`mt-3 text-sm ${message.ok ? 'text-emerald-600' : 'text-red-600'}`}>{message.text}</div>
      )}
    </section>
  );
}
