import type { ChangeType, ReleaseSection } from './changelog';

const DAILY_VERSION_PREFIX = 'Daily ';
const DAILY_NO_CHANGE_ITEM = '当日无面向用户的代码变更，服务保持稳定运行。';
const RELEASE_HEADER_RE = /^##\s+\[[^\]]+\]/;

/** 用户向更新的三分类（PR body 小节行前缀与 CHANGELOG Section 名一致）。 */
export type UserFacingChangeType = '新功能' | '改进' | '修复';
export interface UserFacingEntry { type: UserFacingChangeType; text: string }

const USER_FACING_ORDER: UserFacingChangeType[] = ['新功能', '改进', '修复'];
const USER_FACING_SECTION_RE = /^##\s*用户向更新\s*$/;
const USER_FACING_ITEM_RE = /^\s*-\s*(新功能|改进|修复)\s*[:：]\s*(.+?)\s*$/;

export function dailyReleaseVersion(date: string): string {
  return `${DAILY_VERSION_PREFIX}${date}`;
}

/** 解析单行 `- 新功能: xxx`；非法行返回 null。 */
export function parseUserFacingLine(line: string): UserFacingEntry | null {
  const match = USER_FACING_ITEM_RE.exec(line.trim());
  if (!match) return null;
  return { type: match[1] as UserFacingChangeType, text: match[2].trim() };
}

/** 从 PR body 提取 `## 用户向更新` 小节内的行前缀条目；小节在下一个 `## ` 标题处结束。 */
export function extractUserFacingEntries(prBody: string): UserFacingEntry[] {
  const lines = prBody.replace(/\r\n/g, '\n').split('\n');
  const entries: UserFacingEntry[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s*/.test(line)) {
      inSection = USER_FACING_SECTION_RE.test(line);
      continue;
    }
    if (!inSection) continue;
    const entry = parseUserFacingLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function buildDailyReleaseSections(entries: UserFacingEntry[]): ReleaseSection[] {
  const sections = new Map<UserFacingChangeType, string[]>();
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.text || seen.has(entry.text)) continue;
    seen.add(entry.text);
    sections.set(entry.type, [...(sections.get(entry.type) ?? []), entry.text]);
  }

  if (seen.size === 0) {
    sections.set('改进', [DAILY_NO_CHANGE_ITEM]);
  }

  return USER_FACING_ORDER
    .map((type) => ({ type: type as ChangeType, items: sections.get(type) ?? [] }))
    .filter((section) => section.items.length > 0);
}

export function buildDailyReleaseBlock(date: string, entries: UserFacingEntry[]): string {
  const sections = buildDailyReleaseSections(entries);
  const lines = [`## [${dailyReleaseVersion(date)}] - ${date}`];

  for (const section of sections) {
    lines.push(`### ${section.type}`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function upsertDailyReleaseBlock(markdown: string, date: string, entries: UserFacingEntry[]): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blockLines = buildDailyReleaseBlock(date, entries).trimEnd().split('\n');
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
