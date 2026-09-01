// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentExposurePanel } from '../components/AgentExposurePanel';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  upsertAutoAcceptPolicy: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  agentExposureEvents: () => ({
    getActive: vi.fn().mockResolvedValue({
      ok: true,
      projection: {
        manifestId: 'manifest-1', agentId: 'agent-1', revision: 3,
        capabilities: [{
          name: '代码审查', description: '审查代码',
          registry: { capabilityId: 'cap-review', registryVersion: 1 }, evidence: [],
        }],
        skills: [], constraints: [], availability: { status: 'available' }, validUntil: null,
      },
    }),
    listRevisions: vi.fn().mockResolvedValue({ ok: true, revisions: [], activeRestriction: null }),
    getAutoAcceptPolicy: vi.fn().mockResolvedValue({ ok: true, policy: null }),
    createDraft: vi.fn(), publish: vi.fn(), revoke: vi.fn(), upsertRestriction: vi.fn(),
    upsertAutoAcceptPolicy: mocks.upsertAutoAcceptPolicy,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Agent auto-accept policy panel (#1270)', () => {
  test('owner 一次授权公开能力后，后续消息无需 composer 协作开关', async () => {
    mocks.upsertAutoAcceptPolicy.mockResolvedValue({
      ok: true,
      policy: {
        id: 'policy-1', teamId: 'team-1', agentId: 'agent-1', manifestId: 'manifest-1',
        manifestRevision: 3, revision: 1, enabled: true, allowedCapabilityIds: ['cap-review'],
        allowUnspecifiedCapabilities: true, allowedRiskLevels: ['low'],
        allowFrozenProjectInputs: false, requireCompletePreview: true, maxActiveClaims: 1,
        validUntil: null, updatedBy: 'user-1', createdAt: 1, updatedAt: 1,
      },
    });
    render(<AgentExposurePanel teamId="team-1" agentId="agent-1" canManage canRestrict={false} />);

    await screen.findByText('自动认领策略');
    expect((screen.getByLabelText('代码审查') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('启用自动认领'));
    fireEvent.click(screen.getByRole('button', { name: '保存自动认领策略' }));

    await waitFor(() => expect(mocks.upsertAutoAcceptPolicy).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', agentId: 'agent-1', enabled: true,
      allowedCapabilityIds: ['cap-review'], allowUnspecifiedCapabilities: true,
      allowedRiskLevels: ['low'], maxActiveClaims: 1,
    })));
    expect(await screen.findByText(/自动认领策略已保存/)).toBeTruthy();
  });

  test('非 owner 不读取或展示自动认领策略', async () => {
    render(<AgentExposurePanel teamId="team-1" agentId="agent-1" canManage={false} canRestrict={false} />);
    await screen.findByText(/当前 revision/);
    expect(screen.queryByText('自动认领策略')).toBeNull();
    expect(mocks.upsertAutoAcceptPolicy).not.toHaveBeenCalled();
  });
});
