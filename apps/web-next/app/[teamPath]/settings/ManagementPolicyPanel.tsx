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
  const [maxManagementPhase, setMaxManagementPhase] = useState<1 | 2 | 3>(1);
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
        setMaxManagementPhase(result.policy.maxManagementPhase);
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
    const result = await managementPolicyEvents().update({ teamId, mode, maxManagementPhase, placementPolicy: placement });
    setSaving(false);
    setMessage(result.ok
      ? { ok: true, text: '管理模式已保存' }
      : { ok: false, text: result.error ?? '保存失败' });
  };

  const managedMissingDevice = mode === 'managed' && (placement.allowedDeviceIds?.length ?? 0) === 0;

  return (
    <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-management-policy" data-team-id={teamId}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">PI 管理模式</h3>
      <p className="mb-4 text-xs text-neutral-500">默认 direct；managed 默认只开放 Phase 1 单 Agent 请求。Phase 2 必须由 owner/admin 显式开启，并在请求时通过完整预检。</p>
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
      <label className="mb-1 mt-4 block text-xs font-medium text-neutral-500">最高管理阶段</label>
      <select
        value={maxManagementPhase}
        onChange={(event) => setMaxManagementPhase(Number(event.target.value) as 1 | 2 | 3)}
        disabled={loading || !canManage || mode !== 'managed'}
        className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm disabled:bg-neutral-50"
        data-smoke="settings-management-phase"
      >
        <option value={1}>Phase 1（单 Agent，默认）</option>
        <option value={2}>Phase 2（Task DAG 与团队认领）</option>
        <option value={3}>Phase 3（跨 Agent Memory，worker 工具接通）</option>
      </select>
      {mode === 'managed' && maxManagementPhase === 2 && (
        <div className="mt-2 text-xs text-amber-700" data-smoke="settings-management-phase-warning">
          仅显式“作为任务”的请求会尝试进入 Phase 2；Worker、协议、凭证、预算和候选 Agent 任一未就绪都会拒绝创建 Run。
        </div>
      )}
      {mode === 'managed' && maxManagementPhase === 3 && (
        <div className="mt-2 text-xs text-amber-700">
          Phase 3 开放跨 Agent Memory 工具（search/create_capsule/propose_candidate/link_sources）；Worker 须声明 V3 capability，且 Memory 注入（P3-13）完成前 Memory 不会真正进入 PI 上下文。
        </div>
      )}
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
