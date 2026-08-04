import { describe, expect, test } from 'vitest';
import { WEB_EVENTS } from '../src/socket.js';
import {
  PACKAGE_REVIEW_COMMAND_HASH_VERSION,
  PACKAGE_REVIEW_COMMAND_NAMES,
  PACKAGE_REVIEW_ACTIONS,
  PACKAGE_REVIEW_AUTHORITY_BASIS_KINDS,
  PACKAGE_REVIEW_REJECTION_REASONS,
  canonicalizePackageReviewCommand,
  parsePackageReviewCommandEnvelopeV1,
  parsePackageReviewCommandInputV1,
  parsePackageReviewCommandResponseV1,
  type PackageReviewCommandEnvelopeV1,
  type PackageReviewCommandResponseV1,
} from '../src/package-review.js';

const INVALID = /PACKAGE_REVIEW_PAYLOAD_INVALID/;

const envelope: PackageReviewCommandEnvelopeV1 = {
  schemaVersion: 1,
  commandName: 'submit-package-artifact-review',
  commandSchemaVersion: 1,
  idempotencyKey: 'review:ch-1:pkg-1:ver-1:user-1',
};

const reviewInput = {
  channelId: 'ch-1',
  packageId: 'pkg-1',
  collectionId: 'col-1',
  versionId: 'ver-1',
  decision: 'approved',
  comment: '通过',
  idempotencyKey: 'review:ch-1:pkg-1:ver-1:user-1',
} as const;

describe('package-review contracts (#1061)', () => {
  test('注册表冻结:3 个命令、6 个动作、6 种 authority basis', () => {
    expect(PACKAGE_REVIEW_COMMAND_NAMES).toEqual([
      'submit-package-artifact-review',
      'submit-package-review-and-finalize',
      'submit-package-review-and-reject-delivery',
    ]);
    expect(PACKAGE_REVIEW_ACTIONS).toEqual([
      'review-approved',
      'review-changes-requested',
      'review-rejected',
      'review-and-finalize',
      'review-and-reject-delivery',
      'set-final',
    ]);
    expect(PACKAGE_REVIEW_AUTHORITY_BASIS_KINDS).toEqual([
      'team-owner',
      'team-admin',
      'project-lead',
      'stage-reviewer-delegation',
      'subtask-human-acceptance',
      'root-review-authority',
    ]);
  });

  test('socket 事件名与 WEB_EVENTS 对齐', () => {
    expect(WEB_EVENTS.project.submitPackageArtifactReview).toBe('project:submit-package-artifact-review');
    expect(WEB_EVENTS.project.submitPackageReviewAndFinalize).toBe('project:submit-package-review-and-finalize');
    expect(WEB_EVENTS.project.submitPackageReviewAndRejectDelivery)
      .toBe('project:submit-package-review-and-reject-delivery');
    expect(WEB_EVENTS.project.packageReviewUpdated).toBe('project:package-review-updated');
  });

  test('envelope 解析:合法通过,克隆防外泄', () => {
    const parsed = parsePackageReviewCommandEnvelopeV1(envelope);
    expect(parsed).toEqual(envelope);
    expect(parsed).not.toBe(envelope);
  });

  test('envelope 拒绝 authority/scope 自报告字段', () => {
    expect(() => parsePackageReviewCommandEnvelopeV1({
      ...envelope,
      teamId: 'team-1',
    })).toThrow(INVALID);
    expect(() => parsePackageReviewCommandEnvelopeV1({
      ...envelope,
      actor: 'user-1',
    })).toThrow(INVALID);
  });

  test('envelope 拒绝未知 command / 未来 schema 版本', () => {
    expect(() => parsePackageReviewCommandEnvelopeV1({
      ...envelope,
      commandName: 'submit-package-review',
    })).toThrow(INVALID);
    expect(() => parsePackageReviewCommandEnvelopeV1({
      ...envelope,
      commandSchemaVersion: 2,
    })).toThrow(INVALID);
  });

  test('input 解析:三个命令各自 exact-key', () => {
    expect(parsePackageReviewCommandInputV1('submit-package-artifact-review', reviewInput)).toEqual(reviewInput);
    expect(parsePackageReviewCommandInputV1('submit-package-review-and-finalize', {
      ...reviewInput,
      expectedCollectionRevision: 2,
    })).toEqual({ ...reviewInput, expectedCollectionRevision: 2 });
    expect(parsePackageReviewCommandInputV1('submit-package-review-and-reject-delivery', {
      ...reviewInput,
      decision: 'changes_requested',
      expectedTaskRevision: 2,
      expectedTaskAttempt: 1,
      rejectReason: '需要修改',
    })).toEqual({
      ...reviewInput,
      decision: 'changes_requested',
      expectedTaskRevision: 2,
      expectedTaskAttempt: 1,
      rejectReason: '需要修改',
    });
  });

  test('input 拒绝:非法决策 / 缺失字段 / 非法拒绝理由', () => {
    expect(() => parsePackageReviewCommandInputV1('submit-package-artifact-review', {
      ...reviewInput,
      decision: 'pass',
    })).toThrow(INVALID);
    expect(() => parsePackageReviewCommandInputV1('submit-package-artifact-review', {
      ...reviewInput,
      packageId: '',
    })).toThrow(INVALID);
    expect(() => parsePackageReviewCommandInputV1('submit-package-review-and-finalize', {
      ...reviewInput,
      expectedCollectionRevision: 0,
    })).toThrow(INVALID);
    expect(() => parsePackageReviewCommandInputV1('submit-package-review-and-reject-delivery', {
      ...reviewInput,
      decision: 'changes_requested',
      expectedTaskRevision: 1,
      rejectReason: '',
    })).toThrow(INVALID);
  });

  test('canonical 序列化:key 排序、hash 版本参与', () => {
    const a = canonicalizePackageReviewCommand(
      'submit-package-artifact-review', 1, reviewInput,
    );
    // 输入字段顺序不影响 canonical(idempotencyKey 是 payload 字段,同 key 同 payload 恒等)。
    const b = canonicalizePackageReviewCommand(
      'submit-package-artifact-review', 1, {
        decision: 'approved',
        versionId: 'ver-1',
        collectionId: 'col-1',
        packageId: 'pkg-1',
        channelId: 'ch-1',
        comment: '通过',
        idempotencyKey: 'review:ch-1:pkg-1:ver-1:user-1',
      },
    );
    expect(a).toBe(b);
    // 语义 payload 不同 → canonical 不同。
    const c = canonicalizePackageReviewCommand(
      'submit-package-artifact-review', 1, { ...reviewInput, decision: 'rejected' },
    );
    expect(a).not.toBe(c);
    // 命令名不同 → canonical 不同。
    const d = canonicalizePackageReviewCommand(
      'submit-package-review-and-finalize', 1, { ...reviewInput, expectedCollectionRevision: 2 },
    );
    expect(a).not.toBe(d);
  });

  test('response 解析:applied + result 与 command 对齐', () => {
    const response: PackageReviewCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'submit-package-artifact-review',
      outcome: 'applied',
      retryDirective: 'none',
      stableCode: 'REVIEW_RECORDED',
      receipt: {
        schemaVersion: 1,
        receiptId: 'r-1',
        commandName: 'submit-package-artifact-review',
        commandSchemaVersion: 1,
        idempotencyKey: 'review:ch-1:pkg-1:ver-1:user-1',
        commandHash: 'abc',
        outcome: 'applied',
        committedRevisions: [],
        eventRefs: [],
        commitTime: 1_000,
        resultAvailable: true,
      },
      result: {
        commandName: 'submit-package-artifact-review',
        review: {
          id: 'rev-1',
          teamId: 'team-1',
          channelId: 'ch-1',
          collectionId: 'col-1',
          versionId: 'ver-1',
          packageId: 'pkg-1',
          deliveryId: 'del-1',
          taskId: 'task-1',
          taskRevision: 3,
          taskAttempt: 2,
          decision: 'approved',
          comment: '通过',
          authorityBasis: 'stage-reviewer-delegation',
          reviewedBy: 'user-1',
          createdAt: 1_000,
        },
      },
    };
    const parsed = parsePackageReviewCommandResponseV1(response);
    expect(parsed).toEqual(response);
  });

  test('response 解析:组合命令 result 结构正确', () => {
    const response: PackageReviewCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'submit-package-review-and-finalize',
      outcome: 'applied',
      retryDirective: 'none',
      stableCode: 'REVIEW_AND_FINALIZED',
      result: {
        commandName: 'submit-package-review-and-finalize',
        review: {
          id: 'rev-1', teamId: 'team-1', channelId: 'ch-1', collectionId: 'col-1', versionId: 'ver-1',
          packageId: 'pkg-1', deliveryId: 'del-1', taskId: 'task-1', taskRevision: 3, taskAttempt: 2,
          decision: 'approved', comment: '通过', authorityBasis: 'project-lead',
          reviewedBy: 'user-1', createdAt: 1_000,
        },
        finalization: {
          id: 'fin-1', collectionId: 'col-1', versionId: 'ver-1', previousVersionId: 'ver-0',
          basisReviewId: 'rev-1', finalizedBy: 'user-1', createdAt: 1_000,
        },
        collection: {
          collectionId: 'col-1', finalVersionId: 'ver-1', previousVersionId: 'ver-0', revision: 3,
        },
      },
    };
    expect(parsePackageReviewCommandResponseV1(response)).toEqual(response);
    // result 与 response 命令不一致 → 拒绝。
    expect(() => parsePackageReviewCommandResponseV1({
      ...response,
      result: { ...response.result!, commandName: 'submit-package-artifact-review' as const },
    })).toThrow(INVALID);
  });

  test('response 解析:rejected 带结构化拒绝码', () => {
    const rejected: PackageReviewCommandResponseV1 = {
      schemaVersion: 1,
      commandName: 'submit-package-artifact-review',
      outcome: 'rejected',
      retryDirective: 'user_action',
      stableCode: 'PACKAGE_REVIEW_REJECTED',
      rejectedReason: 'actor-not-authorized',
    };
    const parsed = parsePackageReviewCommandResponseV1(rejected);
    expect(parsed.rejectedReason).toBe('actor-not-authorized');
    expect(PACKAGE_REVIEW_REJECTION_REASONS).toContain(parsed.rejectedReason);
    expect(() => parsePackageReviewCommandResponseV1({
      ...rejected,
      rejectedReason: 'unknown-code',
    })).toThrow(INVALID);
  });
});
