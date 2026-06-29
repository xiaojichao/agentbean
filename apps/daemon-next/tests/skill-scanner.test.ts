import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { scanCustomAgentSkills } from '../src/skill-scanner';

function writeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nbody\n`);
}

describe('scanCustomAgentSkills', () => {
  test('claude-code 扫全局 + 项目 skills', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const projectCwd = mkdtempSync(join(tmpdir(), 'proj-'));
    writeSkill(join(home, '.claude/skills'), 'global-skill', 'global desc');
    writeSkill(join(projectCwd, '.claude/skills'), 'project-skill', 'project desc');

    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'claude-code', cwd: projectCwd }, home);

    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['global-skill', 'project-skill']);
    const proj = skills.find((s) => s.name === 'project-skill')!;
    expect(proj.scope).toBe('project');
    const glob = skills.find((s) => s.name === 'global-skill')!;
    expect(glob.scope).toBe('user');
  });

  test('codex 扫 ~/.agents/skills + 项目 + 内置 system', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const projectCwd = mkdtempSync(join(tmpdir(), 'proj-'));
    writeSkill(join(home, '.agents/skills'), 'codex-user', 'codex user skill');
    writeSkill(join(projectCwd, '.agents/skills'), 'codex-proj', 'codex proj skill');

    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'codex', cwd: projectCwd }, home);
    const names = skills.map((s) => s.name);
    expect(names).toContain('codex-user');
    expect(names).toContain('codex-proj');
    expect(names).toContain('skill-creator');      // 内置 system
    const sys = skills.find((s) => s.name === 'skill-creator')!;
    expect(sys.scope).toBe('system');
  });

  test('目录不存在 → 空数组（不抛错）', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'claude-code', cwd: '/nonexistent-cwd' }, home);
    // claude-code 无 system，全局/项目都不存在 → 空
    expect(skills).toEqual([]);
  });

  test('SKILL.md 缺 name frontmatter → 跳过该 skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const skillDir = join(home, '.claude/skills', 'bad');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\ndescription: no name here\n---\nbody`);
    writeSkill(join(home, '.claude/skills'), 'good', 'has name');

    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'claude-code' }, home);
    expect(skills.map((s) => s.name)).toEqual(['good']);
  });

  test('不支持的 adapterKind → 空数组', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'hermes', cwd: '/x' }, home);
    expect(skills).toEqual([]);
  });

  test('description 截断到 200 字符', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const longDesc = 'x'.repeat(500);
    writeSkill(join(home, '.claude/skills'), 'big', longDesc);
    const skills = scanCustomAgentSkills(
      { id: 'a1', adapterKind: 'claude-code' }, home);
    expect(skills[0].description.length).toBe(200);
  });
});
