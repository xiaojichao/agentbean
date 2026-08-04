import { describe, expect, test } from 'vitest';
import {
  PROJECT_REFERENCE_PACKAGE_PROJECTION_POLICIES,
  PROJECT_REFERENCE_SET_CONTRACT_VERSION,
  parseProjectReferenceSelectionRequestV1,
  parseProjectReferenceSelectionRequestsV1,
} from '../src/project-reference.js';

const INVALID = /PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID/;

describe('#1063 project-reference selection request parser', () => {
  test('合同版本保持 1(纯新增 arm,不改既有 items 语义)', () => {
    expect(PROJECT_REFERENCE_SET_CONTRACT_VERSION).toBe(1);
  });

  test('projection policy 枚举冻结(delivered/current/final;specified 走 package_members arm)', () => {
    expect(PROJECT_REFERENCE_PACKAGE_PROJECTION_POLICIES).toEqual(['delivered', 'current', 'final']);
  });

  test('package_projection:解析 current 策略与 expectedMemberRevisions fence', () => {
    const input = {
      kind: 'package_projection',
      packageId: 'pkg-1',
      policy: 'current',
      expectedMemberRevisions: [{ collectionId: 'col-1', revision: 3 }],
    };
    expect(parseProjectReferenceSelectionRequestV1(input)).toEqual(input);
  });

  test('package_projection:拒绝未知 policy 与多余字段', () => {
    expect(() => parseProjectReferenceSelectionRequestV1({
      kind: 'package_projection', packageId: 'pkg-1', policy: 'specified',
    })).toThrow(INVALID);
    expect(() => parseProjectReferenceSelectionRequestV1({
      kind: 'package_projection', packageId: 'pkg-1', policy: 'current', teamId: 'team-1',
    })).toThrow(INVALID);
    expect(() => parseProjectReferenceSelectionRequestV1({
      kind: 'package_projection', packageId: 'pkg-1', policy: 'final',
      expectedMemberRevisions: [{ collectionId: 'col-1', revision: 0 }],
    })).toThrow(INVALID);
  });

  test('package_members:单选/多选共用同一 arm', () => {
    const single = {
      kind: 'package_members',
      packageId: 'pkg-1',
      members: [{ collectionId: 'col-1', versionId: 'ver-1' }],
    };
    expect(parseProjectReferenceSelectionRequestV1(single)).toEqual(single);
    const multi = {
      kind: 'package_members',
      packageId: 'pkg-1',
      members: [
        { collectionId: 'col-1', versionId: 'ver-1' },
        { collectionId: 'col-2', versionId: 'ver-9' },
      ],
    };
    expect(parseProjectReferenceSelectionRequestV1(multi)).toEqual(multi);
  });

  test('package_members:拒绝空 members 与缺字段', () => {
    expect(() => parseProjectReferenceSelectionRequestV1({
      kind: 'package_members', packageId: 'pkg-1',
    })).toThrow(INVALID);
    expect(() => parseProjectReferenceSelectionRequestV1({
      kind: 'package_members', packageId: 'pkg-1',
      members: [{ collectionId: 'col-1' }],
    })).toThrow(INVALID);
  });

  test('联合类型仍刻意无序号 arm(短编号不得进入 message:send)', () => {
    expect(() => parseProjectReferenceSelectionRequestV1({
      kind: 'ordinal', ordinal: 3,
    })).toThrow(INVALID);
  });

  test('既有四 arm 形状不变(web 端精确 DTO 形状不受影响)', () => {
    const cases = [
      { kind: 'bundle_all', bundleId: 'b-1' },
      {
        kind: 'bundle_all', bundleId: 'b-1',
        expectedRevisions: [{ documentId: 'd-1', revisionId: 'r-1' }],
      },
      { kind: 'bundle_subset', bundleId: 'b-1', documentIds: ['d-1', 'd-2'] },
      { kind: 'document', documentId: 'd-1', expectedRevisionId: 'r-1' },
      { kind: 'artifact_version', collectionId: 'c-1', versionId: 'v-1' },
    ];
    for (const input of cases) {
      expect(parseProjectReferenceSelectionRequestV1(input)).toEqual(input);
    }
    // 多余 authority/scope 自报字段一律拒绝。
    expect(() => parseProjectReferenceSelectionRequestV1({
      kind: 'document', documentId: 'd-1', actorId: 'u-9',
    })).toThrow(INVALID);
  });

  test('数组 parser 逐项校验', () => {
    expect(parseProjectReferenceSelectionRequestsV1([
      { kind: 'package_projection', packageId: 'pkg-1', policy: 'delivered' },
      { kind: 'package_members', packageId: 'pkg-1', members: [{ collectionId: 'c-1', versionId: 'v-1' }] },
    ])).toHaveLength(2);
    expect(() => parseProjectReferenceSelectionRequestsV1('not-an-array')).toThrow(INVALID);
  });
});
