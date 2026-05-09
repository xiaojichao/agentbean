'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Monitor, Circle } from 'lucide-react';
import { ConnectionBanner } from '@/components/connection-banner';
import { AgentCard } from '@/components/agent-card';
import { deviceEvents } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import type { DeviceInfo } from '@/lib/schema';

interface DeviceAgent {
  id: string;
  name: string;
  role: string;
  adapterKind: string;
  category?: string;
  visibility?: 'public' | 'private';
}

interface DeviceDetail extends DeviceInfo {
  agents: DeviceAgent[];
}

const STATUS_COLORS: Record<string, string> = {
  online: 'text-emerald-500',
  busy: 'text-amber-500',
  offline: 'text-neutral-400',
  error: 'text-red-500',
  connecting: 'text-blue-500',
};

export default function DeviceDetailPage() {
  const params = useParams();
  const deviceId = params.id as string;
  const conn = useAgentBeanStore((s) => s.conn);
  const np = useCurrentNetworkPath();
  const [device, setDevice] = useState<DeviceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (conn !== 'open') return;
    setLoading(true);
    deviceEvents().get({ id: deviceId }).then((res) => {
      if (res.ok && res.device) {
        setDevice(res.device);
      } else {
        setError(res.error ?? 'NOT_FOUND');
      }
      setLoading(false);
    });
  }, [conn, deviceId]);

  if (loading) {
    return <div className="p-6 text-sm text-neutral-500">加载中...</div>;
  }

  if (error || !device) {
    return (
      <div className="p-6">
        <ConnectionBanner />
        <div className="text-sm text-red-600">设备未找到：{error}</div>
        <Link href={`/${np}/devices`} className="mt-4 inline-flex items-center gap-1 text-sm text-neutral-600 hover:text-neutral-900">
          <ArrowLeft size={14} /> 返回设备列表
        </Link>
      </div>
    );
  }

  const agentos = device.agents.filter((a) => a.category === 'agentos-hosted');
  const otherAgents = device.agents.filter((a) => a.category !== 'agentos-hosted');

  return (
    <div className="p-6">
      <ConnectionBanner />

      <Link href={`/${np}/devices`} className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900">
        <ArrowLeft size={14} /> 设备列表
      </Link>

      {/* Device header */}
      <div className="mb-6 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-100">
          <Monitor size={24} className="text-neutral-600" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{device.id}</h1>
            <Circle size={10} className={`fill-current ${STATUS_COLORS[device.status] ?? 'text-neutral-400'}`} />
            <span className="text-xs text-neutral-500">{device.status}</span>
          </div>
          <div className="mt-0.5 text-sm text-neutral-500">
            {device.tailscaleIp && <span>IP: {device.tailscaleIp} · </span>}
            最后在线: {new Date(device.lastSeenAt).toLocaleString()}
          </div>
        </div>
      </div>

      {/* Device properties */}
      <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-500">设备属性</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <PropRow label="设备 ID" value={device.id} />
          <PropRow label="状态" value={device.status} />
          <PropRow label="Tailscale IP" value={device.tailscaleIp ?? '—'} />
          <PropRow label="所属网络" value={device.networkId} />
          <PropRow label="Agent 数量" value={`${device.agentIds.length}`} />
          <PropRow label="最后心跳" value={new Date(device.lastSeenAt).toLocaleString()} />
        </div>
      </section>

      {/* AgentOS */}
      {agentos.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">AgentOS</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agentos.map((a) => (
              <div key={a.id} className="rounded-lg border border-neutral-200 bg-white p-3">
                <div className="text-sm font-medium">{a.name}</div>
                <div className="mt-1 text-xs text-neutral-500">{a.adapterKind}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Agents */}
      {otherAgents.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Agents</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {otherAgents.map((a) => (
              <Link key={a.id} href={`/agents/${a.id}`} className="block hover:shadow-md transition-shadow">
                <AgentCard agent={{
                  id: a.id,
                  name: a.name,
                  role: a.role,
                  adapterKind: a.adapterKind as any,
                  status: device.status === 'online' ? 'online' : 'offline',
                  lastSeenAt: device.lastSeenAt,
                  connectCommand: '',
                  visibility: a.visibility,
                  category: a.category as any,
                  deviceId: device.id,
                }} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {device.agents.length === 0 && (
        <div className="text-sm text-neutral-500">此设备暂无 Agent。</div>
      )}
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-100 bg-neutral-50 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-neutral-800 truncate">{value}</div>
    </div>
  );
}
