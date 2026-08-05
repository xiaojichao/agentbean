import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';

// #1084 切片3 fs:read：读取本机 .agentbean snapshots 副本单文件字节（频道文件预览/下载本机优先）。
//
// 与 fs:list（directory-lister）的关键区别——读字节比列名敏感，故 readpath 用**白名单**而非 denylist：
// 入参 path resolve 后必须落在 ~/.agentbean/workspaces/<teamId>/channels/<channelId>/snapshots/<revisionId>/
// 子树内（channelProjectionRoot/snapshots/<revisionId>/，复用 workspace-run.ts 的合法 root 计算）。
// 越界一律 OUTSIDE_SNAPSHOTS（专用码，区别于「文件不存在」）。
//
// 安全不变量（spec / issue #1084 gotcha）：
// - readpath 白名单 = snapshots 子树：teamId/channelId/revisionId 走 safe-segment 校验（无法夹带 `..`/`/`），
//   path 只允许相对、无 `..`/`\`/null/绝对前缀。lexical + realpath 双层 containment 防符号链接逃逸。
// - directory-lister 的 denylist（.ssh/.aws/...）在此**结构性失效**：snapshots root 恒位于
//   agentBeanHome/workspaces/<team>/<channel>/snapshots/<rev>/，与用户 home 下的凭证目录不相交；
//   故 readpath 白名单是其超集，无需叠加（gotcha 明示 readpath 白名单是关键闸）。
// - 大小上限 + 限速器（类比 createListDirectoryRateLimiter）。
// - 回包附 sha256，web 与 server artifact.sha256 比对判本机是否最新（落后则静默回退 server）。

/** 单文件读取大小上限：超过即 PATH_NOT_FOUND（触发 web 回退 server；不另立码，避免暴露细节）。 */
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

export interface ReadFileParams {
  teamId: string;
  channelId: string;
  revisionId: string;
  path: string;
}

export interface ReadFileDeps {
  /** agentBeanHome（~/.agentbean；测试注入 tmpdir）。snapshots root 锚点。 */
  home: string;
}

export type ReadFileResult =
  | { ok: true; contentBase64: string; sizeBytes: number; sha256: string }
  | { ok: false; error: 'PATH_NOT_FOUND' | 'PERMISSION_DENIED' | 'RATE_LIMITED' | 'OUTSIDE_SNAPSHOTS' };

/**
 * 复用 workspace-run.ts 的 safe-segment 规则（id 字段不可含 `..`/`/`/空）。
 * 直接内联（而非 import + try/catch assertSafeSegment）是为了返回错误码而非 throw，
 * 保持 readFile 的错误语义统一为 result union。
 */
function isSafeSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

/**
 * path 必须是非空 POSIX 相对路径：无绝对前缀、无反斜杠、无 null、任一段非 `.`/`..`/空。
 * 满足后 `resolve(snapshotRoot, path)` 才不会逃离 snapshotRoot。
 */
function isSafeRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/**
 * child 是否位于 parent 子树内（含 realpath 后的跨盘 / 符号链接逃逸判定）。
 * - relative 返回 '' 表示 child===parent（目录本身，非文件）→ 视为越界。
 * - relative 返回以 '..' 开头 → 越界。
 * - Windows 跨盘时 relative 返回绝对路径（如 'D:\foo'）→ 越界。
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return false;
  if (rel.startsWith('..')) return false;
  // 跨盘（Windows）relative 返回绝对路径；POSIX 不会出现。
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) return false;
  return true;
}

export async function readFile(params: ReadFileParams, deps: ReadFileDeps): Promise<ReadFileResult> {
  const { teamId, channelId, revisionId, path } = params;
  // 闸 1：id 段 safe-segment（teamId/channelId/revisionId 不可构造遍历）。
  if (!isSafeSegment(teamId) || !isSafeSegment(channelId) || !isSafeSegment(revisionId)) {
    return { ok: false, error: 'OUTSIDE_SNAPSHOTS' };
  }
  // 闸 2：path 必须是合法相对路径（无 `..`/绝对/反斜杠）。
  if (!isSafeRelativePath(path)) {
    return { ok: false, error: 'OUTSIDE_SNAPSHOTS' };
  }

  const home = resolve(deps.home);
  const snapshotRoot = resolve(home, 'workspaces', teamId, 'channels', channelId, 'snapshots', revisionId);
  const target = resolve(snapshotRoot, path);

  // 闸 3：lexical containment（resolve 已消解 `..`，此处确认 target 落在 snapshotRoot 子树）。
  if (!isInside(snapshotRoot, target)) {
    return { ok: false, error: 'OUTSIDE_SNAPSHOTS' };
  }

  // 闸 4：realpath containment（防符号链接逃逸：snapshotRoot 中间段或 target 叶子是符号链接指向外）。
  // 路径不存在时 realpathSync 抛 ENOENT → 归一 PATH_NOT_FOUND（不暴露「是文件但越界」vs「不存在」）。
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = realpathSync(target);
    realRoot = realpathSync(snapshotRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, error: 'PERMISSION_DENIED' };
    }
    return { ok: false, error: 'PATH_NOT_FOUND' };
  }
  if (!isInside(realRoot, realTarget)) {
    // realpath 后越界 = 符号链接逃逸，专用码区别于「文件不存在」。
    return { ok: false, error: 'OUTSIDE_SNAPSHOTS' };
  }

  // 闸 5：必须是普通文件 + 大小上限。
  let stat;
  try {
    stat = statSync(realTarget);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, error: 'PERMISSION_DENIED' };
    }
    return { ok: false, error: 'PATH_NOT_FOUND' };
  }
  if (!stat.isFile()) {
    // 目录或特殊文件 → PATH_NOT_FOUND（不暴露类型细节）。
    return { ok: false, error: 'PATH_NOT_FOUND' };
  }
  if (stat.size > MAX_READ_FILE_BYTES) {
    // 超大小上限 → 让 web 回退 server（不另立码，避免侧信道）。
    return { ok: false, error: 'PATH_NOT_FOUND' };
  }

  // 闸 6：读字节 + 计算 sha256（回包附 sha256 让 web 比对 server artifact.sha256 判本机是否最新）。
  try {
    const bytes = readFileSync(realTarget);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      ok: true,
      contentBase64: bytes.toString('base64'),
      sizeBytes: bytes.byteLength,
      sha256,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, error: 'PERMISSION_DENIED' };
    }
    return { ok: false, error: 'PATH_NOT_FOUND' };
  }
}

/** 生产 deps 工厂：agentBeanHome = AGENTBEAN_HOME ?? ~/.agentbean（与 index.ts:453 一致）。 */
export function productionReadFileDeps(): ReadFileDeps {
  return { home: process.env.AGENTBEAN_HOME ?? resolve(homedir(), '.agentbean') };
}

export interface ReadFileRateLimiterOptions {
  max: number;
  windowMs: number;
  now: () => number;
}

/**
 * fs:read 限速器（滑动窗口）：单连接 QPS 上限，防批量拉取扫描。
 * 与 createListDirectoryRateLimiter 同款；per-socket 一个实例。
 */
export function createReadFileRateLimiter(options: ReadFileRateLimiterOptions): { allow: () => boolean } {
  const timestamps: number[] = [];
  return {
    allow() {
      const now = options.now();
      while (timestamps.length > 0 && now - timestamps[0]! >= options.windowMs) {
        timestamps.shift();
      }
      if (timestamps.length >= options.max) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
  };
}
