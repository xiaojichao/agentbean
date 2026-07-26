import { describe, expect, test } from 'vitest';

import {
  MINIMUM_BACKFILLED_BUNDLE_MEMBERS,
  evaluateBundleBackfillGrouping,
  type ProjectDocumentBundleBackfillDocumentFact,
} from '../src/index.js';

const CHANNEL = 'channel-1';

function fact(
  overrides: Partial<ProjectDocumentBundleBackfillDocumentFact> & { documentId: string },
): ProjectDocumentBundleBackfillDocumentFact {
  return {
    channelId: CHANNEL,
    createdAt: 1_000,
    derivesFromRunNow: true,
    ...overrides,
  };
}

describe('#830 历史 Markdown 输出的回填分组判定', () => {
  test('同一次 Run 的多份可证 Markdown 按创建时间成组', () => {
    const grouping = evaluateBundleBackfillGrouping(
      [
        fact({ documentId: 'doc-b', createdAt: 2_000 }),
        fact({ documentId: 'doc-a', createdAt: 1_000 }),
      ],
      { channelId: CHANNEL },
    );
    expect(grouping).toEqual({ groupable: true, documentIds: ['doc-a', 'doc-b'] });
  });

  test('创建时间相同时按 documentId 取稳定序，保证重试的请求指纹不漂移', () => {
    const facts = [
      fact({ documentId: 'doc-z', createdAt: 1_000 }),
      fact({ documentId: 'doc-a', createdAt: 1_000 }),
    ];
    const first = evaluateBundleBackfillGrouping(facts, { channelId: CHANNEL });
    const second = evaluateBundleBackfillGrouping(facts.slice().reverse(), { channelId: CHANNEL });
    expect(first).toEqual(second);
    expect(first).toEqual({ groupable: true, documentIds: ['doc-a', 'doc-z'] });
  });

  test('有成员漂移则整次 Run 判为歧义，不把剩下的凑成一个包', () => {
    const grouping = evaluateBundleBackfillGrouping(
      [
        fact({ documentId: 'doc-a' }),
        fact({ documentId: 'doc-b' }),
        fact({ documentId: 'doc-c', derivesFromRunNow: false }),
      ],
      { channelId: CHANNEL },
    );
    expect(grouping).toEqual({ groupable: false, code: 'member_drifted' });
  });

  test('漂移优先于数量：只剩一份可证时仍报 member_drifted 而不是 single_document', () => {
    const grouping = evaluateBundleBackfillGrouping(
      [
        fact({ documentId: 'doc-a' }),
        fact({ documentId: 'doc-b', derivesFromRunNow: false }),
      ],
      { channelId: CHANNEL },
    );
    // 漂移意味着「这次 Run 到底产出几份」不可知；报 single_document 会把不可知说成已知。
    expect(grouping).toEqual({ groupable: false, code: 'member_drifted' });
  });

  test('跨频道声称同一次 Run 的文档使整次 Run 判为歧义', () => {
    const grouping = evaluateBundleBackfillGrouping(
      [
        fact({ documentId: 'doc-a' }),
        fact({ documentId: 'doc-b', channelId: 'channel-2' }),
      ],
      { channelId: CHANNEL },
    );
    expect(grouping).toEqual({ groupable: false, code: 'cross_channel_member' });
  });

  test('单份输出不成包', () => {
    const grouping = evaluateBundleBackfillGrouping(
      [fact({ documentId: 'doc-a' })],
      { channelId: CHANNEL },
    );
    expect(grouping).toEqual({ groupable: false, code: 'single_document' });
  });

  test('没有任何可证成员时给出独立原因码', () => {
    expect(evaluateBundleBackfillGrouping([], { channelId: CHANNEL }))
      .toEqual({ groupable: false, code: 'no_provable_member' });
  });

  test('下限是「多份」，即至少两个成员', () => {
    expect(MINIMUM_BACKFILLED_BUNDLE_MEMBERS).toBe(2);
    const facts = [fact({ documentId: 'doc-a' }), fact({ documentId: 'doc-b' })];
    expect(evaluateBundleBackfillGrouping(facts, { channelId: CHANNEL }).groupable).toBe(true);
  });
});
