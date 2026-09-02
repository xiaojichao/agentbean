/**
 * Terminal progress for `agentbean update`.
 *
 * TTY: one progress bar line + one task detail line (rewritten in place).
 * Non-TTY / tests: plain sequential lines so logs stay readable.
 */

export interface UpdateProgress {
  /** Announce total steps and optional title (e.g. version range). */
  begin(totalSteps: number, title?: string): void;
  /** Advance to the next step and show its label as the active task. */
  step(label: string): void;
  /** Update the detail line under the bar without advancing the step counter. */
  detail(message: string): void;
  /** Finish successfully; clears live UI and prints a final line. */
  done(message: string): void;
  /** Finish with failure; clears live UI and prints a final line to stderr path. */
  fail(message: string): void;
}

export interface CreateUpdateProgressInput {
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
  readonly write?: (chunk: string) => void;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

const CLEAR_LINE = '\x1b[2K';
const CURSOR_UP = '\x1b[1A';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * East-Asian wide characters occupy two terminal columns. Pure codepoint
 * ranges keep this source ASCII-safe (literal wide chars mutate between tools).
 */
function isWideChar(code: number): boolean {
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
  for (const ch of text) width += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
}

/** 窄于该列数的终端放不下最窄进度条（~24 列）+ 可读任务行，退回顺序输出。 */
const MIN_LIVE_BAR_COLUMNS = 36;

/**
 * Keep the task line within one physical terminal row. paint() moves the
 * cursor up exactly two rows to reach the bar, which only lands on the bar
 * when the task line did not wrap (long paths, narrow terminals, or CJK
 * double-width text all wrap it).
 */
function fitSingleLine(text: string, maxColumns: number): string {
  if (displayWidth(text) <= maxColumns) return text;
  let width = 0;
  let fitted = '';
  for (const ch of text) {
    const w = isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + w > maxColumns - 1) return `${fitted}…`;
    fitted += ch;
    width += w;
  }
  return fitted;
}

export function createUpdateProgress(input: CreateUpdateProgressInput = {}): UpdateProgress {
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  const write = input.write
    ?? ((chunk: string) => {
      process.stderr.write(chunk);
    });
  const isTTY = input.isTTY ?? Boolean(process.stderr.isTTY);
  // Real terminal width (no floor): clamping to a wider value would wrap the
  // bar/task on narrow split panes and break the two-row move-back.
  const columns = () => Math.min(input.columns ?? process.stderr.columns ?? 80, 120);
  // Below this width neither the narrowest bar (~24 cols) nor a readable task
  // line fits without wrapping, so fall back to sequential lines.
  const useLiveBar = isTTY && columns() >= MIN_LIVE_BAR_COLUMNS;

  let total = 0;
  let current = 0;
  let activeLabel = '';
  let detailLine = '';
  let live = false;
  let finished = false;

  function renderBar(): string {
    const width = Math.max(12, Math.min(28, columns() - 28));
    const ratio = total <= 0 ? 0 : Math.min(1, current / total);
    const filled = Math.round(width * ratio);
    const empty = Math.max(0, width - filled);
    const percent = total <= 0 ? 0 : Math.min(100, Math.round(ratio * 100));
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${current}/${total}  ${percent}%`;
  }

  function paint(): void {
    if (!useLiveBar || finished) return;
    const task = fitSingleLine(`正在执行：${detailLine || activeLabel || '…'}`, columns());
    const bar = renderBar();
    if (!live) {
      write(HIDE_CURSOR);
      write(`${CLEAR_LINE}${bar}\n`);
      write(`${CLEAR_LINE}${task}\n`);
      live = true;
      return;
    }
    // Rewrite the two live lines in place. The cursor sits one line below both
    // live lines, so move up two lines to the bar and paint down through both;
    // a single CURSOR_UP lands on the task line and the new bar gets erased by
    // the task write, freezing the bar at its first (0/N) frame.
    write(`${CURSOR_UP}${CURSOR_UP}${CLEAR_LINE}${bar}\n`);
    write(`${CLEAR_LINE}${task}\n`);
  }

  function endLive(): void {
    if (!useLiveBar || !live) return;
    write(SHOW_CURSOR);
    live = false;
  }

  return {
    begin(totalSteps, title) {
      if (finished) return;
      total = Math.max(0, totalSteps);
      current = 0;
      activeLabel = '';
      detailLine = '';
      if (title) stdout(title);
      if (useLiveBar) paint();
    },
    step(label) {
      if (finished) return;
      current = Math.min(total, current + 1);
      activeLabel = label;
      detailLine = label;
      if (useLiveBar) paint();
      else stdout(`[${current}/${total}] ${label}`);
    },
    detail(message) {
      if (finished) return;
      detailLine = message;
      if (useLiveBar) paint();
      else stdout(`  → ${message}`);
    },
    done(message) {
      if (finished) return;
      finished = true;
      endLive();
      stdout(message);
    },
    fail(message) {
      if (finished) return;
      finished = true;
      endLive();
      stderr(message);
    },
  };
}
