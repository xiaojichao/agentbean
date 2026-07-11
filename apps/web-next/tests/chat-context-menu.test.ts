import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

function messageContextMenuSource(): string {
  const start = source.indexOf('aria-label="Message context menu"');
  const end = source.indexOf('{/* Avatar */}', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('message context menu', () => {
  it('keeps the channel chat right-click menu aligned with Raft', () => {
    const menu = messageContextMenuSource();

    expect(menu).toContain('label="复制链接"');
    expect(menu).toContain('label="复制 Markdown"');
    expect(menu).toContain('label="选中消息"');
    expect(menu).toContain('label="打开讨论串"');
    expect(menu).toContain("label={saved ? '取消收藏' : '保存消息'}");
    expect(menu).toContain('label="取消关注讨论串"');
    expect(menu).toContain('label="标记为完成"');
    expect(menu).toContain('label="转换为任务"');

    expect(menu).not.toContain('label="复制文本"');
    expect(menu).not.toContain('label={readDone');
    expect(menu).not.toContain('label="固定到频道"');
    expect(menu).not.toContain('label="查看任务详情"');
    expect(menu).not.toContain('label="重新打开任务"');
  });
});
