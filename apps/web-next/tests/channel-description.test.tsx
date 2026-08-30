// @vitest-environment jsdom
//
// 频道描述两个入口的回归回路：
// 1) 新建频道表单提供描述输入框，且描述随 create 请求走 title 通道；
// 2) 编辑频道对话框的描述初值与提交 payload 均走 title 通道（server 只认 title）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NewChannelDialog } from '../components/new-channel-dialog';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  createChannel: vi.fn(),
  listMembers: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (state: unknown) => unknown) =>
    selector({
      visibleAgents: [],
      currentUser: { id: 'user-1' },
      currentTeamId: 'team-1',
    }),
  useCurrentTeamPath: () => 'team-path',
}));

vi.mock('@/lib/socket', () => ({
  channelEvents: () => ({ create: mocks.createChannel }),
  memberEvents: () => ({ list: mocks.listMembers }),
}));

describe('新建频道描述入口', () => {
  beforeEach(() => {
    mocks.listMembers.mockResolvedValue({ ok: true, humans: [] });
    mocks.createChannel.mockResolvedValue({ ok: true, channel: { id: 'ch-1' } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('表单提供描述输入框', () => {
    render(<NewChannelDialog onClose={() => {}} teamId="team-1" teamPath="team-path" />);
    expect(screen.getByPlaceholderText('这个频道用于什么？')).toBeTruthy();
  });

  test('填写描述后创建请求携带描述（title 通道）', async () => {

    render(<NewChannelDialog onClose={() => {}} teamId="team-1" teamPath="team-path" />);
    fireEvent.change(screen.getByPlaceholderText('频道名 (留空则自动命名)'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByPlaceholderText('这个频道用于什么？'), { target: { value: '运维例行公告' } });
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => expect(mocks.createChannel).toHaveBeenCalledTimes(1));
    expect(mocks.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', name: 'ops', title: '运维例行公告', visibility: 'public' }),
    );
  });
});

describe('编辑频道描述保存', () => {
  const chatSource = readFileSync(join(process.cwd(), 'app/[teamPath]/chat/page.tsx'), 'utf8');

  test('描述初值来自 server 下发的 title 字段', () => {
    expect(chatSource).toContain('channel.title ??');
    expect(chatSource).not.toContain('channel.description ??');
  });

  test('描述提交走 title 通道而非 server 不认识的 description', () => {
    expect(chatSource).toContain('title: description.trim() || null');
    expect(chatSource).not.toContain('description: description.trim() || null');
  });
});
