import { describe, expect, test } from 'vitest';
import {
  formatMessageDateLabel,
  formatMessageDateTime,
  shouldShowMessageDateDivider,
} from '../lib/chat-message-date';

describe('频道聊天消息日期时间', () => {
  test('当日分隔线显示“今天”，历史日期显示 YYYY-MM-DD', () => {
    const now = new Date(2026, 7, 9, 12, 0).getTime();

    expect(formatMessageDateLabel(new Date(2026, 7, 9, 8, 30).getTime(), now)).toBe('今天');
    expect(formatMessageDateLabel(new Date(2026, 7, 8, 23, 59).getTime(), now)).toBe('2026-08-08');
  });

  test('每条消息使用 YYYY-MM-DD HH:mm 的本地日期时间', () => {
    const timestamp = new Date(2026, 7, 8, 3, 4).getTime();

    expect(formatMessageDateTime(timestamp)).toBe('2026-08-08 03:04');
  });

  test('首条消息和跨日消息显示分隔线，同日消息不重复显示', () => {
    const morning = new Date(2026, 7, 8, 9, 0).getTime();
    const evening = new Date(2026, 7, 8, 18, 0).getTime();
    const nextDay = new Date(2026, 7, 9, 0, 1).getTime();

    expect(shouldShowMessageDateDivider(undefined, morning)).toBe(true);
    expect(shouldShowMessageDateDivider(morning, evening)).toBe(false);
    expect(shouldShowMessageDateDivider(evening, nextDay)).toBe(true);
  });
});
