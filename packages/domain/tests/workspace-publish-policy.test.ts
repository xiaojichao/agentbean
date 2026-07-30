import { describe, expect, test } from 'vitest';

import { evaluateWorkspacePublish } from '../src/index.js';
import type { EvaluateWorkspacePublishInput, WorkspacePublishFileEntry } from '../src/index.js';

function file(path: string, artifactId: string): WorkspacePublishFileEntry {
  return { path, artifactId };
}

function baseInput(overrides: Partial<EvaluateWorkspacePublishInput> = {}): EvaluateWorkspacePublishInput {
  return {
    current: { revisionId: 'rev-1', revision: 1, files: [file('a.txt', 'art-a')] },
    baselineRevisionId: 'rev-1',
    files: [file('a.txt', 'art-a-v2')],
    ...overrides,
  };
}

describe('evaluateWorkspacePublish (#966 原子发布 + 冲突反馈)', () => {
  test('基线 == 当前、非空清单 → publish，nextRevision = current+1', () => {
    expect(evaluateWorkspacePublish(baseInput()))
      .toEqual({ kind: 'publish', nextRevision: 2 });
  });

  test('基线 != 当前 → conflict，回显当前版本与提交基线，不写', () => {
    const decision = evaluateWorkspacePublish(baseInput({ baselineRevisionId: 'rev-stale' }));
    expect(decision).toEqual({
      kind: 'conflict',
      currentRevisionId: 'rev-1',
      currentRevision: 1,
      submittedBaselineRevisionId: 'rev-stale',
      conflictingPaths: ['a.txt'],
    });
  });

  test('conflict 的 conflictingPaths = 提交清单与当前版本的「不一致路径」升序', () => {
    // current: a.txt=art-a, b.txt=art-b, c.txt=art-c
    // submitted: a.txt=art-a-v2(改), b.txt=art-b(同), d.txt=art-d(新增)
    // 不一致面：a.txt(改)、c.txt(提交删除)、d.txt(新增) —— b.txt 同则不算冲突
    const decision = evaluateWorkspacePublish(baseInput({
      baselineRevisionId: 'rev-stale',
      current: {
        revisionId: 'rev-2', revision: 2,
        files: [file('a.txt', 'art-a'), file('b.txt', 'art-b'), file('c.txt', 'art-c')],
      },
      files: [file('a.txt', 'art-a-v2'), file('b.txt', 'art-b'), file('d.txt', 'art-d')],
    }));
    expect(decision.kind).toBe('conflict');
    if (decision.kind !== 'conflict') return;
    expect(decision.conflictingPaths).toEqual(['a.txt', 'c.txt', 'd.txt']);
    expect(decision.currentRevision).toBe(2);
  });

  test('提交清单与当前完全一致（基线 != 当前）→ conflict 但 conflictingPaths 为空', () => {
    const decision = evaluateWorkspacePublish(baseInput({
      baselineRevisionId: 'rev-stale',
      current: { revisionId: 'rev-2', revision: 2, files: [file('a.txt', 'art-a-v2')] },
      files: [file('a.txt', 'art-a-v2')],
    }));
    expect(decision).toEqual({
      kind: 'conflict',
      currentRevisionId: 'rev-2',
      currentRevision: 2,
      submittedBaselineRevisionId: 'rev-stale',
      conflictingPaths: [],
    });
  });

  test('空清单 → rejected empty-files（兜底；调用方应已校验）', () => {
    expect(evaluateWorkspacePublish(baseInput({ files: [] })))
      .toEqual({ kind: 'rejected', reason: 'empty-files' });
  });

  test('current.revision 达 MAX_SAFE_INTEGER（基线匹配）→ rejected revision-overflow', () => {
    expect(evaluateWorkspacePublish(baseInput({
      current: { revisionId: 'rev-max', revision: Number.MAX_SAFE_INTEGER, files: [file('a.txt', 'art-a')] },
      baselineRevisionId: 'rev-max',
      files: [file('a.txt', 'art-a-v2')],
    }))).toEqual({ kind: 'rejected', reason: 'revision-overflow' });
  });

  test('基线匹配且提交 == 当前（无内容变化）仍 publish（policy 只判基线，不做 no-op 去重）', () => {
    expect(evaluateWorkspacePublish(baseInput({
      files: [file('a.txt', 'art-a')],
    }))).toEqual({ kind: 'publish', nextRevision: 2 });
  });
});
