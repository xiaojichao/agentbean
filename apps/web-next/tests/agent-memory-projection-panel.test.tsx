// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  createDraft: vi.fn(),
  publish: vi.fn(),
  withdraw: vi.fn(),
  listRevisions: vi.fn(),
  upsertOptIn: vi.fn(),
  getConsumable: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  agentMemoryProjectionEvents: () => ({
    createDraft: mocks.createDraft,
    publish: mocks.publish,
    withdraw: mocks.withdraw,
    listRevisions: mocks.listRevisions,
    upsertOptIn: mocks.upsertOptIn,
    getConsumable: mocks.getConsumable,
  }),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const activeProjection = {
  schemaVersion: 1, id: 'p1', teamId: 'team-1', agentId: 'agent-1', revision: 1,
  status: 'active' as const, kind: 'preference' as const, content: 'prefers concise replies',
  summary: 'concise', tags: ['style'], sourceRefs: [], validFrom: 100, validUntil: null,
  publishedBy: 'u1', publishedAt: 100, supersededById: null, createdBy: 'u1', createdAt: 100, updatedAt: 100,
};

describe('AgentMemoryProjectionPanel (issue #718 AC#6)', () => {
  beforeEach(() => {
    mocks.listRevisions.mockResolvedValue({ ok: true, revisions: [activeProjection], activeOptIn: null });
  });

  test('owner 渲染当前投影内容、类型标签与发布按钮', async () => {
    const { AgentMemoryProjectionPanel } = await import('../components/AgentMemoryProjectionPanel');
    render(React.createElement(AgentMemoryProjectionPanel, {
      teamId: 'team-1', agentId: 'agent-1', canManage: true, canOptIn: false,
    }));
    // active 展示与 draft 表单（draft 预填当前 active）都会渲染 content/kind → findAll 容忍重复
    expect((await screen.findAllByText('prefers concise replies')).length).toBeGreaterThanOrEqual(1);
    expect((await screen.findAllByText('偏好')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: '发布' })).toBeTruthy();
  });

  test('非 owner 不显示发布按钮，仅提示', async () => {
    const { AgentMemoryProjectionPanel } = await import('../components/AgentMemoryProjectionPanel');
    render(React.createElement(AgentMemoryProjectionPanel, {
      teamId: 'team-1', agentId: 'agent-1', canManage: false, canOptIn: false,
    }));
    await screen.findByText('prefers concise replies');
    expect(screen.queryByRole('button', { name: '发布' })).toBeNull();
    expect(screen.getByText('仅 Agent 拥有者可发布或撤回投影。')).toBeTruthy();
  });

  test('owner 发布流程依次调用 createDraft + publish', async () => {
    mocks.createDraft.mockResolvedValue({ ok: true, projection: { ...activeProjection, id: 'p2', status: 'draft' } });
    mocks.publish.mockResolvedValue({ ok: true, projection: { ...activeProjection, id: 'p2', revision: 2 } });
    const { AgentMemoryProjectionPanel } = await import('../components/AgentMemoryProjectionPanel');
    render(React.createElement(AgentMemoryProjectionPanel, {
      teamId: 'team-1', agentId: 'agent-1', canManage: true, canOptIn: false,
    }));
    const contentArea = await screen.findByPlaceholderText('投影内容（面向本 Team 的公开最小化记忆）');
    fireEvent.change(contentArea, { target: { value: '新内容' } });
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => {
      expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({ content: '新内容', agentId: 'agent-1' }));
      expect(mocks.publish).toHaveBeenCalledWith({ teamId: 'team-1', projectionId: 'p2' });
    });
  });

  test('owner 撤回调用 withdraw', async () => {
    mocks.withdraw.mockResolvedValue({ ok: true, withdrawn: true });
    mocks.listRevisions.mockResolvedValueOnce({ ok: true, revisions: [activeProjection], activeOptIn: null })
      .mockResolvedValue({ ok: true, revisions: [], activeOptIn: null });
    const { AgentMemoryProjectionPanel } = await import('../components/AgentMemoryProjectionPanel');
    render(React.createElement(AgentMemoryProjectionPanel, {
      teamId: 'team-1', agentId: 'agent-1', canManage: true, canOptIn: false,
    }));
    const revokeBtn = await screen.findByRole('button', { name: '撤回当前' });
    fireEvent.click(revokeBtn);
    await waitFor(() => {
      expect(mocks.withdraw).toHaveBeenCalledWith({ teamId: 'team-1', agentId: 'agent-1' });
    });
  });

  test('Team admin 启用 opt-in 调用 upsertOptIn', async () => {
    mocks.upsertOptIn.mockResolvedValue({ ok: true, optIn: { id: 'o1', teamId: 'team-1', agentId: 'agent-1', projectionId: 'p1', enabled: true, updatedBy: 'admin', updatedAt: 100 } });
    const { AgentMemoryProjectionPanel } = await import('../components/AgentMemoryProjectionPanel');
    render(React.createElement(AgentMemoryProjectionPanel, {
      teamId: 'team-1', agentId: 'agent-1', canManage: false, canOptIn: true,
    }));
    const enableBtn = await screen.findByRole('button', { name: '启用' });
    fireEvent.click(enableBtn);
    await waitFor(() => {
      expect(mocks.upsertOptIn).toHaveBeenCalledWith({ teamId: 'team-1', agentId: 'agent-1', enabled: true });
    });
  });
});
