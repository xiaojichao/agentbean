'use client';

import { useEffect, useState } from 'react';
import { piPolicyEvents } from '@/lib/socket';
import { DEFAULT_PI_POLICY_STATE, piPolicyStateFromResult } from '@/lib/pi-policy-form';

/**
 * Team PI 自动协调开关（#707, AC#1）。
 * 这是 Team 级 PI 设置的唯一产品入口：只展示 autoCoordinationEnabled，不展示
 * mode/Phase/placement/Provider/Model/budget（旧 ManagementPolicyPanel 已移除）。
 * Owner/Admin 可切换；普通成员只读。
 */
export function PiPolicyPanel({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const [enabled, setEnabled] = useState(DEFAULT_PI_POLICY_STATE.autoCoordinationEnabled);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setMessage(null);
    void piPolicyEvents().get(teamId).then((result) => {
      if (!active) return;
      setEnabled(piPolicyStateFromResult(result).autoCoordinationEnabled);
      if (!result.ok) setMessage({ ok: false, text: result.error ?? '读取 PI 自动协调状态失败' });
      setLoading(false);
    });
    return () => { active = false; };
  }, [teamId]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setMessage(null);
    const result = await piPolicyEvents().update({ teamId, autoCoordinationEnabled: next });
    setSaving(false);
    if (result.ok && typeof result.autoCoordinationEnabled === 'boolean') {
      setEnabled(result.autoCoordinationEnabled);
      setMessage({ ok: true, text: result.autoCoordinationEnabled ? '已开启 PI 自动协调' : '已关闭 PI 自动协调' });
    } else {
      setMessage({ ok: false, text: result.error ?? '保存失败' });
    }
  };

  return (
    <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-pi-policy" data-team-id={teamId}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">PI 自动协调</h3>
      <p className="mb-4 text-xs text-neutral-500">开启后 PI 自动理解每条消息并按风险门禁执行低风险动作；关闭后仅建议、不自动执行（显式 @Agent 与明确任务不受影响）。</p>
      <label className="flex items-center gap-3 text-sm" data-smoke="settings-pi-auto-coordination">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => toggle(event.target.checked)}
          disabled={loading || saving || !canManage}
          className="peer sr-only"
        />
        <span className="relative h-6 w-11 rounded-full bg-neutral-200 transition peer-checked:bg-neutral-900 peer-disabled:opacity-50">
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${enabled ? 'left-5' : 'left-0.5'}`} />
        </span>
        <span className="flex-1">
          <span className="block font-medium text-neutral-900">PI 自动协调</span>
          <span className="mt-0.5 block text-xs text-neutral-500">{enabled ? '已开启' : '已关闭'}</span>
        </span>
      </label>
      {!canManage && <div className="mt-3 text-xs text-neutral-400">仅 Team owner/admin 可修改。</div>}
      {message && <div className={`mt-3 text-sm ${message.ok ? 'text-emerald-600' : 'text-red-600'}`}>{message.text}</div>}
    </section>
  );
}
