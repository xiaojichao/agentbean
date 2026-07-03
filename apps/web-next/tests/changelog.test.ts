import { describe, expect, test } from 'vitest';
import { parseChangelog } from '../lib/changelog';

const SAMPLE = `# Changelog

本文件记录产品变更。说明段落应被忽略。

## [Unreleased]
### Added
- 未发布的实验条目，不应出现

## [0.3.0] - 2026-07-10
### Added
- 功能 C
### Fixed
- 修复 C

## [0.1.0] - 2026-05-05
### Added
- 初始版本

## [0.2.0] - 2026-06-01
### Added
- 功能 B
### Removed
- 移除旧接口
`;

describe('parseChangelog', () => {
  test('解析出全部版本并按日期降序', () => {
    const r = parseChangelog(SAMPLE);
    expect(r.map((x) => x.version)).toEqual(['0.3.0', '0.2.0', '0.1.0']);
    expect(r[0].date).toBe('2026-07-10');
    expect(r[r.length - 1].date).toBe('2026-05-05');
  });

  test('Unreleased 块被跳过', () => {
    const r = parseChangelog(SAMPLE);
    expect(r.find((x) => x.sections.some((s) => s.items.includes('未发布的实验条目，不应出现')))).toBeUndefined();
  });

  test('分类与条目正确归属对应版本', () => {
    const r = parseChangelog(SAMPLE);
    const v03 = r.find((x) => x.version === '0.3.0')!;
    expect(v03.sections.map((s) => s.type)).toEqual(['Added', 'Fixed']);
    expect(v03.sections.find((s) => s.type === 'Added')!.items).toEqual(['功能 C']);
  });

  test('空分类被过滤（items 为空的不出现）', () => {
    const md = `## [0.1.0] - 2026-05-05
### Added
- 一条
### Fixed
`;
    const r = parseChangelog(md);
    expect(r[0].sections.map((s) => s.type)).toEqual(['Added']);
  });

  test('version 不含前导 v', () => {
    const r = parseChangelog('## [0.2.0] - 2026-06-01\n### Added\n- x\n');
    expect(r[0].version).toBe('0.2.0');
  });

  test('格式不合规的行不抛异常', () => {
    expect(() => parseChangelog('乱七八糟\n## 不是版本\n### 不是分类\n')).not.toThrow();
  });

  test('重复版本号保留最后一块', () => {
    const md = `## [0.1.0] - 2026-05-05
### Added
- 旧
## [0.1.0] - 2026-05-05
### Added
- 新
`;
    const v = parseChangelog(md).find((x) => x.version === '0.1.0')!;
    expect(v.sections[0].items).toEqual(['新']);
  });

  test('空字符串返回空数组', () => {
    expect(parseChangelog('')).toEqual([]);
  });

  test('版本号去除前导 v（防止 UI 显示 vv0.2.0）', () => {
    const r = parseChangelog('## [v0.2.0] - 2026-06-01\n### Added\n- x\n');
    expect(r[0].version).toBe('0.2.0');
  });

  test('无日期的版本块被跳过，其条目不并入前一版本', () => {
    const md = `## [1.0.0] - 2026-01-01
### Added
- real

## [2.0.0]
### Added
- draft
`;
    const r = parseChangelog(md);
    expect(r.map((x) => x.version)).toEqual(['1.0.0']);
    const v1 = r.find((x) => x.version === '1.0.0')!;
    expect(v1.sections).toHaveLength(1);
    expect(v1.sections[0].type).toBe('Added');
    expect(v1.sections[0].items).toEqual(['real']);
    expect(v1.sections.flatMap((s) => s.items)).not.toContain('draft');
  });
});
