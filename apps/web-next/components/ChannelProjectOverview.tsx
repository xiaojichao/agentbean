'use client';

import { AlertCircle, CheckCircle2, ChevronDown, Plus, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ChannelProjectOverviewDto,
  ProjectArtifactLibraryDto,
  ProjectStageRequiredInputRuleDto,
} from '@agentbean/contracts';

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

export interface ProjectStageEdgeDraft {
  upstreamStageId: string;
  downstreamStageId: string;
  semantics: 'blocks_start' | 'provides_context';
  requiredInputs: ProjectStageRequiredInputRuleDto[];
}

export function ChannelProjectOverview({
  overview,
  tasks,
  participants,
  currentUserId,
  artifactLibrary,
  onCreate,
  onCreateEdge,
  onDeleteEdge,
}: {
  overview: ChannelProjectOverviewDto | null;
  tasks: ProjectTaskOption[];
  participants: ProjectParticipantOption[];
  currentUserId?: string;
  artifactLibrary?: ProjectArtifactLibraryDto | null;
  onCreate: (draft: InitialProjectStageDraft) => Promise<string | null>;
  onCreateEdge?: (draft: ProjectStageEdgeDraft) => Promise<string | null>;
  onDeleteEdge?: (edgeId: string) => Promise<string | null>;
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
                <dt className="text-neutral-400">前置</dt>
                <dd data-testid={`stage-upstream-${stage.id}`} className="text-neutral-700">
                  {stage.upstreamStageIds.length === 0
                    ? '无'
                    : (
                      <>
                        {stage.upstreamStageIds.map((id) => stageName(id, overview)).join('、')}
                        <span className={stage.dependenciesSatisfied ? 'ml-1 text-emerald-600' : 'ml-1 text-orange-700'}>
                          {stage.dependenciesSatisfied ? '· 依赖已满足' : '· 依赖未满足'}
                        </span>
                      </>
                    )}
                </dd>
              </dl>
              {stage.missingRequiredInputs.length > 0 && (
                <div
                  data-testid={`stage-missing-inputs-${stage.id}`}
                  className="mt-2 rounded bg-orange-50 px-2 py-1 text-xs text-orange-700"
                >
                  缺少必需输入：{stage.missingRequiredInputs
                    .map((input) => `${input.label}（${input.kind === 'artifact' ? '产物' : '文档'}）`)
                    .join('、')}
                </div>
              )}
              {stage.blockingReasons.length > 0 && (
                <div
                  data-testid={`stage-blocking-${stage.id}`}
                  className="mt-2 flex items-center gap-1.5 rounded bg-orange-50 px-2 py-1 text-xs text-orange-700"
                >
                  <AlertCircle size={13} />
                  {dedupeLabels(stage.blockingReasons.map((reason) => blockingReasonLabel(reason.code))).join('；')}
                </div>
              )}
              {!stage.executionAllowed && (
                <div data-testid={`stage-execution-blocked-${stage.id}`} className="mt-1 text-[11px] font-medium text-orange-700">
                  依赖或必需输入未满足，暂不能启动执行
                </div>
              )}
              <div
                data-testid={`stage-advance-${stage.id}`}
                className="mt-2 rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[11px] text-neutral-600"
              >
                <div className="font-medium text-neutral-700">
                  PI 推进：{stageAdvanceLabel(stage.advance.kind)}
                  {!stage.advance.automatic && '（仅建议）'}
                </div>
                {stage.advance.reason && <div>等待原因：{stageAdvanceReasonLabel(stage.advance.reason)}</div>}
                {stage.advance.stableInputs.length > 0 && (
                  <div>稳定输入：{stage.advance.stableInputs
                    .map((input) => `${input.key} · ${input.kind === 'artifact_version' ? input.versionId : input.revisionId}`)
                    .join('、')}</div>
                )}
                {stage.advance.targetAgentId && (
                  <div>目标 Agent：{participantName(stage.advance.targetAgentId, participants)}</div>
                )}
                {!stage.advance.targetAgentId && stage.advance.candidateAgentIds.length > 0 && (
                  <div>候选 Agent：{stage.advance.candidateAgentIds
                    .map((id) => participantName(id, participants)).join('、')}</div>
                )}
              </div>
              <StageArtifactSummary stageId={stage.id} library={artifactLibrary} />
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
        <ProjectStageEdgeSection
          overview={overview}
          onCreateEdge={onCreateEdge}
          onDeleteEdge={onDeleteEdge}
        />
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

function StageArtifactSummary({
  stageId,
  library,
}: {
  stageId: string;
  library?: ProjectArtifactLibraryDto | null;
}) {
  const entries = (library?.collections ?? []).flatMap((collection) =>
    collection.versions
      .filter((version) => version.source.stageId === stageId)
      .map((version) => ({ collection, version })));
  if (entries.length === 0) return null;
  return (
    <details className="mt-2 text-xs text-neutral-500">
      <summary className="cursor-pointer">阶段产物（{entries.length}）</summary>
      <ul className="mt-1 space-y-1">
        {entries.map(({ collection, version }) => (
          <li key={version.id} className="rounded bg-neutral-50 px-2 py-1 text-[11px] text-neutral-700">
            {collection.name} · v{version.versionNumber} · {reviewStateLabel(version.reviewState)}
            {version.id === collection.currentVersionId ? ' · 当前版' : ''}
            {version.id === collection.finalVersionId ? ' · 最终版' : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

function reviewStateLabel(state: ProjectArtifactLibraryDto['collections'][number]['versions'][number]['reviewState']): string {
  if (state === 'approved') return '已通过';
  if (state === 'rejected') return '已拒绝';
  if (state === 'changes_requested') return '需修改';
  return '待审核';
}

/** #822 阶段依赖图：展示既有边并提供增删入口；归档频道只读。 */
function ProjectStageEdgeSection({
  overview,
  onCreateEdge,
  onDeleteEdge,
}: {
  overview: ChannelProjectOverviewDto;
  onCreateEdge?: (draft: ProjectStageEdgeDraft) => Promise<string | null>;
  onDeleteEdge?: (edgeId: string) => Promise<string | null>;
}) {
  const stages = overview.stages;
  const [upstreamStageId, setUpstreamStageId] = useState('');
  const [downstreamStageId, setDownstreamStageId] = useState('');
  const [semantics, setSemantics] = useState<'blocks_start' | 'provides_context'>('blocks_start');
  const [requiredInputs, setRequiredInputs] = useState<RequiredInputDraft[]>([
    { label: '', kind: 'artifact', sourceId: '', versionPolicy: 'final' },
  ]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!onCreateEdge || !upstreamStageId || !downstreamStageId) return;
    const rules = requiredInputs.filter((item) => item.label.trim());
    if (rules.some((item) => !item.sourceId.trim())) {
      setError('必需输入必须绑定明确的产物集合或文档包 ID');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const nextError = await onCreateEdge({
        upstreamStageId,
        downstreamStageId,
        semantics,
        requiredInputs: rules.map((rule, index) => ({
          key: `${rule.kind}-${index + 1}`,
          kind: rule.kind,
          label: rule.label.trim(),
          source: rule.kind === 'artifact'
            ? {
              kind: 'artifact_collection' as const,
              collectionId: rule.sourceId.trim(),
              versionPolicy: rule.versionPolicy,
            }
            : {
              kind: 'document_bundle' as const,
              bundleId: rule.sourceId.trim(),
            },
        })),
      });
      if (nextError) setError(nextError);
      else {
        setRequiredInputs([
          { label: '', kind: 'artifact', sourceId: '', versionPolicy: 'final' },
        ]);
      }
    } finally {
      setPending(false);
    }
  };

  const remove = async (edgeId: string) => {
    if (!onDeleteEdge) return;
    setPending(true);
    setError(null);
    try {
      const nextError = await onDeleteEdge(edgeId);
      if (nextError) setError(nextError);
    } finally {
      setPending(false);
    }
  };

  return (
    <div aria-label="阶段依赖" className="mt-3 border-t border-amber-200 pt-3">
      <h3 className="mb-2 text-xs font-semibold text-neutral-700">阶段依赖</h3>
      {overview.edges.length === 0
        ? <p data-testid="stage-edges-empty" className="text-xs text-neutral-500">尚未配置阶段依赖</p>
        : (
          <ul className="space-y-1">
            {overview.edges.map((edge) => (
              <li
                key={edge.id}
                data-testid={`stage-edge-${edge.id}`}
                className="flex items-center gap-2 text-xs text-neutral-700"
              >
                <span>
                  {stageName(edge.upstreamStageId, overview)} → {stageName(edge.downstreamStageId, overview)}
                </span>
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600">
                  {edge.semantics === 'blocks_start' ? '完成后可启动' : '仅作为上下文'}
                </span>
                {edge.requiredInputs.length > 0 && (
                  <span className="text-[11px] text-neutral-500">
                    必需输入：{edge.requiredInputs.map((rule) => rule.label).join('、')}
                  </span>
                )}
                {!overview.archived && onDeleteEdge && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => { void remove(edge.id); }}
                    className="ml-auto text-neutral-400 hover:text-red-600 disabled:opacity-50"
                    title="删除依赖"
                    aria-label={`删除依赖 ${edge.id}`}
                  >
                    <X size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      {overview.archived
        ? (
          <p data-testid="stage-edges-readonly" className="mt-2 text-[11px] text-neutral-500">
            频道已归档，依赖图只读
          </p>
        )
        : onCreateEdge && stages.length >= 2 && (
          <form onSubmit={submit} className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            <ProjectField label="前置阶段">
              <select
                aria-label="前置阶段"
                value={upstreamStageId}
                onChange={(event) => setUpstreamStageId(event.target.value)}
                className={inputClass}
              >
                <option value="">请选择</option>
                {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
              </select>
            </ProjectField>
            <ProjectField label="后续阶段">
              <select
                aria-label="后续阶段"
                value={downstreamStageId}
                onChange={(event) => setDownstreamStageId(event.target.value)}
                className={inputClass}
              >
                <option value="">请选择</option>
                {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
              </select>
            </ProjectField>
            <ProjectField label="项目语义">
              <select
                aria-label="项目语义"
                value={semantics}
                onChange={(event) => setSemantics(event.target.value === 'provides_context' ? 'provides_context' : 'blocks_start')}
                className={inputClass}
              >
                <option value="blocks_start">完成后才能启动后续阶段</option>
                <option value="provides_context">仅作为后续阶段上下文</option>
              </select>
            </ProjectField>
            <div className="grid gap-2 md:col-span-2 md:grid-cols-2 xl:col-span-4 xl:grid-cols-4">
              {requiredInputs.map((rule, index) => {
                const suffix = index === 0 ? '' : ` ${index + 1}`;
                const updateRule = (changes: Partial<RequiredInputDraft>) => {
                  setRequiredInputs((current) => current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, ...changes } : item));
                };
                return (
                  <div
                    key={index}
                    className="contents"
                    data-testid={`required-input-row-${index + 1}`}
                  >
                    <ProjectField label={`必需输入${suffix}（可留空）`}>
                      <input
                        aria-label={`必需输入${suffix}`}
                        value={rule.label}
                        onChange={(event) => updateRule({ label: event.target.value })}
                        className={inputClass}
                        placeholder="剧本终稿"
                      />
                    </ProjectField>
                    <ProjectField label={`必需输入类型${suffix}`}>
                      <select
                        aria-label={`必需输入类型${suffix}`}
                        value={rule.kind}
                        onChange={(event) => updateRule({
                          kind: event.target.value === 'document' ? 'document' : 'artifact',
                        })}
                        className={inputClass}
                      >
                        <option value="artifact">产物</option>
                        <option value="document">文档</option>
                      </select>
                    </ProjectField>
                    <ProjectField label={rule.kind === 'artifact' ? '产物集合 ID' : '文档包 ID'}>
                      <input
                        aria-label={`必需输入来源 ID${suffix}`}
                        value={rule.sourceId}
                        onChange={(event) => updateRule({ sourceId: event.target.value })}
                        className={inputClass}
                        placeholder={rule.kind === 'artifact' ? 'collection-id' : 'bundle-id'}
                      />
                    </ProjectField>
                    <div className="flex items-end gap-2">
                      {rule.kind === 'artifact' && (
                        <ProjectField label={`版本要求${suffix}`}>
                          <select
                            aria-label={`产物版本要求${suffix}`}
                            value={rule.versionPolicy}
                            onChange={(event) => updateRule({
                              versionPolicy: event.target.value === 'approved' ? 'approved' : 'final',
                            })}
                            className={inputClass}
                          >
                            <option value="final">必须是最终版</option>
                            <option value="approved">已通过即可（优先最终版）</option>
                          </select>
                        </ProjectField>
                      )}
                      {requiredInputs.length > 1 && (
                        <button
                          type="button"
                          aria-label={`删除必需输入${suffix || ' 1'}`}
                          onClick={() => setRequiredInputs((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index))}
                          className="h-9 shrink-0 text-xs text-neutral-500 hover:text-red-600"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => setRequiredInputs((current) => [...current, {
                  label: '',
                  kind: 'artifact',
                  sourceId: '',
                  versionPolicy: 'final',
                }])}
                className="h-8 justify-self-start text-xs text-neutral-600 hover:text-neutral-900"
              >
                添加必需输入
              </button>
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={pending || !upstreamStageId || !downstreamStageId}
                className="h-8 rounded-md bg-neutral-900 px-3 text-xs font-medium text-white disabled:opacity-50"
              >
                {pending ? '保存中...' : '添加依赖'}
              </button>
            </div>
          </form>
        )}
      {error && <p data-testid="stage-edge-error" className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const inputClass = 'h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-500';

interface RequiredInputDraft {
  readonly label: string;
  readonly kind: 'artifact' | 'document';
  readonly sourceId: string;
  readonly versionPolicy: 'final' | 'approved';
}

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

function stageName(stageId: string, overview: ChannelProjectOverviewDto): string {
  return overview.stages.find((stage) => stage.id === stageId)?.name ?? stageId;
}

function dedupeLabels(labels: string[]): string[] {
  return Array.from(new Set(labels));
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
  switch (code) {
    case 'task_not_started': return '绑定任务尚未开始';
    case 'dependency_incomplete': return '依赖任务尚未完成';
    case 'review_pending': return '等待审核结论';
    case 'review_rejected': return '审核未通过';
    case 'review_needs_human': return '需要人工确认';
    case 'stage_dependency_incomplete': return '前置阶段尚未完成';
    case 'stage_dependency_unaccepted': return '前置阶段产出未通过审核';
    case 'required_input_missing': return '缺少必需输入';
  }
}

function stageAdvanceLabel(kind: ChannelProjectOverviewDto['stages'][number]['advance']['kind']): string {
  if (kind === 'publish_offer') return '可发布 Agent Offer';
  if (kind === 'create_invocation') return 'Agent 已接受，可创建 Invocation';
  if (kind === 'suggest') return '建议推进';
  return '等待';
}

function stageAdvanceReasonLabel(
  reason: NonNullable<ChannelProjectOverviewDto['stages'][number]['advance']['reason']>,
): string {
  const labels: Record<typeof reason, string> = {
    channel_archived: '频道已归档',
    automation_unavailable: '自动推进暂不可用',
    task_not_pending: 'Task 当前状态不可推进',
    task_revision_stale: 'Task 或 Stage revision 已变化',
    execution_gate_blocked: '阶段依赖或审核门禁未满足',
    required_input_incomplete: '必需稳定输入不完整',
    stable_input_stale: '稳定输入 revision 已变化',
    no_eligible_agent: '没有通过公开能力匹配的 Agent',
    claim_stale: 'Agent claim 已失效',
    invocation_active: '当前 revision 已有活动 Invocation',
  };
  return labels[reason];
}
