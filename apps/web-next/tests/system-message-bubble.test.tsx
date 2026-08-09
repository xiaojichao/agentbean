// @vitest-environment jsdom

/**
 * SystemMessageBubble 集成测试:堵住 #1100 后发现的 CI 盲点——
 * 此前 system 消息(output-package meta)被 ChatBubble/channel-message 的 system 早返回吃掉,
 * 只显示「Agent 交付 N 个文件」药丸,文件包卡片结构性不可达。现有测试只单测
 * <OutputPackageCard> 组件,没覆盖「system 消息 → 卡片」这条路径。
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  // OutputPackageCard 的 useEffect 调 getOutputPackage(...).then(...);mock 必须返回 Promise,
  // 否则 undefined.then 抛错(传 channelId 时触发查询)。返回 {ok:false} → 卡片纯静态展示。
  getOutputPackage: vi.fn().mockResolvedValue({ ok: false }),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({ getOutputPackage: mocks.getOutputPackage }),
}));

import { SystemMessageBubble } from '../components/SystemMessageBubble';
import type { ChatMessage } from '@/lib/schema';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const packageMeta = {
  kind: 'output-package' as const,
  packageId: 'pkg-1',
  taskId: 'task-1',
  taskTitle: '写剧本',
  agentName: 'Agent-A',
  memberCount: 1,
  members: [
    { shortLabel: 'F1', filename: 'ep1.md', artifactVersionId: 'ver-1', collectionId: 'col-1' },
  ],
  workspaceRevisionId: 'rev-1',
  publishId: 'pub-1',
  createdAt: 1000,
};

const systemMsg = {
  id: 'msg-1',
  senderKind: 'system',
  body: 'Agent 交付 1 个文件',
  channelId: 'ch-1',
  teamId: 't-1',
  createdAt: new Date(2026, 7, 9, 19, 17).getTime(),
} as unknown as ChatMessage;

describe('SystemMessageBubble —— system 消息渲染文件包卡片', () => {
  test('output-package system 消息渲染为卡片(出现文件名),而非琥珀药丸 body', () => {
    const { container } = render(<SystemMessageBubble msg={systemMsg} meta={packageMeta} />);
    // 卡片渲染了冻结成员的文件名
    expect(container.textContent).toContain('ep1.md');
    // 药丸兜底 body 不出现(被卡片替代)
    expect(container.textContent).not.toContain('Agent 交付 1 个文件');
  });

  test('普通 system 消息(非 output-package meta)仍渲染兜底药丸', () => {
    const { container } = render(
      <SystemMessageBubble msg={systemMsg} meta={{ kind: 'plain-event' }} />,
    );
    expect(container.textContent).toContain('Agent 交付 1 个文件');
    expect(container.textContent).not.toContain('ep1.md');
  });

  test('output-package 卡片挂载 chat-message 锚点(data-smoke)', () => {
    const { container } = render(<SystemMessageBubble msg={systemMsg} meta={packageMeta} />);
    expect(container.querySelector('[data-smoke="chat-message"]')).not.toBeNull();
  });

  test('system 消息同样显示完整日期时间', () => {
    const { container } = render(
      <SystemMessageBubble msg={systemMsg} meta={{ kind: 'plain-event' }} />,
    );
    expect(container.textContent).toContain('2026-08-09 19:17');
  });
});
