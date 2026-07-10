// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddAgentModal } from '../components/add-agent-modal';
import { RegisterAgentModal } from '../components/register-agent-modal';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  setVisibility: vi.fn(),
  listDevices: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  agentEvents: () => ({
    create: mocks.create,
    setVisibility: mocks.setVisibility,
  }),
  deviceEvents: () => ({ list: mocks.listDevices }),
}));

vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (state: { currentTeamId: string }) => unknown) => selector({ currentTeamId: 'team-1' }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('agent registration modals', () => {
  test('AddAgentModal sends its explicit team and device without inventing a command', async () => {
    mocks.create.mockResolvedValue({ ok: true });
    render(React.createElement(AddAgentModal, {
      open: true,
      teamId: 'team-1',
      deviceId: 'device-scan-1',
      onClose: vi.fn(),
    }));

    expect(screen.queryByText('创建者')).toBeNull();
    expect(screen.queryByText('可见性')).toBeNull();
    expect(screen.queryByText('团队')).toBeNull();

    const name = screen.getByPlaceholderText('例如：Codex-肖');
    fireEvent.change(name, { target: { value: 'Custom Agent' } });
    fireEvent.submit(name.closest('form')!);

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      teamId: 'team-1',
      deviceId: 'device-scan-1',
      name: 'Custom Agent',
    });
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('command');
  });

  test('RegisterAgentModal creates an executor on the device that produced the scan', async () => {
    mocks.create.mockResolvedValue({ ok: true });
    mocks.listDevices.mockResolvedValue({
      ok: true,
      devices: [{ id: 'wrong-device', status: 'online' }],
    });
    render(React.createElement(RegisterAgentModal, {
      open: true,
      teamId: 'team-1',
      scanDeviceId: 'device-scan-1',
      discoveredAgent: {
        name: 'Codex',
        category: 'executor-hosted',
        adapterKind: 'codex',
        command: '',
        source: 'filesystem',
      },
      onClose: vi.fn(),
    }));

    expect(screen.queryByText('角色')).toBeNull();
    expect(screen.queryByText('团队')).toBeNull();
    expect(screen.queryByText('可见性')).toBeNull();

    const name = screen.getByPlaceholderText('例如：Codex-肖');
    fireEvent.submit(name.closest('form')!);

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.listDevices).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      teamId: 'team-1',
      deviceId: 'device-scan-1',
      name: 'Codex',
    });
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('command');
  });

  test('RegisterAgentModal never turns an automatically registered AgentOS agent into a custom agent', async () => {
    mocks.create.mockResolvedValue({ ok: true });
    mocks.listDevices.mockResolvedValue({
      ok: true,
      devices: [{ id: 'wrong-device', status: 'online' }],
    });
    render(React.createElement(RegisterAgentModal, {
      open: true,
      teamId: 'team-1',
      scanDeviceId: 'device-scan-1',
      discoveredAgent: {
        name: 'Hermes',
        category: 'agentos-hosted',
        adapterKind: 'hermes',
        command: 'hermes gateway',
        source: 'gateway',
      },
      onClose: vi.fn(),
    }));

    expect(screen.getByText('AgentOS Agent 已由设备自动注册，无需再创建自定义 Agent。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '注册' })).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.listDevices).not.toHaveBeenCalled();
  });
});
