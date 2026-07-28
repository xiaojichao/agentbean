/** 频道消息正文默认折叠阈值：超过该行数时显示「展开」。 */
export const MESSAGE_COLLAPSE_LINE_THRESHOLD = 10;

/**
 * 折叠预览高度：相对父级字号的 `em`，与 `leading-relaxed`（1.625）对齐。
 * 用于 CSS max-height，使预览约等于阈值行数。
 */
export function messageCollapseMaxHeightCss(
  maxLines: number = MESSAGE_COLLAPSE_LINE_THRESHOLD,
): string {
  return `calc(1.625em * ${maxLines})`;
}

/** 归一化换行后统计正文行数（空行也占垂直空间，计入阈值）。 */
export function countMessageBodyLines(body: string): number {
  if (!body) return 0;
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length === 0) return 0;
  return normalized.split('\n').length;
}

/** 正文行数是否超过折叠阈值（> maxLines 才折叠，恰好 maxLines 行仍完整展示）。 */
export function messageBodyExceedsLineThreshold(
  body: string,
  maxLines: number = MESSAGE_COLLAPSE_LINE_THRESHOLD,
): boolean {
  return countMessageBodyLines(body) > maxLines;
}
