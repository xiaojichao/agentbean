import { describe, expect, test } from 'vitest';
import { createUpdateProgress } from '../src/update-progress';

/** 与 src 相同的 East-Asian 宽字符码点范围（中文/全角占 2 列）。 */
function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6);
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
}

/**
 * 迷你终端模拟器：解释进度 UI 用到的 ANSI 序列（清行/上移/换行）并按
 * 物理列宽建模自动折行与 CJK 双宽，还原就地重绘后的最终屏幕内容。
 * 「重绘写错行」「任务折行导致上移两行落空」这类 bug 只有在屏幕层面
 * 断言才能看见——对原始 chunk 序列做单测抓不住。
 */
class Screen {
  private readonly lines: string[] = [''];
  private row = 0;
  /** 当前行的显示列（宽字符占 2 列）与 UTF-16 码元位置分开跟踪。 */
  private col = 0;
  private cell = 0;

  constructor(private readonly columns: number) {}

  write(chunk: string): void {
    let index = 0;
    while (index < chunk.length) {
      if (chunk[index] === '\x1b') {
        const control = /^(\x1b\[[?]?[0-9]*[A-Za-z])/.exec(chunk.slice(index))?.[1];
        if (control) {
          this.applyControl(control);
          index += control.length;
          continue;
        }
        index += 1;
        continue;
      }
      if (chunk[index] === '\n') {
        this.row += 1;
        this.col = 0;
        this.cell = 0;
        this.ensureRow();
        index += 1;
        continue;
      }
      const ch = chunk[index];
      const w = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
      if (this.col + w > this.columns) {
        this.row += 1;
        this.col = 0;
        this.cell = 0;
        this.ensureRow();
      }
      this.ensureRow();
      const line = this.lines[this.row] ?? '';
      this.lines[this.row] = line.slice(0, this.cell) + ch + line.slice(this.cell + 1);
      this.col += w;
      this.cell += 1;
      index += 1;
    }
  }

  line(row: number): string {
    return (this.lines[row] ?? '').trimEnd();
  }

  private ensureRow(): void {
    while (this.lines.length <= this.row) this.lines.push('');
  }

  private applyControl(control: string): void {
    if (control === '\x1b[2K') {
      this.ensureRow();
      this.lines[this.row] = '';
      this.col = 0;
      this.cell = 0;
      return;
    }
    if (control.endsWith('A')) {
      this.row = Math.max(0, this.row - 1);
    }
    // 光标显隐（\x1b[?25l / \x1b[?25h）等其他序列不影响屏幕内容。
  }
}

/** progress 宽度公式：columns=80 → bar 宽 min(28, 80-28) = 28。 */
const bar = (filled: number, current: number, total: number, percent: number): string =>
  `[${'█'.repeat(filled)}${'░'.repeat(28 - filled)}] ${current}/${total}  ${percent}%`;

function ttyProgress(screen: Screen) {
  return createUpdateProgress({
    isTTY: true,
    columns: 80,
    write: (chunk) => screen.write(chunk),
    stdout: () => {},
    stderr: () => {},
  });
}

describe('createUpdateProgress TTY 实时进度条', () => {
  test('重绘把新进度条画到进度条行，而不是冻结在首帧 0/N', () => {
    const screen = new Screen(80);
    const progress = ttyProgress(screen);

    progress.begin(5, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('停止 Device Service');
    progress.step('备份当前安装');
    progress.step('安装 @agentbean/daemon@0.3.55');

    // 3/5 = 60%，filled = round(28 × 0.6) = 17。
    expect(screen.line(0)).toBe(bar(17, 3, 5, 60));
    expect(screen.line(1)).toBe('正在执行：安装 @agentbean/daemon@0.3.55');
  });

  test('detail 只更新任务行，不动进度条', () => {
    const screen = new Screen(80);
    const progress = ttyProgress(screen);

    progress.begin(5, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('安装 @agentbean/daemon@0.3.55');
    progress.detail('npm install + 模块导入验证（可能需要一到两分钟）…');

    expect(screen.line(0)).toBe(bar(6, 1, 5, 20));
    expect(screen.line(1)).toBe('正在执行：npm install + 模块导入验证（可能需要一到两分钟）…');
  });

  test('done 保留完成的进度条帧并在其下方打印总结', () => {
    const screen = new Screen(80);
    const printed: string[] = [];
    const progress = createUpdateProgress({
      isTTY: true,
      columns: 80,
      write: (chunk) => screen.write(chunk),
      stdout: (message) => printed.push(message),
      stderr: (message) => printed.push(message),
    });

    progress.begin(5, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('停止 Device Service');
    progress.step('备份当前安装');
    progress.step('安装 @agentbean/daemon@0.3.55');
    progress.step('启动 Device Service');
    progress.step('清理备份');
    progress.done('AgentBean 已更新到 0.3.55，Device Service 已安全重启。');

    expect(screen.line(0)).toBe(bar(28, 5, 5, 100));
    expect(screen.line(1)).toBe('正在执行：清理备份');
    expect(printed).toContain('AgentBean 已更新到 0.3.55，Device Service 已安全重启。');
  });
});

describe('createUpdateProgress 任务行单行不变量（Codex P2）', () => {
  // paint() 上移两行回到进度条行的前提是任务行恰好占一个物理行；
  // 长路径/窄终端/CJK 双宽都会让任务折行，必须截断到一行显示宽度。

  test('超长 ASCII 路径 detail 截断到一行，重绘不错位', () => {
    const screen = new Screen(80);
    const progress = ttyProgress(screen);
    const longDetail = `快照 → /Users/shaw/.nvm/versions/node/v24.11.0/lib/agentbean-daemon-update-backup/${'x'.repeat(120)}`;

    progress.begin(5, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('备份当前安装');
    progress.detail(longDetail);

    // 任务行只占一个物理行：以省略号结尾、宽度不超过终端列数、第三行留空。
    expect(screen.line(1).endsWith('…')).toBe(true);
    expect(displayWidth(screen.line(1))).toBeLessThanOrEqual(80);
    expect(screen.line(2)).toBe('');

    // 折行被消除后，后续重绘仍落回进度条行。
    progress.step('安装 @agentbean/daemon@0.3.55');
    expect(screen.line(0)).toBe(bar(11, 2, 5, 40));
    expect(screen.line(2)).toBe('');
  });

  test('超长中文 detail 按 2 列宽度截断', () => {
    const screen = new Screen(80);
    const progress = ttyProgress(screen);
    // 「正在执行：」前缀 10 列 + 60 个中文字 120 列，远超 80 列。
    const longDetail = '正在备份当前安装目录以免换包失败无法回滚恢复'.repeat(3);

    progress.begin(5, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('备份当前安装');
    progress.detail(longDetail);

    expect(screen.line(1).endsWith('…')).toBe(true);
    expect(displayWidth(screen.line(1))).toBeLessThanOrEqual(80);
    expect(screen.line(2)).toBe('');
  });
});

describe('createUpdateProgress 窄终端降级（Codex P2 第二轮）', () => {
  // <36 列的分屏终端里最窄 bar（~24 列）也放不下；退回顺序行输出，
  // 避免按被 clamp 的列数截断后任务行依然折行、重绘再次错位。

  test('20 列终端退回顺序行输出，不写任何 ANSI', () => {
    const printed: string[] = [];
    const writes: string[] = [];
    const progress = createUpdateProgress({
      isTTY: true,
      columns: 20,
      write: (chunk) => writes.push(chunk),
      stdout: (message) => printed.push(message),
      stderr: (message) => printed.push(`ERR:${message}`),
    });

    progress.begin(3, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('停止 Device Service');
    progress.detail('bootout LaunchAgent…');

    expect(writes.join('')).toBe('');
    expect(printed).toEqual([
      'AgentBean 更新 0.3.54 → 0.3.55',
      '[1/3] 停止 Device Service',
      '  → bootout LaunchAgent…',
    ]);
  });

  test('36 列边界仍走 live bar，任务行按真实列数截断不折行', () => {
    const screen = new Screen(36);
    const progress = createUpdateProgress({
      isTTY: true,
      columns: 36,
      write: (chunk) => screen.write(chunk),
      stdout: () => {},
      stderr: () => {},
    });

    progress.begin(5, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('备份当前安装');
    progress.detail(`快照 → ${'/opt/agentbean/'.repeat(8)}`);

    // 36 列下 bar 宽 = max(12, 36-28) = 12。
    expect(screen.line(0)).toBe(`[${'█'.repeat(2)}${'░'.repeat(10)}] 1/5  20%`);
    expect(screen.line(1).endsWith('…')).toBe(true);
    expect(displayWidth(screen.line(1))).toBeLessThanOrEqual(36);
    expect(screen.line(2)).toBe('');
  });
});
