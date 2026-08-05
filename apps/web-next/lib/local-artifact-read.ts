import { directoryBrowseMode } from './device-permissions';
import type { Artifact, DeviceInfo } from './schema';

/**
 * #1084 切片3：web 频道文件预览/下载本机优先的纯逻辑（无 React，便于单测）。
 *
 * 策略（弱解释已定）：列表仍读 server；预览/下载字节优先读本机 .agentbean snapshots 副本，
 * 失败/离线/版本不匹配（sha256 不一致）静默回退 server artifact download URL。
 *
 * 本机命中前置门（gotcha #6）：本机设备 directoryBrowseMode==='tree'（fsBrowse 能力自报，
 * cli.ts:644）且在线。无新 capability，复用三态门。
 */

/** 选出可用于本机读取的设备：isLocal + 在线 + tree 浏览模式（fsBrowse 能力）。 */
export function pickLocalReadFileDevice(devices: DeviceInfo[] | null | undefined): DeviceInfo | null {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  return devices.find((d) => {
    if (d.isLocal !== true) return false;
    if (d.status !== 'online') return false;
    return directoryBrowseMode({
      fsBrowse: d.capabilities?.fsBrowse,
      daemonVersion: d.daemonVersionInfo?.current ?? d.latestDaemonVersion ?? null,
      isLocal: d.isLocal,
    }) === 'tree';
  }) ?? null;
}

/**
 * 判断一次本机 readFile 结果是否应被采用（版本最新性校验，gotcha #5）。
 * - artifact 无 sha256 → 无法判最新性，保守拒绝（回退 server）。
 * - daemon 回包 sha256 与 server artifact.sha256 严格相等才采用；不等 = 本机落后 → 回退。
 */
export function localReadMatchesArtifact(
  result: { ok: true; sha256?: string } | { ok: false; error?: string },
  artifact: Artifact,
): boolean {
  if (!result.ok) return false;
  if (!result.sha256) return false;
  if (!artifact.sha256) return false;
  return result.sha256 === artifact.sha256;
}

/** base64 → Uint8Array（浏览器 atob 优先；Node 测试环境走 Buffer）。 */
function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return bytes;
  }
  // Node（vitest jsdom 无 atob 兜底）/更老环境
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * base64 内容 → Blob URL（预览/下载共用一个 URL，调用方负责 revokeObjectURL）。
 * mimeType 缺失时回退 application/octet-stream（浏览器据此决定预览 vs 下载）。
 */
export function blobUrlFromBase64(contentBase64: string, mimeType: string | undefined): string {
  const bytes = base64ToUint8Array(contentBase64);
  // TS DOM lib 的 BlobPart 要求 ArrayBufferView<ArrayBuffer>；Uint8Array 在本 lib 标注为
  // ArrayBufferLike（含 SharedArrayBuffer 可能性）。运行时 Blob 接受 Uint8Array，此处显式断言。
  const blob = new Blob([bytes as unknown as ArrayBuffer], {
    type: mimeType && mimeType.length > 0 ? mimeType : 'application/octet-stream',
  });
  return URL.createObjectURL(blob);
}
