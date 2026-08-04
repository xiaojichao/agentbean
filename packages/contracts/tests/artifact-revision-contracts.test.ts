import { describe, expect, test } from 'vitest';
import { WEB_EVENTS } from '../src/socket.js';
import {
  ARTIFACT_REVISION_ACTIONS,
  ARTIFACT_REVISION_COMMAND_NAMES,
  ARTIFACT_REVISION_CONFLICT_CODES,
  ARTIFACT_REVISION_OUTCOMES,
  ARTIFACT_REVISION_REJECTION_REASONS,
  ARTIFACT_REVISION_RETRY_DIRECTIVES,
  canonicalizeArtifactRevisionCommand,
  parseArtifactRevisionCommandEnvelopeV1,
  parseArtifactRevisionCommandInputV1,
  parseArtifactRevisionCommandResponseV1,
  type ArtifactRevisionCommandEnvelopeV1,
  type ArtifactRevisionCommandResponseV1,
} from '../src/artifact-revision.js';

const INVALID = /ARTIFACT_REVISION_PAYLOAD_INVALID/;

const envelope: ArtifactRevisionCommandEnvelopeV1 = {
  schemaVersion: 1,
  commandName: 'save-artifact-version-revision',
  commandSchemaVersion: 1,
  idempotencyKey: 'revise:ch-1:col-1:ver-1:user-1',
};

const saveInput = {
  channelId: 'ch-1',
  collectionId: 'col-1',
  baseVersionId: 'ver-1',
  content: '# 剧本 v2\n\n修订内容',
  expectedCollectionRevision: 3,
  revisionBasis: {
    sourceVersionId: 'ver-1',
    basisReviewId: 'rev-1',
    packageId: 'pkg-1',
    deliveryId: 'del-1',
  },
  idempotencyKey: 'revise:ch-1:col-1:ver-1:user-1',
} as const;

const appliedResponse: ArtifactRevisionCommandResponseV1 = {
  schemaVersion: 1,
  commandName: 'save-artifact-version-revision',
  outcome: 'applied',
  retryDirective: 'none',
  stableCode: 'applied',
  receipt: {
    schemaVersion: 1,
    receiptId: 'rcpt-1',
    commandName: 'save-artifact-version-revision',
    commandSchemaVersion: 1,
    idempotencyKey: 'revise:ch-1:col-1:ver-1:user-1',
    commandHash: 'ab'.repeat(32),
    outcome: 'applied',
    committedRevisions: [{ streamKind: 'project-artifact-collection', streamId: 'col-1', revision: 4 }],
    eventRefs: [],
    commitTime: 1722700000000,
    resultAvailable: true,
  },
  result: {
    commandName: 'save-artifact-version-revision',
    versionId: 'ver-2',
    collectionId: 'col-1',
    versionNumber: 2,
    artifactId: 'art-2',
    baseVersionId: 'ver-1',
    sourceVersionId: 'ver-1',
    basisReviewId: 'rev-1',
    packageId: 'pkg-1',
    deliveryId: 'del-1',
    collectionRevision: 4,
    currentVersionId: 'ver-2',
    finalVersionId: 'ver-0',
    createdAt: 1722700000000,
  },
};

describe('artifact-revision contracts (#1062)', () => {
  test('注册表冻结:1 个命令、1 个动作、4 种 conflict code', () => {
    expect(ARTIFACT_REVISION_COMMAND_NAMES).toEqual(['save-artifact-version-revision']);
    expect(ARTIFACT_REVISION_ACTIONS).toEqual(['revise-version']);
    expect(ARTIFACT_REVISION_CONFLICT_CODES).toEqual([
      'base-version-stale',
      'collection-revision-stale',
      'revision-basis-stale',
    ]);
    expect(ARTIFACT_REVISION_OUTCOMES).toEqual([
      'applied', 'no_op', 'replayed', 'freshness_hold',
      'conflict', 'rejected', 'temporarily_unavailable', 'outcome_unknown',
    ]);
    expect(ARTIFACT_REVISION_RETRY_DIRECTIVES).toEqual([
      'none', 'same_key', 'reread_then_new_command', 'user_action',
    ]);
    expect(ARTIFACT_REVISION_REJECTION_REASONS).toEqual([
      'channel-not-found',
      'channel-archived',
      'collection-not-found',
      'version-not-in-collection',
      'not-markdown-version',
      'actor-not-authorized',
      'revision-basis-mismatch',
      'revision-editing-disabled',
      'content-invalid',
      'invalid-request',
    ]);
  });

  test('socket 事件名与 WEB_EVENTS 对齐', () => {
    expect(WEB_EVENTS.project.saveArtifactVersionRevision).toBe('project:save-artifact-version-revision');
  });

  test('envelope 解析:合法通过,克隆防外泄', () => {
    const parsed = parseArtifactRevisionCommandEnvelopeV1(envelope);
    expect(parsed).toEqual(envelope);
    expect(parsed).not.toBe(envelope);
  });

  test('envelope 拒绝 authority/scope 自报告字段', () => {
    expect(() => parseArtifactRevisionCommandEnvelopeV1({ ...envelope, teamId: 'team-1' })).toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandEnvelopeV1({ ...envelope, actor: 'user-1' })).toThrow(INVALID);
  });

  test('envelope 拒绝未知 command / 未来 schema 版本', () => {
    expect(() => parseArtifactRevisionCommandEnvelopeV1({
      ...envelope,
      commandName: 'save-artifact-revision',
    })).toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandEnvelopeV1({
      ...envelope,
      commandSchemaVersion: 2,
    })).toThrow(INVALID);
  });

  test('input 解析:完整字段通过;filename 可选', () => {
    expect(parseArtifactRevisionCommandInputV1('save-artifact-version-revision', saveInput)).toEqual(saveInput);
    expect(parseArtifactRevisionCommandInputV1('save-artifact-version-revision', {
      ...saveInput,
      filename: '剧本.md',
    })).toEqual({ ...saveInput, filename: '剧本.md' });
  });

  test('input 解析:revisionBasis 只允许冻结 provenance 四字段', () => {
    const minimal = {
      ...saveInput,
      revisionBasis: { sourceVersionId: 'ver-1' },
    };
    expect(parseArtifactRevisionCommandInputV1('save-artifact-version-revision', minimal)).toEqual(minimal);
    expect(() => parseArtifactRevisionCommandInputV1('save-artifact-version-revision', {
      ...saveInput,
      revisionBasis: { ...saveInput.revisionBasis, taskId: 'task-1' },
    })).toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandInputV1('save-artifact-version-revision', {
      ...saveInput,
      revisionBasis: {},
    })).toThrow(INVALID);
  });

  test('input 拒绝:缺字段 / 未知字段 / 非法 revision / 非字符串 content', () => {
    const { content: _content, ...missingContent } = saveInput;
    expect(() => parseArtifactRevisionCommandInputV1('save-artifact-version-revision', missingContent))
      .toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandInputV1('save-artifact-version-revision', {
      ...saveInput, role: 'admin',
    })).toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandInputV1('save-artifact-version-revision', {
      ...saveInput, expectedCollectionRevision: 0,
    })).toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandInputV1('save-artifact-version-revision', {
      ...saveInput, content: 42,
    })).toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandInputV1('save-artifact-version-revision', {
      ...saveInput, content: '',
    })).not.toThrow();
  });

  test('response 解析:applied 携带 receipt 与保存结果', () => {
    const parsed = parseArtifactRevisionCommandResponseV1(appliedResponse);
    expect(parsed).toEqual(appliedResponse);
    expect(parsed.result?.commandName).toBe('save-artifact-version-revision');
  });

  test('response 解析:conflict 携带结构化 revisionConflict(base/Server 最新/草稿保留)', () => {
    const conflictResponse: ArtifactRevisionCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'save-artifact-version-revision',
      outcome: 'conflict',
      retryDirective: 'reread_then_new_command',
      stableCode: 'base-version-stale',
      conflictReason: 'base-version-stale',
      revisionConflict: {
        code: 'base-version-stale',
        baseVersionId: 'ver-1',
        serverCurrentVersionId: 'ver-9',
        serverCurrentVersionNumber: 9,
        collectionRevision: 12,
        draftPreserved: true,
      },
    };
    expect(parseArtifactRevisionCommandResponseV1(conflictResponse)).toEqual(conflictResponse);
  });

  test('response 拒绝:result 与 commandName 串型 / 非法 conflict code / 未知字段', () => {
    expect(() => parseArtifactRevisionCommandResponseV1({
      ...appliedResponse,
      result: { ...appliedResponse.result!, commandName: 'record-agent-output-package' },
    })).toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandResponseV1({
      ...appliedResponse,
      revisionConflict: {
        code: 'something-else',
        baseVersionId: 'ver-1',
        serverCurrentVersionId: 'ver-9',
        serverCurrentVersionNumber: 9,
        collectionRevision: 12,
        draftPreserved: true,
      },
    })).toThrow(INVALID);
    expect(() => parseArtifactRevisionCommandResponseV1({
      ...appliedResponse,
      actorRole: 'admin',
    })).toThrow(INVALID);
  });

  test('canonical 序列化:字段顺序无关;改语义变 hash(idempotencyKey 是 payload 字段,同 key 同 payload 恒等)', () => {
    const a = canonicalizeArtifactRevisionCommand('save-artifact-version-revision', 1, saveInput);
    const b = canonicalizeArtifactRevisionCommand('save-artifact-version-revision', 1, {
      idempotencyKey: 'revise:ch-1:col-1:ver-1:user-1',
      revisionBasis: {
        deliveryId: 'del-1',
        packageId: 'pkg-1',
        basisReviewId: 'rev-1',
        sourceVersionId: 'ver-1',
      },
      expectedCollectionRevision: 3,
      content: '# 剧本 v2\n\n修订内容',
      baseVersionId: 'ver-1',
      collectionId: 'col-1',
      channelId: 'ch-1',
    });
    expect(a).toBe(b);
    const c = canonicalizeArtifactRevisionCommand('save-artifact-version-revision', 1, {
      ...saveInput,
      content: '# 别的内容',
    });
    expect(c).not.toBe(a);
    const d = canonicalizeArtifactRevisionCommand('save-artifact-version-revision', 1, {
      ...saveInput,
      expectedCollectionRevision: 4,
    });
    expect(d).not.toBe(a);
    const e = canonicalizeArtifactRevisionCommand('save-artifact-version-revision', 1, {
      ...saveInput,
      revisionBasis: { sourceVersionId: 'ver-1' },
    });
    expect(e).not.toBe(a);
  });
});
