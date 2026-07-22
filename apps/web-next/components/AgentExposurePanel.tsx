'use client';

import { useEffect, useState } from 'react';
import { agentExposureEvents } from '@/lib/socket';
import {
  EMPTY_DRAFT_FORM,
  draftFormFromProjection,
  validateDraftForm,
  type ExposureDraftFormState,
} from '@/lib/agent-exposure-form';
import type { AgentExposureRestrictionDto } from '@agentbean/contracts';

interface ActiveProjection {
  readonly revision: number;
  readonly capabilities: readonly { name: string; description: string }[];
  readonly skills: readonly { name: string; description: string }[];
  readonly constraints: readonly { kind: string; description: string }[];
  readonly availability: { status: string; reason?: string };
  readonly validUntil: number | null;
}

/**
 * #710 Agent Exposure 面板（AC#5）。
 * 所有团队成员可读当前 active 投影（公开 capability/skill/约束/状态，无 sourcePath）。
 * Agent owner（canManage）可发布/撤回；Team owner/admin（canRestrict）可收紧已公开 operation。
 */
export function AgentExposurePanel({
  teamId,
  agentId,
  canManage,
  canRestrict,
}: {
  teamId: string;
  agentId: string;
  canManage: boolean;
  canRestrict: boolean;
}) {
  const [active, setActive] = useState<ActiveProjection | null>(null);
  const [restriction, setRestriction] = useState<AgentExposureRestrictionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ExposureDraftFormState>(EMPTY_DRAFT_FORM);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      agentExposureEvents().getActive(teamId, agentId),
      agentExposureEvents().listRevisions(teamId, agentId),
    ]).then(([activeResult, listResult]) => {
      if (!live) return;
      setActive(activeResult.ok && activeResult.projection ? {
        revision: activeResult.projection.revision,
        capabilities: activeResult.projection.capabilities,
        skills: activeResult.projection.skills,
        constraints: activeResult.projection.constraints,
        availability: activeResult.projection.availability,
        validUntil: activeResult.projection.validUntil,
      } : null);
      setRestriction(listResult.ok ? (listResult.activeRestriction ?? null) : null);
      setDraft(draftFormFromProjection(activeResult.ok && activeResult.projection ? {
        capabilities: activeResult.projection.capabilities,
        skills: activeResult.projection.skills,
        availability: activeResult.projection.availability,
        validUntil: activeResult.projection.validUntil,
      } : null));
      setLoading(false);
    });
    return () => { live = false; };
  }, [teamId, agentId]);

  const reload = async () => {
    const [activeResult, listResult] = await Promise.all([
      agentExposureEvents().getActive(teamId, agentId),
      agentExposureEvents().listRevisions(teamId, agentId),
    ]);
    setActive(activeResult.ok && activeResult.projection ? {
      revision: activeResult.projection.revision,
      capabilities: activeResult.projection.capabilities,
      skills: activeResult.projection.skills,
      constraints: activeResult.projection.constraints,
      availability: activeResult.projection.availability,
      validUntil: activeResult.projection.validUntil,
    } : null);
    setRestriction(listResult.ok ? (listResult.activeRestriction ?? null) : null);
  };

  const publish = async () => {
    const error = validateDraftForm(draft);
    if (error) { setMessage({ ok: false, text: error }); return; }
    setBusy(true);
    setMessage(null);
    const created = await agentExposureEvents().createDraft({
      teamId, agentId,
      capabilities: draft.capabilities.map((capability) => ({ name: capability.name.trim(), description: capability.description.trim() || capability.name.trim() })),
      skills: draft.skills.filter((skill) => skill.name.trim()).map((skill) => ({ name: skill.name.trim(), description: skill.description.trim() || skill.name.trim() })),
    });
    if (!created.ok || !created.manifest) {
      setBusy(false);
      setMessage({ ok: false, text: created.error ?? created.message ?? '创建草稿失败' });
      return;
    }
    const result = await agentExposureEvents().publish({ teamId, manifestId: created.manifest.id });
    setBusy(false);
    if (result.ok && result.manifest) {
      setMessage({ ok: true, text: `已发布 revision ${result.manifest.revision}` });
      await reload();
    } else {
      setMessage({ ok: false, text: result.error ?? result.message ?? '发布失败' });
    }
  };

  const revoke = async () => {
    setBusy(true);
    const result = await agentExposureEvents().revoke({ teamId, agentId });
    setBusy(false);
    if (result.ok && result.revoked) {
      setMessage({ ok: true, text: '已撤回当前 Exposure' });
      await reload();
    } else {
      setMessage({ ok: false, text: result.error ?? result.message ?? '撤回失败' });
    }
  };

  const saveRestriction = async (disabledCapabilities: string[], disabledSkills: string[]) => {
    setBusy(true);
    const result = await agentExposureEvents().upsertRestriction({ teamId, agentId, disabledCapabilities, disabledSkills });
    setBusy(false);
    if (result.ok && result.restriction) {
      setRestriction(result.restriction);
      setMessage({ ok: true, text: '已更新 Team 收紧' });
    } else {
      setMessage({ ok: false, text: result.error ?? result.message ?? '收紧失败（仅可禁用已公开 operation）' });
    }
  };

  return (
    <section className="rounded-lg border border-neutral-200 p-5" data-smoke="agent-exposure-panel">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">Agent Exposure</h3>

      {loading ? (
        <p className="text-sm text-neutral-400">读取中…</p>
      ) : active ? (
        <div className="mb-4 space-y-2">
          <div className="text-xs text-neutral-500">
            当前 revision <span className="font-medium text-neutral-800">{active.revision}</span>
            {' · '}
            <span className={active.availability.status === 'available' ? 'text-emerald-600' : 'text-amber-600'}>
              {active.availability.status === 'available' ? '可用' : '不可用'}
            </span>
            {active.availability.reason ? ` · ${active.availability.reason}` : ''}
          </div>
          <CapabilityList title="Capabilities" items={active.capabilities.map((capability) => capability.name)} />
          <CapabilityList title="Skills" items={active.skills.map((skill) => skill.name)} />
          {active.constraints.length > 0 && (
            <div>
              <div className="text-xs font-medium text-neutral-600">约束</div>
              <ul className="ml-4 list-disc text-xs text-neutral-600">
                {active.constraints.map((constraint, index) => <li key={`${constraint.kind}-${index}`}>{constraint.kind}: {constraint.description}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="mb-4 text-sm text-neutral-400">尚未发布 Agent Exposure。PI 与成员暂无法匹配该 Agent 的公开能力。</p>
      )}

      {canRestrict && active && (
        <RestrictionEditor
          capabilities={active.capabilities.map((capability) => capability.name)}
          skills={active.skills.map((skill) => skill.name)}
          initial={restriction}
          disabled={busy}
          onSave={saveRestriction}
        />
      )}
      {!canRestrict && active && (
        <p className="mb-4 text-xs text-neutral-400">Team owner/admin 可在此收紧已公开 operation。</p>
      )}

      {canManage && (
        <div className="mt-4 border-t border-neutral-200 pt-4">
          <div className="mb-2 text-xs font-medium text-neutral-600">发布新版本</div>
          <RowEditor
            label="Capabilities"
            rows={draft.capabilities}
            onChange={(rows) => setDraft({ ...draft, capabilities: rows })}
          />
          <RowEditor
            label="Skills"
            rows={draft.skills}
            onChange={(rows) => setDraft({ ...draft, skills: rows })}
          />
          <div className="mt-3 flex gap-2">
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
                onClick={revoke}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-50"
              >
                撤回当前
              </button>
            )}
          </div>
        </div>
      )}
      {!canManage && <p className="text-xs text-neutral-400">仅 Agent 拥有者可发布或撤回 Exposure。</p>}

      {message && <div className={`mt-3 text-sm ${message.ok ? 'text-emerald-600' : 'text-red-600'}`}>{message.text}</div>}
    </section>
  );
}

function CapabilityList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-neutral-600">{title}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span key={item} className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">{item}</span>
        ))}
      </div>
    </div>
  );
}

function RowEditor({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: readonly { name: string; description: string }[];
  onChange: (rows: { name: string; description: string }[]) => void;
}) {
  const list = rows as { name: string; description: string }[];
  const patch = (index: number, change: Partial<{ name: string; description: string }>) =>
    onChange(list.map((row, i) => (i === index ? { ...row, ...change } : row)));
  return (
    <div className="mb-2">
      <div className="mb-1 text-xs text-neutral-500">{label}</div>
      {list.map((row, index) => (
        <div key={index} className="mb-1 flex gap-1">
          <input
            value={row.name}
            onChange={(event) => patch(index, { name: event.target.value })}
            placeholder="名称"
            className="w-1/3 rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <input
            value={row.description}
            onChange={(event) => patch(index, { description: event.target.value })}
            placeholder="描述"
            className="flex-1 rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <button type="button" onClick={() => onChange(list.filter((_, i) => i !== index))} className="text-xs text-neutral-400">✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, { name: '', description: '' }])} className="text-xs text-neutral-500">+ 添加</button>
    </div>
  );
}

function RestrictionEditor({
  capabilities,
  skills,
  initial,
  disabled,
  onSave,
}: {
  capabilities: readonly string[];
  skills: readonly string[];
  initial: AgentExposureRestrictionDto | null;
  disabled: boolean;
  onSave: (disabledCapabilities: string[], disabledSkills: string[]) => void;
}) {
  const [disabledCaps, setDisabledCaps] = useState<Set<string>>(new Set(initial?.disabledCapabilities ?? []));
  const [disabledSkillsState, setDisabledSkills] = useState<Set<string>>(new Set(initial?.disabledSkills ?? []));

  useEffect(() => {
    setDisabledCaps(new Set(initial?.disabledCapabilities ?? []));
    setDisabledSkills(new Set(initial?.disabledSkills ?? []));
  }, [initial]);

  const toggle = (set: Set<string>, value: string, update: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    update(next);
  };

  return (
    <div className="border-t border-neutral-200 pt-4">
      <div className="mb-2 text-xs font-medium text-neutral-600">Team 收紧（仅可禁用已公开 operation）</div>
      <ToggleList label="禁用 Capabilities" items={capabilities} selected={disabledCaps} onToggle={(value) => toggle(disabledCaps, value, setDisabledCaps)} />
      <ToggleList label="禁用 Skills" items={skills} selected={disabledSkillsState} onToggle={(value) => toggle(disabledSkillsState, value, setDisabledSkills)} />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSave([...disabledCaps], [...disabledSkillsState])}
        className="mt-2 rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-50"
      >
        保存收紧
      </button>
    </div>
  );
}

function ToggleList({ label, items, selected, onToggle }: {
  label: string;
  items: readonly string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-1">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <label key={item} className="flex items-center gap-1 text-xs text-neutral-700">
            <input type="checkbox" checked={selected.has(item)} onChange={() => onToggle(item)} />
            {item}
          </label>
        ))}
      </div>
    </div>
  );
}
