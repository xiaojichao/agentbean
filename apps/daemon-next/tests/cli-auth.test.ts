import { describe, expect, test } from 'vitest';
import { resolveDeviceCredentials } from '../src/cli';
import type { AuthData } from '../src/auth-store';

// Approach A: resolveDeviceCredentials is a PURE function. We unit-test the
// invite/saved/config/error decision directly with zero mocks, then trust that
// runDaemonNextCli wires it up (the wiring is thin: loadAuth → helper → saveAuth).
//
// This keeps the credential-resolution logic fast and robust, and avoids mocking
// socket.io-client / waitForDeviceInviteCredentials / createDaemonProtocolClient.

const SAVED_TOKEN: AuthData = {
  token: 'saved-token',
  serverUrl: 'http://127.0.0.1:4000',
  teamId: 'saved-team',
  ownerId: 'saved-owner',
};

describe('resolveDeviceCredentials (pure decision)', () => {
  test('invite path: uses invite credentials and signals persist under config.profileId', () => {
    const resolved = resolveDeviceCredentials({
      inviteCode: 'INVITE-1',
      inviteCredentials: { teamId: 'invite-team', ownerId: 'invite-owner', token: 'invite-token' },
      saved: null,
      profileId: 'default',
      serverUrl: 'http://127.0.0.1:4000',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.teamId).toBe('invite-team');
    expect(resolved.ownerId).toBe('invite-owner');
    expect(resolved.token).toBe('invite-token');
    expect(resolved.persist).toEqual({
      token: 'invite-token',
      serverUrl: 'http://127.0.0.1:4000',
      teamId: 'invite-team',
      ownerId: 'invite-owner',
    });
    // Decision 1: profileId comes from config, NOT slugify(teamId). This is what
    // makes single-team auto-load work (invite with no --profile-id stores under
    // 'default'; next start with no --profile-id loads 'default').
    expect(resolved.persistProfileId).toBe('default');
  });

  test('invite path: explicit --profile-id is honored for persist', () => {
    const resolved = resolveDeviceCredentials({
      inviteCode: 'INVITE-1',
      inviteCredentials: { teamId: 'teamA', ownerId: 'ownerA', token: 'tokA' },
      saved: null,
      profileId: 'teamA',
      serverUrl: 'http://srv',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.persistProfileId).toBe('teamA');
    expect(resolved.persist?.teamId).toBe('teamA');
  });

  test('invite path without inviteCredentials signals a clear error (no partial persist)', () => {
    const resolved = resolveDeviceCredentials({
      inviteCode: 'INVITE-1',
      saved: null,
      profileId: 'default',
      serverUrl: 'http://127.0.0.1:4000',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/invite credentials were supplied/);
  });

  test('non-invite + saved auth: uses saved token/teamId/ownerId, no persist', () => {
    const resolved = resolveDeviceCredentials({
      saved: SAVED_TOKEN,
      configTeamId: 'ignored-team',
      configOwnerId: 'ignored-owner',
      profileId: 'default',
      serverUrl: 'http://127.0.0.1:4000',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.teamId).toBe('saved-team');
    expect(resolved.ownerId).toBe('saved-owner');
    expect(resolved.token).toBe('saved-token');
    expect(resolved.persist).toBeUndefined();
    expect(resolved.persistProfileId).toBeUndefined();
  });

  test('non-invite + no saved + config teamId/ownerId: uses config, no token, no persist', () => {
    const resolved = resolveDeviceCredentials({
      saved: null,
      configTeamId: 'cfg-team',
      configOwnerId: 'cfg-owner',
      profileId: 'default',
      serverUrl: 'http://127.0.0.1:4000',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.teamId).toBe('cfg-team');
    expect(resolved.ownerId).toBe('cfg-owner');
    expect(resolved.token).toBeUndefined();
    expect(resolved.persist).toBeUndefined();
  });

  test('non-invite + no saved + no config: signals the clear startup error', () => {
    const resolved = resolveDeviceCredentials({
      saved: null,
      profileId: 'default',
      serverUrl: 'http://127.0.0.1:4000',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe('AGENTBEAN_NEXT_TEAM_ID or --team-id is required');
  });

  test('non-invite + no saved + only teamId (not ownerId): signals the clear startup error', () => {
    const resolved = resolveDeviceCredentials({
      saved: null,
      configTeamId: 'cfg-team',
      profileId: 'default',
      serverUrl: 'http://127.0.0.1:4000',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe('AGENTBEAN_NEXT_OWNER_ID or --owner-id is required');
  });

  test('Decision 1 invariant: invite path does NOT slugify(teamId) — stores under profileId', () => {
    // teamId 'Acme Corp' would slugify to 'acme-corp', but we persist under
    // the config-provided profileId so save/load stay consistent.
    const resolved = resolveDeviceCredentials({
      inviteCode: 'INVITE-1',
      inviteCredentials: { teamId: 'Acme Corp', ownerId: 'owner', token: 'tok' },
      saved: null,
      profileId: 'default',
      serverUrl: 'http://127.0.0.1:4000',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.persistProfileId).toBe('default');
    expect(resolved.persist?.teamId).toBe('Acme Corp');
  });
});

// Fix #3 invariant: persist and persistProfileId are ALWAYS set together. The
// ResolvedCredentials type is now a discriminated intersection so that whenever
// `persist` is present, `persistProfileId` is present (and vice versa). This is
// what lets runDaemonNextCli call saveAuth(persist, { profileId: persistProfileId })
// with no `?? config.profileId` fallback. These tests lock the invariant down so
// a future refactor that sets one without the other fails both at runtime and
// (via the commented compile-time check) at the type level.
describe('resolveDeviceCredentials persist/persistProfileId co-occurrence (Fix #3)', () => {
  test('invite path: persist and persistProfileId are both set', () => {
    const resolved = resolveDeviceCredentials({
      inviteCode: 'INVITE',
      inviteCredentials: { teamId: 't', ownerId: 'o', token: 'tok' },
      saved: null,
      profileId: 'prod',
      serverUrl: 'http://srv',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Both-or-neither: persist defined IFF persistProfileId defined.
    expect(resolved.persist).toBeDefined();
    expect(resolved.persistProfileId).toBeDefined();
    // The exact pairing the saveAuth call site relies on:
    expect(resolved.persistProfileId).toBe('prod');
    expect(resolved.persist).toEqual({
      token: 'tok',
      serverUrl: 'http://srv',
      teamId: 't',
      ownerId: 'o',
    });
  });

  test('saved path: persist and persistProfileId are both undefined', () => {
    const resolved = resolveDeviceCredentials({
      saved: SAVED_TOKEN,
      profileId: 'prod',
      serverUrl: 'http://srv',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.persist).toBeUndefined();
    expect(resolved.persistProfileId).toBeUndefined();
  });

  test('config path: persist and persistProfileId are both undefined', () => {
    const resolved = resolveDeviceCredentials({
      saved: null,
      configTeamId: 'ct',
      configOwnerId: 'co',
      profileId: 'prod',
      serverUrl: 'http://srv',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.persist).toBeUndefined();
    expect(resolved.persistProfileId).toBeUndefined();
  });

  // Compile-time guard (uncomment to verify the type-level invariant holds):
  //   import type { ResolveDeviceCredentialsResult } from '../src/cli';
  //   type EnsurePersistImpliesProfileId<T> = T extends { ok: true; persist: infer _ }
  //     ? T extends { persistProfileId: string } ? true : never
  //     : true;
  //   type _Check = EnsurePersistImpliesProfileId<ResolveDeviceCredentialsResult>;
});
