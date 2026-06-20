// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DeviceInfo } from '@/lib/schema';
import { useAgentBeanStore } from '@/lib/store';

const { deviceGetMock, agentsListMock, listCustomMock, routerPushMock, routeDeviceIdMock } = vi.hoisted(() => ({
  deviceGetMock: vi.fn(),
  agentsListMock: vi.fn(),
  listCustomMock: vi.fn(),
  routerPushMock: vi.fn(),
  routeDeviceIdMock: vi.fn(() => 'device-1'),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ networkPath: 'acme', id: routeDeviceIdMock() }),
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
    delete: vi.fn(),
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

import DevicesPage from '@/app/[networkPath]/devices/page';

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
    render(<DevicesPage />);

    await waitFor(() => expect(deviceGetMock).toHaveBeenCalledWith({ id: 'device-1' }));
    await waitFor(() => expect(screen.getAllByText('My Laptop').length).toBeGreaterThan(0));

    expect(screen.getByText('设备信息')).toBeInTheDocument();
    expect(useAgentBeanStore.getState().devices['device-1']?.hostname).toBe('My Laptop');
  });

  it('switches from a stale routed device id to the canonical device returned by the server', async () => {
    routeDeviceIdMock.mockReturnValue('legacy-device');
    deviceGetMock.mockResolvedValue({
      ok: true,
      device: makeDevice({ id: 'device-1', hostname: 'Canonical Laptop', status: 'offline' }),
    });

    render(<DevicesPage />);

    await waitFor(() => expect(deviceGetMock).toHaveBeenCalledWith({ id: 'legacy-device' }));
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/acme/devices/device-1'));
    await waitFor(() => expect(screen.getAllByText('Canonical Laptop').length).toBeGreaterThan(0));

    const devices = useAgentBeanStore.getState().devices;
    expect(devices['device-1']?.status).toBe('offline');
    expect(devices['legacy-device']).toBeUndefined();
  });
});
