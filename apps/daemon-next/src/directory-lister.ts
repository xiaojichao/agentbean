import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

// fs:list 目录列表的核心逻辑（切片3：安全闸齐备）。
// 抽成独立模块是为了让 socket 接线（index.ts）与文件系统逻辑解耦，便于单测。
// （mattpocock「the interface is the test surface」：listDirectory 本身就是测试面。）
//
// 安全不变量（spec §5.2 §6）：
// - denylist 命中统一返回 PATH_NOT_FOUND，绝不暴露敏感目录存在性（无 PATH_FORBIDDEN 码）。
// - 所有入参先 path.resolve 规范化（`..` 被消解）再比对 denylist，遍历无法绕过。
// - 只列目录名 + isDir，不含任何文件元数据。

export interface DirectoryEntry {
  name: string;
  isDir: boolean;
}

export interface ListDirectoryResult {
  ok: boolean;
  entries?: DirectoryEntry[];
  homePath?: string;
  error?: string;
  /** 条目超 MAX_ENTRIES 被截断时为 true（前端据此提示「仅显示前 1000 项」）。 */
  truncated?: boolean;
}

export interface ListDirectoryDeps {
  /** 首参锚点 `~` / 空串展开的根目录。生产用 os.homedir()，测试注入 tmpdir。 */
  home: string;
}

/** 单次响应条目上限（spec §6：防「目录 10 万项」的超大响应）。 */
export const MAX_DIRECTORY_ENTRIES = 1000;

/**
 * 敏感路径 denylist（相对 home），命中者及其子树一律拒列。
 * 与认证相关的凭证目录（呼应 codex-auth-local-oauth / custom-agent-auth-source）：
 * 列出这些目录的名字本身就泄漏凭证布局（如有几个 GCP project、有没有 1password CLI 配置）。
 */
const DENYLIST_HOME_RELATIVE = [
  '.ssh',
  '.aws',
  '.config/gcloud',
  '.codex/auth.json',
  '.claude',
];

// 首参 path 为空串或字面量 `~` 时，列表 daemon 的 $HOME；否则视为绝对路径。
// 所有返回值经 resolve 规范化：`..`、重复斜杠、尾部斜杠在此被消解，
// 调用方拿到的永远是可直接比对 denylist 的规范绝对路径。
function resolveListPath(rawPath: string, home: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '' || trimmed === '~') {
    return resolve(home);
  }
  // `~/foo` 形式展开 home（与 shell 一致）；resolve 同时消解其中可能夹带的 `..`。
  if (trimmed.startsWith('~/')) {
    return resolve(home, trimmed.slice(2));
  }
  return resolve(trimmed);
}

/** candidate 是否命中 denylist（等于某项或位于其子树）。双侧小写归一后比对。 */
function matchesDenylist(candidate: string, resolvedHome: string): boolean {
  const lower = candidate.toLowerCase();
  return DENYLIST_HOME_RELATIVE.some((entry) => {
    const target = resolve(resolvedHome, entry).toLowerCase();
    // startsWith 必须带分隔符边界，否则 `.ssh-backup` 会被 `.ssh` 误伤。
    return lower === target || lower.startsWith(target + sep);
  });
}

/** resolved 是否命中 denylist（比对在 resolve 之后，`..` 无法绕过）。 */
function isDenylisted(resolvedPath: string, home: string): boolean {
  const resolvedHome = resolve(home);
  // 词法层比对（大小写不敏感）：macOS APFS / Windows 默认大小写不敏感，
  // `~/.SSH` 在大小写敏感比对下不命中、readdir 却会成功 → denylist 被绕过。
  // 双侧 toLowerCase 归一堵死；在大小写敏感 FS 上可能过杀（.SSH ≠ .ssh），
  // 但 denylist 语义下过杀即 fail-closed，可接受。
  if (matchesDenylist(resolvedPath, resolvedHome)) {
    return true;
  }
  // 尽力而为挡符号链接：取 on-disk 真实路径再比对一次（`~/innocent -> ~/.ssh`）。
  // 比对锚点也必须是 realpath(home)——macOS 的 /var 本身是 /private/var 的符号链接，
  // 词法 home 与 realpath(target) 前缀不一致会导致漏判。
  // 两侧任一路径含符号链接都要用真实路径重比：入参本身无符号链接、但 home 在符号链接
  // 之后（如 /var/home）时，直接给真实路径的 `realpath(home)/.ssh` 词法不命中、
  // real === resolvedPath 又跳过重比 → 绕过。real===resolvedPath 且 realHome===resolvedHome
  // 时重比与词法层等价（已判 false），此时跳过仅为省一次遍历。
  // 路径不存在时 realpathSync 抛错 → 跳过（后续 readdir 会归一 PATH_NOT_FOUND）。
  try {
    const real = realpathSync(resolvedPath);
    const realHome = realpathSync(resolvedHome);
    if (real !== resolvedPath || realHome !== resolvedHome) {
      return matchesDenylist(real, realHome);
    }
  } catch {
    // 不存在或不可读 → 交给 readdir 的错误归一处理
  }
  return false;
}

export async function listDirectory(
  rawPath: string,
  deps: ListDirectoryDeps,
): Promise<ListDirectoryResult> {
  const target = resolveListPath(rawPath, deps.home);
  // denylist 命中 → PATH_NOT_FOUND（无论该目录是否真实存在，存在性不可知）。
  if (isDenylisted(target, deps.home)) {
    return { ok: false, error: 'PATH_NOT_FOUND' };
  }
  try {
    const dirents = readdirSync(target, { withFileTypes: true });
    // 先按码点排序再截断：截断结果确定（前 1000 个），不丢任意项；
    // 不用 localeCompare（结果依赖运行环境 ICU/locale，跨 daemon 不一致）。
    const entries: DirectoryEntry[] = dirents
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const truncated = entries.length > MAX_DIRECTORY_ENTRIES;
    return {
      ok: true,
      entries: truncated ? entries.slice(0, MAX_DIRECTORY_ENTRIES) : entries,
      homePath: deps.home,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EACCES / EPERM 单独成码：web 据此提示「没有权限」，区别于「路径不存在」。
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, error: 'PERMISSION_DENIED' };
    }
    // ENOENT / ENOTDIR 统一为 PATH_NOT_FOUND（不暴露「目录不存在」vs「是文件」的区别）；
    // 其余未知错误也归一 PATH_NOT_FOUND（fail-closed，不泄漏 fs 细节）。
    return { ok: false, error: 'PATH_NOT_FOUND' };
  }
}

/** 生产环境用的 deps 工厂：home = os.homedir()。 */
export function productionListDirectoryDeps(): ListDirectoryDeps {
  return { home: homedir() };
}

export interface ListDirectoryRateLimiterOptions {
  /** 窗口内最大放行次数（spec §6 建议 10/s）。 */
  max: number;
  /** 滑动窗口长度（毫秒）。 */
  windowMs: number;
  /** 时钟注入点（测试用假时钟）。 */
  now: () => number;
}

/**
 * fs:list 限速器（滑动窗口）：单连接 QPS 上限，防全盘枚举扫描（spec §6）。
 * daemon 与其 server 之间只有一条 socket 连接，per-socket 一个实例即「单连接」语义。
 * 无状态 caller 概念——调用方（index.ts handler）持实例，每次请求前 allow()。
 */
export function createListDirectoryRateLimiter(options: ListDirectoryRateLimiterOptions): {
  allow: () => boolean;
} {
  const timestamps: number[] = [];
  return {
    allow() {
      const now = options.now();
      // 滑出窗口的旧时间戳出队
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
