import { describe, expect, test } from 'vitest';

import { RELIABILITY_RISK_HINT, type ReliabilityAttributionFactDto } from '@agentbean/contracts';

import {
  evaluateTeamLocalReliability,
  redactReliabilityForTaskMatching,
  reliabilityRankingScore,
} from '../src/reliability-policy.js';
import { resolveAttributionCorrection } from '../src/operation-restriction-policy.js';

function fact(partial: Partial<ReliabilityAttributionFactDto>): ReliabilityAttributionFactDto {
  return {
    teamId: 't1',
    agentId: 'a1',
    operationKey: 'code-review',
    outcome: 'completed',
    sourceRef: { kind: 'task', id: 'f1' },
    confirmedAt: 1000,
    ...partial,
  } as ReliabilityAttributionFactDto;
}

describe('evaluateTeamLocalReliability — AC#1 当前 Team 已确认归因', () => {
  test('只统计当前 team+agent 的事实，丢弃其他 Team（AC#1/AC#2 跨 Team 隔离）', () => {
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'code-review', outcome: 'completed', sourceRef: { kind: 'task', id: 'f1' } }),
        // 其他 Team 的事实——必须被丢弃，不能形成当前 Team 负面事实
        fact({ teamId: 'other-team', operationKey: 'code-review', outcome: 'timed_out', sourceRef: { kind: 'task', id: 'f2' } }),
        // 其他 agent 的事实——必须被丢弃
        fact({ agentId: 'a2', operationKey: 'code-review', outcome: 'timed_out', sourceRef: { kind: 'task', id: 'f3' } }),
      ],
    });
    expect(signal.perOperation).toHaveLength(1);
    const entry = signal.perOperation[0]!;
    expect(entry.operationKey).toBe('code-review');
    expect(entry.completed).toBe(1);
    expect(entry.timedOut).toBe(0); // 跨 team/agent 的 timeout 不计入
    expect(entry.score).toBe(1); // 1 完成 / 1 总 = 完美，无负面
  });

  test('无任何已确认事实 → neutral（overallScore=1.0），不形成负面事实（AC#2）', () => {
    const signal = evaluateTeamLocalReliability({ teamId: 't1', agentId: 'a1', facts: [] });
    expect(signal.perOperation).toEqual([]);
    expect(signal.overallScore).toBe(1); // 无数据 = 中性高，永不降权未证 agent
  });
});

describe('evaluateTeamLocalReliability — AC#2 仅已确认 outcome 形成事实', () => {
  test('score = positive/total；全负向 → 0；混合 → 比例', () => {
    const allNegative = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'i1' } }),
        fact({ operationKey: 'deploy', outcome: 'relinquished', sourceRef: { kind: 'claim', id: 'c1' } }),
      ],
    });
    expect(allNegative.perOperation[0]!.score).toBe(0);

    const mixed = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 'x1' } }),
        fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 'x2' } }),
        fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'x3' } }),
      ],
    });
    expect(mixed.perOperation[0]!.score).toBeCloseTo(2 / 3, 5);
  });

  test('confirmed 正向 outcome 全部参与：accepted/completed/manual_verified', () => {
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'lint', outcome: 'accepted', sourceRef: { kind: 'offer', id: 'o1' } }),
        fact({ operationKey: 'lint', outcome: 'completed', sourceRef: { kind: 'task', id: 'o2' } }),
        fact({ operationKey: 'lint', outcome: 'manual_verified', sourceRef: { kind: 'acceptance', id: 'o3' } }),
      ],
    });
    const entry = signal.perOperation[0]!;
    expect(entry.accepted).toBe(1);
    expect(entry.completed).toBe(1);
    expect(entry.manualVerified).toBe(1);
    expect(entry.score).toBe(1);
  });
});

describe('evaluateTeamLocalReliability — overallScore 与样本加权', () => {
  test('overallScore = 各 operation score 的样本加权平均；无 entry → 1.0', () => {
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        // op-a: 3 完成 → score 1.0 (total 3)
        fact({ operationKey: 'op-a', outcome: 'completed', sourceRef: { kind: 'task', id: 'a1' } }),
        fact({ operationKey: 'op-a', outcome: 'completed', sourceRef: { kind: 'task', id: 'a2' } }),
        fact({ operationKey: 'op-a', outcome: 'completed', sourceRef: { kind: 'task', id: 'a3' } }),
        // op-b: 1 完成 + 1 timeout → score 0.5 (total 2)
        fact({ operationKey: 'op-b', outcome: 'completed', sourceRef: { kind: 'task', id: 'b1' } }),
        fact({ operationKey: 'op-b', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'b2' } }),
      ],
    });
    // weighted = (1.0*3 + 0.5*2) / (3+2) = 4/5 = 0.8
    expect(signal.overallScore).toBeCloseTo(0.8, 5);
  });
});

describe('evaluateTeamLocalReliability — AC#3 风险提示', () => {
  test('≥2 次 confirmed timeout → HIGH_TIMEOUT_RATE', () => {
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 't1' } }),
        fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 't2' } }),
        fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 't3' } }),
      ],
    });
    expect(signal.perOperation[0]!.riskHints).toContain(RELIABILITY_RISK_HINT.HIGH_TIMEOUT_RATE);
  });

  test('≥2 次 confirmed relinquish → HIGH_RELINQUISH_RATE', () => {
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'deploy', outcome: 'relinquished', sourceRef: { kind: 'claim', id: 'r1' } }),
        fact({ operationKey: 'deploy', outcome: 'relinquished', sourceRef: { kind: 'claim', id: 'r2' } }),
      ],
    });
    expect(signal.perOperation[0]!.riskHints).toContain(RELIABILITY_RISK_HINT.HIGH_RELINQUISH_RATE);
  });

  test('total < 3 → LOW_SAMPLE（信息性，非负面事实）', () => {
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 's1' } })],
    });
    expect(signal.perOperation[0]!.riskHints).toContain(RELIABILITY_RISK_HINT.LOW_SAMPLE);
  });

  test('单次 timeout（<阈值）不触发 HIGH_TIMEOUT_RATE，仅可能 LOW_SAMPLE', () => {
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'u1' } }),
        fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 'u2' } }),
        fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 'u3' } }),
      ],
    });
    expect(signal.perOperation[0]!.riskHints).not.toContain(RELIABILITY_RISK_HINT.HIGH_TIMEOUT_RATE);
    expect(signal.perOperation[0]!.riskHints).not.toContain(RELIABILITY_RISK_HINT.LOW_SAMPLE); // total=3
  });
});

describe('evaluateTeamLocalReliability — AC#7 确定性', () => {
  test('相同输入（任意顺序）→ 相同输出；perOperation 按 operationKey 排序', () => {
    const facts: ReliabilityAttributionFactDto[] = [
      fact({ operationKey: 'zebra', outcome: 'completed', sourceRef: { kind: 'task', id: 'z1' } }),
      fact({ operationKey: 'alpha', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'a1' } }),
      fact({ operationKey: 'alpha', outcome: 'completed', sourceRef: { kind: 'task', id: 'a2' } }),
      fact({ operationKey: 'zebra', outcome: 'completed', sourceRef: { kind: 'task', id: 'z2' } }),
    ];
    // 打乱顺序两次输入，结果必须一致
    const s1 = evaluateTeamLocalReliability({ teamId: 't1', agentId: 'a1', facts });
    const s2 = evaluateTeamLocalReliability({ teamId: 't1', agentId: 'a1', facts: [...facts].reverse() });
    expect(s1).toEqual(s2);
    expect(s1.perOperation.map((e) => e.operationKey)).toEqual(['alpha', 'zebra']);
  });
});

describe('evaluateTeamLocalReliability — AC#5 纠错降权（excludedFactRefs）', () => {
  test('acknowledged 纠错的事实从计算中排除（不自动删除，但不再形成负面事实）', () => {
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'bad' } }),
        fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 'good' } }),
      ],
      // Agent owner 对 bad 这条 timeout 提出纠错并被 acknowledged → 排除
      excludedFactRefs: [{ kind: 'invocation', id: 'bad' }],
    });
    const entry = signal.perOperation[0]!;
    expect(entry.timedOut).toBe(0); // 纠错事实降权排除
    expect(entry.completed).toBe(1);
    expect(entry.score).toBe(1);
  });
});

describe('reliabilityRankingScore — 排序标量（AC#3/AC#7）', () => {
  const signal = evaluateTeamLocalReliability({
    teamId: 't1',
    agentId: 'a1',
    facts: [
      fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'd1' } }),
      fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 'd2' } }),
      // op-a 完美
      fact({ operationKey: 'op-a', outcome: 'completed', sourceRef: { kind: 'task', id: 'oa1' } }),
    ],
  });

  test('无 required operation → neutral 1.0（reliability 不适用）', () => {
    expect(reliabilityRankingScore(signal, [])).toBe(1);
  });

  test('required operation 无 reliability 条目 → neutral 1.0（AC#2 不因无数据降权）', () => {
    expect(reliabilityRankingScore(signal, ['never-seen-op'])).toBe(1);
  });

  test('required operation 有条目 → 该条目 score（deploy=0.5）', () => {
    expect(reliabilityRankingScore(signal, ['deploy'])).toBeCloseTo(0.5, 5);
  });

  test('多个 required operation → 取均值（deploy 0.5 + op-a 1.0 = 0.75）', () => {
    expect(reliabilityRankingScore(signal, ['deploy', 'op-a'])).toBeCloseTo(0.75, 5);
  });

  test('混合场景：部分 required operation 有失败、部分无数据 → 无数据按 neutral 1.0 计，不过度降权（AC#2）', () => {
    // deploy score 0.5（有失败），never-seen-op 无条目 → 应贡献 neutral 1.0，均值 (0.5+1.0)/2=0.75，
    // 而非只算有数据的 deploy=0.5（那会把单个 operation 的失败放大成整体 0.5，过度降权）。
    expect(reliabilityRankingScore(signal, ['deploy', 'never-seen-op'])).toBeCloseTo(0.75, 5);
  });
});

describe('redactReliabilityForTaskMatching — AC#6 成员可见性裁剪', () => {
  const signal = evaluateTeamLocalReliability({
    teamId: 't1',
    agentId: 'a1',
    facts: [
      // deploy: 1 timeout + 1 complete → score 0.5, affectsRanking true
      fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'd1' } }),
      fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 'd2' } }),
      // unrelated-op: 3 次完成 → score 1.0、无 LOW_SAMPLE、与本次 Task 匹配无关
      fact({ operationKey: 'unrelated-op', outcome: 'completed', sourceRef: { kind: 'task', id: 'u1' } }),
      fact({ operationKey: 'unrelated-op', outcome: 'completed', sourceRef: { kind: 'task', id: 'u2' } }),
      fact({ operationKey: 'unrelated-op', outcome: 'completed', sourceRef: { kind: 'task', id: 'u3' } }),
    ],
  });

  test('成员视图只保留与当前 Task 相关的 operation，丢弃其他 operation', () => {
    const view = redactReliabilityForTaskMatching(signal, { requiredOperations: ['deploy'] });
    expect(view.entries.map((e) => e.operationKey)).toEqual(['deploy']);
    const deploy = view.entries[0]!;
    expect(deploy.affectsRanking).toBe(true); // score 0.5 < 1.0
  });

  test('成员视图不含 overallScore / 计数 / 纠错细节（只看是否影响本次匹配 + 单条提示）', () => {
    const view = redactReliabilityForTaskMatching(signal, { requiredOperations: ['deploy'] });
    const deploy = view.entries[0]!;
    expect(deploy).not.toHaveProperty('score');
    expect(deploy).not.toHaveProperty('completed');
    expect(deploy).not.toHaveProperty('timedOut');
  });

  test('完美 operation（score 1.0）→ affectsRanking false，无风险提示', () => {
    const view = redactReliabilityForTaskMatching(signal, { requiredOperations: ['unrelated-op'] });
    const entry = view.entries[0]!;
    expect(entry.affectsRanking).toBe(false);
    expect(entry.riskHint).toBeNull();
  });
});

describe('纠错 → reliability 反馈链（AC#5，跨模块集成）', () => {
  test('resolveAttributionCorrection.downweightedFactRef 线程进 evaluateTeamLocalReliability.excludedFactRefs → 该事实被排除', () => {
    // Agent owner 对 deploy 的 timeout(inv-1) 提纠错，Team admin acknowledge → 降权。
    const resolution = resolveAttributionCorrection({
      isTeamOwnerOrAdmin: true,
      decision: 'acknowledge',
      factRef: { kind: 'invocation', id: 'inv-1' },
    });
    expect(resolution.kind).toBe('acknowledged');
    if (resolution.kind !== 'acknowledged') return;

    // 把 downweightedFactRef 直接线程进 reliability 计算的 excludedFactRefs（接线层将这样消费）。
    // 关键：两端共用 reliabilityFactRefKey，故 ref 匹配生效，inv-1 被排除。
    const signal = evaluateTeamLocalReliability({
      teamId: 't1',
      agentId: 'a1',
      facts: [
        fact({ operationKey: 'deploy', outcome: 'timed_out', sourceRef: { kind: 'invocation', id: 'inv-1' } }),
        fact({ operationKey: 'deploy', outcome: 'completed', sourceRef: { kind: 'task', id: 'good' } }),
      ],
      excludedFactRefs: [resolution.downweightedFactRef],
    });
    const deploy = signal.perOperation[0]!;
    expect(deploy.timedOut).toBe(0); // inv-1 被纠错降权排除
    expect(deploy.completed).toBe(1);
    expect(deploy.score).toBe(1); // 排除误判后，deploy 恢复完美
  });
});
