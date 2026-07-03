// 读取仓库根 CHANGELOG.md，解析为 Release[]，序列化为 lib/releases.generated.ts。
// 由 web-next 的 predev / prebuild 钩子调用，用 tsx 运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from '../lib/changelog';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..'); // apps/web-next/scripts → 仓库根
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
const outPath = path.join(__dirname, '..', 'lib', 'releases.generated.ts');

const md = fs.readFileSync(changelogPath, 'utf8');
const releases = parseChangelog(md);

const header =
  '// AUTO-GENERATED from CHANGELOG.md by scripts/gen-changelog.ts — do not edit.\n' +
  "import type { Release } from './changelog';\n" +
  'export const releases: Release[] = ';
fs.writeFileSync(outPath, header + JSON.stringify(releases, null, 2) + ';\n');

console.log(`[gen-changelog] wrote ${releases.length} releases → ${path.relative(repoRoot, outPath)}`);
