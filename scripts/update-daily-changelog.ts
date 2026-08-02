import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractUserFacingEntries,
  parseUserFacingLine,
  upsertDailyReleaseBlock,
  type UserFacingEntry,
} from '../apps/web-next/lib/daily-changelog';

/**
 * 每日更新日志生成脚本（用户向内容模型）。
 *
 * 数据源：当天合并的 GitHub PR。PR body 中的 `## 用户向更新` 小节提供人工
 * 条目；缺失小节的 PR 通过 server 内部端点（内置 PI Manager 的 Active PI
 * Model）生成兜底条目。两者都失败/未配置时 fail-open：当天只有人工条目或
 * 占位文案，绝不阻断流水线。
 *
 * Env:
 * - GITHUB_REPOSITORY / GITHUB_TOKEN：拉取合并 PR（CI 自动提供；本地缺失时跳过）
 * - AGENTBEAN_CHANGELOG_SERVER_URL / AGENTBEAN_CHANGELOG_SERVER_TOKEN：
 *   调用 server 的 /api/internal/changelog-summarize（未配置时跳过兜底）
 */

interface Options {
  date?: string;
  since?: string;
  until?: string;
  dryRun: boolean;
  subjects: string[];
}

interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  updated_at: string;
}

interface ChangelogSummarizeResult {
  number: number;
  entries: UserFacingEntry[];
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_UTC_OFFSET = '+08:00';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const options = parseArgs(process.argv.slice(2));
const date = options.date ?? formatDateInTimeZone(new Date(), process.env.AGENTBEAN_CHANGELOG_TIMEZONE ?? DEFAULT_TIMEZONE);
const since = options.since ?? `${date}T00:00:00${process.env.AGENTBEAN_CHANGELOG_UTC_OFFSET ?? DEFAULT_UTC_OFFSET}`;
const until = options.until ?? `${date}T23:59:59${process.env.AGENTBEAN_CHANGELOG_UTC_OFFSET ?? DEFAULT_UTC_OFFSET}`;

await main();

async function main(): Promise<void> {
  const entries = await resolveEntries();
  const current = fs.readFileSync(changelogPath, 'utf8');
  const next = upsertDailyReleaseBlock(current, date, entries);

  if (options.dryRun) {
    process.stdout.write(next);
  } else {
    fs.writeFileSync(changelogPath, next);
    console.log(`[daily-changelog] updated CHANGELOG.md for ${date} with ${entries.length} user-facing entr(ies)`);
  }
}

async function resolveEntries(): Promise<UserFacingEntry[]> {
  if (options.subjects.length > 0) {
    return options.subjects
      .map((line) => parseUserFacingLine(line))
      .filter((entry): entry is UserFacingEntry => entry !== null);
  }

  const pulls = await fetchMergedPullRequests(since, until);
  console.log(`[daily-changelog] ${pulls.length} merged PR(s) for ${date}`);
  const serverConfig = readServerConfig();
  const fallback = await summarizeMissingEntries(pulls, serverConfig);

  const entries: UserFacingEntry[] = [];
  for (const pr of pulls) {
    entries.push(...extractUserFacingEntries(pr.body ?? ''));
    entries.push(...(fallback.get(pr.number) ?? []));
  }
  return entries;
}

/** 拉取 merged_at 落在 [since, until] 的合并 PR；GITHUB_REPOSITORY/GITHUB_TOKEN 缺失时返回空（fail-open）。 */
async function fetchMergedPullRequests(since: string, until: string): Promise<PullRequest[]> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.log('[daily-changelog] GITHUB_REPOSITORY/GITHUB_TOKEN 缺失，跳过 PR 拉取（仅用 --subject 条目）');
    return [];
  }

  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  const all: PullRequest[] = [];

  // state=closed + updated desc 分页；PR 的 updated_at >= merged_at，
  // 某一页全部 updated_at < since 时不可能再出现当天合并的 PR，提前终止。
  for (let page = 1; page <= 10; page += 1) {
    const url = `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

    const batch = (await res.json()) as PullRequest[];
    all.push(
      ...batch.filter((pr) => {
        if (!pr.merged_at) return false;
        const mergedMs = Date.parse(pr.merged_at);
        return mergedMs >= sinceMs && mergedMs <= untilMs;
      }),
    );
    if (batch.length < 100 || batch.every((pr) => Date.parse(pr.updated_at) < sinceMs)) break;
  }
  return all;
}

/** 对无小节 PR 调用 server 内部端点，由内置 PI Manager 生成兜底条目；未配置/失败 → 空 Map（fail-open）。 */
async function summarizeMissingEntries(
  pulls: PullRequest[],
  config: { serverUrl: string; serverToken: string } | null,
): Promise<Map<number, UserFacingEntry[]>> {
  const missing = pulls.filter((pr) => !pr.body?.includes('## 用户向更新'));
  const result = new Map<number, UserFacingEntry[]>();
  if (missing.length === 0 || !config) return result;

  try {
    const res = await fetch(`${config.serverUrl}/api/internal/changelog-summarize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.serverToken}`,
      },
      body: JSON.stringify({
        pulls: missing.map((pr) => ({ number: pr.number, title: pr.title, body: pr.body ?? '' })),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`server summarize ${res.status}`);
    const data = (await res.json()) as { results?: ChangelogSummarizeResult[] };
    for (const item of data.results ?? []) {
      result.set(item.number, item.entries);
    }
  } catch (error) {
    console.log(`[daily-changelog] server 兜底失败（fail-open）：${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

function readServerConfig(): { serverUrl: string; serverToken: string } | null {
  const serverUrl = process.env.AGENTBEAN_CHANGELOG_SERVER_URL;
  const serverToken = process.env.AGENTBEAN_CHANGELOG_SERVER_TOKEN;
  if (!serverUrl || !serverToken) return null;
  return { serverUrl: serverUrl.replace(/\/+$/, ''), serverToken };
}

function parseArgs(args: string[]): Options {
  const options: Options = { dryRun: false, subjects: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--date') {
      options.date = readValue(args, (index += 1), arg);
    } else if (arg === '--since') {
      options.since = readValue(args, (index += 1), arg);
    } else if (arg === '--until') {
      options.until = readValue(args, (index += 1), arg);
    } else if (arg === '--subject') {
      options.subjects.push(readValue(args, (index += 1), arg));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
