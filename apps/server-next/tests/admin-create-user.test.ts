import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

function createApp(idSeed = 0) {
  const repositories = createInMemoryRepositories();
  let n = idSeed;
  const ids = { nextId: () => `id-${++n}` };
  const clock = { now: () => 10_000 + n };
  return { app: createServerNextUseCases({ repositories, clock, ids }), repositories };
}

async function seedAdmin() {
  const ctx = createApp();
  await ctx.repositories.users.create({
    id: 'admin-1',
    username: 'admin',
    role: 'admin',
    primaryTeamId: 'team-admin',
    currentTeamId: 'team-admin',
    passwordHash: 'legacy-hash',
    createdAt: 1,
    updatedAt: 1,
  });
  await ctx.repositories.teams.create({
    id: 'team-admin',
    name: 'Ops',
    path: 'ops',
    visibility: 'private',
    ownerId: 'admin-1',
    createdAt: 1,
  });
  await ctx.repositories.teams.addMember({
    teamId: 'team-admin',
    userId: 'admin-1',
    username: 'admin',
    role: 'owner',
    joinedAt: 1,
  });
  return ctx;
}

describe('admin create user (default personal team)', () => {
  test('admin can create user role with personal team and new user can login', async () => {
    const { app } = await seedAdmin();

    const created = await app.createAdminUser({
      adminUserId: 'admin-1',
      username: 'alice',
      displayName: 'Alice Chen',
      password: 'secret12',
      role: 'user',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.user).toMatchObject({
      username: 'alice',
      displayName: 'Alice Chen',
      role: 'user',
    });
    expect(created.team).toMatchObject({
      visibility: 'private',
      ownerId: created.user.id,
      currentUserRole: 'owner',
    });
    expect(created.defaultChannel).toMatchObject({
      name: 'all',
      teamId: created.team!.id,
    });

    const login = await app.loginUser({ username: 'alice', password: 'secret12' });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(login.currentTeam.id).toBe(created.team!.id);

    const listed = await app.listAdminUsers({ userId: 'admin-1' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.users.some((u) => u.username === 'alice' && u.role === 'user')).toBe(true);
  });

  test('admin can create admin role account', async () => {
    const { app } = await seedAdmin();

    const created = await app.createAdminUser({
      adminUserId: 'admin-1',
      username: 'ops-admin',
      password: 'secret12',
      role: 'admin',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.user.role).toBe('admin');
  });

  test('username conflict returns CONFLICT and does not overwrite', async () => {
    const { app, repositories } = await seedAdmin();
    await repositories.users.create({
      id: 'existing',
      username: 'alice',
      role: 'user',
      passwordHash: 'old-hash',
      createdAt: 2,
      updatedAt: 2,
    });

    const created = await app.createAdminUser({
      adminUserId: 'admin-1',
      username: 'Alice',
      password: 'secret12',
      role: 'user',
    });

    expect(created).toMatchObject({
      ok: false,
      error: 'CONFLICT',
    });
    expect(created.ok === false && created.message).toMatch(/already exists|已存在|Username/i);

    const still = await repositories.users.getById('existing');
    expect(still?.passwordHash).toBe('old-hash');
    expect(await repositories.users.getByUsername('alice')).toMatchObject({ id: 'existing' });
  });

  test('optional no-team path creates user that cannot login without membership', async () => {
    const { app } = await seedAdmin();

    const created = await app.createAdminUser({
      adminUserId: 'admin-1',
      username: 'invite-only',
      password: 'secret12',
      role: 'user',
      createPersonalTeam: false,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.team).toBeUndefined();
    expect(created.defaultChannel).toBeUndefined();

    const login = await app.loginUser({ username: 'invite-only', password: 'secret12' });
    expect(login.ok).toBe(false);
    if (login.ok) return;
    expect(login.error).toBe('FORBIDDEN');
    expect(login.message).toMatch(/no team membership/i);
  });

  test('non-admin cannot create users', async () => {
    const { app, repositories } = await seedAdmin();
    await repositories.users.create({
      id: 'member-1',
      username: 'member',
      role: 'user',
      passwordHash: 'x',
      createdAt: 3,
      updatedAt: 3,
    });

    const created = await app.createAdminUser({
      adminUserId: 'member-1',
      username: 'nobody',
      password: 'secret12',
      role: 'user',
    });

    expect(created).toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  test('rejects short password and invalid role', async () => {
    const { app } = await seedAdmin();

    await expect(
      app.createAdminUser({
        adminUserId: 'admin-1',
        username: 'short-pw',
        password: '12345',
        role: 'user',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    await expect(
      app.createAdminUser({
        adminUserId: 'admin-1',
        username: 'bad-role',
        password: 'secret12',
        role: 'superadmin' as 'user',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });
});
