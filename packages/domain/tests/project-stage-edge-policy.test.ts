import { describe, expect, test } from 'vitest';

import {
  evaluateProjectStageEdgeCreation,
  evaluateProjectStageExecutionGate,
  type ProjectStageEdgeEndpoint,
  type ProjectStageUpstreamEdgeFacts,
} from '../src/project-stage-edge-policy.js';

const stage = (stageId: string, taskId: string, overrides: Partial<ProjectStageEdgeEndpoint> = {}):
ProjectStageEdgeEndpoint => ({
  stageId,
  teamId: 'team-1',
  channelId: 'channel-1',
  taskId,
  ...overrides,
});

const createInput = (overrides: Partial<Parameters<typeof evaluateProjectStageEdgeCreation>[0]> = {}) => ({
  teamId: 'team-1',
  channelId: 'channel-1',
  upstream: stage('stage-script', 'task-script'),
  downstream: stage('stage-storyboard', 'task-storyboard'),
  existingEdges: [],
  requiredInputs: [],
  ...overrides,
});

describe('Project Stage edge 创建校验', () => {
  test('同频道内不同阶段之间的边被接受', () => {
    expect(evaluateProjectStageEdgeCreation(createInput())).toEqual({ kind: 'accepted' });
  });

  test('缺失阶段 fail closed', () => {
    expect(evaluateProjectStageEdgeCreation(createInput({ upstream: null })))
      .toEqual({ kind: 'rejected', reason: 'unknown_stage' });
    expect(evaluateProjectStageEdgeCreation(createInput({ downstream: undefined })))
      .toEqual({ kind: 'rejected', reason: 'unknown_stage' });
  });

  test('自依赖被拒绝：同一阶段或同一绑定 Task', () => {
    expect(evaluateProjectStageEdgeCreation(createInput({
      downstream: stage('stage-script', 'task-other'),
    }))).toEqual({ kind: 'rejected', reason: 'self_dependency' });
    expect(evaluateProjectStageEdgeCreation(createInput({
      downstream: stage('stage-other', 'task-script'),
    }))).toEqual({ kind: 'rejected', reason: 'self_dependency' });
  });

  test('跨 Team 与跨 Channel 依赖被拒绝', () => {
    expect(evaluateProjectStageEdgeCreation(createInput({
      upstream: stage('stage-script', 'task-script', { teamId: 'team-2' }),
    }))).toEqual({ kind: 'rejected', reason: 'cross_team' });
    expect(evaluateProjectStageEdgeCreation(createInput({
      downstream: stage('stage-storyboard', 'task-storyboard', { channelId: 'channel-2' }),
    }))).toEqual({ kind: 'rejected', reason: 'cross_channel' });
  });

  test('非法必需输入规则被拒绝：空 key、空 label、未知 kind、重复 key', () => {
    const cases = [
      [{ key: ' ', kind: 'artifact' as const, label: '剧本' }],
      [{ key: 'script', kind: 'artifact' as const, label: '  ' }],
      [{ key: 'script', kind: 'video' as unknown as 'artifact', label: '剧本' }],
      [{
        key: 'script',
        kind: 'artifact' as const,
        label: '剧本',
        source: { kind: 'document_bundle' as const, bundleId: 'bundle-1' },
      }],
      [{
        key: 'notes',
        kind: 'document' as const,
        label: '改稿说明',
        source: {
          kind: 'artifact_collection' as const,
          collectionId: 'collection-1',
          versionPolicy: 'final' as const,
        },
      }],
      [
        { key: 'script', kind: 'artifact' as const, label: '剧本' },
        { key: 'script', kind: 'document' as const, label: '剧本文档' },
      ],
    ];
    for (const requiredInputs of cases) {
      expect(evaluateProjectStageEdgeCreation(createInput({ requiredInputs })))
        .toEqual({ kind: 'rejected', reason: 'invalid_required_input' });
    }
  });

  test('重复但内容不同的边仍按重复拒绝，依赖事实唯一', () => {
    expect(evaluateProjectStageEdgeCreation(createInput({
      existingEdges: [{ upstreamStageId: 'stage-script', downstreamStageId: 'stage-storyboard' }],
      requiredInputs: [{ key: 'script', kind: 'artifact', label: '剧本终稿' }],
    }))).toEqual({ kind: 'rejected', reason: 'duplicate_edge' });
  });

  test('直接成环被拒绝', () => {
    expect(evaluateProjectStageEdgeCreation(createInput({
      existingEdges: [{ upstreamStageId: 'stage-storyboard', downstreamStageId: 'stage-script' }],
    }))).toEqual({ kind: 'rejected', reason: 'cycle' });
  });

  test('多跳传递成环被拒绝', () => {
    expect(evaluateProjectStageEdgeCreation(createInput({
      upstream: stage('stage-a', 'task-a'),
      downstream: stage('stage-b', 'task-b'),
      existingEdges: [
        { upstreamStageId: 'stage-b', downstreamStageId: 'stage-c' },
        { upstreamStageId: 'stage-c', downstreamStageId: 'stage-d' },
        { upstreamStageId: 'stage-d', downstreamStageId: 'stage-a' },
      ],
    }))).toEqual({ kind: 'rejected', reason: 'cycle' });
  });

  test('菱形汇聚不是环，可以接受', () => {
    expect(evaluateProjectStageEdgeCreation(createInput({
      upstream: stage('stage-costume', 'task-costume'),
      downstream: stage('stage-final-review', 'task-final-review'),
      existingEdges: [
        { upstreamStageId: 'stage-script', downstreamStageId: 'stage-costume' },
        { upstreamStageId: 'stage-script', downstreamStageId: 'stage-storyboard' },
        { upstreamStageId: 'stage-storyboard', downstreamStageId: 'stage-final-review' },
      ],
    }))).toEqual({ kind: 'accepted' });
  });

  test('既有图中已存在的环不会让检测进入死循环', () => {
    expect(evaluateProjectStageEdgeCreation(createInput({
      upstream: stage('stage-x', 'task-x'),
      downstream: stage('stage-y', 'task-y'),
      existingEdges: [
        { upstreamStageId: 'stage-y', downstreamStageId: 'stage-z' },
        { upstreamStageId: 'stage-z', downstreamStageId: 'stage-y' },
      ],
    }))).toEqual({ kind: 'accepted' });
  });
});

const upstreamEdge = (
  overrides: Partial<ProjectStageUpstreamEdgeFacts> = {},
): ProjectStageUpstreamEdgeFacts => ({
  edgeId: 'edge-1',
  upstreamStageId: 'stage-script',
  upstreamTaskId: 'task-script',
  semantics: 'blocks_start',
  upstreamTaskStatus: 'done',
  upstreamReviewDecision: 'accepted',
  requiredInputs: [],
  satisfiedRequiredInputKeys: [],
  ...overrides,
});

describe('Project Stage 执行门禁', () => {
  test('没有入边时放行', () => {
    expect(evaluateProjectStageExecutionGate({ upstreamEdges: [] })).toEqual({ kind: 'allowed' });
  });

  test('blocks_start 上游未完成时阻止执行', () => {
    expect(evaluateProjectStageExecutionGate({
      upstreamEdges: [upstreamEdge({ upstreamTaskStatus: 'in_progress' })],
    })).toEqual({
      kind: 'blocked',
      blocks: [{
        code: 'stage_dependency_incomplete',
        edgeId: 'edge-1',
        upstreamStageId: 'stage-script',
        upstreamTaskId: 'task-script',
      }],
    });
  });

  test('上游完成且无必需输入时放行', () => {
    expect(evaluateProjectStageExecutionGate({
      upstreamEdges: [upstreamEdge({ upstreamTaskStatus: 'closed' })],
    })).toEqual({ kind: 'allowed' });
  });

  test('blocks_start 上游完成但 canonical acceptance 缺失时仍阻止执行', () => {
    expect(evaluateProjectStageExecutionGate({
      upstreamEdges: [upstreamEdge({ upstreamReviewDecision: undefined })],
    })).toEqual({
      kind: 'blocked',
      blocks: [{
        code: 'stage_dependency_unaccepted',
        edgeId: 'edge-1',
        upstreamStageId: 'stage-script',
        upstreamTaskId: 'task-script',
      }],
    });
  });

  test('provides_context 上游未完成本身不阻塞', () => {
    expect(evaluateProjectStageExecutionGate({
      upstreamEdges: [upstreamEdge({ semantics: 'provides_context', upstreamTaskStatus: 'todo' })],
    })).toEqual({ kind: 'allowed' });
  });

  test('必需输入未满足时逐项阻塞，且 provides_context 也要求上游已交付', () => {
    const decision = evaluateProjectStageExecutionGate({
      upstreamEdges: [upstreamEdge({
        semantics: 'provides_context',
        upstreamTaskStatus: 'in_progress',
        requiredInputs: [
          { key: 'script', kind: 'artifact', label: '剧本终稿' },
          { key: 'notes', kind: 'document', label: '改稿说明' },
        ],
      })],
    });
    expect(decision).toEqual({
      kind: 'blocked',
      blocks: [
        {
          code: 'stage_dependency_incomplete',
          edgeId: 'edge-1',
          upstreamStageId: 'stage-script',
          upstreamTaskId: 'task-script',
        },
        {
          code: 'required_input_missing',
          edgeId: 'edge-1',
          upstreamStageId: 'stage-script',
          upstreamTaskId: 'task-script',
          requiredInputKey: 'script',
        },
        {
          code: 'required_input_missing',
          edgeId: 'edge-1',
          upstreamStageId: 'stage-script',
          upstreamTaskId: 'task-script',
          requiredInputKey: 'notes',
        },
      ],
    });
  });

  test('上游被否决时必需输入不可用', () => {
    const decision = evaluateProjectStageExecutionGate({
      upstreamEdges: [upstreamEdge({
        upstreamTaskStatus: 'done',
        upstreamReviewDecision: 'rejected',
        requiredInputs: [{ key: 'script', kind: 'artifact', label: '剧本终稿' }],
        satisfiedRequiredInputKeys: ['script'],
      })],
    });
    expect(decision).toEqual({
      kind: 'blocked',
      blocks: [{
        code: 'stage_dependency_unaccepted',
        edgeId: 'edge-1',
        upstreamStageId: 'stage-script',
        upstreamTaskId: 'task-script',
      }],
    });
  });

  test('必需输入全部满足后门禁自动放行，无需人工修复内部状态', () => {
    expect(evaluateProjectStageExecutionGate({
      upstreamEdges: [upstreamEdge({
        requiredInputs: [{ key: 'script', kind: 'artifact', label: '剧本终稿' }],
        satisfiedRequiredInputKeys: ['script'],
      })],
    })).toEqual({ kind: 'allowed' });
  });

  test('多条入边的阻塞原因全部保留', () => {
    const decision = evaluateProjectStageExecutionGate({
      upstreamEdges: [
        upstreamEdge({ edgeId: 'edge-1', upstreamTaskStatus: 'todo' }),
        upstreamEdge({
          edgeId: 'edge-2',
          upstreamStageId: 'stage-costume',
          upstreamTaskId: 'task-costume',
          upstreamTaskStatus: 'in_review',
        }),
      ],
    });
    expect(decision.kind).toBe('blocked');
    expect(decision.kind === 'blocked' && decision.blocks.map((block) => block.edgeId))
      .toEqual(['edge-1', 'edge-2']);
  });
});
