function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatMessageDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

export function formatMessageDateLabel(timestamp: number, now = Date.now()): string {
  return formatMessageDate(timestamp) === formatMessageDate(now)
    ? '今天'
    : formatMessageDate(timestamp);
}

export function formatMessageDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${formatMessageDate(timestamp)} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

export function millisecondsUntilNextLocalDate(now = Date.now()): number {
  const date = new Date(now);
  const nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return Math.max(0, nextDate.getTime() - now);
}

export function shouldShowMessageDateDivider(
  previousTimestamp: number | undefined,
  currentTimestamp: number,
): boolean {
  return previousTimestamp === undefined
    || formatMessageDate(previousTimestamp) !== formatMessageDate(currentTimestamp);
}
