import { describe, expect, test } from 'vitest';

import {
  evaluateBundleComposition,
  evaluateBundleMemberEligibility,
  type ProjectDocumentBundleMemberCandidate,
  type ProjectDocumentBundleMemberDerivation,
} from '../src/project-document-bundle-policy.js';

const SCOPE = { teamId: 'team-1', channelId: 'channel-1', workspaceRunId: 'run-1' };

function derivation(
  overrides: Partial<ProjectDocumentBundleMemberDerivation> = {},
): ProjectDocumentBundleMemberDerivation {
  return {
    workspaceRunId: 'run-1',
    relativePath: 'docs/plan.md',
    normalizedRelativePath: 'docs/plan.md',
    artifactId: 'artifact-plan',
    artifactRole: 'run_output',
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ProjectDocumentBundleMemberCandidate> = {},
): ProjectDocumentBundleMemberCandidate {
  return {
    documentId: 'document-plan',
    teamId: 'team-1',
    channelId: 'channel-1',
    filename: 'plan.md',
    currentRevisionId: 'revision-1',
    currentRevisionNumber: 1,
    artifact: { filename: 'plan.md', mimeType: 'text/markdown' },
    derivation: derivation(),
    visible: true,
    ...overrides,
  };
}

describe('#825 Bundle 成员资格判定', () => {
  test('同 Team/Channel、同一次 Run 产出的可见 Markdown 够格', () => {
    expect(evaluateBundleMemberEligibility(candidate(), SCOPE)).toEqual({ eligible: true });
  });

  test.each([
    [
      '跨 Team',
      candidate({ teamId: 'team-2' }),
      'scope_mismatch',
    ],
    [
      '跨 Channel',
      candidate({ channelId: 'channel-2' }),
      'scope_mismatch',
    ],
    [
      '来源缺失（人工上传或纯人工编辑）',
      candidate({ derivation: undefined }),
      'source_mismatch',
    ],
    [
      '来源是另一次 Run',
      candidate({ derivation: derivation({ workspaceRunId: 'run-2' }) }),
      'source_mismatch',
    ],
    [
      '来源是内部运行日志',
      candidate({
        artifact: { filename: 'run-log.md', mimeType: 'text/markdown' },
        derivation: derivation({
          relativePath: 'logs/workspace-run.log',
          normalizedRelativePath: 'logs/workspace-run.log',
        }),
      }),
      'run_log',
    ],
    [
      '来源是 preview derivative 文件',
      candidate({
        derivation: derivation({
          relativePath: 'docs/preview.webp',
          normalizedRelativePath: 'docs/preview.webp',
        }),
      }),
      'preview_derivative',
    ],
    [
      '正文不是 Markdown',
      candidate({ artifact: { filename: 'data.csv', mimeType: 'text/csv' } }),
      'not_markdown',
    ],
    [
      '来源文件不是 Markdown',
      candidate({
        derivation: derivation({
          relativePath: 'data/data.csv',
          normalizedRelativePath: 'data/data.csv',
        }),
      }),
      'not_markdown',
    ],
    [
      '文档不可见',
      candidate({ visible: false }),
      'not_visible',
    ],
  ])('%s 被拒为 %s', (_label, input, code) => {
    expect(evaluateBundleMemberEligibility(input, SCOPE)).toEqual({ eligible: false, code });
  });

  test('名为 previews 的目录下的合法 Markdown 不被误判为预览派生物', () => {
    expect(evaluateBundleMemberEligibility(candidate({
      filename: 'summary.md',
      artifact: { filename: 'summary.md', mimeType: 'text/markdown' },
      derivation: derivation({
        relativePath: 'previews/summary.md',
        normalizedRelativePath: 'previews/summary.md',
      }),
    }), SCOPE)).toEqual({ eligible: true });
  });

  test('运行日志判定优先于 Markdown 判定：伪装成 .md 的日志仍被拒', () => {
    expect(evaluateBundleMemberEligibility(candidate({
      artifact: { filename: 'workspace-run.log.md', mimeType: 'text/markdown' },
      derivation: derivation({
        relativePath: 'logs/workspace-run.log',
        normalizedRelativePath: 'logs/workspace-run.log',
      }),
    }), SCOPE)).toEqual({ eligible: false, code: 'run_log' });
  });
});

describe('#825 Bundle 整包裁决', () => {
  test('保留调用方顺序并逐项给出拒绝原因', () => {
    const composition = evaluateBundleComposition([
      candidate({ documentId: 'document-plan' }),
      candidate({ documentId: 'document-foreign', derivation: derivation({ workspaceRunId: 'run-2' }) }),
      candidate({ documentId: 'document-spec', filename: 'spec.md' }),
    ], SCOPE);

    expect(composition.accepted.map((item) => item.documentId)).toEqual(['document-plan', 'document-spec']);
    expect(composition.rejections).toEqual([{ documentId: 'document-foreign', code: 'source_mismatch' }]);
  });

  test('同一 documentId 重复出现只接受首次，其余判为 duplicate', () => {
    const composition = evaluateBundleComposition([
      candidate({ documentId: 'document-plan' }),
      candidate({ documentId: 'document-plan' }),
    ], SCOPE);

    expect(composition.accepted).toHaveLength(1);
    expect(composition.rejections).toEqual([{ documentId: 'document-plan', code: 'duplicate' }]);
  });

  test('全部合格时不产生任何拒绝', () => {
    const composition = evaluateBundleComposition([
      candidate({ documentId: 'document-plan' }),
      candidate({ documentId: 'document-spec' }),
    ], SCOPE);

    expect(composition.rejections).toEqual([]);
    expect(composition.accepted).toHaveLength(2);
  });
});
