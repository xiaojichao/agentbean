import { describe, expect, test } from 'vitest';
import {
  buildDailyReleaseBlock,
  buildDailyReleaseSections,
  classifyDailyChange,
  normalizeDailyChangeItem,
  upsertDailyReleaseBlock,
} from '../lib/daily-changelog';

describe('daily changelog', () => {
  test('按提交主题归类并清理 conventional commit 前缀', () => {
    expect(classifyDailyChange('feat(settings): 支持更新日志日更')).toBe('Added');
    expect(classifyDailyChange('修复设置页更新日志展示')).toBe('Fixed');
    expect(classifyDailyChange('强化鉴权边界')).toBe('Security');
    expect(normalizeDailyChangeItem('feat(settings): 支持更新日志日更 (#123)')).toBe('支持更新日志日更');
  });

  test('生成日更 release block', () => {
    expect(buildDailyReleaseBlock('2026-07-09', [
      'feat(settings): 支持更新日志日更',
      'fix(settings): 修复更新日志显示',
    ])).toBe(`## [Daily 2026-07-09] - 2026-07-09
### Added
- 支持更新日志日更
### Fixed
- 修复更新日志显示
`);
  });

  test('无提交时仍生成每日稳定性记录', () => {
    expect(buildDailyReleaseSections([])).toEqual([
      {
        type: 'Changed',
        items: ['当日无面向用户的代码变更，服务保持稳定运行。'],
      },
    ]);
  });

  test('把日更块插入 Unreleased 之后并保留旧版本', () => {
    const md = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-07-03
### Added
- 旧版本
`;
    const next = upsertDailyReleaseBlock(md, '2026-07-09', ['feat: 新增日更']);
    expect(next).toContain(`## [Unreleased]

## [Daily 2026-07-09] - 2026-07-09
### Added
- 新增日更

## [0.2.0] - 2026-07-03`);
  });

  test('同一天重复运行时替换原日更块而不是追加重复块', () => {
    const md = `# Changelog

## [Unreleased]

## [Daily 2026-07-09] - 2026-07-09
### Added
- 旧日更

## [0.2.0] - 2026-07-03
### Added
- 旧版本
`;
    const next = upsertDailyReleaseBlock(md, '2026-07-09', ['fix: 新日更']);
    expect(next.match(/## \[Daily 2026-07-09\]/g)).toHaveLength(1);
    expect(next).toContain('### Fixed\n- 新日更');
    expect(next).not.toContain('旧日更');
  });
});
