// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  fetchMemoryAttribution: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  fetchMemoryAttribution: mocks.fetchMemoryAttribution,
}));

import { MemoryAttributionSources } from '../components/MemoryAttributionSources';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.fetchMemoryAttribution.mockReset();
});

function attribution(entries: Array<{ id: string; source: string; selectionReason: string }>) {
  return { ok: true, attribution: { schemaVersion: 1, contextHash: 'sha256:x', entries } };
}

describe('MemoryAttributionSources (#965 AC#4)', () => {
  test('有归因时展示来源作用域标签（去重、固定顺序）', async () => {
    mocks.fetchMemoryAttribution.mockResolvedValue(
      attribution([
        { id: 'm1', source: 'channel_formal_memory', selectionReason: 'current_channel_context' },
        { id: 'm2', source: 'team_formal_memory', selectionReason: 'current_team_policy' },
        { id: 'm3', source: 'team_formal_memory', selectionReason: 'current_team_policy' },
      ]),
    );
    render(<MemoryAttributionSources teamId="team-1" jobId="job-1" />);
    // team 排在 channel 前（固定枚举顺序），且重复的 team 只出现一次。
    expect(await screen.findByText('记忆来源：Team 记忆、频道记忆')).toBeTruthy();
  });

  test('任务来源展示为「任务记忆」', async () => {
    mocks.fetchMemoryAttribution.mockResolvedValue(
      attribution([{ id: 'm1', source: 'task_fact', selectionReason: 'current_task_scope' }]),
    );
    render(<MemoryAttributionSources teamId="team-1" jobId="job-1" />);
    expect(await screen.findByText('记忆来源：任务记忆')).toBeTruthy();
  });

  test('未授权 / fail-closed 返回 null 归因 → 不渲染（不泄露存在性）', async () => {
    mocks.fetchMemoryAttribution.mockResolvedValue({ ok: true, attribution: null });
    const { container } = render(<MemoryAttributionSources teamId="team-1" jobId="job-1" />);
    // 让微任务/effect 跑完。
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
    expect(screen.queryByText(/记忆来源/)).toBeNull();
  });

  test('请求失败 → 不渲染', async () => {
    mocks.fetchMemoryAttribution.mockRejectedValue(new Error('timeout'));
    const { container } = render(<MemoryAttributionSources teamId="team-1" jobId="job-1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });

  test('空 entries → 不渲染', async () => {
    mocks.fetchMemoryAttribution.mockResolvedValue(attribution([]));
    const { container } = render(<MemoryAttributionSources teamId="team-1" jobId="job-1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });
});
