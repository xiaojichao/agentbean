'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManagementMode } from '@agentbean/contracts';
import { managementPolicyEvents } from '@/lib/socket';
import {
  AUTO_PLACEMENT_NOTICE,
  buildPlacementPolicyPayload,
  MANAGED_PLACEMENT_PRIVACY_NOTICE,
  placementFormStateFromPolicy,
  placementOnModeChange,
  validatePlacementForm,
  type PlacementChoice,
  type PlacementFormState,
} from '@/lib/management-policy-form';

export function ManagementPolicyPanel({ teamId, canManage, deviceIds }: {
  teamId: string;
  canManage: boolean;
  deviceIds: readonly string[];
}) {
  const [form, setForm] = useState<PlacementFormState>(() => placementFormStateFromPolicy(null));
  // 初值必为 device（null policy 默认）；后续 policy 载入时同步重置（见下方 effect）。
  const rememberedPlacementRef = useRef<'device' | 'managed'>(form.placement === 'managed' ? 'managed' : 'device');
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
        const next = placementFormStateFromPolicy(result.policy);
        // auto 不参与记忆恢复（placementOnModeChange 对 auto 原样保留），记忆值归位安全默认。
        rememberedPlacementRef.current = next.placement === 'auto' ? 'device' : next.placement;
        setForm(next);
      } else {
        setMessage({ ok: false, text: result.error ?? '读取管理模式失败' });
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [teamId]);

  const patch = (partial: Partial<PlacementFormState>) => setForm((current) => ({ ...current, ...partial }));

  // placement 只在 managed 模式下有意义；切出 managed 时归位 device（可保存的安全默认），
  // 切回时恢复用户原选择——mode 往返不静默丢弃隐私相关的 managed placement。
  const changeMode = (mode: ManagementMode) => {
    const next = placementOnModeChange(form.placement, rememberedPlacementRef.current, mode);
    rememberedPlacementRef.current = next.remembered;
    patch({ mode, placement: next.placement });
  };

  const toggleDevice = (deviceId: string) => {
    const current = form.allowedDeviceIds;
    patch({
      allowedDeviceIds: current.includes(deviceId)
        ? current.filter((id) => id !== deviceId)
        : [...current, deviceId],
    });
  };

  const formError = validatePlacementForm(form);

  const save = async () => {
    if (formError) {
      setMessage({ ok: false, text: formError });
      return;
    }
    setSaving(true);
    setMessage(null);
    const result = await managementPolicyEvents().update({
      teamId,
      mode: form.mode,
      maxManagementPhase: form.maxManagementPhase,
      placementPolicy: buildPlacementPolicyPayload(form),
    });
    setSaving(false);
    setMessage(result.ok
      ? { ok: true, text: '管理模式已保存' }
      : { ok: false, text: result.error ?? '保存失败' });
  };

  return (
    <section className="rounded-lg border border-neutral-200 p-5" data-smoke="settings-management-policy" data-team-id={teamId}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">PI 管理模式</h3>
      <p className="mb-4 text-xs text-neutral-500">默认 direct；managed 默认只开放 Phase 1 单 Agent 请求。Phase 2 必须由 owner/admin 显式开启，并在请求时通过完整预检。</p>
      <label className="mb-1 block text-xs font-medium text-neutral-500">路由模式</label>
      <select
        value={form.mode}
        onChange={(event) => changeMode(event.target.value as ManagementMode)}
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
        value={form.maxManagementPhase}
        onChange={(event) => patch({ maxManagementPhase: Number(event.target.value) as 1 | 2 | 3 })}
        disabled={loading || !canManage || form.mode !== 'managed'}
        className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm disabled:bg-neutral-50"
        data-smoke="settings-management-phase"
      >
        <option value={1}>Phase 1（单 Agent，默认）</option>
        <option value={2}>Phase 2（Task DAG 与团队认领）</option>
        <option value={3}>Phase 3（跨 Agent Memory，worker 工具接通）</option>
      </select>
      {form.mode === 'managed' && form.maxManagementPhase === 2 && (
        <div className="mt-2 text-xs text-amber-700" data-smoke="settings-management-phase-warning">
          仅显式“作为任务”的请求会尝试进入 Phase 2；Worker、协议、凭证、预算和候选 Agent 任一未就绪都会拒绝创建 Run。
        </div>
      )}
      {form.mode === 'managed' && form.maxManagementPhase === 3 && (
        <div className="mt-2 text-xs text-amber-700">
          Phase 3 开放跨 Agent Memory 工具（search/create_capsule/propose_candidate/link_sources）；Worker 须声明 V3 capability，且 Memory 注入（P3-13）完成前 Memory 不会真正进入 PI 上下文。
        </div>
      )}
      <label className="mb-1 mt-4 block text-xs font-medium text-neutral-500">执行位置（placement）</label>
      <select
        value={form.placement}
        onChange={(event) => patch({ placement: event.target.value as PlacementChoice })}
        disabled={loading || !canManage || form.mode !== 'managed'}
        className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm disabled:bg-neutral-50"
        data-smoke="settings-management-placement"
      >
        <option value="device">device（在你授权的 Device 上执行）</option>
        <option value="managed">managed（Server Worker 在 Server 端执行）</option>
        <option value="auto">auto（按隐私与可用性自动选择）</option>
      </select>
      {form.mode === 'managed' && form.placement === 'auto' && (
        <div className="mt-2 space-y-2" data-smoke="settings-management-auto-notice">
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600">
            {AUTO_PLACEMENT_NOTICE}
          </div>
          <label className="flex items-start gap-2 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={form.allowServerContext}
              onChange={(event) => patch({ allowServerContext: event.target.checked })}
              disabled={!canManage}
              className="mt-0.5"
              data-smoke="settings-management-allow-server-context"
            />
            <span>Device 全离线时允许 Server Worker 兜底（完成任务所需的最小授权内容将发送至 Server provider，每次访问写入审计；不勾选则 Device 离线时任务明确失败，绝不上传）</span>
          </label>
        </div>
      )}
      {form.mode === 'managed' && form.placement === 'managed' && (
        <div className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600" data-smoke="settings-management-privacy">
          {MANAGED_PLACEMENT_PRIVACY_NOTICE}
        </div>
      )}
      {form.mode === 'managed' && (form.placement === 'device' || form.placement === 'auto') && (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-neutral-500">允许承载的 Device</div>
          {uniqueDeviceIds.map((deviceId) => (
            <label key={deviceId} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.allowedDeviceIds.includes(deviceId)} onChange={() => toggleDevice(deviceId)} disabled={!canManage} />
              <span className="font-mono text-xs">{deviceId}</span>
            </label>
          ))}
          {uniqueDeviceIds.length === 0 && <div className="text-xs text-neutral-400">当前 Team 没有可选 Device。</div>}
        </div>
      )}
      {form.mode === 'managed' && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">首选 provider（可选）</label>
            <input
              type="text"
              value={form.preferredProvider}
              onChange={(event) => patch({ preferredProvider: event.target.value })}
              disabled={loading || !canManage}
              placeholder="如 anthropic"
              className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm disabled:bg-neutral-50"
              data-smoke="settings-management-preferred-provider"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">首选模型（可选）</label>
            <input
              type="text"
              value={form.preferredModel}
              onChange={(event) => patch({ preferredModel: event.target.value })}
              disabled={loading || !canManage}
              placeholder="如 claude-fable-5"
              className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm disabled:bg-neutral-50"
              data-smoke="settings-management-preferred-model"
            />
          </div>
        </div>
      )}
      {form.mode === 'managed' && formError && (
        <div className="mt-3 text-xs text-amber-700" data-smoke="settings-management-preflight">{formError}</div>
      )}
      {!canManage && <div className="mt-3 text-xs text-neutral-400">仅 Team owner/admin 可修改。</div>}
      <button onClick={save} disabled={loading || saving || !canManage || formError !== null} className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40" data-smoke="settings-management-save">
        {saving ? '保存中...' : '保存管理模式'}
      </button>
      {message && <div className={`mt-3 text-sm ${message.ok ? 'text-emerald-600' : 'text-red-600'}`}>{message.text}</div>}
    </section>
  );
}
