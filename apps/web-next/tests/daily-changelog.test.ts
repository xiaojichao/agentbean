import { describe, expect, test } from 'vitest';
import {
  buildDailyReleaseBlock,
  buildDailyReleaseSections,
  extractUserFacingEntries,
  parseUserFacingLine,
  upsertDailyReleaseBlock,
} from '../lib/daily-changelog';

describe('parseUserFacingLine', () => {
  test('解析行前缀条目（中文冒号）', () => {
    expect(parseUserFacingLine('- 新功能: 支持频道文件预览')).toEqual({ type: '新功能', text: '支持频道文件预览' });
    expect(parseUserFacingLine('- 改进: 消息加载性能提升')).toEqual({ type: '改进', text: '消息加载性能提升' });
    expect(parseUserFacingLine('- 修复：修复断线重连偶发失败')).toEqual({ type: '修复', text: '修复断线重连偶发失败' });
  });

  test('非法行返回 null', () => {
    expect(parseUserFacingLine('- 无关行')).toBeNull();
    expect(parseUserFacingLine('普通段落')).toBeNull();
    expect(parseUserFacingLine('- 移除: 不支持分类')).toBeNull();
  });
});

describe('extractUserFacingEntries', () => {
  test('提取小节内的行前缀条目（中英文冒号）', () => {
    const body = `## 描述
重构了内部路由。
## 用户向更新
- 新功能: 支持频道文件预览
- 改进: 消息加载性能提升
- 修复：修复断线重连偶发失败
## 其他小节
不应进入
`;
    expect(extractUserFacingEntries(body)).toEqual([
      { type: '新功能', text: '支持频道文件预览' },
      { type: '改进', text: '消息加载性能提升' },
      { type: '修复', text: '修复断线重连偶发失败' },
    ]);
  });

  test('无小节或全无条目返回空数组', () => {
    expect(extractUserFacingEntries('无小节')).toEqual([]);
    expect(extractUserFacingEntries('## 用户向更新\n- 无关行\n')).toEqual([]);
  });

  test('小节后首个 ## 标题结束小节', () => {
    const body = `## 用户向更新
- 新功能: A
## 下一个
- 新功能: B
`;
    expect(extractUserFacingEntries(body)).toEqual([{ type: '新功能', text: 'A' }]);
  });
});

describe('buildDailyReleaseSections', () => {
  test('三分组装并按固定顺序', () => {
    const sections = buildDailyReleaseSections([
      { type: '修复', text: '修复 X' },
      { type: '新功能', text: '新增 Y' },
      { type: '改进', text: '更快 Z' },
    ]);
    expect(sections.map((s) => s.type)).toEqual(['新功能', '改进', '修复']);
    expect(sections[0].items).toEqual(['新增 Y']);
    expect(sections[1].items).toEqual(['更快 Z']);
    expect(sections[2].items).toEqual(['修复 X']);
  });

  test('去重相同条目', () => {
    const sections = buildDailyReleaseSections([
      { type: '新功能', text: 'A' },
      { type: '新功能', text: 'A' },
    ]);
    expect(sections[0].items).toEqual(['A']);
  });

  test('空条目写入占位文案（改进组）', () => {
    const sections = buildDailyReleaseSections([]);
    expect(sections).toEqual([{ type: '改进', items: ['当日无面向用户的代码变更，服务保持稳定运行。'] }]);
  });
});

describe('buildDailyReleaseBlock', () => {
  test('生成中文三分格式的日更块', () => {
    expect(buildDailyReleaseBlock('2026-08-01', [
      { type: '新功能', text: '支持频道文件预览' },
      { type: '修复', text: '修复断线重连偶发失败' },
    ])).toBe(`## [Daily 2026-08-01] - 2026-08-01
### 新功能
- 支持频道文件预览
### 修复
- 修复断线重连偶发失败
`);
  });
});

describe('upsertDailyReleaseBlock', () => {
  test('把日更块插入 Unreleased 之后并保留旧版本', () => {
    const md = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-07-03
### Added
- 旧版本
`;
    const next = upsertDailyReleaseBlock(md, '2026-07-09', [{ type: '新功能', text: '新增日更' }]);
    expect(next).toContain(`## [Unreleased]

## [Daily 2026-07-09] - 2026-07-09
### 新功能
- 新增日更

## [0.2.0] - 2026-07-03`);
  });

  test('同一天重复运行时替换原日更块而不是追加重复块', () => {
    const md = `# Changelog

## [Unreleased]

## [Daily 2026-07-09] - 2026-07-09
### 新功能
- 旧日更

## [0.2.0] - 2026-07-03
### Added
- 旧版本
`;
    const next = upsertDailyReleaseBlock(md, '2026-07-09', [{ type: '修复', text: '新日更' }]);
    expect(next.match(/## \[Daily 2026-07-09\]/g)).toHaveLength(1);
    expect(next).toContain('### 修复\n- 新日更');
    expect(next).not.toContain('旧日更');
  });
});
