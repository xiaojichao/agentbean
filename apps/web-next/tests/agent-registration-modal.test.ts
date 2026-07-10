// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddAgentModal } from '../components/add-agent-modal';
import { RegisterAgentModal } from '../components/register-agent-modal';
import { findRegisteredExecutor } from '../lib/agent-registration';
import RegisterPage from '../app/register/page';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  setVisibility: vi.fn(),
  listDevices: vi.fn(),
  scanDevice: vi.fn(),
  storeState: {
    discovered: [] as unknown[],
    agents: {} as Record<string, unknown>,
    discovering: false,
    currentTeamId: 'team-1',
    setDiscovered: vi.fn(),
    setRuntimes: vi.fn(),
    setDiscovering: vi.fn(),
  },
}));

vi.mock('@/lib/socket', () => ({
  agentEvents: () => ({
    create: mocks.create,
    setVisibility: mocks.setVisibility,
    onDiscovered: () => vi.fn(),
  }),
  deviceEvents: () => ({ list: mocks.listDevices, scan: mocks.scanDevice }),
  getWebSocket: () => ({}),
}));

vi.mock('@/lib/store', () => {
  const useAgentBeanStore = (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState);
  useAgentBeanStore.getState = () => mocks.storeState;
  return { useAgentBeanStore };
});

beforeEach(() => {
  mocks.storeState.discovered = [];
  mocks.storeState.agents = {};
  mocks.storeState.discovering = false;
  mocks.storeState.currentTeamId = 'team-1';
});

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

  test('matches a discovered executor to its real custom agent instead of a name slug', () => {
    const match = findRegisteredExecutor(
      {
        name: 'Codex Local',
        category: 'executor-hosted',
        adapterKind: 'codex',
        command: 'codex',
        source: 'filesystem',
      },
      [
        {
          id: 'server-random-agent-id',
          primaryTeamId: 'team-1',
          visibleTeamIds: ['team-1'],
          name: 'Codex Local',
          role: 'agent',
          adapterKind: 'codex',
          category: 'executor-hosted',
          source: 'custom',
          deviceId: 'device-scan-1',
          status: 'online',
          lastSeenAt: 1,
          connectCommand: '',
        },
        {
          id: 'same-name-wrong-device',
          primaryTeamId: 'team-1',
          visibleTeamIds: ['team-1'],
          name: 'Codex Local',
          role: 'agent',
          adapterKind: 'codex',
          category: 'executor-hosted',
          source: 'custom',
          deviceId: 'other-device',
          status: 'online',
          lastSeenAt: 1,
          connectCommand: '',
        },
        {
          id: 'same-runtime-not-custom',
          primaryTeamId: 'team-1',
          visibleTeamIds: ['team-1'],
          name: 'Codex Local',
          role: 'agent',
          adapterKind: 'codex',
          category: 'executor-hosted',
          source: 'scanned',
          deviceId: 'device-scan-1',
          status: 'online',
          lastSeenAt: 1,
          connectCommand: '',
        },
      ],
      'device-scan-1',
    );

    expect(match?.id).toBe('server-random-agent-id');
  });

  test('updates the real matched agent and preserves its current team visibility by default', async () => {
    mocks.setVisibility.mockResolvedValue({ ok: true });
    render(React.createElement(RegisterAgentModal, {
      open: true,
      teamId: 'team-1',
      scanDeviceId: 'device-scan-1',
      registeredAgentId: 'server-random-agent-id',
      initiallyVisible: true,
      mode: 'update',
      discoveredAgent: {
        name: 'Codex Local',
        category: 'executor-hosted',
        adapterKind: 'codex',
        command: 'codex',
        source: 'filesystem',
      },
      onClose: vi.fn(),
    }));

    expect((screen.getByRole('checkbox', { name: '在当前团队中可见' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mocks.setVisibility).toHaveBeenCalledTimes(1));
    expect(mocks.setVisibility).toHaveBeenCalledWith('server-random-agent-id', 'team-1', true);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  test('RegisterPage offers edit instead of duplicate create for a matched custom executor', async () => {
    mocks.listDevices.mockResolvedValue({ ok: true, devices: [{ id: 'device-scan-1', status: 'online' }] });
    mocks.storeState.discovered = [{
      name: 'Codex Local',
      category: 'executor-hosted',
      adapterKind: 'codex',
      command: 'codex',
      source: 'filesystem',
    }];
    mocks.storeState.agents = {
      'server-random-agent-id': {
        id: 'server-random-agent-id',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        name: 'Codex Local',
        role: 'agent',
        adapterKind: 'codex',
        category: 'executor-hosted',
        source: 'custom',
        deviceId: 'device-scan-1',
        status: 'online',
        lastSeenAt: 1,
        connectCommand: '',
      },
    };

    render(React.createElement(RegisterPage));

    const editButton = await screen.findByRole('button', { name: '编辑配置' });
    expect(screen.queryByRole('button', { name: '注册' })).toBeNull();
    fireEvent.click(editButton);

    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '在当前团队中可见' }) as HTMLInputElement).checked).toBe(true);
  });
});
