// @vitest-environment jsdom

import React from 'react';
import { renderToString } from 'react-dom/server';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import MembersPage from '../app/[teamPath]/members/page';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  routeParams: {} as Record<string, string>,
  push: vi.fn(),
  replace: vi.fn(),
  storeState: {} as Record<string, unknown>,
}));

vi.mock('next/navigation', () => ({
  useParams: () => mocks.routeParams,
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string }) =>
    React.createElement('a', { href }, children),
}));

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (state: unknown) => unknown) => selector(mocks.storeState),
  useCurrentTeamPath: () => 'team-a',
}));

vi.mock('@/lib/socket', () => ({
  memberEvents: () => ({ list: vi.fn().mockResolvedValue({ ok: true, humans: [], agents: [] }) }),
  deviceEvents: () => ({ subscribe: vi.fn(), onSnapshot: () => vi.fn(), onStatus: () => vi.fn() }),
  agentEvents: () => ({ onStatus: () => vi.fn() }),
}));

const OWNER = { userId: 'user-1', username: 'alice', role: 'owner' as const };
const TARGET = { userId: 'user-2', username: 'bob', role: 'member' as const };

beforeEach(() => {
  mocks.routeParams = { teamPath: 'team-a' };
  mocks.storeState = {
    conn: 'open',
    devices: {},
    teams: [{ id: 'team-1', path: 'team-a' }],
    currentUser: { id: OWNER.userId, username: OWNER.username },
    currentTeamId: 'team-1',
    humans: [OWNER, TARGET],
    visibleAgents: [],
    agents: {}, // HumanDetail 用它算「该成员拥有的 Agent」（member-detail.tsx:526）
    applyDevicesSnapshot: vi.fn(),
    applyDeviceStatus: vi.fn(),
    applyAgentsSnapshot: vi.fn(),
    applyAgentStatus: vi.fn(),
    applyHumansSnapshot: vi.fn(),
    upsertHuman: vi.fn(),
    removeHuman: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MembersPage 选中项派生于路由（#853）', () => {
  // 这一组用 renderToString 而不是 testing-library 的 render，是刻意的：
  // renderToString 只做一次同步 render，**effect 完全不跑**，正好等于「首帧」。
  // testing-library 的 render 内部由 act() 包裹，会同步 flush passive effect ——
  // 于是「useState(null) + effect 从路由补回」的旧实现也能通过，测试对本回归失去敏感度
  // （实测过：回退产品改动后 act 版断言仍全绿）。
  //
  // 首帧之所以是真实可观测的一帧：/[teamPath]/human/[userId] 是独立 route segment
  // （其 page 只是 `return <MembersPage />`），从列表跳详情会让本组件卸载重挂载、
  // 所有 useState 归零。browser smoke #853 的失败就发生在这一帧——
  // waitForWebUiHumanMemberAction 命中之后、page.click 之前，按钮消失。
  test('首帧（effect 未跑）即渲染成员详情与管理按钮', () => {
    mocks.routeParams = { teamPath: 'team-a', userId: TARGET.userId };

    const html = renderToString(React.createElement(MembersPage));

    expect(html).toContain('data-smoke="human-member-detail"');
    expect(html).toContain(`data-user-id="${TARGET.userId}"`);
    // smoke 真正点击的那个按钮：它与详情同生同死，重挂载丢帧时一起消失。
    expect(html).toContain('data-smoke="member-role-promote-admin"');
    expect(html).not.toContain('选择左侧成员查看详情');
  });

  test('首帧停在列表路由时是空态', () => {
    const html = renderToString(React.createElement(MembersPage));

    expect(html).not.toContain('data-smoke="human-member-detail"');
    expect(html).toContain('选择左侧成员查看详情');
  });

  test('effect 跑完后（客户端稳定态）详情与按钮仍在', () => {
    mocks.routeParams = { teamPath: 'team-a', userId: TARGET.userId };

    render(React.createElement(MembersPage));

    const detail = document.querySelector('[data-smoke="human-member-detail"]');
    expect(detail).not.toBeNull();
    expect(detail?.getAttribute('data-user-id')).toBe(TARGET.userId);
    expect(detail?.getAttribute('data-member-role')).toBe('member');
    expect(document.querySelector('[data-smoke="member-role-promote-admin"]')).not.toBeNull();
    expect(screen.queryByText('选择左侧成员查看详情')).toBeNull();
  });

  test('停在列表路由时首帧是空态', () => {
    render(React.createElement(MembersPage));

    expect(document.querySelector('[data-smoke="human-member-detail"]')).toBeNull();
    expect(screen.queryByText('选择左侧成员查看详情')).not.toBeNull();
  });

  test('路由指向不存在的成员时不渲染详情，也不崩溃', () => {
    mocks.routeParams = { teamPath: 'team-a', userId: 'ghost-user' };

    render(React.createElement(MembersPage));

    expect(document.querySelector('[data-smoke="human-member-detail"]')).toBeNull();
  });
});
