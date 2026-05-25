import type { AgentRegistry } from './registry.js';
import type { DeviceRegistry } from './device-registry.js';

export interface HeartbeatScannerOptions {
  registry: AgentRegistry;
  timeoutMs: number;
  intervalMs: number;
  onTimeout: (agentId: string) => void;
}

export function startHeartbeatScanner(opts: HeartbeatScannerOptions): () => void {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const a of opts.registry.all()) {
      if (a.status === 'offline') continue;
      if (a.source === 'custom' && a.socketId === null) continue;
      if (now - a.lastHeartbeatAt > opts.timeoutMs) {
        opts.registry.markOffline(a.id, 'heartbeat-timeout');
        opts.onTimeout(a.id);
      }
    }
  }, opts.intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

export interface DeviceHeartbeatScannerOptions {
  deviceRegistry: DeviceRegistry;
  timeoutMs: number;
  intervalMs: number;
  onTimeout: (deviceId: string) => void;
}

export function startDeviceHeartbeatScanner(opts: DeviceHeartbeatScannerOptions): () => void {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const d of opts.deviceRegistry.all()) {
      if (d.status === 'offline') continue;
      if (now - d.lastSeenAt > opts.timeoutMs) {
        opts.deviceRegistry.markOffline(d.id);
        opts.onTimeout(d.id);
      }
    }
  }, opts.intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
