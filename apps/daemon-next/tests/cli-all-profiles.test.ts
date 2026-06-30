import { afterEach, describe, expect, test, vi } from 'vitest';
import { expandAllProfiles, parseDaemonNextCliConfig, runDaemonNextCli, type DaemonNextCliConfig, type DaemonNextCliDeps } from '../src/cli';
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

  test('clears inviteCode so saved profiles do not re-enter invite mode', () => {
    const config = baseConfig({ allProfiles: true, inviteCode: 'STALE-INVITE' });
    const [sub] = expandAllProfiles(config, [makeProfile('team-a')]);
    expect(sub.inviteCode).toBeUndefined();
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

describe('runDaemonNextCli --all-profiles empty list (Fix #2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('rejects with a clear error when listAuthProfiles returns []', async () => {
    const deps: DaemonNextCliDeps = {
      listAuthProfiles: vi.fn(() => []),
      loadAuth: vi.fn(() => null),
      saveAuth: vi.fn(),
    };

    await expect(
      runDaemonNextCli({
        ...baseConfig({ allProfiles: true }),
      }, deps),
    ).rejects.toThrowError(/No saved AgentBean team profiles found/);
    expect(deps.listAuthProfiles).toHaveBeenCalledOnce();
    expect(deps.loadAuth).not.toHaveBeenCalled();
  });
});

describe('runDaemonNextCli all-profiles wiring (listAuthProfiles + recursion)', () => {
  test('calls listAuthProfiles and recurses once per profile with overridden profileId + allProfiles=false', async () => {
    const profiles = [
      makeProfile('team-a', 'http://server-a.example/'),
      makeProfile('team-b', 'http://server-b.example'),
    ];
    const runDaemon = vi.fn(async () => undefined);
    const deps: DaemonNextCliDeps = {
      listAuthProfiles: vi.fn(() => profiles),
      runDaemon,
    };

    await runDaemonNextCli(baseConfig({
      allProfiles: true,
      inviteCode: 'stale-invite',
      serverUrl: 'http://parent.example',
    }), deps);

    expect(deps.listAuthProfiles).toHaveBeenCalledOnce();
    expect(runDaemon).toHaveBeenCalledTimes(2);
    const subConfigs = runDaemon.mock.calls.map(([subConfig]) => subConfig);
    expect(subConfigs).toEqual([
      expect.objectContaining({
        profileId: 'team-a',
        serverUrl: 'http://server-a.example',
        serverUrlExplicit: true,
        allProfiles: false,
      }),
      expect.objectContaining({
        profileId: 'team-b',
        serverUrl: 'http://server-b.example',
        serverUrlExplicit: true,
        allProfiles: false,
      }),
    ]);
    expect(subConfigs.every((subConfig) => !('inviteCode' in subConfig))).toBe(true);
  });
});

describe('runDaemonNextCli device-removed shutdown', () => {
  test('onDeviceRemoved disconnects the socket and exits the process', async () => {
    const disconnect = vi.fn();
    const fakeSocket = {
      connected: true,
      connect: vi.fn(),
      disconnect,
      emitWithAck: vi.fn(async () => ({ ok: true })),
      on: vi.fn(),
      off: vi.fn(),
    };
    const captured: { onDeviceRemoved?: () => void } = {};
    const exit = vi.fn();
    const deps: DaemonNextCliDeps = {
      // saved auth → 走单 profile 路径，跳过 invite 握手
      loadAuth: vi.fn(() => ({
        profileId: 'default',
        token: 'token-default',
        serverUrl: 'http://127.0.0.1:4000',
        teamId: 'team-1',
        ownerId: 'user-1',
      })),
      // 命中缓存 → 跳过真实扫描
      loadScanCache: vi.fn(() => ({ runtimes: [], agents: [] }) as never),
      connectSocket: vi.fn(async () => fakeSocket),
      createProtocolClient: vi.fn((input) => {
        captured.onDeviceRemoved = input.onDeviceRemoved;
        return { start: async () => {} };
      }),
      exit,
    };

    await runDaemonNextCli(baseConfig({ profileId: 'default', machineId: 'machine-1' }), deps);

    expect(captured.onDeviceRemoved).toBeInstanceOf(Function);
    // 模拟服务端下发 device:removed → daemon 应断开 socket 并退出进程
    captured.onDeviceRemoved!();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
