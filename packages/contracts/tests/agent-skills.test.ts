import { describe, expect, test } from 'vitest';
import { AGENT_EVENTS } from '../src/socket';
import type { SkillDto, AgentDto } from '../src/agent';

describe('agent skills contracts', () => {
  test('AGENT_EVENTS.agent.reportCustomSkills 定义为 agent:report-custom-skills', () => {
    expect(AGENT_EVENTS.agent.reportCustomSkills).toBe('agent:report-custom-skills');
  });

  test('SkillDto 含必要字段', () => {
    const skill: SkillDto = {
      name: 'analyze',
      description: 'deep analysis',
      scope: 'user',
      sourcePath: '/home/u/.claude/skills/analyze',
      adapterKind: 'claude-code',
    };
    expect(skill.scope === 'user' || skill.scope === 'project' || skill.scope === 'system').toBe(true);
  });

  test('AgentDto.skills 可选', () => {
    const agent = { id: 'a1', primaryTeamId: 't1', visibleTeamIds: [], name: 'x',
      adapterKind: 'claude-code', category: 'executor-hosted', source: 'custom', status: 'online' } as AgentDto;
    expect(agent.skills).toBeUndefined();
  });
});
