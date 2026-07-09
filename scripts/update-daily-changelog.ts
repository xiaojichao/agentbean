import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upsertDailyReleaseBlock } from '../apps/web-next/lib/daily-changelog';

interface Options {
  date?: string;
  since?: string;
  until?: string;
  dryRun: boolean;
  subjects: string[];
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
const subjects = options.subjects.length > 0 ? options.subjects : readCommitSubjects(since, until);
const current = fs.readFileSync(changelogPath, 'utf8');
const next = upsertDailyReleaseBlock(current, date, subjects);

if (options.dryRun) {
  process.stdout.write(next);
} else {
  fs.writeFileSync(changelogPath, next);
  console.log(`[daily-changelog] updated CHANGELOG.md for ${date} using ${subjects.length} commit subject(s)`);
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

function readCommitSubjects(since: string, until: string): string[] {
  const result = spawnSync(
    'git',
    ['log', '--no-merges', `--since=${since}`, `--until=${until}`, '--format=%s'],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || `git log failed with status ${result.status}`);
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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
