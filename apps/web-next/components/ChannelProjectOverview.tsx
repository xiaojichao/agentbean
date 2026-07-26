'use client';

import { AlertCircle, CheckCircle2, ChevronDown, Plus, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ChannelProjectOverviewDto } from '@agentbean/contracts';

export interface ProjectTaskOption {
  id: string;
  title: string;
}

export interface ProjectParticipantOption {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

export interface InitialProjectStageDraft {
  projectLeadId: string;
  defaultReviewerIds: string[];
  stage: {
    name: string;
    goal: string;
    ownerId: string;
    reviewerIds: string[];
    acceptanceCriteria: string[];
    taskId: string;
  };
}

export function ChannelProjectOverview({
  overview,
  tasks,
  participants,
  currentUserId,
  onCreate,
}: {
  overview: ChannelProjectOverviewDto | null;
  tasks: ProjectTaskOption[];
  participants: ProjectParticipantOption[];
  currentUserId?: string;
  onCreate: (draft: InitialProjectStageDraft) => Promise<string | null>;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? '');
  const [ownerId, setOwnerId] = useState(currentUserId ?? '');
  const [projectLeadId, setProjectLeadId] = useState(currentUserId ?? '');
  const [defaultReviewerIds, setDefaultReviewerIds] = useState<string[]>([]);
  const [stageReviewerIds, setStageReviewerIds] = useState<string[]>([]);
  const [criteria, setCriteria] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const humanParticipants = participants.filter((participant) => participant.kind === 'human');
  const defaultReviewerId = humanParticipants.find((participant) => participant.id !== currentUserId)?.id
    ?? humanParticipants[0]?.id;

  useEffect(() => {
    if (!taskId && tasks[0]) setTaskId(tasks[0].id);
  }, [taskId, tasks]);

  useEffect(() => {
    if (!ownerId && currentUserId) setOwnerId(currentUserId);
    if (!projectLeadId && currentUserId) setProjectLeadId(currentUserId);
  }, [currentUserId, ownerId, projectLeadId]);

  useEffect(() => {
    if (!defaultReviewerId) return;
    if (defaultReviewerIds.length === 0) setDefaultReviewerIds([defaultReviewerId]);
    if (stageReviewerIds.length === 0) setStageReviewerIds([defaultReviewerId]);
  }, [defaultReviewerId, defaultReviewerIds.length, stageReviewerIds.length]);

  if (overview) {
    return (
      <section aria-label="项目总览" className="shrink-0 border-b border-neutral-200 bg-amber-50/60 px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-neutral-900">项目阶段</h2>
          <span className="text-xs text-neutral-500">
            负责人：{participantName(overview.profile.projectLeadId, participants)}
          </span>
          {overview.archived && (
            <span className="rounded bg-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
              已归档 · 只读
            </span>
          )}
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {overview.stages.map((stage) => (
            <article key={stage.id} className="rounded-md border border-amber-200 bg-white p-3">
              <div className="flex items-start gap-2">
                {stage.aggregateStatus === 'complete'
                  ? <CheckCircle2 size={15} className="mt-0.5 text-emerald-600" />
                  : <span className="mt-1 h-2.5 w-2.5 rounded-full bg-amber-400" />}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-neutral-900">{stage.name}</div>
                  <div className="mt-0.5 text-xs text-neutral-500">{stage.goal}</div>
                </div>
                <span className="text-[11px] font-medium text-neutral-500">
                  {aggregateStatusLabel(stage.aggregateStatus)}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-[52px_1fr] gap-x-2 gap-y-1 text-xs">
                <dt className="text-neutral-400">任务</dt>
                <dd className="truncate text-neutral-700">{stage.task.title}</dd>
                <dt className="text-neutral-400">负责人</dt>
                <dd className="text-neutral-700">{participantName(stage.ownerId, participants)}</dd>
                <dt className="text-neutral-400">审核者</dt>
                <dd className="text-neutral-700">
                  {stage.reviewerIds.map((id) => participantName(id, participants)).join('、') || '未配置'}
                </dd>
              </dl>
              {stage.blockingReasons.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5 rounded bg-orange-50 px-2 py-1 text-xs text-orange-700">
                  <AlertCircle size={13} />
                  {stage.blockingReasons.map((reason) => blockingReasonLabel(reason.code)).join('；')}
                </div>
              )}
              <details className="mt-2 text-xs text-neutral-500">
                <summary className="flex cursor-pointer list-none items-center gap-1">
                  <ChevronDown size={12} />
                  验收标准（{stage.acceptanceCriteria.length}）
                </summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {stage.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
                </ul>
              </details>
            </article>
          ))}
        </div>
      </section>
    );
  }

  if (!showCreate) {
    return tasks.length > 0 && currentUserId ? (
      <div className="shrink-0 border-b border-neutral-100 px-4 py-2">
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-900"
        >
          <Plus size={13} />
          创建首个项目阶段
        </button>
      </div>
    ) : null;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const acceptanceCriteria = criteria.split('\n').map((item) => item.trim()).filter(Boolean);
    if (!name.trim() || !goal.trim() || !taskId || !ownerId || !projectLeadId
      || defaultReviewerIds.length === 0 || stageReviewerIds.length === 0
      || acceptanceCriteria.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const nextError = await onCreate({
        projectLeadId,
        defaultReviewerIds,
        stage: {
          name: name.trim(),
          goal: goal.trim(),
          ownerId,
          reviewerIds: stageReviewerIds,
          acceptanceCriteria,
          taskId,
        },
      });
      if (nextError) setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="shrink-0 border-b border-neutral-200 bg-amber-50/60 px-4 py-3">
      <div className="mb-3 flex items-center">
        <h2 className="text-sm font-semibold text-neutral-900">创建首个项目阶段</h2>
        <button type="button" onClick={() => setShowCreate(false)} className="ml-auto text-neutral-400 hover:text-neutral-700" title="取消">
          <X size={15} />
        </button>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <ProjectField label="阶段名称">
          <input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} placeholder="例如：发布准备" />
        </ProjectField>
        <ProjectField label="绑定任务">
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)} className={inputClass}>
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
        </ProjectField>
        <ProjectField label="阶段负责人">
          <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)} className={inputClass}>
            {participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}</option>)}
          </select>
        </ProjectField>
        <ProjectField label="项目负责人">
          <select value={projectLeadId} onChange={(event) => setProjectLeadId(event.target.value)} className={inputClass}>
            {humanParticipants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}</option>)}
          </select>
        </ProjectField>
        <ProjectField label="阶段目标">
          <input value={goal} onChange={(event) => setGoal(event.target.value)} className={inputClass} placeholder="本阶段要达成什么" />
        </ProjectField>
        <ProjectField label="默认审核者（可多选）">
          <select
            multiple
            value={defaultReviewerIds}
            onChange={(event) => setDefaultReviewerIds(selectedValues(event.currentTarget))}
            className={`${inputClass} h-20 py-1`}
          >
            {humanParticipants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}</option>)}
          </select>
        </ProjectField>
        <ProjectField label="阶段审核者（可多选）">
          <select
            multiple
            value={stageReviewerIds}
            onChange={(event) => setStageReviewerIds(selectedValues(event.currentTarget))}
            className={`${inputClass} h-20 py-1`}
          >
            {humanParticipants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}</option>)}
          </select>
        </ProjectField>
        <ProjectField label="验收标准（每行一条）">
          <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} className={`${inputClass} min-h-20 py-2`} placeholder={'发布步骤完整\n回滚方案明确'} />
        </ProjectField>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={saving}
        className="mt-3 h-8 rounded-md bg-neutral-900 px-3 text-xs font-medium text-white disabled:opacity-50"
      >
        {saving ? '创建中...' : '创建项目阶段'}
      </button>
    </form>
  );
}

const inputClass = 'h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-500';

function ProjectField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function participantName(id: string, participants: ProjectParticipantOption[]): string {
  return participants.find((participant) => participant.id === id)?.name ?? id;
}

function selectedValues(select: HTMLSelectElement): string[] {
  return Array.from(select.selectedOptions, (option) => option.value);
}

function aggregateStatusLabel(status: ChannelProjectOverviewDto['stages'][number]['aggregateStatus']): string {
  if (status === 'pending') return '待开始';
  if (status === 'active') return '进行中';
  if (status === 'in_review') return '审核中';
  return '已完成';
}

function blockingReasonLabel(code: ChannelProjectOverviewDto['stages'][number]['blockingReasons'][number]['code']): string {
  if (code === 'task_not_started') return '绑定任务尚未开始';
  if (code === 'dependency_incomplete') return '依赖任务尚未完成';
  if (code === 'review_pending') return '等待审核结论';
  if (code === 'review_rejected') return '审核未通过';
  return '需要人工确认';
}
