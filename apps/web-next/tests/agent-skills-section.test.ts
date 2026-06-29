import { describe, expect, test } from 'vitest';
import { groupSkills, countSkillsByScope } from '../components/agent-skills-section';

const skills = [
  { name: 'a', description: 'd', scope: 'user', sourcePath: '/p', adapterKind: 'claude-code' },
  { name: 'b', description: 'd', scope: 'project', sourcePath: '/p', adapterKind: 'claude-code' },
  { name: 'c', description: 'd', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
] as any;

describe('AgentSkillsSection 纯逻辑', () => {
  test('groupSkills 按 scope 分组', () => {
    const g = groupSkills(skills);
    expect(g.user.map((s) => s.name)).toEqual(['a']);
    expect(g.project.map((s) => s.name)).toEqual(['b']);
    expect(g.system.map((s) => s.name)).toEqual(['c']);
  });

  test('countSkillsByScope 计数', () => {
    expect(countSkillsByScope(skills)).toEqual({ system: 1, user: 1, project: 1 });
  });

  test('空 skills → 各组空', () => {
    expect(groupSkills([] as any)).toEqual({ system: [], user: [], project: [] });
  });
});
