import type { ChangeType, ReleaseSection } from './changelog';

const DAILY_VERSION_PREFIX = 'Daily ';
const DAILY_NO_CHANGE_ITEM = '当日无面向用户的代码变更，服务保持稳定运行。';
const RELEASE_HEADER_RE = /^##\s+\[[^\]]+\]/;

const SECTION_ORDER: ChangeType[] = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

export function dailyReleaseVersion(date: string): string {
  return `${DAILY_VERSION_PREFIX}${date}`;
}

export function classifyDailyChange(subject: string): ChangeType {
  const normalized = subject.trim().toLowerCase();
  if (/(security|安全|漏洞|权限|鉴权|认证)/i.test(normalized)) return 'Security';
  if (/^(fix|bugfix|hotfix)(\(.+\))?:/.test(normalized) || /(修复|防止|避免|恢复|兜底)/.test(subject)) return 'Fixed';
  if (/^(feat|feature)(\(.+\))?:/.test(normalized) || /(新增|添加|支持|上线|发布|补齐|迁入)/.test(subject)) return 'Added';
  if (/^(remove|removed)(\(.+\))?:/.test(normalized) || /(删除|移除|下线)/.test(subject)) return 'Removed';
  if (/^(deprecate|deprecated)(\(.+\))?:/.test(normalized) || /(弃用|废弃)/.test(subject)) return 'Deprecated';
  return 'Changed';
}

export function normalizeDailyChangeItem(subject: string): string {
  return subject
    .trim()
    .replace(/^(feat|feature|fix|bugfix|hotfix|chore|docs|refactor|perf|test|ci)(\([^)]+\))?!?:\s*/i, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .trim();
}

export function buildDailyReleaseSections(subjects: string[]): ReleaseSection[] {
  const sections = new Map<ChangeType, string[]>();
  const seen = new Set<string>();

  for (const subject of subjects) {
    const item = normalizeDailyChangeItem(subject);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    const type = classifyDailyChange(subject);
    sections.set(type, [...(sections.get(type) ?? []), item]);
  }

  if (seen.size === 0) {
    sections.set('Changed', [DAILY_NO_CHANGE_ITEM]);
  }

  return SECTION_ORDER
    .map((type) => ({ type, items: sections.get(type) ?? [] }))
    .filter((section) => section.items.length > 0);
}

export function buildDailyReleaseBlock(date: string, subjects: string[]): string {
  const sections = buildDailyReleaseSections(subjects);
  const lines = [`## [${dailyReleaseVersion(date)}] - ${date}`];

  for (const section of sections) {
    lines.push(`### ${section.type}`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function upsertDailyReleaseBlock(markdown: string, date: string, subjects: string[]): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blockLines = buildDailyReleaseBlock(date, subjects).trimEnd().split('\n');
  const header = `## [${dailyReleaseVersion(date)}] - ${date}`;
  const existing = findReleaseBlock(lines, header);

  if (existing) {
    lines.splice(existing.start, existing.end - existing.start, ...blockLines);
    return ensureTrailingNewline(lines.join('\n'));
  }

  const insertAt = findDailyInsertIndex(lines);
  const insertLines = [
    ...(insertAt > 0 && lines[insertAt - 1] !== '' ? [''] : []),
    ...blockLines,
    ...(lines[insertAt] !== '' ? [''] : []),
  ];

  lines.splice(insertAt, 0, ...insertLines);
  return ensureTrailingNewline(lines.join('\n'));
}

function findReleaseBlock(lines: string[], header: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (RELEASE_HEADER_RE.test(lines[index])) {
      end = index;
      break;
    }
  }

  while (end > start && lines[end - 1] === '') end -= 1;
  return { start, end };
}

function findDailyInsertIndex(lines: string[]): number {
  const unreleasedIndex = lines.findIndex((line) => /^##\s+\[Unreleased\]/i.test(line));
  if (unreleasedIndex >= 0) {
    for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
      if (RELEASE_HEADER_RE.test(lines[index])) return index;
    }
    return lines.length;
  }

  const firstReleaseIndex = lines.findIndex((line) => RELEASE_HEADER_RE.test(line));
  return firstReleaseIndex >= 0 ? firstReleaseIndex : lines.length;
}

function ensureTrailingNewline(value: string): string {
  return `${value.replace(/\n+$/, '')}\n`;
}
