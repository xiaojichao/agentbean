// 纯 TS 模块：不得 import 任何 Next.js / 浏览器 API 或 @/ alias，
// 以便同时被 vitest 与 Node tsx 脚本（scripts/gen-changelog.ts）import。

export type ChangeType =
  | 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security';

export interface ReleaseSection {
  type: ChangeType;
  items: string[];
}

export interface Release {
  version: string;   // 不含前导 v，如 "0.2.0"
  date: string;      // YYYY-MM-DD
  sections: ReleaseSection[];
}

const VERSION_RE = /^##\s*\[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;
const VERSION_HEADER_RE = /^##\s*\[([^\]]+)\]/;
const SECTION_RE = /^###\s+(Added|Changed|Deprecated|Removed|Fixed|Security)\s*$/;
const ITEM_RE = /^\s*[-*]\s+(.+?)\s*$/;
const UNRELEASED_RE = /^##\s*\[Unreleased\]/i;

/**
 * 解析 Keep a Changelog 1.1.0 格式的字符串为 Release[]。
 * - 跳过 ## [Unreleased] 块与无日期的版本块。
 * - 过滤掉空分类（items 为空）。
 * - 重复版本号保留最后一块。
 * - 返回值按 date 降序排列。
 * - 对格式不合规的行静默跳过，不抛异常。
 */
export function parseChangelog(md: string): Release[] {
  const lines = md.split('\n');
  const byVersion = new Map<string, Release>();
  let current: Release | null = null;
  let currentSection: ReleaseSection | null = null;

  for (const line of lines) {
    if (UNRELEASED_RE.test(line)) {
      current = null;
      currentSection = null;
      continue;
    }
    if (VERSION_HEADER_RE.test(line) && !VERSION_RE.test(line)) {
      current = null;
      currentSection = null;
      continue;
    }
    const vm = VERSION_RE.exec(line);
    if (vm) {
      current = { version: vm[1].trim(), date: vm[2].trim(), sections: [] };
      byVersion.set(current.version, current); // 重复版本号覆盖 → 保留最后
      currentSection = null;
      continue;
    }
    if (!current) continue;
    const sm = SECTION_RE.exec(line);
    if (sm) {
      currentSection = { type: sm[1] as ChangeType, items: [] };
      current.sections.push(currentSection);
      continue;
    }
    if (!currentSection) continue;
    const im = ITEM_RE.exec(line);
    if (im) currentSection.items.push(im[1].trim());
  }

  return Array.from(byVersion.values())
    .map((r) => ({ ...r, sections: r.sections.filter((s) => s.items.length > 0) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
