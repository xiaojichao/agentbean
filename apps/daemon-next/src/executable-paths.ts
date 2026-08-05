import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 返回版本管理器与常见 Node 工具链的 bin/shim 目录（home 相对 + 全局）。
 *
 * 单一真相源：scanner（运行时检测）与 executor-helpers（为子进程补 PATH 找 node）
 * 共用此函数，避免两处独立维护导致分叉——历史上 scanner.pathEntries 漏了 nvm/volta/fnm
 * 而 executor-helpers.candidateNodeBinDirs 早已处理，致使 daemon 能执行 nvm 装的 agent
 * 却检测不到它们已安装（装在版本管理器路径的 claude/codex/gemini 显示"未安装"）。
 *
 * daemon 作为 launchd 后台服务时 process.env.PATH 极简（/usr/bin:/bin:/usr/sbin:/sbin），
 * nvm/volta/fnm 只在交互 shell 动态注入 PATH，后台服务必须显式纳入这些位置才能发现可执行文件。
 */
export function executableSearchDirs(home: string | undefined): string[] {
  const dirs: string[] = [];
  const push = (dir: string) => {
    if (dir.length > 0 && !dirs.includes(dir)) dirs.push(dir);
  };

  if (home) {
    // 包管理器全局 shim
    push(join(home, 'Library/pnpm'));
    push(join(home, '.local/share/pnpm'));
    push(join(home, '.local/bin'));
    push(join(home, '.bun/bin'));
    push(join(home, '.npm-global/bin'));
    // 版本管理器静态 current/shim
    push(join(home, '.nvm/current/bin'));
    push(join(home, '.fnm/current/bin'));
    push(join(home, '.volta/bin'));
    push(join(home, '.asdf/shims'));
    push(join(home, '.local/share/mise/shims'));
    // 版本管理器版本化目录（版本号可变，需扫描）
    pushVersionBins(dirs, join(home, '.nvm/versions/node'), 'bin');
    pushVersionBins(dirs, join(home, '.fnm/node-versions'), 'installation/bin');
    pushVersionBins(dirs, join(home, '.local/share/fnm/node-versions'), 'installation/bin');
  }
  // 系统全局
  push('/opt/homebrew/bin');
  push('/usr/local/bin');
  return dirs;
}

/**
 * 把版本管理器的版本化 bin 目录（如 ~/.nvm/versions/node/<ver>/bin）追加到 dirs。
 * 版本号可变，需 readdirSync 扫描；目录不存在或不可读时静默返回。
 */
function pushVersionBins(dirs: string[], versionsDir: string, suffix: string): void {
  let entries: string[];
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return;
  }
  for (const version of entries) {
    const dir = join(versionsDir, version, suffix);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
}
