'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { deviceEvents, getWebSocket, projectEvents } from './socket';
import {
  blobUrlFromBase64,
  localReadMatchesArtifact,
  pickLocalReadFileDevice,
} from './local-artifact-read';
import type { Artifact, DeviceInfo } from './schema';

/**
 * #1084 切片3：频道文件预览/下载「本机优先」Hook。
 *
 * 入参 serverPreviewUrl/serverDownloadUrl 是现有 server artifact URL（chatArtifactUrl 计算）。
 * 当本机设备 directoryBrowseMode==='tree' 且在线、频道 workspace 有 currentRevisionId、artifact 有
 * relativePath + sha256 时，经 fs:read 链路读本机 snapshots 副本；sha256 与 server artifact.sha256
 * 比对一致 → 返回本机 blob URL（预览/下载共用）。任一环节失败/离线/版本不匹配 → 静默回退 server URL。
 *
 * 设计要点：
 * - 立即返回 server URL（UI 不空白），本机命中后异步升级为 blob URL。
 * - 设备订阅 + 频道 revisionId 在模块级共享（多实例不重复订阅/拉取）。
 * - revisionId 缓存带 TTL（60s）+ sha256 门（gotcha #5）双保险：缓存落后时 sha256 不符 → 回退 server。
 */

// ---- 设备列表共享订阅（多实例复用一条 onSnapshot）----
let cachedDevices: DeviceInfo[] = [];
let deviceSubscribed = false;
const deviceListeners = new Set<() => void>();

function ensureDeviceSubscription(): void {
  if (deviceSubscribed) return;
  deviceSubscribed = true;
  let socket;
  try {
    socket = getWebSocket();
  } catch {
    // 无可用 socket（如 SSR / 未连接）→ 保持空列表，hook 回退 server URL。
    return;
  }
  const events = deviceEvents(socket);
  events.onSnapshot((next: DeviceInfo[]) => {
    cachedDevices = next;
    deviceListeners.forEach((fn) => fn());
  });
  // 首次订阅时主动拉一次列表（onSnapshot 仅推送后续变更）。
  void events.list().then((res) => {
    if (res.ok && Array.isArray(res.devices)) {
      cachedDevices = res.devices;
      deviceListeners.forEach((fn) => fn());
    }
  });
}

function subscribeDevices(cb: () => void): () => void {
  ensureDeviceSubscription();
  deviceListeners.add(cb);
  return () => {
    deviceListeners.delete(cb);
  };
}

function getDevicesSnapshot(): DeviceInfo[] {
  return cachedDevices;
}

// ---- 频道 workspace currentRevisionId 共享缓存（TTL 60s + sha256 门兜底）----
interface RevisionCacheEntry {
  promise: Promise<string | null>;
  resolvedAt: number;
  value: string | null;
}
const REVISION_TTL_MS = 60_000;
const revisionCache = new Map<string, RevisionCacheEntry>();

function fetchChannelRevisionId(channelId: string): Promise<string | null> {
  const now = Date.now();
  const existing = revisionCache.get(channelId);
  if (existing && now - existing.resolvedAt < REVISION_TTL_MS) {
    return existing.promise;
  }
  const promise = projectEvents()
    .workspace(channelId)
    .then((res) => {
      const value = res.ok && res.workspace && res.workspace.currentRevisionId ? res.workspace.currentRevisionId : null;
      const entry = revisionCache.get(channelId);
      if (entry) {
        entry.value = value;
        entry.resolvedAt = Date.now();
      }
      return value;
    })
    .catch(() => null);
  revisionCache.set(channelId, { promise, resolvedAt: now, value: null });
  return promise;
}

// ---- revisionId 订阅 hook ----
function useChannelRevisionId(channelId: string | undefined): string | null | undefined {
  // undefined = 尚未解析；null = 已解析但无 workspace
  const [revisionId, setRevisionId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!channelId) {
      setRevisionId(undefined);
      return;
    }
    let cancelled = false;
    fetchChannelRevisionId(channelId).then((value) => {
      if (!cancelled) setRevisionId(value);
    });
    return () => {
      cancelled = true;
    };
  }, [channelId]);
  return revisionId;
}

export interface LocalFirstArtifactUrls {
  previewUrl: string | null;
  downloadUrl: string | null;
}

export function useLocalFirstArtifactUrls(
  artifact: Artifact,
  serverPreviewUrl: string | null,
  serverDownloadUrl: string | null,
  channelId: string | undefined,
): LocalFirstArtifactUrls {
  const devices = useSyncExternalStore(subscribeDevices, getDevicesSnapshot, getDevicesSnapshot);
  const localDevice = useMemo(() => pickLocalReadFileDevice(devices), [devices]);
  const revisionId = useChannelRevisionId(localDevice ? channelId : undefined);
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  // 依赖项变化时重置本机 URL（避免闪烁旧 blob）。
  useEffect(() => {
    setLocalUrl(null);
  }, [artifact.id]);

  useEffect(() => {
    // 前置门：本机设备 / 频道 / revisionId / artifact 相对路径 + sha256 缺一不可。
    // 取出局部 const 让 TS 在守卫后正确窄化（属性访问不会跨语句窄化）。
    const relativePath = artifact.relativePath;
    const teamId = artifact.teamId;
    if (
      !localDevice
      || !channelId
      || !revisionId
      || !relativePath
      || !artifact.sha256
      || !teamId
    ) {
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    void (async () => {
      try {
        const res = await deviceEvents().readFile(
          localDevice.id,
          teamId,
          channelId,
          revisionId,
          relativePath,
        );
        if (cancelled) return;
        if (localReadMatchesArtifact(res, artifact) && res.contentBase64) {
          createdUrl = blobUrlFromBase64(res.contentBase64, artifact.mimeType);
          if (!cancelled) setLocalUrl(createdUrl);
        }
      } catch {
        // 静默回退 server（gotcha #4）：本机落后/离线/readFile 失败时 UI 不能空白。
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
    // artifact 字段按值入依赖；channelId/revisionId/localDevice.id 变化重新尝试。
  }, [
    localDevice,
    channelId,
    revisionId,
    artifact.id,
    artifact.relativePath,
    artifact.sha256,
    artifact.mimeType,
    artifact.teamId,
  ]);

  if (localUrl) {
    return { previewUrl: localUrl, downloadUrl: localUrl };
  }
  return { previewUrl: serverPreviewUrl, downloadUrl: serverDownloadUrl };
}
