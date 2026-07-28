import { describe, expect, test } from 'vitest';
import {
  MESSAGE_COLLAPSE_LINE_THRESHOLD,
  countMessageBodyLines,
  messageBodyExceedsLineThreshold,
  messageCollapseMaxHeightCss,
} from '../lib/message-collapse';

describe('message collapse helpers', () => {
  test('uses a 10-line threshold', () => {
    expect(MESSAGE_COLLAPSE_LINE_THRESHOLD).toBe(10);
  });

  test('counts normalized lines including blank lines', () => {
    expect(countMessageBodyLines('')).toBe(0);
    expect(countMessageBodyLines('one')).toBe(1);
    expect(countMessageBodyLines('a\nb\nc')).toBe(3);
    expect(countMessageBodyLines('a\r\nb\rc')).toBe(3);
    expect(countMessageBodyLines('a\n\nb')).toBe(3);
  });

  test('does not collapse at exactly the threshold', () => {
    const exactlyTen = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(messageBodyExceedsLineThreshold(exactlyTen)).toBe(false);
  });

  test('collapses when body exceeds the threshold', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(messageBodyExceedsLineThreshold(eleven)).toBe(true);
  });

  test('long code / log / quote bodies trigger collapse', () => {
    const longCode = ['```ts', ...Array.from({ length: 20 }, (_, i) => `console.log(${i});`), '```'].join('\n');
    const longQuote = Array.from({ length: 12 }, (_, i) => `> quote line ${i + 1}`).join('\n');
    const longLog = Array.from({ length: 15 }, (_, i) => `[info] log entry ${i + 1}`).join('\n');

    expect(messageBodyExceedsLineThreshold(longCode)).toBe(true);
    expect(messageBodyExceedsLineThreshold(longQuote)).toBe(true);
    expect(messageBodyExceedsLineThreshold(longLog)).toBe(true);
  });

  test('short replies stay fully visible', () => {
    expect(messageBodyExceedsLineThreshold('好的')).toBe(false);
    expect(messageBodyExceedsLineThreshold('收到\n马上处理')).toBe(false);
  });

  test('max-height css tracks the line threshold', () => {
    expect(messageCollapseMaxHeightCss()).toBe('calc(1.625em * 10)');
    expect(messageCollapseMaxHeightCss(8)).toBe('calc(1.625em * 8)');
  });
});
