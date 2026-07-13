'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ManagementMode, ManagerPlacementPolicyDto } from '@agentbean/contracts';
import { managementPolicyEvents } from '@/lib/socket';

const DEFAULT_PLACEMENT: ManagerPlacementPolicyDto = {
  placement: 'device',
  allowServerContext: false,
  requireLocalModelCredentials: true,
};

export function ManagementPolicyPanel({ teamId, canManage, deviceIds }: {
  teamId: string;
  canManage: boolean;
  deviceIds: readonly string[];
}) {
  const [mode, setMode] = useState<ManagementMode>('direct');
  const [placement, setPlacement] = useState<ManagerPlacementPolicyDto>(DEFAULT_PLACEMENT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const uniqueDeviceIds = useMemo(() => [...new Set(deviceIds)].sort(), [deviceIds]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setMessage(null);
    void managementPolicyEvents().get(teamId).then((result) => {
      if (!active) return;
      if (result.ok && result.policy) {
        setMode(result.policy.mode);
        setPlacement(result.policy.placementPolicy);
      } else {
        setMessage({ ok: false, text: result.error ?? '读取管理模式失败' });
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [teamId]);

  const toggleDevice = (deviceId: string) => {
    const current = placement.allowedDeviceIds ?? [];
    setPlacement({
      ...placement,
      allowedDeviceIds: current.includes(deviceId)
        ? current.filter((id) => id !== deviceId)
        : [...current, deviceId],
    });
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    const result = await managementPolicyEvents().update({ teamId, mode, placementPolicy: placement });
    setSaving(false);
    setMessage(result.ok
      ? { ok: true, text: '管理模式已保存' }
      : { ok: false, text: result.error ?? '保存失败' });
  };

  const managedMissingDevice = mode === 'managed' && (placement.allowedDeviceIds?.length ?? 0) === 0;

  return (
    <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-management-policy" data-team-id={teamId}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">PI 管理模式</h3>
      <p className="mb-4 text-xs text-neutral-500">默认 direct；shadow 保持原路由并隔离记录旁路诊断，managed 会由选定 Device 上的 PI Manager 接管显式单 Agent 请求。</p>
      <label className="mb-1 block text-xs font-medium text-neutral-500">路由模式</label>
      <select
        value={mode}
        onChange={(event) => setMode(event.target.value as ManagementMode)}
        disabled={loading || !canManage}
        className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm disabled:bg-neutral-50"
        data-smoke="settings-management-mode"
      >
        <option value="direct">direct（现有路由）</option>
        <option value="shadow">shadow（旁路评估）</option>
        <option value="managed">managed（PI Manager 接管）</option>
      </select>
      <div className="mt-4 space-y-2">
        <div className="text-xs font-medium text-neutral-500">允许承载的 Device</div>
        {uniqueDeviceIds.map((deviceId) => (
          <label key={deviceId} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={placement.allowedDeviceIds?.includes(deviceId) ?? false} onChange={() => toggleDevice(deviceId)} disabled={!canManage} />
            <span className="font-mono text-xs">{deviceId}</span>
          </label>
        ))}
        {uniqueDeviceIds.length === 0 && <div className="text-xs text-neutral-400">当前 Team 没有可选 Device。</div>}
      </div>
      {managedMissingDevice && <div className="mt-3 text-xs text-amber-700" data-smoke="settings-management-preflight">managed 尚缺 allowed Device；Worker、模型凭证和目标 Agent 也会在请求时 fail closed。</div>}
      {!canManage && <div className="mt-3 text-xs text-neutral-400">仅 Team owner/admin 可修改。</div>}
      <button onClick={save} disabled={loading || saving || !canManage || managedMissingDevice} className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40" data-smoke="settings-management-save">
        {saving ? '保存中...' : '保存管理模式'}
      </button>
      {message && <div className={`mt-3 text-sm ${message.ok ? 'text-emerald-600' : 'text-red-600'}`}>{message.text}</div>}
    </section>
  );
}
