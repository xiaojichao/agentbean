import { useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { AgentSnapshot, SkillDto } from '@/lib/schema';
import { deviceEvents } from '@/lib/socket';

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

const PREVIEW = 5;
const SCOPE_LABEL: Record<keyof ReturnType<typeof groupSkills>, string> = {
  system: '内置',
  user: '全局',
  project: '项目',
};

function SkillRow({ skill }: { skill: SkillDto }) {
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <span className="text-sm font-medium text-neutral-800">{skill.name}</span>
      {skill.description && <span className="text-xs text-neutral-500 line-clamp-2">{skill.description}</span>}
    </div>
  );
}

export function AgentSkillsSection({ agent }: { agent: AgentSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const skills = agent.skills;
  if (!skills || skills.length === 0) return null;

  const grouped = groupSkills(skills);
  const total = skills.length;

  const onRefresh = async () => {
    if (!agent.deviceId) return;
    setRefreshing(true);
    try {
      await deviceEvents().scan(agent.deviceId);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-neutral-500">
        <span className="flex items-center gap-2">
          <Sparkles size={15} />
          技能 ({total})
        </span>
        {agent.deviceId && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            刷新
          </button>
        )}
      </h2>
      <div className="flex flex-col gap-3">
        {(['system', 'user', 'project'] as const).map((scope) => {
          const list = grouped[scope];
          if (list.length === 0) return null;
          const shown = expanded ? list : list.slice(0, PREVIEW);
          return (
            <div key={scope}>
              <div className="mb-1 text-xs text-neutral-400">
                {SCOPE_LABEL[scope]} ({list.length})
              </div>
              {shown.map((s) => (
                <SkillRow key={`${scope}-${s.name}`} skill={s} />
              ))}
            </div>
          );
        })}
      </div>
      {total > PREVIEW && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs text-blue-600 hover:underline"
        >
          {expanded ? '收起' : `查看全部 (${total})`}
        </button>
      )}
    </section>
  );
}
