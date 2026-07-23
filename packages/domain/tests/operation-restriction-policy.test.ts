import { describe, expect, test } from 'vitest';

import type {
  AgentExposureRestrictionWithBasisDto,
  ReliabilityAttributionFactDto,
  ReliabilityFactSourceRefDto,
  RestrictionFactualBasisEntryDto,
} from '@agentbean/contracts';

import {
  evaluateAttributionCorrection,
  evaluateRestrictionFactualBasis,
  redactRestrictionForMemberView,
  resolveAttributionCorrection,
} from '../src/operation-restriction-policy.js';

const confirmedFacts: ReliabilityAttributionFactDto[] = [
  {
    teamId: 't1',
    agentId: 'a1',
    operationKey: 'deploy',
    outcome: 'timed_out',
    sourceRef: { kind: 'invocation', id: 'inv-1' },
    confirmedAt: 1000,
  },
  {
    teamId: 't1',
    agentId: 'a1',
    operationKey: 'deploy',
    outcome: 'timed_out',
    sourceRef: { kind: 'invocation', id: 'inv-2' },
    confirmedAt: 2000,
  },
  {
    teamId: 't1',
    agentId: 'a1',
    operationKey: 'lint',
    outcome: 'completed',
    sourceRef: { kind: 'task', id: 'task-9' },
    confirmedAt: 3000,
  },
];

describe('evaluateRestrictionFactualBasis — AC#5 依据必须扎根当前 Team 已确认事实', () => {
  test('依据引用真实已确认事实 → ok，basis 原样通过（去重保序）', () => {
    const basis: RestrictionFactualBasisEntryDto[] = [
      {
        operationKey: 'deploy',
        citedFactRefs: [{ kind: 'invocation', id: 'inv-1' }, { kind: 'invocation', id: 'inv-2' }],
        summary: '两次部署超时',
      },
    ];
    const result = evaluateRestrictionFactualBasis({
      disabledOperations: ['deploy'],
      basis,
      confirmedFacts,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedBasis[0]!.citedFactRefs).toHaveLength(2);
    }
  });

  test('引用不存在的 fact ref（捏造依据）→ fail-closed（AC#5 依据必须可审计真实）', () => {
    const result = evaluateRestrictionFactualBasis({
      disabledOperations: ['deploy'],
      basis: [
        {
          operationKey: 'deploy',
          citedFactRefs: [{ kind: 'invocation', id: 'fabricated-fact' }],
          summary: '不存在的失败',
        },
      ],
      confirmedFacts,
    });
    expect(result.ok).toBe(false);
  });

  test('依据引用其他 operation 的事实（跨 operation 挪用）→ fail-closed（AC#5 依据必须对齐禁用对象）', () => {
    // 禁用 deploy，却引用 lint 的已确认事实 task-9 → 依据与禁用对象不对应。
    const result = evaluateRestrictionFactualBasis({
      disabledOperations: ['deploy'],
      basis: [
        {
          operationKey: 'deploy',
          citedFactRefs: [{ kind: 'task', id: 'task-9' }], // task-9 归因到 lint，非 deploy
          summary: '挪用 lint 的依据',
        },
      ],
      confirmedFacts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('OPERATION_RESTRICTION_BASIS_CITES_MISALIGNED_FACT');
    }
  });

  test('依据指向同 operation 的已确认正向事实仍可解析（对齐只校验 operationKey，outcome 正负由 governance 把握）', () => {
    // lint 有 1 条 completed（正向、已确认）。函数只保证引用真实且 operationKey 对齐；
    // 是否构成「禁用理由」由 governance 判断，不在纯规则层强制 outcome 正负。
    const result = evaluateRestrictionFactualBasis({
      disabledOperations: ['lint'],
      basis: [
        {
          operationKey: 'lint',
          citedFactRefs: [{ kind: 'task', id: 'task-9' }],
          summary: '依据',
        },
      ],
      confirmedFacts,
    });
    expect(result.ok).toBe(true);
  });

  test('无依据的禁用（空 basis）→ ok 但标记无依据（governance 决定是否接受无依据禁用）', () => {
    const result = evaluateRestrictionFactualBasis({
      disabledOperations: ['deploy'],
      basis: [],
      confirmedFacts,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasUnbasedDisabledOperations).toEqual(['deploy']);
  });
});

describe('evaluateAttributionCorrection — AC#5 错误归因纠正入口（提交）', () => {
  test('Agent owner 对真实已确认事实提纠错 → recorded pending（不自动删除）', () => {
    const result = evaluateAttributionCorrection({
      isAgentOwner: true,
      factRef: { kind: 'invocation', id: 'inv-1' },
      confirmedFactRefs: confirmedFacts.map((f) => f.sourceRef),
      reason: '这次 timeout 是基础设施故障，非 Agent 归因',
    });
    expect(result.kind).toBe('recorded');
    expect(result.status).toBe('pending');
  });

  test('非 Agent owner 提纠错 → fail-closed（NOT_AGENT_OWNER）', () => {
    const result = evaluateAttributionCorrection({
      isAgentOwner: false,
      factRef: { kind: 'invocation', id: 'inv-1' },
      confirmedFactRefs: confirmedFacts.map((f) => f.sourceRef),
      reason: 'x',
    });
    expect(result.kind).toBe('rejected');
    expect(result.reasonCode).toBe('ATTRIBUTION_CORRECTION_NOT_AGENT_OWNER');
  });

  test('引用不存在的事实 → fail-closed（INVALID_FACT_REF），不能对空气纠错', () => {
    const result = evaluateAttributionCorrection({
      isAgentOwner: true,
      factRef: { kind: 'invocation', id: 'does-not-exist' },
      confirmedFactRefs: confirmedFacts.map((f) => f.sourceRef),
      reason: 'x',
    });
    expect(result.kind).toBe('rejected');
    expect(result.reasonCode).toBe('ATTRIBUTION_CORRECTION_INVALID_FACT_REF');
  });

  test('空 reason → fail-closed（纠错必须说明理由，可审计）', () => {
    const result = evaluateAttributionCorrection({
      isAgentOwner: true,
      factRef: { kind: 'invocation', id: 'inv-1' },
      confirmedFactRefs: confirmedFacts.map((f) => f.sourceRef),
      reason: '   ',
    });
    expect(result.kind).toBe('rejected');
  });
});

describe('resolveAttributionCorrection — AC#5 owner/admin 审阅纠错', () => {
  test('Team Owner/Admin acknowledge → fact 降权（产出 downweightedFactRef 供 reliability 排除）', () => {
    const result = resolveAttributionCorrection({
      isTeamOwnerOrAdmin: true,
      decision: 'acknowledge',
      factRef: { kind: 'invocation', id: 'inv-1' },
    });
    expect(result.kind).toBe('acknowledged');
    expect(result.downweightedFactRef).toEqual({ kind: 'invocation', id: 'inv-1' });
  });

  test('Team Owner/Admin reject → 纠错被驳回（REJECTED 码），事实保留', () => {
    const result = resolveAttributionCorrection({
      isTeamOwnerOrAdmin: true,
      decision: 'reject',
      factRef: { kind: 'invocation', id: 'inv-1' },
    });
    expect(result.kind).toBe('rejected_decision');
    if (result.kind === 'rejected_decision') {
      // 用「审阅后驳回」码，而非「提交 pending」码（canonical：每个终态决定一个稳定码）。
      expect(result.reasonCode).toBe('ATTRIBUTION_CORRECTION_REJECTED');
    }
  });

  test('非 owner/admin 不能审阅 → fail-closed（NOT_AUTHORIZED_TO_RESOLVE）', () => {
    const result = resolveAttributionCorrection({
      isTeamOwnerOrAdmin: false,
      decision: 'acknowledge',
      factRef: { kind: 'invocation', id: 'inv-1' },
    });
    expect(result.kind).toBe('denied');
    expect(result.reasonCode).toBe('ATTRIBUTION_CORRECTION_NOT_AUTHORIZED_TO_RESOLVE');
  });
});

describe('redactRestrictionForMemberView — AC#6 成员不看依据/纠错细节', () => {
  const restriction: AgentExposureRestrictionWithBasisDto = {
    id: 'r1',
    teamId: 't1',
    agentId: 'a1',
    manifestId: 'm1',
    disabledCapabilities: ['deploy'],
    disabledSkills: ['deploy-skill'],
    factualBasis: [
      {
        operationKey: 'deploy',
        citedFactRefs: [{ kind: 'invocation', id: 'inv-1' }],
        summary: '两次部署超时',
      },
    ],
    updatedBy: 'owner-1',
    updatedAt: 5000,
  };

  test('成员视图只看「哪些 operation 被禁用」，不看 factualBasis / 纠错细节 / updatedBy', () => {
    const view = redactRestrictionForMemberView(restriction);
    expect(view.disabledCapabilities).toEqual(['deploy']);
    expect(view.disabledSkills).toEqual(['deploy-skill']);
    expect(view.hasFactualBasis).toBe(true);
    // 关键：成员看不到依据正文、引用与审计字段
    expect(view).not.toHaveProperty('factualBasis');
    expect(view).not.toHaveProperty('updatedBy');
    expect(view).not.toHaveProperty('manifestId');
  });

  test('无依据的 restriction → hasFactualBasis false（成员仍看到禁用列表）', () => {
    const view = redactRestrictionForMemberView({ ...restriction, factualBasis: [] });
    expect(view.hasFactualBasis).toBe(false);
    expect(view.disabledCapabilities).toEqual(['deploy']);
  });
});
