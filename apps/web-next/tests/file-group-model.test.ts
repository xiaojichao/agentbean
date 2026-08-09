import { describe, expect, test } from 'vitest';

/**
 * 文件库「逻辑产物」视图的左侧文件组聚合模型(纯函数)。
 *
 * 覆盖(design.md 数据流 + prd R2/R3):
 * - 三类混排(输出包/文件集合/等待上游),lastActivityAt 倒序,waiting 恒排尾;
 * - 输出包卡片:成员数/聚合审核态/Task rX·attempt chips,agentId 保留,摘要无 final;
 * - 交付处理中(pendingDeliveries)以 package 类卡片呈现,不伪造完整交付;
 * - 文件集合卡片:类型/阶段/当前版/审核态/final 指针 chips,lastActivityAt 取
 *   最新版本/审核/finalize 时间 max;
 * - 等待上游 = 存在 stage 但无集合归属且无输出包关联(taskId 命中);
 * - 筛选谓词:全部/待审核/有 final/Agent 输出;
 * - 搜索谓词:文件组名/文件名/版本号;Agent 名经 withAgentNames 由调用方映射;
 * - withPackageFinalStates:包 final 事实来自懒加载投影(Server),摘要阶段不可推断。
 */

import {
  buildFileGroupCards,
  filterFileGroupCards,
  filterFileGroupCardsByRoleAndStatus,
  packageProjectionSummaryLines,
  withAgentNames,
  withPackageFinalStates,
  type FileGroupCardModel,
} from '../lib/file-group-model';
import type {
  OutputPackagePendingDeliveryDto,
  OutputPackageSummaryDto,
  ProjectArtifactLibraryDto,
} from '@agentbean/contracts';

const pkg1: OutputPackageSummaryDto = {
  schemaVersion: 1,
  packageId: 'pkg-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  revision: 1,
  deliveryId: 'del-1',
  publishId: 'pub-1',
  workspaceRevisionId: 'ws-1',
  agentId: 'agent-a',
  taskId: 'task-1',
  taskBinding: 'managed',
  taskRevision: 2,
  taskAttempt: 1,
  memberCount: 2,
  reviewState: 'pending',
  status: 'recorded',
  createdAt: 1000,
};

const pkg2: OutputPackageSummaryDto = {
  ...pkg1,
  packageId: 'pkg-2',
  deliveryId: 'del-2',
  publishId: 'pub-2',
  workspaceRevisionId: 'ws-2',
  agentId: 'agent-b',
  taskId: 'task-2',
  taskRevision: 1,
  reviewState: 'approved',
  createdAt: 2000,
};

const pending: OutputPackagePendingDeliveryDto = {
  publishId: 'pub-3',
  workspaceRevisionId: 'ws-3',
  agentId: 'agent-b',
  taskId: 'task-2',
  taskAttempt: 2,
  committedAt: 2500,
};

function version(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    teamId: 'team-1',
    channelId: 'channel-1',
    collectionId: 'col-1',
    versionNumber: 1,
    artifact: { id: `art-${id}`, filename: `${id}.md` },
    source: { stageId: 'stage-1', taskId: 'task-1', taskRevision: 1 },
    lineage: [],
    promotedBy: 'user-1',
    createdAt: 800,
    reviews: [],
    reviewState: 'pending',
    packageMemberships: [],
    ...overrides,
  };
}

const collection1 = {
  id: 'col-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  name: 'script.ep01',
  kind: 'script',
  revision: 4,
  currentVersionId: 'ver-c1',
  finalVersionId: 'ver-c1',
  versions: [
    version('ver-1', { versionNumber: 1, createdAt: 800, reviewState: 'approved' }),
    version('ver-c1', {
      versionNumber: 4,
      createdAt: 1500,
      reviewState: 'approved',
      reviews: [{ createdAt: 1600 }],
    }),
  ],
  finalizations: [{ createdAt: 1700 }],
  createdBy: 'user-1',
  createdAt: 800,
  updatedAt: 1700,
};

const library: ProjectArtifactLibraryDto = {
  archived: false,
  collections: [collection1],
};

const stages = [
  { id: 'stage-1', name: '剧本', goal: '产出第 1 集剧本', taskId: 'task-1' },
  { id: 'stage-2', name: '服装', goal: '产出服装参考图', taskId: 'task-2' },
  { id: 'stage-3', name: '分镜', goal: '产出分镜图组', taskId: 'task-3' },
];

describe('buildFileGroupCards', () => {
  test('三类混排:package/collection 按 lastActivityAt 倒序,waiting 恒排尾', () => {
    const cards = buildFileGroupCards({
      packages: [pkg1, pkg2],
      pendingDeliveries: [pending],
      library,
      stages,
    });
    // pkg-2(2000) > collection(1700) > pkg-1(1000) > pending(2500 但 kind=package,
    // 与 package 一样按时间混排 → 应排最前)…… 时间轴: pending 2500、pkg2 2000、
    // collection 1700、pkg1 1000;waiting(stage-2 被 pkg-2 taskId 关联、stage-3
    // 无任何归属 → 仅 stage-3)排尾。
    expect(cards.map((card) => card.id)).toEqual([
      `pending:${pending.publishId}`,
      pkg2.packageId,
      collection1.id,
      pkg1.packageId,
      'waiting:stage-3',
    ]);
  });

  test('输出包卡片:成员数/审核态/Task rX·attempt chips,保留 agentId,摘要无 final 事实', () => {
    const cards = buildFileGroupCards({ packages: [pkg1], pendingDeliveries: [], library: null, stages: [] });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.kind).toBe('package');
    expect(card.id).toBe('pkg-1');
    expect(card.title).toBe('输出包');
    expect(card.chips).toEqual(['2 个文件', '待审核', 'Task r2 · attempt 1']);
    expect(card.agentId).toBe('agent-a');
    expect(card.lastActivityAt).toBe(1000);
    expect(card.pendingReview).toBe(true);
    expect(card.hasFinal).toBe(false);
    expect(card.agentOutput).toBe(true);
    expect(card.payload).toEqual({ kind: 'package', package: pkg1 });
  });

  test('输出包成员集合由包卡统一承载，不在包外重复生成集合卡', () => {
    const cards = buildFileGroupCards({
      packages: [pkg1],
      pendingDeliveries: [],
      library,
      stages,
      packageMemberCollectionIds: new Set(['col-1']),
    });
    expect(cards.some((card) => card.kind === 'package' && card.id === 'pkg-1')).toBe(true);
    expect(cards.some((card) => card.kind === 'collection' && card.id === 'col-1')).toBe(false);
  });

  test('交付处理中:以 package 类卡片呈现,不伪造完整交付', () => {
    const cards = buildFileGroupCards({ packages: [], pendingDeliveries: [pending], library: null, stages: [] });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.kind).toBe('package');
    expect(card.title).toBe('交付处理中');
    expect(card.chips).toEqual(['attempt 2']);
    expect(card.lastActivityAt).toBe(2500);
    expect(card.payload).toEqual({ kind: 'pending-delivery', pending });
    expect(card.pendingReview).toBe(false);
  });

  test('文件集合卡片:类型/阶段/当前版/审核态/final chips,lastActivityAt 取各事实时间 max', () => {
    const cards = buildFileGroupCards({ packages: [], pendingDeliveries: [], library, stages });
    const card = cards.find((item) => item.id === 'col-1')!;
    expect(card.kind).toBe('collection');
    expect(card.title).toBe('script.ep01');
    // 共 2 版 / 阶段名(来自版本 source.stageId 映射) / 当前版审核态 / 有 final。
    expect(card.chips).toContain('共 2 版');
    expect(card.chips).toContain('剧本');
    expect(card.chips).toContain('已通过');
    expect(card.chips).toContain('有 final');
    // max(updatedAt 1700, 版本 800/1500, 审核 1600, finalize 1700)。
    expect(card.lastActivityAt).toBe(1700);
    expect(card.summaryLines).toEqual(['当前版 v4 · ver-c1.md']);
    expect(card.pendingReview).toBe(false);
    expect(card.hasFinal).toBe(true);
  });

  test('集合归属 stage:任一版本 source.stageId 命中即不算等待上游;无归属且无包关联 → 等待上游', () => {
    // stage-1 被集合 col-1 归属;stage-2 被 pkg-2 taskId 关联;stage-3 无任何归属。
    const cards = buildFileGroupCards({ packages: [pkg1, pkg2], pendingDeliveries: [], library, stages });
    const waiting = cards.filter((card) => card.kind === 'waiting');
    expect(waiting.map((card) => card.id)).toEqual(['waiting:stage-3']);
    expect(waiting[0].title).toBe('分镜输出包');
    expect(waiting[0].chips).toEqual(['等待上游']);
    expect(waiting[0].summaryLines).toEqual(['产出分镜图组']);
    expect(waiting[0].payload).toEqual({ kind: 'waiting', stage: { id: 'stage-3', name: '分镜', goal: '产出分镜图组', taskId: 'task-3' } });
  });

  test('空数据:无包/无集合/无阶段 → 空列表', () => {
    expect(buildFileGroupCards({ packages: [], pendingDeliveries: [], library: null, stages: [] })).toEqual([]);
  });
});

describe('filterFileGroupCards', () => {
  const cards = buildFileGroupCards({ packages: [pkg1, pkg2], pendingDeliveries: [pending], library, stages });

  test('全部:原样返回(保持排序)', () => {
    const filtered = filterFileGroupCards(cards, 'all', '');
    expect(filtered).toHaveLength(cards.length);
    expect(filtered.map((card) => card.id)).toEqual(cards.map((card) => card.id));
  });

  test('待审核:package 聚合态/集合当前版为 pending 命中', () => {
    const filtered = filterFileGroupCards(cards, 'pending_review', '');
    // pkg-1(pending)命中;pkg-2(approved)、pending 卡、col-1(approved)不命中;waiting 不命中。
    expect(filtered.map((card) => card.id)).toEqual(['pkg-1']);
  });

  test('有 final:集合 finalVersionId 命中;包 final 事实来自投影 enrichment', () => {
    const filtered = filterFileGroupCards(cards, 'has_final', '');
    expect(filtered.map((card) => card.id)).toEqual(['col-1']);
    const enriched = withPackageFinalStates(cards, new Map([['pkg-1', true]]));
    expect(filterFileGroupCards(enriched, 'has_final', '').map((card) => card.id)).toEqual(['col-1', 'pkg-1']);
  });

  test('Agent 输出筛选只返回包卡；带 packageMemberships 的集合不重复列出', () => {
    const filtered = filterFileGroupCards(cards, 'agent_output', '');
    // pkg-1/pkg-2/pending(agentOutput=true)、col-1 无 packageMemberships → 不命中。
    // 保持构建序(按 lastActivityAt 倒序):pending 2500、pkg-2 2000、pkg-1 1000。
    expect(filtered.map((card) => card.id)).toEqual([`pending:${pending.publishId}`, 'pkg-2', 'pkg-1']);
    // 集合带交付包成员后由包卡承载，不再生成集合卡。
    const withDelivery = buildFileGroupCards({
      packages: [pkg2],
      pendingDeliveries: [],
      library: {
        archived: false,
        collections: [{
          ...collection1,
          versions: [version('ver-c1', {
            versionNumber: 4, reviewState: 'approved',
            packageMemberships: [{ packageId: 'pkg-2', sequence: 1, shortLabel: 'F1', deliveredAt: 2000 }],
          })],
        }],
      },
      stages,
    });
    expect(filterFileGroupCards(withDelivery, 'agent_output', '').map((card) => card.id)).toEqual(['pkg-2']);
  });

  test('搜索:按文件组名/文件名/版本号过滤;大小写不敏感', () => {
    expect(filterFileGroupCards(cards, 'all', '服装').map((card) => card.id)).toEqual(['pkg-2']);
    expect(filterFileGroupCards(cards, 'all', 'script.ep01').map((card) => card.id)).toEqual(['col-1']);
    expect(filterFileGroupCards(cards, 'all', 'ver-c1.md').map((card) => card.id)).toEqual(['col-1']);
    expect(filterFileGroupCards(cards, 'all', 'v4').map((card) => card.id)).toEqual(['col-1']);
    expect(filterFileGroupCards(cards, 'all', 'SCRIPT.EP01').map((card) => card.id)).toEqual(['col-1']);
    expect(filterFileGroupCards(cards, 'all', '不存在的关键字')).toEqual([]);
  });

  test('搜索 + 筛选叠加生效', () => {
    expect(filterFileGroupCards(cards, 'pending_review', 'pkg-2')).toEqual([]);
    expect(filterFileGroupCards(cards, 'pending_review', 'pkg-1').map((card) => card.id)).toEqual(['pkg-1']);
  });

  test('原型角色/状态下拉可独立组合', () => {
    expect(filterFileGroupCardsByRoleAndStatus(cards, {
      agentId: 'agent-a',
      status: 'pending',
      search: '',
    }).map((card) => card.id)).toEqual(['pkg-1']);
    expect(filterFileGroupCardsByRoleAndStatus(cards, {
      agentId: 'all',
      status: 'approved',
      search: '',
    }).map((card) => card.id)).toEqual(['pkg-2', 'col-1']);
    expect(filterFileGroupCardsByRoleAndStatus(cards, {
      agentId: 'all',
      status: 'waiting',
      search: '分镜',
    }).map((card) => card.id)).toEqual(['waiting:stage-3']);
  });
});

describe('packageProjectionSummaryLines', () => {
  test('投影成员 → 短编号+版本摘要行(F1 v4 / F2 v3)', () => {
    expect(packageProjectionSummaryLines([
      { shortLabel: 'F1', versionNumber: 4 },
      { shortLabel: 'F2', versionNumber: 3 },
      { shortLabel: 'IMG', versionNumber: 1 },
    ])).toEqual(['F1 v4', 'F2 v3', 'IMG v1']);
  });

  test('空成员 → 空摘要', () => {
    expect(packageProjectionSummaryLines([])).toEqual([]);
  });
});

describe('withAgentNames', () => {
  test('调用方把 agentId 映射为显示名后追加进搜索池,不改动其它字段', () => {
    const cards = buildFileGroupCards({ packages: [pkg1], pendingDeliveries: [], library: null, stages: [] });
    const named = withAgentNames(cards, new Map([['agent-a', '编剧Agent']]));
    expect(named[0].agentId).toBe('agent-a');
    expect(named[0].chips).toEqual(cards[0].chips);
    expect(filterFileGroupCards(named, 'all', '编剧Agent').map((card) => card.id)).toEqual(['pkg-1']);
    // 未映射的名字不命中。
    expect(filterFileGroupCards(named, 'all', '未映射Agent')).toEqual([]);
  });

  test('无 agentId 的卡片(集合/等待)原样返回', () => {
    const cards = buildFileGroupCards({ packages: [], pendingDeliveries: [], library, stages });
    const named = withAgentNames(cards, new Map());
    expect(named).toEqual(cards);
  });
});

describe('withPackageFinalStates', () => {
  test('仅覆盖 package 卡;集合/waiting 卡不受影响', () => {
    const cards = buildFileGroupCards({ packages: [pkg1, pkg2], pendingDeliveries: [], library, stages });
    const enriched = withPackageFinalStates(cards, new Map([['pkg-1', true]]));
    const byId = new Map(enriched.map((card: FileGroupCardModel) => [card.id, card]));
    expect(byId.get('pkg-1')!.hasFinal).toBe(true);
    expect(byId.get('pkg-2')!.hasFinal).toBe(false);
    expect(byId.get('col-1')!.hasFinal).toBe(true); // 集合 final 事实不来自投影
    expect(byId.get('waiting:stage-3')!.hasFinal).toBe(false);
  });
});
