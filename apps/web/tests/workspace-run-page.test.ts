import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runPage = readFileSync(new URL('../app/[networkPath]/runs/[runId]/page.tsx', import.meta.url), 'utf8');

describe('workspace run detail page', () => {
  it('links back to the source chat message when message metadata is available', () => {
    expect(runPage).toContain('sourceMessageHref');
    expect(runPage).toContain("message=${encodeURIComponent(`${run.channelId}:${run.messageId}`)}");
    expect(runPage).toContain('返回消息');
  });

  it('shows the reported workspace run command when it is available', () => {
    expect(runPage).toContain('run.command');
    expect(runPage).toContain('命令');
  });

  it('shows a collapsible workspace run log excerpt when it is available', () => {
    expect(runPage).toContain('run.logExcerpt');
    expect(runPage).toContain('日志摘要');
  });
});
