import { afterEach, describe, expect, test, vi } from 'vitest';
import { expandAllProfiles, parseDaemonNextCliConfig, runDaemonNextCli, type DaemonNextCliConfig } from '../src/cli';
import type { AuthProfile } from '../src/auth-store';

function makeProfile(profileId: string, serverUrl = 'http://127.0.0.1:4000'): AuthProfile {
  return {
    profileId,
    token: `token-${profileId}`,
    serverUrl,
    teamId: `team-${profileId}`,
    ownerId: `owner-${profileId}`,
  };
}

function baseConfig(overrides: Partial<DaemonNextCliConfig> = {}): DaemonNextCliConfig {
  return {
    serverUrl: 'http://127.0.0.1:4000',
    profileId: 'default',
    hostname: 'host.local',
    fallbackPrefix: 'daemon-next:',
    ...overrides,
  };
}

describe('expandAllProfiles (pure orchestration)', () => {
  test('returns one sub-config per profile', () => {
    const config = baseConfig({ allProfiles: true });
    const profiles = [makeProfile('team-a'), makeProfile('team-b'), makeProfile('team-c')];
    const subConfigs = expandAllProfiles(config, profiles);

    expect(subConfigs).toHaveLength(3);
    expect(subConfigs.map((c) => c.profileId)).toEqual(['team-a', 'team-b', 'team-c']);
  });

  test('each sub-config has distinct profileId and allProfiles=false', () => {
    const config = baseConfig({ allProfiles: true });
    const profiles = [makeProfile('team-a'), makeProfile('team-b')];
    const subConfigs = expandAllProfiles(config, profiles);

    for (const sub of subConfigs) {
      expect(sub.allProfiles).toBe(false);
    }
    const ids = subConfigs.map((c) => c.profileId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('preserves all other config fields, only overrides profileId + allProfiles', () => {
    const config = baseConfig({
      allProfiles: true,
      teamId: 'orig-team',
      ownerId: 'orig-owner',
      hostname: 'special-host',
      fallbackPrefix: 'p:',
    });
    // Profile with the SAME serverUrl as the parent config — so this test
    // still asserts the non-serverUrl fields survive the spread.
    const profiles = [makeProfile('team-x', 'http://127.0.0.1:4000')];
    const [sub] = expandAllProfiles(config, profiles);

    expect(sub).toMatchObject({
      serverUrl: 'http://127.0.0.1:4000',
      teamId: 'orig-team',
      ownerId: 'orig-owner',
      hostname: 'special-host',
      fallbackPrefix: 'p:',
      profileId: 'team-x',
      allProfiles: false,
    });
  });

  test('each sub-config uses its profile serverUrl (multi-server correctness)', () => {
    // Fix #1: --all-profiles must connect each profile to ITS OWN saved
    // serverUrl, not the parent config's. Two profiles invited from two
    // different servers must each get their own serverUrl in the sub-config.
    const config = baseConfig({ allProfiles: true, serverUrl: 'http://parent:4000' });
    const profiles = [
      makeProfile('team-a', 'http://server-a:4000/'),  // trailing slash → must be trimmed
      makeProfile('team-b', 'http://server-b:4000'),
    ];
    const subConfigs = expandAllProfiles(config, profiles);

    const byId = new Map(subConfigs.map((c) => [c.profileId, c]));
    expect(byId.get('team-a')?.serverUrl).toBe('http://server-a:4000'); // trimmed
    expect(byId.get('team-b')?.serverUrl).toBe('http://server-b:4000');
    // None of them inherited the parent's serverUrl.
    for (const sub of subConfigs) {
      expect(sub.serverUrl).not.toBe('http://parent:4000');
    }
  });

  test('falls back to parent config.serverUrl when a profile has no serverUrl (defensive)', () => {
    // listAuthProfiles always returns serverUrl (loadAuth validates it), but
    // guard the shape so a malformed profile does not yield serverUrl=undefined.
    const config = baseConfig({ allProfiles: true, serverUrl: 'http://parent:4000' });
    const profile = { ...makeProfile('team-x'), serverUrl: '' };
    const [sub] = expandAllProfiles(config, [profile]);
    expect(sub.serverUrl).toBe('http://parent:4000');
  });

  test('empty profile list returns empty array (caller handles the error)', () => {
    const config = baseConfig({ allProfiles: true });
    expect(expandAllProfiles(config, [])).toEqual([]);
  });

  test('a single profile produces exactly one sub-config', () => {
    const config = baseConfig({ allProfiles: true });
    const [sub] = expandAllProfiles(config, [makeProfile('solo')]);
    expect(sub.profileId).toBe('solo');
    expect(sub.allProfiles).toBe(false);
  });
});

describe('parseDaemonNextCliConfig --all-profiles boolean flag', () => {
  test('parses --all-profiles as boolean true', () => {
    const config = parseDaemonNextCliConfig({ argv: ['--all-profiles'], hostname: 'host.local' });
    expect(config.allProfiles).toBe(true);
  });

  test('omits allProfiles when flag is absent', () => {
    const config = parseDaemonNextCliConfig({
      argv: ['--team-id', 't1', '--owner-id', 'o1'],
      hostname: 'host.local',
    });
    expect(config.allProfiles).toBeUndefined();
  });

  test('does not throw "Missing value" when --all-profiles is the last arg', () => {
    expect(() => parseDaemonNextCliConfig({ argv: ['--all-profiles'], hostname: 'host.local' })).not.toThrow();
  });

  test('does NOT consume the following --flag as its value', () => {
    // If parseArgs treated --all-profiles as value-taking, it would eat
    // '--team-id' as the value and the test below would fail.
    const config = parseDaemonNextCliConfig({
      argv: ['--all-profiles', '--team-id', 't1', '--owner-id', 'o1'],
      hostname: 'host.local',
    });
    expect(config.allProfiles).toBe(true);
    expect(config.teamId).toBe('t1');
    expect(config.ownerId).toBe('o1');
  });

  test('can combine --all-profiles with --server-url (value-taking flag still works)', () => {
    const config = parseDaemonNextCliConfig({
      argv: ['--all-profiles', '--server-url', 'http://example.com:4000/'],
      hostname: 'host.local',
    });
    expect(config.allProfiles).toBe(true);
    expect(config.serverUrl).toBe('http://example.com:4000');
  });
});

// ---------------------------------------------------------------------------
// NOTE on runDaemonNextCli all-profiles WIRING coverage
// ---------------------------------------------------------------------------
// The empty-list branch inside runDaemonNextCli is now covered below: Fix #2
// changed the path from process.exit(1) to `throw new Error(...)`, which
// fires BEFORE connectSocketIoClient runs, so it is testable WITHOUT the
// socket seam (only listAuthProfiles needs mocking). The recursion case
// (non-empty profile list) still calls connectSocketIoClient per sub-config
// and remains BLOCKED on the same socket.io-client require that Vitest
// cannot intercept (see cli.test.ts's top-of-file NOTE).
//
// Coverage that IS in place for Task 5:
//   - expandAllProfiles: the pure orchestration decision (N profiles -> N
//     distinct sub-configs, each with allProfiles=false and the right
//     profileId, all other config preserved) is unit-tested exhaustively
//     above.
//   - parseDaemonNextCliConfig boolean-flag parsing (Decision 3): the flag
//     parses as true, does not throw "Missing value", and does not eat the
//     following --flag as its value — tested above.
//   - runDaemonNextCli empty-list rejection (Fix #2): throws before any socket
//     is opened — tested below.
//
// To unlock the recursion wiring test: make connectSocketIoClient injectable
// (the same seam that would un-skip the Task 4 wiring suite). Tracked as a
// Task 6 follow-up; intentionally out of scope here.
describe('runDaemonNextCli --all-profiles empty list (Fix #2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('rejects with a clear error when listAuthProfiles returns []', async () => {
    vi.mock('../src/auth-store.js', () => ({
      listAuthProfiles: vi.fn(() => []),
      loadAuth: vi.fn(() => null),
      saveAuth: vi.fn(),
    }));

    await expect(
      runDaemonNextCli({
        ...baseConfig({ allProfiles: true }),
      }),
    ).rejects.toThrowError(/No saved AgentBean team profiles found/);
  });
});

describe.skip('runDaemonNextCli all-profiles wiring (listAuthProfiles + recursion) — BLOCKED', () => {
  test('calls listAuthProfiles and recurses once per profile with overridden profileId + allProfiles=false', async () => {
    // Assert: listAuthProfiles called once; runDaemonNextCli called N times,
    // each with profileId from a profile and allProfiles === false.
    // Still BLOCKED: the recursion calls connectSocketIoClient per sub-config,
    // which loads socket.io-client via createRequire and Vitest cannot
    // intercept it. Needs the same socket seam as the Task 4 wiring suite.
  });
});
