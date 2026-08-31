/* @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ChannelMessage } from '../components/channel-message';

beforeAll(() => vi.stubGlobal('React', React));
afterEach(cleanup);

describe('dispatch activity rendering', () => {
  test('在用户原消息下渲染请求感知的 Agent 接收状态', () => {
    render(<ChannelMessage msg={{
      id: 'message-1',
      channelId: 'channel-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: '@OpenSNS 将你所具备的技能总结一下，输出为Markdown文件。',
      createdAt: 1,
      dispatchStatus: 'accepted',
      dispatchId: 'dispatch-1',
    }} />);

    expect(screen.getByText(
      'OpenSNS 已接收，正在处理：「将你所具备的技能总结一下，输出为Markdown文件。」',
    )).toBeInTheDocument();
    expect(screen.queryByText('我来处理，会先看请求和附件，再把结果发在线程里。')).not.toBeInTheDocument();
  });

  test('真实 Agent 动态出现后收起结构化处理状态', () => {
    render(<ChannelMessage hasAgentUpdate msg={{
      id: 'message-1',
      channelId: 'channel-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: '@OpenSNS 将你所具备的技能总结一下，输出为Markdown文件。',
      createdAt: 1,
      dispatchStatus: 'accepted',
      dispatchId: 'dispatch-1',
    }} />);

    expect(screen.queryByText(/OpenSNS 已接收/)).not.toBeInTheDocument();
  });
});
