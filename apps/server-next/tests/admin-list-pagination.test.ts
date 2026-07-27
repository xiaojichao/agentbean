import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function seedAdminFixture() {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 10_000 },
    ids: {
      nextId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    },
  });

  await repositories.users.create({
    id: 'admin-1',
    username: 'admin',
    role: 'admin',
    primaryTeamId: 'team-a',
    currentTeamId: 'team-a',
    passwordHash: sha256('secret'),
    createdAt: 1000,
    updatedAt: 1000,
  });
  await repositories.users.create({
    id: 'user-member',
    username: 'member',
    role: 'user',
    primaryTeamId: 'team-a',
    currentTeamId: 'team-a',
    passwordHash: sha256('secret'),
    createdAt: 2000,
    updatedAt: 2000,
  });
  await repositories.users.create({
    id: 'user-z',
    username: 'zeta',
    role: 'user',
    primaryTeamId: 'team-b',
    currentTeamId: 'team-b',
    passwordHash: sha256('secret'),
    createdAt: 3000,
    updatedAt: 3000,
  });

  await repositories.teams.create({
    id: 'team-a',
    name: 'Alpha',
    path: 'alpha',
    visibility: 'private',
    ownerId: 'admin-1',
    createdAt: 1000,
  });
  await repositories.teams.create({
    id: 'team-b',
    name: 'Beta',
    path: 'beta',
    visibility: 'private',
    ownerId: 'user-z',
    createdAt: 2000,
  });
  await repositories.teams.create({
    id: 'team-c',
    name: 'Charlie',
    path: 'charlie',
    visibility: 'public',
    ownerId: 'admin-1',
    createdAt: 3000,
  });
  for (const member of [
    { teamId: 'team-a', userId: 'admin-1', username: 'admin', role: 'owner' as const, joinedAt: 1000 },
    { teamId: 'team-a', userId: 'user-member', username: 'member', role: 'member' as const, joinedAt: 2000 },
    { teamId: 'team-b', userId: 'user-z', username: 'zeta', role: 'owner' as const, joinedAt: 2000 },
    { teamId: 'team-c', userId: 'admin-1', username: 'admin', role: 'owner' as const, joinedAt: 3000 },
  ]) {
    await repositories.teams.addMember(member);
  }

  await repositories.devices.upsertHello({
    id: 'device-old',
    teamId: 'team-a',
    ownerId: 'user-member',
    status: 'online',
    name: 'Old Device',
    machineId: 'machine-old',
    profileId: 'default',
    lastSeenAt: 5000,
    createdAt: 1500,
    updatedAt: 5000,
  });
  await repositories.devices.upsertHello({
    id: 'device-new',
    teamId: 'team-b',
    ownerId: 'user-z',
    status: 'offline',
    name: 'New Device',
    machineId: 'machine-new',
    profileId: 'default',
    lastSeenAt: 9000,
    createdAt: 3500,
    updatedAt: 9000,
  });
  await repositories.devices.upsertHello({
    id: 'device-mid',
    teamId: 'team-c',
    ownerId: 'admin-1',
    status: 'online',
    name: 'Mid Device',
    machineId: 'machine-mid',
    profileId: 'default',
    lastSeenAt: 7000,
    createdAt: 2500,
    updatedAt: 7000,
  });

  await repositories.agents.upsert({
    id: 'agent-old',
    primaryTeamId: 'team-a',
    visibleTeamIds: ['team-a'],
    name: 'Old Agent',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'online',
    ownerId: 'user-member',
    deviceId: 'device-old',
    lastSeenAt: 4000,
    createdAt: 1600,
  });
  await repositories.agents.upsert({
    id: 'agent-new',
    primaryTeamId: 'team-b',
    visibleTeamIds: ['team-b'],
    name: 'New Agent',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'online',
    ownerId: 'user-z',
    deviceId: 'device-new',
    lastSeenAt: 8000,
    createdAt: 3600,
  });
  await repositories.agents.upsert({
    id: 'agent-mid',
    primaryTeamId: 'team-c',
    visibleTeamIds: ['team-c'],
    name: 'Mid Agent',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'offline',
    ownerId: 'admin-1',
    deviceId: 'device-mid',
    lastSeenAt: 6000,
    createdAt: 2600,
  });
  await repositories.agents.upsert({
    id: 'agent-deleted',
    primaryTeamId: 'team-a',
    visibleTeamIds: ['team-a'],
    name: 'Deleted Agent',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'offline',
    ownerId: 'admin-1',
    deviceId: 'device-old',
    lastSeenAt: 9900,
    createdAt: 9900,
  });
  await repositories.agents.softDelete({ agentId: 'agent-deleted', timestamp: 9950 });

  return { app, repositories };
}

describe('admin inventory list pagination', () => {
  test('non-admin callers are FORBIDDEN for all four lists', async () => {
    const { app } = await seedAdminFixture();
    await expect(app.listAdminTeams({ userId: 'user-member' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.listAdminUsers({ userId: 'user-member' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.listAdminDevices({ userId: 'user-member' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.listAdminAgents({ userId: 'user-member' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  test('defaults to page=1 pageSize=20 and returns total with createdAt desc order', async () => {
    const { app } = await seedAdminFixture();

    const teams = await app.listAdminTeams({ userId: 'admin-1' });
    expect(teams).toMatchObject({
      ok: true,
      page: 1,
      pageSize: 20,
      total: 3,
      teams: [
        expect.objectContaining({ id: 'team-c', name: 'Charlie' }),
        expect.objectContaining({ id: 'team-b', name: 'Beta' }),
        expect.objectContaining({ id: 'team-a', name: 'Alpha' }),
      ],
    });

    const users = await app.listAdminUsers({ userId: 'admin-1' });
    expect(users).toMatchObject({
      ok: true,
      page: 1,
      pageSize: 20,
      total: 3,
      users: [
        expect.objectContaining({ id: 'user-z', username: 'zeta' }),
        expect.objectContaining({ id: 'user-member', username: 'member' }),
        expect.objectContaining({ id: 'admin-1', username: 'admin' }),
      ],
    });

    const devices = await app.listAdminDevices({ userId: 'admin-1' });
    expect(devices).toMatchObject({
      ok: true,
      page: 1,
      pageSize: 20,
      total: 3,
      devices: [
        expect.objectContaining({ id: 'device-new', name: 'New Device' }),
        expect.objectContaining({ id: 'device-mid', name: 'Mid Device' }),
        expect.objectContaining({ id: 'device-old', name: 'Old Device' }),
      ],
    });

    const agents = await app.listAdminAgents({ userId: 'admin-1' });
    expect(agents).toMatchObject({
      ok: true,
      page: 1,
      pageSize: 20,
      total: 3,
      agents: [
        expect.objectContaining({ id: 'agent-new', name: 'New Agent' }),
        expect.objectContaining({ id: 'agent-mid', name: 'Mid Agent' }),
        expect.objectContaining({ id: 'agent-old', name: 'Old Agent' }),
      ],
    });
    // Soft-deleted agents stay out of the default inventory.
    expect(agents.ok && agents.agents.map((agent) => agent.id)).not.toContain('agent-deleted');
  });

  test('page and pageSize slice results while total stays complete', async () => {
    const { app } = await seedAdminFixture();

    const page1 = await app.listAdminTeams({ userId: 'admin-1', page: 1, pageSize: 2 });
    expect(page1).toMatchObject({
      ok: true,
      page: 1,
      pageSize: 2,
      total: 3,
      teams: [
        expect.objectContaining({ id: 'team-c' }),
        expect.objectContaining({ id: 'team-b' }),
      ],
    });
    expect(page1.ok && page1.teams).toHaveLength(2);

    const page2 = await app.listAdminTeams({ userId: 'admin-1', page: 2, pageSize: 2 });
    expect(page2).toMatchObject({
      ok: true,
      page: 2,
      pageSize: 2,
      total: 3,
      teams: [expect.objectContaining({ id: 'team-a' })],
    });
    expect(page2.ok && page2.teams).toHaveLength(1);

    const usersPage = await app.listAdminUsers({ userId: 'admin-1', page: 2, pageSize: 1 });
    expect(usersPage).toMatchObject({
      ok: true,
      page: 2,
      pageSize: 1,
      total: 3,
      users: [expect.objectContaining({ id: 'user-member' })],
    });

    const devicesPage = await app.listAdminDevices({ userId: 'admin-1', page: 1, pageSize: 1 });
    expect(devicesPage).toMatchObject({
      ok: true,
      page: 1,
      pageSize: 1,
      total: 3,
      devices: [expect.objectContaining({ id: 'device-new' })],
    });

    const agentsPage = await app.listAdminAgents({ userId: 'admin-1', page: 3, pageSize: 1 });
    expect(agentsPage).toMatchObject({
      ok: true,
      page: 3,
      pageSize: 1,
      total: 3,
      agents: [expect.objectContaining({ id: 'agent-old' })],
    });
  });

  test('invalid page/pageSize fall back to defaults and clamp', async () => {
    const { app } = await seedAdminFixture();

    const zeroPage = await app.listAdminUsers({ userId: 'admin-1', page: 0, pageSize: 0 });
    expect(zeroPage).toMatchObject({ ok: true, page: 1, pageSize: 20, total: 3 });
    expect(zeroPage.ok && zeroPage.users).toHaveLength(3);

    const huge = await app.listAdminDevices({ userId: 'admin-1', page: 1, pageSize: 999 });
    expect(huge).toMatchObject({ ok: true, page: 1, pageSize: 100, total: 3 });

    const pastEnd = await app.listAdminAgents({ userId: 'admin-1', page: 99, pageSize: 20 });
    expect(pastEnd).toMatchObject({ ok: true, page: 99, pageSize: 20, total: 3, agents: [] });
  });
});
