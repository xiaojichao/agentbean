import { describe, expect, test } from 'vitest';
import { createUpdateProgress } from '../src/update-progress';

/**
 * 迷你终端模拟器：解释进度 UI 用到的 ANSI 序列（清行/上移/换行），
 * 还原就地重绘后的最终屏幕内容。「重绘把新进度条写错行又被任务文本抹掉」
 * 这类 bug 只有在屏幕层面断言才能看见——对原始 chunk 序列做单测抓不住。
 */
class Screen {
  private readonly lines: string[] = [''];
  private row = 0;
  private col = 0;

  write(chunk: string): void {
    for (let index = 0; index < chunk.length; index += 1) {
      const rest = chunk.slice(index);
      if (rest.startsWith('\x1b[')) {
        const control = /^(\x1b\[[?]?[0-9]*[A-Za-z])/.exec(rest)?.[1];
        if (control) {
          this.applyControl(control);
          index += control.length - 1;
          continue;
        }
      }
      const ch = chunk[index];
      if (ch === '\n') {
        this.row += 1;
        this.col = 0;
        this.ensureRow();
        continue;
      }
      this.ensureRow();
      const line = this.lines[this.row] ?? '';
      this.lines[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
      this.col += 1;
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
      return;
    }
    if (control.endsWith('A')) {
      this.row = Math.max(0, this.row - 1);
    }
    // 光标显隐（\x1b[?25l / \x1b[?25h）等其他序列不影响屏幕内容。
  }
}

/** columns=80 → 进度条宽度 = min(28, 80-28) = 28。 */
const bar = (filled: number, current: number, total: number, percent: number): string =>
  `[${'█'.repeat(filled)}${'░'.repeat(28 - filled)}] ${current}/${total}  ${percent}%`;

describe('createUpdateProgress TTY 实时进度条', () => {
  test('重绘把新进度条画到进度条行，而不是冻结在首帧 0/N', () => {
    const screen = new Screen();
    const progress = createUpdateProgress({
      isTTY: true,
      columns: 80,
      write: (chunk) => screen.write(chunk),
      stdout: () => {},
      stderr: () => {},
    });

    progress.begin(5, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('停止 Device Service');
    progress.step('备份当前安装');
    progress.step('安装 @agentbean/daemon@0.3.55');

    // 3/5 = 60%，filled = round(28 × 0.6) = 17。
    expect(screen.line(0)).toBe(bar(17, 3, 5, 60));
    expect(screen.line(1)).toBe('正在执行：安装 @agentbean/daemon@0.3.55');
  });

  test('detail 只更新任务行，不动进度条', () => {
    const screen = new Screen();
    const progress = createUpdateProgress({
      isTTY: true,
      columns: 80,
      write: (chunk) => screen.write(chunk),
      stdout: () => {},
      stderr: () => {},
    });

    progress.begin(5, 'AgentBean 更新 0.3.54 → 0.3.55');
    progress.step('安装 @agentbean/daemon@0.3.55');
    progress.detail('npm install + 模块导入验证（可能需要一到两分钟）…');

    expect(screen.line(0)).toBe(bar(6, 1, 5, 20));
    expect(screen.line(1)).toBe('正在执行：npm install + 模块导入验证（可能需要一到两分钟）…');
  });

  test('done 保留完成的进度条帧并在其下方打印总结', () => {
    const screen = new Screen();
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
