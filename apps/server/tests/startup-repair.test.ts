import { describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/index.js';
import { initGlobalDb } from '../src/db.js';

describe('startup data repair', () => {
  it('repairs device and agent owners from the saved connection command token', async () => {
    const globalPath = join(tmpdir(), `agentbean-repair-${Date.now()}-${Math.random()}.db`);
    const now = Date.now();
    const global = initGlobalDb(globalPath);
    try {
      global.users.create({ id: 'test01', username: 'test01', passwordHash: null, createdAt: now });
      global.users.create({ id: 'demo1', username: 'demo1', passwordHash: null, createdAt: now });
      global.networks.create({ id: 'opensns', ownerId: 'test01', name: 'OpenSNS', path: 'opensns', visibility: 'public', createdAt: now });
      global.networkMembers.add('opensns', 'test01', 'owner');
      global.devices.upsert({
        id: 'my-mbp-device',
        userId: 'demo1',
        networkId: 'opensns',
        hostname: 'MyMBP',
        lastSeenAt: now,
        systemInfo: { hostname: 'MyMBP', daemonVersion: '0.1.26' },
      });
      global.devices.setConnectCommand(
        'my-mbp-device',
        'npx @agentbean/daemon@latest --server-url https://api.agentbean.dev --token test01:opensns:abc123',
      );
      global.agents.upsert({
        id: 'agent-on-mybmp',
        name: 'Hermes-Agent',
        role: 'assistant',
        adapterKind: 'hermes',
        deviceId: 'my-mbp-device',
        networkId: 'opensns',
        visibility: 'public',
        category: 'agentos-hosted',
        source: 'scanned',
        firstSeenAt: now,
        lastSeenAt: now,
        ownerId: null,
        command: 'hermes',
        cwd: null,
        description: null,
      });
      global.agents.upsert({
        id: 'agent-on-mybmp-with-demo-owner',
        name: 'test-Agent',
        role: null,
        adapterKind: 'codex',
        deviceId: 'my-mbp-device',
        networkId: 'opensns',
        visibility: 'public',
        category: 'executor-hosted',
        source: 'custom',
        firstSeenAt: now,
        lastSeenAt: now,
        ownerId: 'demo1',
        command: 'codex',
        args: null,
        cwd: '/Users/shaw/drama',
        env: null,
        description: null,
      });
    } finally {
      global.close();
    }

    const app = await buildApp({ dbPath: ':memory:', globalDbPath: globalPath, agentToken: 'default:default:tok' });
    try {
      expect(app.globalDb.devices.get('my-mbp-device')).toMatchObject({ userId: 'test01' });
      expect(app.globalDb.agents.getFull('agent-on-mybmp')).toMatchObject({ ownerId: 'test01' });
      expect(app.globalDb.agents.getFull('agent-on-mybmp-with-demo-owner')).toMatchObject({ ownerId: 'test01' });
    } finally {
      await app.close();
      try { unlinkSync(globalPath); } catch {}
    }
  });
});
