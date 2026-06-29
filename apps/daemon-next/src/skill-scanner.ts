import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { AdapterKind, SkillDto } from '../../../packages/contracts/src/index.js';

const MAX_DESCRIPTION = 200;
const MAX_SKILLS = 200;

// codex 二进制内置 system skills（磁盘扫不到，静态清单）
const CODEX_SYSTEM_SKILLS: SkillDto[] = [
  { name: 'skill-creator', description: 'Create new Codex skills', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
  { name: 'plugin-creator', description: 'Create Codex plugins bundling skills + MCP', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
  { name: 'imagegen', description: 'Generate images via Codex', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
];

// 配置表驱动：每个 adapter 的全局/项目 skills 目录。其它 adapter 留 undefined（架构预留）。
const SKILL_SCAN_CONFIGS: Partial<Record<AdapterKind, { userDir: string; projectDir: string; system: SkillDto[] }>> = {
  'claude-code': { userDir: '.claude/skills', projectDir: '.claude/skills', system: [] },
  'codex': { userDir: '.agents/skills', projectDir: '.agents/skills', system: CODEX_SYSTEM_SKILLS },
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** 解析 SKILL.md frontmatter，提取 name + description。失败返回 null。 */
function parseSkillFrontmatter(skillMdPath: string, scope: SkillDto['scope'], adapterKind: AdapterKind, sourcePath: string): SkillDto | null {
  try {
    const raw = readFileSync(skillMdPath, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const front = parseYaml(match[1]) as { name?: unknown; description?: unknown } | null;
    if (!front || typeof front !== 'object') return null;
    const name = typeof front.name === 'string' ? front.name.trim() : '';
    if (!name) return null;
    const description = typeof front.description === 'string' ? truncate(front.description, MAX_DESCRIPTION) : '';
    return { name, description, scope, sourcePath, adapterKind };
  } catch {
    return null;
  }
}

function scanDir(dir: string, scope: SkillDto['scope'], adapterKind: AdapterKind): SkillDto[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SkillDto[] = [];
  for (const entry of entries) {
    const sub = join(dir, entry);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = parseSkillFrontmatter(join(sub, 'SKILL.md'), scope, adapterKind, sub);
    if (skill) out.push(skill);
  }
  return out;
}

export function scanCustomAgentSkills(customAgent: { id: string; adapterKind: AdapterKind; cwd?: string }, home: string): SkillDto[] {
  const config = SKILL_SCAN_CONFIGS[customAgent.adapterKind];
  if (!config) return [];
  const user = scanDir(join(home, config.userDir), 'user', customAgent.adapterKind);
  const project = customAgent.cwd ? scanDir(join(customAgent.cwd, config.projectDir), 'project', customAgent.adapterKind) : [];
  const merged = [...config.system, ...user, ...project];
  return merged.length > MAX_SKILLS ? merged.slice(0, MAX_SKILLS) : merged;
}
