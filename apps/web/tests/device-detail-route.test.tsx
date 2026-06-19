// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DeviceInfo } from '@/lib/schema';
import { useAgentBeanStore } from '@/lib/store';

const { deviceGetMock, deviceDeleteMock, agentsListMock, listCustomMock, routerPushMock, routeDeviceIdMock } = vi.hoisted(() => ({
  deviceGetMock: vi.fn(),
  deviceDeleteMock: vi.fn(),
  agentsListMock: vi.fn(),
  listCustomMock: vi.fn(),
  routerPushMock: vi.fn(),
  routeDeviceIdMock: vi.fn(() => 'device-1'),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ teamPath: 'acme', id: routeDeviceIdMock() }),
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('@/lib/socket', () => ({
  authEvents: () => ({ inviteCreate: vi.fn() }),
  getResolvedServerUrl: () => 'https://www.agentbean.dev',
  authedApiUrl: (url: string) => url,
  fetchAgentWorkspace: vi.fn(),
  deviceEvents: () => ({
    subscribe: vi.fn(),
    onSnapshot: () => () => {},
    onStatus: () => () => {},
    get: deviceGetMock,
    agentsList: agentsListMock,
    scan: vi.fn(),
    selectDirectory: vi.fn(),
    delete: deviceDeleteMock,
    rename: vi.fn(),
  }),
  agentEvents: () => ({
    listCustom: listCustomMock,
    delete: vi.fn(),
    publish: vi.fn(),
    unpublish: vi.fn(),
    updateConfig: vi.fn(),
    create: vi.fn(),
  }),
}));

import DeviceDetailPage from '@/app/[teamPath]/devices/[id]/page';

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 'device-1',
    userId: 'user-1',
    ownerName: 'Shaw',
    userName: 'Shaw',
    networkId: 'team-1',
    hostname: 'My Laptop',
    lastSeenAt: 1_786_000_000_000,
    status: 'online',
    agentIds: [],
    canManage: true,
    isLocal: false,
    runtimes: [],
    ...overrides,
  };
}

beforeEach(() => {
  useAgentBeanStore.setState({
    conn: 'open',
    teams: [{ id: 'team-1', ownerId: 'user-1', name: 'Acme', path: 'acme', description: null, createdAt: 1 }],
    currentTeamId: 'team-1',
    currentUser: { id: 'user-1', username: 'shaw', email: null, role: 'admin' },
    devices: {},
    agents: {},
    channels: [],
    dms: [],
    messagesByChannel: {},
    outbox: {},
    discovered: [],
    runtimes: [],
    agentMetrics: {},
  });
  deviceGetMock.mockResolvedValue({ ok: true, device: makeDevice() });
  deviceDeleteMock.mockResolvedValue({ ok: true });
  agentsListMock.mockResolvedValue({ ok: true, agents: [], runtimes: [] });
  listCustomMock.mockResolvedValue({ ok: true, agents: [] });
  routeDeviceIdMock.mockReturnValue('device-1');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('device detail route', () => {
  it('loads and renders the routed device when the snapshot has not arrived yet', async () => {
    render(<DeviceDetailPage />);

    await waitFor(() => expect(deviceGetMock).toHaveBeenCalledWith({ id: 'device-1' }));
    await waitFor(() => expect(screen.getAllByText('My Laptop').length).toBeGreaterThan(0));

    expect(screen.getByText('信息')).toBeInTheDocument();
    expect(useAgentBeanStore.getState().devices['device-1']?.hostname).toBe('My Laptop');
  });

  it('switches from a stale routed device id to the canonical device returned by the server', async () => {
    routeDeviceIdMock.mockReturnValue('legacy-device');
    deviceGetMock.mockResolvedValue({
      ok: true,
      device: makeDevice({ id: 'device-1', hostname: 'Canonical Laptop', status: 'offline' }),
    });

    render(<DeviceDetailPage />);

    await waitFor(() => expect(deviceGetMock).toHaveBeenCalledWith({ id: 'legacy-device' }));
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/acme/devices/device-1'));
    await waitFor(() => expect(screen.getAllByText('Canonical Laptop').length).toBeGreaterThan(0));

    const devices = useAgentBeanStore.getState().devices;
    expect(devices['device-1']?.status).toBe('offline');
    expect(devices['legacy-device']).toBeUndefined();
  });

  it('shows a terminal not-found state instead of staying in the loading state', async () => {
    deviceGetMock.mockResolvedValue({ ok: false, error: 'DEVICE_NOT_FOUND' });

    render(<DeviceDetailPage />);

    await waitFor(() => expect(deviceGetMock).toHaveBeenCalledWith({ id: 'device-1' }));
    expect(await screen.findByText('未找到该设备或已被删除')).toBeInTheDocument();
    expect(screen.queryByText('正在加载设备详情...')).not.toBeInTheDocument();
  });

  it('returns to the device directory after deleting the routed device', async () => {
    useAgentBeanStore.setState({
      devices: { 'device-1': makeDevice() },
    });

    render(<DeviceDetailPage />);

    await waitFor(() => expect(screen.getAllByText('My Laptop').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: '删除设备' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(deviceDeleteMock).toHaveBeenCalledWith('device-1'));
    expect(routerPushMock).toHaveBeenCalledWith('/acme/devices');
  });
});
