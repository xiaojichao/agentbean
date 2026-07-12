import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultRoots = [
  'packages/contracts/src',
  'packages/contracts/tests',
  'apps/server-next/src',
  'apps/server-next/tests',
  'apps/web-next',
  'apps/daemon-next/src',
  'apps/daemon-next/tests',
  'scripts/check-agentbean-next-readiness.mjs',
  'scripts/smoke-agentbean-next-browser.mjs',
  'scripts/audit-agentbean-next-cutover.mjs',
  'scripts/check-agentbean-next-railway-preflight.mjs',
  'scripts/prepare-agentbean-next-daemon-release.mjs',
  '.github/workflows/ci-cd.yml',
  '.github/workflows/daily-changelog.yml',
  'package.json',
  'railway.json',
  'README.md',
  'agentbean-next/docs',
  'docs/superpowers/specs',
];

const rules = [
  ['product identifier', /network(?:Ids?|Name|Path)\b/gi],
  ['visibility identifier', /(?:published|unpublished)NetworkIds\b/g],
  ['admin identifier', /(?:list|delete)Networks?\b/g],
  ['Pascal/camel identifier', /Network(?:s|Id|Name|Path|Ids|Dialog)?\b/g],
  ['socket event', /\bnetwork:[a-z-]+/g],
  ['admin event', /admin:(?:list|delete)-networks?\b/g],
  ['HTTP route', /\/api\/networks\b/g],
  ['browser key', /agentbean\.networkPath/g],
  ['resource/table', /\bnetworks\b/gi],
  ['schema column', /\bnetwork_id\b/g],
  ['schema column', /\bcurrent_network_id\b/g],
  ['schema column', /\bprimary_network_id\b/g],
  ['schema table', /\bnetwork_members\b/g],
  ['removed product dependency', /\bTailscale\b/gi],
];

const ignoredSegments = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const generatedOrBinaryExtensions = /\.(?:tsbuildinfo|png|jpe?g|gif|webp|ico|zip|gz|pdf|sqlite|db|woff2?|ttf|eot)$/i;
const requestedRoots = process.argv.slice(2);
const scanRoots = (requestedRoots.length > 0 ? requestedRoots : defaultRoots)
  .map((entry) => resolve(workspaceRoot, entry));

function walk(entry) {
  if (!existsSync(entry)) throw new Error(`Terminology scan path does not exist: ${entry}`);
  const stat = statSync(entry);
  if (stat.isFile()) return [entry];
  if (!stat.isDirectory()) return [];

  return readdirSync(entry, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((dirent) => {
      if (dirent.isDirectory() && ignoredSegments.has(dirent.name)) return [];
      return walk(resolve(entry, dirent.name));
    });
}

const violations = [];
for (const file of scanRoots.flatMap(walk)) {
  const repoPath = relative(workspaceRoot, file).split(sep).join('/');
  if (generatedOrBinaryExtensions.test(file)) continue;

  const source = readFileSync(file, 'utf8');
  if (source.includes('\0')) continue;

  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [label, pattern] of rules) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) violations.push(`${repoPath}:${index + 1}:${label}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`Team terminology check passed (${scanRoots.length} roots).`);
