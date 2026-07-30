import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';
import { createServerNextUseCases } from '../src/application/usecases';
import {
  evaluateDeviceAgentLifecycle,
  resolveAgentLifecycleFromDevice,
  describeDeviceLifecycleEffect,
} from '../../../packages/domain/src/device-agent-lifecycle-policy.js';

// ============================================================================
// Domain policy unit tests
// ============================================================================

describe('evaluateDeviceAgentLifecycle', () => {
  test('eligible when agent online on online device', () => {
    expect(evaluateDeviceAgentLifecycle({
      agentDeviceId: 'd1', agentStatus: 'online', agentDeletedAt: undefined,
      deviceStatus: 'online', deviceExists: true,
    })).toEqual({ kind: 'eligible' });
  });

  test('ineligible: device_missing', () => {
    expect(evaluateDeviceAgentLifecycle({
      agentDeviceId: undefined, agentStatus: 'online', agentDeletedAt: undefined,
      deviceStatus: 'online', deviceExists: true,
    })).toEqual({ kind: 'ineligible', reason: 'device_missing' });
  });

  test('ineligible: device_deleted', () => {
    expect(evaluateDeviceAgentLifecycle({
      agentDeviceId: 'd1', agentStatus: 'offline', agentDeletedAt: 1000,
      deviceStatus: 'online', deviceExists: true,
    })).toEqual({ kind: 'ineligible', reason: 'device_deleted' });
  });

  test('ineligible: device_offline (device not exist)', () => {
    expect(evaluateDeviceAgentLifecycle({
      agentDeviceId: 'd1', agentStatus: 'online', agentDeletedAt: undefined,
      deviceStatus: undefined, deviceExists: false,
    })).toEqual({ kind: 'ineligible', reason: 'device_offline' });
  });

  test('ineligible: device_offline (device offline)', () => {
    expect(evaluateDeviceAgentLifecycle({
      agentDeviceId: 'd1', agentStatus: 'online', agentDeletedAt: undefined,
      deviceStatus: 'offline', deviceExists: true,
    })).toEqual({ kind: 'ineligible', reason: 'device_offline' });
  });

  test('ineligible: agent_not_ready', () => {
    expect(evaluateDeviceAgentLifecycle({
      agentDeviceId: 'd1', agentStatus: 'offline', agentDeletedAt: undefined,
      deviceStatus: 'online', deviceExists: true,
    })).toEqual({ kind: 'ineligible', reason: 'agent_not_ready' });
  });

  test('priority: device_missing before device_deleted', () => {
    expect(evaluateDeviceAgentLifecycle({
      agentDeviceId: undefined, agentStatus: 'offline', agentDeletedAt: 1000,
      deviceStatus: 'online', deviceExists: true,
    }).reason).toBe('device_missing');
  });

  test('priority: device_deleted before device_offline', () => {
    expect(evaluateDeviceAgentLifecycle({
      agentDeviceId: 'd1', agentStatus: 'online', agentDeletedAt: 1000,
      deviceStatus: 'offline', deviceExists: true,
    }).reason).toBe('device_deleted');
  });
});

describe('resolveAgentLifecycleFromDevice', () => {
  test('all eligible when device online', () => {
    const r = resolveAgentLifecycleFromDevice({ id: 'd1', status: 'online' }, [
      { id: 'a1', deviceId: 'd1', status: 'online', deletedAt: undefined },
      { id: 'a2', deviceId: 'd1', status: 'online', deletedAt: undefined },
    ]);
    expect(r.eligible).toHaveLength(2);
    expect(r.ineligible).toHaveLength(0);
  });

  test('all device_offline when device null', () => {
    const r = resolveAgentLifecycleFromDevice(null, [
      { id: 'a1', deviceId: 'd1', status: 'online', deletedAt: undefined },
    ]);
    expect(r.ineligible[0].reason).toBe('device_offline');
  });

  test('mixed eligible and ineligible', () => {
    const r = resolveAgentLifecycleFromDevice({ id: 'd1', status: 'online' }, [
      { id: 'a1', deviceId: 'd1', status: 'online', deletedAt: undefined },
      { id: 'a2', deviceId: 'd1', status: 'offline', deletedAt: undefined },
      { id: 'a3', deviceId: 'd1', status: 'online', deletedAt: 1000 },
    ]);
    expect(r.eligible).toHaveLength(1);
    expect(r.eligible[0].agentId).toBe('a1');
    expect(r.ineligible).toHaveLength(2);
  });
});

describe('describeDeviceLifecycleEffect', () => {
  test('offline -> mark_offline', () => {
    expect(describeDeviceLifecycleEffect('offline').agentEffect).toBe('mark_offline');
  });
  test('revoked -> mark_deleted', () => {
    expect(describeDeviceLifecycleEffect('revoked').agentEffect).toBe('mark_deleted');
  });
  test('deleted -> mark_deleted', () => {
    expect(describeDeviceLifecycleEffect('deleted').agentEffect).toBe('mark_deleted');
  });
  test('online -> none', () => {
    expect(describeDeviceLifecycleEffect('online').agentEffect).toBe('none');
  });
});

// ============================================================================
// Integration tests
// ============================================================================

function createIds(seq: string[]) { let i = 0; return () => i < seq.length ? seq[i++] : `auto-${i++}`; }

async function boot() {
  const repos = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories: repos,
    clock: { now: () => 1000 },
    ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'device-a', 'device-b', 'user-2', 'invite-1', 'agent-1', 'agent-2']) },
  });
  return { app, repos };
}

// AC#1: Same name on different devices -> independent agents

describe('AC#1: independent agents per device', () => {
  test('same name on two devices creates distinct agents', async () => {
    const { app, repos } = await boot();
    const reg = await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'T' });
    expect(reg.ok).toBe(true);
    const teamId = reg.ok ? reg.user.primaryTeamId! : '';

    const hA = await app.deviceHello({ teamId, ownerId: 'user-1', hostname: 'mac-A', machineId: 'm-A' });
    const hB = await app.deviceHello({ teamId, ownerId: 'user-1', hostname: 'mac-B', machineId: 'm-B' });
    expect(hA.ok).toBe(true); expect(hB.ok).toBe(true);
    const dA = hA.ok ? hA.device.id : ''; const dB = hB.ok ? hB.device.id : '';

    const sA = await app.registerDiscoveredAgents({ teamId, deviceId: dA, agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    const sB = await app.registerDiscoveredAgents({ teamId, deviceId: dB, agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    expect(sA.ok && sA.agents).toHaveLength(1);
    expect(sB.ok && sB.agents).toHaveLength(1);
    const aA = sA.ok ? sA.agents[0].id : '';
    const aB = sB.ok ? sB.agents[0].id : '';
    expect(aA).not.toBe(aB);

    const agA = await repos.agents.getById(aA);
    const agB = await repos.agents.getById(aB);
    expect(agA?.deviceId).toBe(dA);
    expect(agB?.deviceId).toBe(dB);

    // Idempotent re-scan
    const sA2 = await app.registerDiscoveredAgents({ teamId, deviceId: dA, agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    expect(sA2.ok && sA2.agents[0].id).toBe(aA);
  });
});

// AC#2a: Device offline -> agent ineligible

describe('AC#2a: device offline', () => {
  test('offline cascades to agent and makes it ineligible', async () => {
    const { app, repos } = await boot();
    const reg = await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'T' });
    expect(reg.ok).toBe(true);
    const teamId = reg.ok ? reg.user.primaryTeamId! : '';

    const h = await app.deviceHello({ teamId, ownerId: 'user-1', hostname: 'mac-A' });
    expect(h.ok).toBe(true);
    const devId = h.ok ? h.device.id : '';

    const s = await app.registerDiscoveredAgents({ teamId, deviceId: devId, agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    expect(s.ok).toBe(true);
    const aId = s.ok ? s.agents[0].id : '';

    let agent = await repos.agents.getById(aId);
    expect(agent?.status).toBe('online');

    await app.markDeviceOffline({ deviceId: devId, timestamp: 2000 });
    agent = await repos.agents.getById(aId);
    expect(agent?.status).toBe('offline');

    const device = await repos.devices.getById(devId);
    const dec = evaluateDeviceAgentLifecycle({
      agentDeviceId: agent?.deviceId, agentStatus: agent?.status ?? 'unknown',
      agentDeletedAt: agent?.deletedAt, deviceStatus: device?.status,
      deviceExists: device !== null && device !== undefined,
    });
    expect(dec.kind).toBe('ineligible');
    expect(dec.reason).toBe('device_offline');
  });
});

// AC#2b: Device delete -> agent soft-deleted

describe('AC#2b: device delete', () => {
  test('delete cascades to soft-delete and prevents reconnection', async () => {
    const { app, repos } = await boot();
    const reg = await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'T' });
    expect(reg.ok).toBe(true);
    const teamId = reg.ok ? reg.user.primaryTeamId! : '';

    const h = await app.deviceHello({ teamId, ownerId: 'user-1', hostname: 'mac-A', machineId: 'm1' });
    expect(h.ok).toBe(true);
    const devId = h.ok ? h.device.id : '';

    const s = await app.registerDiscoveredAgents({ teamId, deviceId: devId, agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    expect(s.ok).toBe(true);
    const aId = s.ok ? s.agents[0].id : '';

    const del = await app.deleteDevice({ userId: 'user-1', deviceId: devId });
    expect(del.ok).toBe(true);

    const agent = await repos.agents.getById(aId);
    expect(agent?.deletedAt).toBeDefined();
    expect(agent?.status).toBe('offline');

    const dec = evaluateDeviceAgentLifecycle({
      agentDeviceId: agent?.deviceId, agentStatus: agent?.status ?? 'unknown',
      agentDeletedAt: agent?.deletedAt, deviceStatus: 'online', deviceExists: false,
    });
    expect(dec.kind).toBe('ineligible');
    expect(dec.reason).toBe('device_deleted');

    const reh = await app.deviceHello({ teamId, ownerId: 'user-1', machineId: 'm1', hostname: 'mac-A' });
    expect(reh.ok).toBe(false);
    if (!reh.ok) expect(reh.error).toBe('DEVICE_REVOKED');
  });
});

// AC#3: Device delete preserves published workspace data

describe('AC#3: published data survives device delete', () => {
  test('artifacts and workspace runs persist after device delete', async () => {
    const { app, repos } = await boot();
    const reg = await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'T' });
    expect(reg.ok).toBe(true);
    const teamId = reg.ok ? reg.user.primaryTeamId! : '';

    const h = await app.deviceHello({ teamId, ownerId: 'user-1', hostname: 'mac-A', machineId: 'm1' });
    expect(h.ok).toBe(true);
    const devId = h.ok ? h.device.id : '';

    const s = await app.registerDiscoveredAgents({ teamId, deviceId: devId, agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    expect(s.ok).toBe(true);
    const aId = s.ok ? s.agents[0].id : '';

    await repos.artifacts.create({ id: 'art-1', teamId, channelId: 'channel-1', agentId: aId, messageId: 'msg-1', workspaceRunId: 'run-1', filename: 'out.json', mimeType: 'application/json', sizeBytes: 100, role: 'output', createdAt: 1000, updatedAt: 1000 });
    await repos.workspaceRuns.create({ id: 'run-1', teamId, channelId: 'channel-1', agentId: aId, deviceId: devId, status: 'done', createdAt: 1000, updatedAt: 1000 });

    await app.deleteDevice({ userId: 'user-1', deviceId: devId });

    expect(await repos.devices.getById(devId)).toBeNull();
    expect((await repos.agents.getById(aId))?.deletedAt).toBeDefined();
    expect(await repos.artifacts.getForTeam({ teamId, artifactId: 'art-1' })).toBeDefined();
    expect(await repos.workspaceRuns.getForTeam({ teamId, runId: 'run-1' })).toBeDefined();
  });
});

// Offline-reconnect cycle

describe('offline-reconnect cycle', () => {
  test('custom agent offline cascade and device reconnection', async () => {
    const { app, repos } = await boot();
    const reg = await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'T' });
    expect(reg.ok).toBe(true);
    const teamId = reg.ok ? reg.user.primaryTeamId! : '';

    const h = await app.deviceHello({ teamId, ownerId: 'user-1', hostname: 'mac-A', machineId: 'm1' });
    expect(h.ok).toBe(true);
    const devId = h.ok ? h.device.id : '';

    const ca = await app.createCustomAgent({ teamId, userId: 'user-1', deviceId: devId, name: 'my-bot', adapterKind: 'codex' });
    expect(ca.ok).toBe(true);
    const aId = ca.ok ? ca.agent.id : '';

    let agent = await repos.agents.getById(aId);
    expect(agent?.status).toBe('online');

    // Offline cascade
    await app.markDeviceOffline({ deviceId: devId, timestamp: 2000 });
    agent = await repos.agents.getById(aId);
    expect(agent?.status).toBe('offline');

    // Token-based reconnect: device is recoverable (not deleted, no DEVICE_REVOKED)
    const rehello = await app.deviceHelloFromCredentials({
      token: h.ok ? h.credentials?.token ?? '' : '',
    });
    expect(rehello.ok).toBe(true);
    const deviceAfter = await repos.devices.getById(devId);
    expect(deviceAfter).not.toBeNull();
  });

  test('scanned agents stay offline until re-scanned', async () => {
    const { app, repos } = await boot();
    const reg = await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'T' });
    expect(reg.ok).toBe(true);
    const teamId = reg.ok ? reg.user.primaryTeamId! : '';

    const h = await app.deviceHello({ teamId, ownerId: 'user-1', hostname: 'mac-A' });
    expect(h.ok).toBe(true);
    const devId = h.ok ? h.device.id : '';

    const s = await app.registerDiscoveredAgents({ teamId, deviceId: devId, agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    expect(s.ok).toBe(true);
    const aId = s.ok ? s.agents[0].id : '';

    await app.markDeviceOffline({ deviceId: devId, timestamp: 2000 });
    expect((await repos.agents.getById(aId))?.status).toBe('offline');

    // Re-scan restores online
    const s2 = await app.registerDiscoveredAgents({ teamId, deviceId: devId, agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    expect(s2.ok).toBe(true);
    expect((await repos.agents.getById(aId))?.status).toBe('online');
  });
});
