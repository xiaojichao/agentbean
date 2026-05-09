import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelative } from '../lib/format-time.js';

afterEach(() => vi.useRealTimers());

describe('formatRelative', () => {
  it('returns 刚刚 for less than a minute', () => {
    vi.useFakeTimers().setSystemTime(60_000);
    expect(formatRelative(45_000)).toBe('刚刚');
  });
  it('returns N 分钟前', () => {
    vi.useFakeTimers().setSystemTime(10 * 60_000);
    expect(formatRelative(7 * 60_000)).toBe('3 分钟前');
  });
  it('returns N 小时前', () => {
    vi.useFakeTimers().setSystemTime(3 * 3600_000);
    expect(formatRelative(60_000)).toBe('2 小时前');
  });
});
