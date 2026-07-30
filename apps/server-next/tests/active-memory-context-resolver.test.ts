import { describe, expect, test } from 'vitest';
import { createActiveMemoryContextResolver, type ActiveMemoryContextResolverDeps } from '../src/application/active-memory-context-resolver.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

// #969 AC#3 回归：归档频道的 channel formal memory 与其自身关联的 Experience Pack 均不注入活跃上下文；
// team formal memory 不受影响。跨频道（关联到其他活跃频道）的 Pack 经目标频道解析存活——
// 那是 listApprovedForChannel 的目标 scope 决定的，不由这里的 input.channelId 归档状态决定。
// 本测试锁定 resolver 内两处显式归档门控（channel formal memory 块 + experience pack 块）。

function makeResolver(archivedAt: number | null) {
  const channel = {
    id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'project', visibility: 'public',
    humanMemberIds: ['user-1'], archivedAt,
  };
  const repositories = {
    channels: { async getById() { return channel; } },
    teams: { async isMember() { return true; } },
    agents: { async getById() { return null; } },
    tasks: { async getById() { return null; } },
    memory: {},
  } as unknown as ServerNextRepositories;

  const teamFormal = [{ id: 'mem-team', kind: 'fact', scopeType: 'team', scopeRef: 'team-1', content: 'team fact', summary: 's', status: 'active', updatedAt: 1 }];
  const channelFormal = [{ id: 'mem-chan', kind: 'decision', scopeType: 'channel', scopeRef: 'channel-1', content: 'channel decision', summary: 's', status: 'active', updatedAt: 1 }];
  const packs = [{ schemaVersion: 1 as const, id: 'pack-1', teamId: 'team-1', status: 'approved', title: 'Pack One', sourceChannelId: 'channel-1', summary: 's', conclusions: 'c' }];

  const deps = {
    repositories,
    formalMemory: { async list({ scopeType }: { scopeType: string }) { return scopeType === 'channel' ? channelFormal : teamFormal; } },
    agentMemoryProjection: { async getConsumableProjections() { return { projections: [] as never[] }; } },
    experiencePack: { async listApprovedForChannel() { return packs; } },
    clock: { now: () => 1000 },
    limit: 6,
  } as unknown as ActiveMemoryContextResolverDeps;
  return createActiveMemoryContextResolver(deps);
}

async function sourcesFor(archivedAt: number | null): Promise<string[]> {
  const resolver = makeResolver(archivedAt);
  const result = await resolver.resolve({
    teamId: 'team-1', channelId: 'channel-1', messageId: 'm-1',
    senderUserId: 'user-1', prompt: 'irrelevant', includeAgentProjections: false,
  });
  return result.context.items.map((item) => item.provenance.source);
}

describe('Active Memory Context Resolver — #969 AC#3 归档冻结', () => {
  test('活跃频道：注入 team formal + channel formal + experience pack', async () => {
    const sources = await sourcesFor(null);
    expect(sources).toContain('team_formal_memory');
    expect(sources).toContain('channel_formal_memory');
    expect(sources).toContain('experience_pack');
  });

  test('归档频道：冻结 channel formal memory 与自身 experience pack；team formal 不受影响', async () => {
    const sources = await sourcesFor(1000);
    expect(sources).toContain('team_formal_memory');
    expect(sources).not.toContain('channel_formal_memory');
    expect(sources).not.toContain('experience_pack');
  });
});
