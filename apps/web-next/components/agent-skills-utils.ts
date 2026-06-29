import type { SkillDto } from '@/lib/schema';

export function groupSkills(skills: SkillDto[] | undefined) {
  const base = { system: [] as SkillDto[], user: [] as SkillDto[], project: [] as SkillDto[] };
  if (!skills) return base;
  for (const s of skills) {
    if (s.scope === 'system') base.system.push(s);
    else if (s.scope === 'user') base.user.push(s);
    else base.project.push(s);
  }
  return base;
}

export function countSkillsByScope(skills: SkillDto[] | undefined) {
  const g = groupSkills(skills);
  return { system: g.system.length, user: g.user.length, project: g.project.length };
}
