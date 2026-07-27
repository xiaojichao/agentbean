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

async function seedAdmin(options?: { secondAdmin?: boolean }) {
  const ctx = createApp();
  await ctx.repositories.users.create({
    id: 'admin-1',
    username: 'admin',
    role: 'admin',
    displayName: 'Root Admin',
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

  if (options?.secondAdmin) {
    await ctx.repositories.users.create({
      id: 'admin-2',
      username: 'admin2',
      role: 'admin',
      displayName: 'Second Admin',
      primaryTeamId: 'team-admin',
      currentTeamId: 'team-admin',
      passwordHash: 'legacy-hash',
      createdAt: 2,
      updatedAt: 2,
    });
    await ctx.repositories.teams.addMember({
      teamId: 'team-admin',
      userId: 'admin-2',
      username: 'admin2',
      role: 'admin',
      joinedAt: 2,
    });
  }

  return ctx;
}

async function seedUser(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  input: {
    id: string;
    username: string;
    role?: 'user' | 'admin';
    displayName?: string;
    email?: string | null;
    passwordHash?: string;
  },
) {
  await repositories.users.create({
    id: input.id,
    username: input.username,
    role: input.role ?? 'user',
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    primaryTeamId: 'team-user',
    currentTeamId: 'team-user',
    passwordHash: input.passwordHash ?? 'legacy-old',
    createdAt: 5,
    updatedAt: 5,
  });
  const team = await repositories.teams.getById('team-user');
  if (!team) {
    await repositories.teams.create({
      id: 'team-user',
      name: 'User Team',
      path: 'user-team',
      visibility: 'private',
      ownerId: input.id,
      createdAt: 5,
    });
  }
  await repositories.teams.addMember({
    teamId: 'team-user',
    userId: input.id,
    username: input.username,
    role: 'owner',
    joinedAt: 5,
  });
}

describe('admin update user profile and role', () => {
  test('admin can update displayName, email, and role and list reflects changes', async () => {
    const { app, repositories } = await seedAdmin();
    await seedUser(repositories, {
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      email: 'old@example.com',
    });

    const updated = await app.updateAdminUser({
      adminUserId: 'admin-1',
      targetUserId: 'user-1',
      displayName: 'Alice Chen',
      email: 'alice@example.com',
      role: 'admin',
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.user).toMatchObject({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice Chen',
      email: 'alice@example.com',
      role: 'admin',
    });

    const listed = await app.listAdminUsers({ userId: 'admin-1' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const row = listed.users.find((u) => u.id === 'user-1');
    expect(row).toMatchObject({
      displayName: 'Alice Chen',
      email: 'alice@example.com',
      role: 'admin',
    });
  });

  test('admin can clear email and displayName with null/empty', async () => {
    const { app, repositories } = await seedAdmin();
    await seedUser(repositories, {
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
    });

    const updated = await app.updateAdminUser({
      adminUserId: 'admin-1',
      targetUserId: 'user-1',
      displayName: '',
      email: null,
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // Explicit null (not omitted undefined) so socket/JSON clients can clear list-row fields.
    expect(updated.user.displayName).toBeNull();
    expect(updated.user.email).toBeNull();
  });

  test('cannot demote the last remaining admin', async () => {
    const { app } = await seedAdmin();

    const demoted = await app.updateAdminUser({
      adminUserId: 'admin-1',
      targetUserId: 'admin-1',
      role: 'user',
    });

    expect(demoted).toMatchObject({
      ok: false,
      error: 'CONFLICT',
    });
    expect(demoted.ok === false && demoted.message).toMatch(/last admin|最后|admin/i);

    const still = await app.listAdminUsers({ userId: 'admin-1' });
    expect(still.ok).toBe(true);
    if (!still.ok) return;
    expect(still.users.find((u) => u.id === 'admin-1')?.role).toBe('admin');
  });

  test('can demote an admin when another admin remains', async () => {
    const { app } = await seedAdmin({ secondAdmin: true });

    const demoted = await app.updateAdminUser({
      adminUserId: 'admin-1',
      targetUserId: 'admin-2',
      role: 'user',
    });

    expect(demoted.ok).toBe(true);
    if (!demoted.ok) return;
    expect(demoted.user.role).toBe('user');
  });

  test('cannot update protected system identity by id or username', async () => {
    const { app, repositories } = await seedAdmin();
    await repositories.users.create({
      id: 'system',
      username: 'system',
      role: 'admin',
      passwordHash: 'x',
      createdAt: 0,
      updatedAt: 0,
    });
    await repositories.users.create({
      id: 'system-user-generated-id',
      username: 'system',
      role: 'user',
      passwordHash: 'x',
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      app.updateAdminUser({
        adminUserId: 'admin-1',
        targetUserId: 'system',
        displayName: 'Nope',
        role: 'user',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    // Username "system" is protected even when id is not the literal "system".
    await expect(
      app.updateAdminUser({
        adminUserId: 'admin-1',
        targetUserId: 'system-user-generated-id',
        displayName: 'Nope',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('non-admin cannot update users', async () => {
    const { app, repositories } = await seedAdmin();
    await seedUser(repositories, { id: 'member-1', username: 'member' });

    const updated = await app.updateAdminUser({
      adminUserId: 'member-1',
      targetUserId: 'member-1',
      displayName: 'Hacker',
    });

    expect(updated).toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  test('rejects invalid role', async () => {
    const { app, repositories } = await seedAdmin();
    await seedUser(repositories, { id: 'user-1', username: 'alice' });

    await expect(
      app.updateAdminUser({
        adminUserId: 'admin-1',
        targetUserId: 'user-1',
        role: 'superadmin' as 'user',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('duplicate email returns CONFLICT instead of throwing', async () => {
    const { app, repositories } = await seedAdmin();
    await seedUser(repositories, {
      id: 'user-1',
      username: 'alice',
      email: 'alice@example.com',
    });
    await repositories.users.create({
      id: 'user-2',
      username: 'bob',
      role: 'user',
      email: 'bob@example.com',
      passwordHash: 'x',
      createdAt: 6,
      updatedAt: 6,
    });

    const updated = await app.updateAdminUser({
      adminUserId: 'admin-1',
      targetUserId: 'user-2',
      email: 'alice@example.com',
    });

    expect(updated).toMatchObject({
      ok: false,
      error: 'CONFLICT',
    });
    expect(updated.ok === false && updated.message).toMatch(/email|邮箱|already/i);

    const bob = await repositories.users.getById('user-2');
    expect(bob?.email).toBe('bob@example.com');
  });

  test('self-delete and system identity remain protected', async () => {
    const { app, repositories } = await seedAdmin();
    await repositories.users.create({
      id: 'system',
      username: 'system',
      role: 'admin',
      passwordHash: 'x',
      createdAt: 0,
      updatedAt: 0,
    });

    await expect(
      app.deleteAdminUser({ adminUserId: 'admin-1', targetUserId: 'admin-1' }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    await expect(
      app.deleteAdminUser({ adminUserId: 'admin-1', targetUserId: 'system' }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });
});

describe('admin reset user password', () => {
  test('reset password invalidates old password and allows new login', async () => {
    const { app, repositories } = await seedAdmin();
    // Create user via admin path so password is properly hashed.
    const created = await app.createAdminUser({
      adminUserId: 'admin-1',
      username: 'alice',
      password: 'old-pass-1',
      role: 'user',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const loginOldBefore = await app.loginUser({ username: 'alice', password: 'old-pass-1' });
    expect(loginOldBefore.ok).toBe(true);

    const reset = await app.resetAdminUserPassword({
      adminUserId: 'admin-1',
      targetUserId: created.user.id,
      newPassword: 'new-pass-9',
    });
    expect(reset.ok).toBe(true);

    const loginOld = await app.loginUser({ username: 'alice', password: 'old-pass-1' });
    expect(loginOld.ok).toBe(false);

    const loginNew = await app.loginUser({ username: 'alice', password: 'new-pass-9' });
    expect(loginNew.ok).toBe(true);

    // silence unused
    void repositories;
  });

  test('rejects short password', async () => {
    const { app, repositories } = await seedAdmin();
    await seedUser(repositories, { id: 'user-1', username: 'alice' });

    await expect(
      app.resetAdminUserPassword({
        adminUserId: 'admin-1',
        targetUserId: 'user-1',
        newPassword: '12345',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('cannot reset protected system identity by id or username', async () => {
    const { app, repositories } = await seedAdmin();
    await repositories.users.create({
      id: 'system',
      username: 'system',
      role: 'admin',
      passwordHash: 'x',
      createdAt: 0,
      updatedAt: 0,
    });
    await repositories.users.create({
      id: 'system-user-generated-id',
      username: 'system',
      role: 'user',
      passwordHash: 'x',
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      app.resetAdminUserPassword({
        adminUserId: 'admin-1',
        targetUserId: 'system',
        newPassword: 'secret12',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    await expect(
      app.resetAdminUserPassword({
        adminUserId: 'admin-1',
        targetUserId: 'system-user-generated-id',
        newPassword: 'secret12',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('non-admin cannot reset passwords', async () => {
    const { app, repositories } = await seedAdmin();
    await seedUser(repositories, { id: 'member-1', username: 'member' });
    await seedUser(repositories, { id: 'user-1', username: 'alice' });

    await expect(
      app.resetAdminUserPassword({
        adminUserId: 'member-1',
        targetUserId: 'user-1',
        newPassword: 'secret12',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('reset password returns NOT_FOUND when target disappears before write', async () => {
    const { app, repositories } = await seedAdmin();
    await seedUser(repositories, { id: 'user-1', username: 'alice' });
    const originalUpdate = repositories.users.updatePassword.bind(repositories.users);
    repositories.users.updatePassword = async (input) => {
      await repositories.users.delete(input.userId);
      return originalUpdate(input);
    };

    await expect(
      app.resetAdminUserPassword({
        adminUserId: 'admin-1',
        targetUserId: 'user-1',
        newPassword: 'secret12',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });
});
