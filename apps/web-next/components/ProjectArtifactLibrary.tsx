'use client';

import { CheckCircle2, ChevronDown, GitBranch, Layers, MessageSquare, Plus, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ProjectArtifactCollectionDto,
  ProjectArtifactLibraryDto,
  ProjectArtifactLineageRefDto,
  ProjectArtifactReviewBasisRefDto,
  ProjectArtifactReviewDecision,
  ProjectArtifactVersionDto,
  ProjectReferenceSelectionRequestDto,
} from '@agentbean/contracts';

export interface PromotableArtifactOption {
  id: string;
  filename: string;
  logicalPath?: string;
}

export interface ProjectArtifactStageOption {
  id: string;
  name: string;
}

export interface PromoteArtifactDraft {
  artifactId: string;
  stageId: string;
  collectionId?: string;
  expectedCollectionRevision?: number;
  collection?: { name: string; kind: string };
  lineage?: ProjectArtifactLineageRefDto[];
}

export interface SubmitArtifactReviewDraft {
  versionId: string;
  decision: ProjectArtifactReviewDecision;
  comment: string;
  basis: ProjectArtifactReviewBasisRefDto[];
}

export interface SetArtifactFinalVersionDraft {
  collectionId: string;
  versionId: string;
  expectedCollectionRevision: number;
  reason?: string;
}

/**
 * #823 文件库的逻辑产物视图：按集合展示当前版、历史版本、来源与 lineage。
 * 普通文件视图由调用方保留，本组件只负责项目产物语义。
 */
export function ProjectArtifactLibrary({
  library,
  stages,
  promotableArtifacts,
  canPromote,
  canDecideVersion,
  onPromote,
  referenceSelections = [],
  onReferenceSelection,
  onReview,
  onFinalize,
  onReviseVersion,
}: {
  library: ProjectArtifactLibraryDto | null;
  stages: ProjectArtifactStageOption[];
  promotableArtifacts: PromotableArtifactOption[];
  canPromote: boolean;
  canDecideVersion?: (version: ProjectArtifactVersionDto) => boolean;
  onPromote: (draft: PromoteArtifactDraft) => Promise<string | null>;
  referenceSelections?: readonly ProjectReferenceSelectionRequestDto[];
  onReferenceSelection?: (selection: ProjectReferenceSelectionRequestDto | null, versionId: string) => void;
  onReview?: (draft: SubmitArtifactReviewDraft) => Promise<string | null>;
  onFinalize?: (draft: SetArtifactFinalVersionDraft) => Promise<string | null>;
  /** #1062 AC1:对被拒绝/要求修改的 Markdown 版本发起「基于此修改」(冻结 sourceVersion/basis)。 */
  onReviseVersion?: (request: {
    collectionId: string;
    collectionName: string;
    filename: string;
    baseVersionId: string;
    sourceVersionId: string;
    basisReviewId?: string;
    collectionRevision: number;
  }) => void;
}) {
  const [showPromote, setShowPromote] = useState(false);
  const collections = library?.collections ?? [];
  const archived = library?.archived ?? false;
  const canOpenPromote = canPromote && !archived && stages.length > 0;
  const promotable = canOpenPromote && promotableArtifacts.length > 0;

  return (
    <div data-smoke="project-artifact-library" className="min-h-0 flex-1 overflow-y-auto bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <Layers size={14} className="text-neutral-400" />
        <h2 className="text-sm font-semibold text-neutral-900">逻辑产物</h2>
        {archived && (
          <span className="rounded bg-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
            已归档 · 只读
          </span>
        )}
        {promotable && !showPromote && (
          <button
            type="button"
            onClick={() => setShowPromote(true)}
            className="ml-auto flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-900"
          >
            <Plus size={13} />
            提升为逻辑产物版本
          </button>
        )}
        {canOpenPromote && promotableArtifacts.length === 0 && (
          <span className="ml-auto text-xs text-neutral-500">
            先在文件视图中打开目标文件所在目录，再回到这里提升
          </span>
        )}
      </div>

      {showPromote && promotable && (
        <PromoteArtifactForm
          stages={stages}
          promotableArtifacts={promotableArtifacts}
          collections={collections}
          onCancel={() => setShowPromote(false)}
          onPromote={onPromote}
        />
      )}

      {collections.length === 0 ? (
        <div className="flex h-32 flex-col items-center justify-center gap-2 text-neutral-400">
          <Layers size={28} strokeWidth={1.5} />
          <span className="text-sm">暂无逻辑产物</span>
        </div>
      ) : (
        <div className="space-y-2">
          {collections.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              referenceSelections={referenceSelections}
              onReferenceSelection={onReferenceSelection}
              canDecideVersion={archived ? undefined : canDecideVersion}
              onReview={onReview}
              onFinalize={onFinalize}
              onReviseVersion={archived ? undefined : onReviseVersion}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CollectionCard({
  collection,
  referenceSelections,
  onReferenceSelection,
  canDecideVersion,
  onReview,
  onFinalize,
  onReviseVersion,
}: {
  collection: ProjectArtifactCollectionDto;
  canDecideVersion?: (version: ProjectArtifactVersionDto) => boolean;
  onReview?: (draft: SubmitArtifactReviewDraft) => Promise<string | null>;
  onFinalize?: (draft: SetArtifactFinalVersionDraft) => Promise<string | null>;
  onReviseVersion?: (request: {
    collectionId: string;
    collectionName: string;
    filename: string;
    baseVersionId: string;
    sourceVersionId: string;
    basisReviewId?: string;
    collectionRevision: number;
  }) => void;
  referenceSelections: readonly ProjectReferenceSelectionRequestDto[];
  onReferenceSelection?: (selection: ProjectReferenceSelectionRequestDto | null, versionId: string) => void;
}) {
  const currentVersion = collection.versions.find((version) => version.id === collection.currentVersionId);
  // 历史版本列表包含 current:VersionDecisionPanel(审核/最终化)只在历史行渲染,
  // 过滤会破坏「current 版本也能审核」的既有能力。
  const history = [...collection.versions].sort((left, right) => right.versionNumber - left.versionNumber);
  // #1062:被拒绝/要求修改的 Markdown 版本可「基于此修改」(reviewState 与 reviews 是 Server 事实)。
  const canRevise = (version: ProjectArtifactVersionDto): boolean => {
    if (!onReviseVersion) return false;
    if (version.reviewState !== 'rejected' && version.reviewState !== 'changes_requested') return false;
    if (!/\.(?:md|markdown)$/i.test(version.artifact.filename)) return false;
    return version.reviews.length > 0;
  };
  const reviseBasis = (version: ProjectArtifactVersionDto): string | undefined => {
    const latest = version.reviews.at(-1);
    return (latest?.decision === 'rejected' || latest?.decision === 'changes_requested')
      ? latest.id
      : undefined;
  };
  const reviseRequest = (version: ProjectArtifactVersionDto) => onReviseVersion?.({
    collectionId: collection.id,
    collectionName: collection.name,
    filename: version.artifact.filename,
    baseVersionId: version.id,
    sourceVersionId: version.id,
    ...(reviseBasis(version) ? { basisReviewId: reviseBasis(version) } : {}),
    collectionRevision: collection.revision,
  });
  return (
    <article
      data-smoke="project-artifact-collection"
      data-collection-id={collection.id}
      className="border border-neutral-300 bg-white p-3"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-neutral-900">{collection.name}</div>
          <div className="mt-0.5 text-xs text-neutral-500">类型：{collection.kind}</div>
        </div>
        <span className="text-[11px] font-medium text-neutral-500">共 {collection.versions.length} 版</span>
      </div>
      {currentVersion && (
        <div data-smoke="project-artifact-current-version" className="mt-2 border border-amber-200 bg-amber-50/70 p-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded bg-amber-200 px-1.5 py-0.5 font-medium text-amber-900">当前版</span>
            <span className="font-medium text-neutral-900">v{currentVersion.versionNumber}</span>
            <span className="truncate text-neutral-600">{currentVersion.artifact.filename}</span>
            <ReviewStateBadge state={currentVersion.reviewState} />
            {currentVersion.id === collection.finalVersionId && (
              <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white">最终版</span>
            )}
            {/* #1065 AC5：本版本属于哪些交付包(Server 投影,区分交付包与逻辑产物身份)。 */}
            {(currentVersion.packageMemberships?.length ?? 0) > 0 && (
              <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-800" data-smoke="package-membership">
                交付包 {currentVersion.packageMemberships!.map((membership) => membership.shortLabel).join('、')}
              </span>
            )}
          </div>
          <VersionSource version={currentVersion} />
          {canRevise(currentVersion) && (
            <button
              type="button"
              data-smoke="project-artifact-revise-version"
              onClick={() => reviseRequest(currentVersion)}
              className="mt-1 border border-neutral-300 bg-white px-2 py-0.5 text-[10px] font-medium text-neutral-600 hover:border-neutral-900"
            >
              基于此修改
            </button>
          )}
        </div>
      )}
      <details className="mt-2 text-xs text-neutral-500">
        <summary className="flex cursor-pointer list-none items-center gap-1">
          <ChevronDown size={12} />
          历史版本（{collection.versions.length}）
        </summary>
        <ul className="mt-1 space-y-2">
          {history.map((version) => (
            <li
              key={version.id}
              data-smoke="project-artifact-version"
              data-version-id={version.id}
              className="border border-neutral-200 p-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-neutral-800">v{version.versionNumber}</span>
                <span className="truncate text-neutral-600">{version.artifact.filename}</span>
                {version.id === collection.currentVersionId && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">当前</span>
                )}
                {(version.packageMemberships?.length ?? 0) > 0 && (
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-800" data-smoke="package-membership">
                    交付包 {version.packageMemberships!.map((membership) => membership.shortLabel).join('、')}
                  </span>
                )}
                {onReferenceSelection && (
                  <button
                    type="button"
                    data-smoke="project-reference-artifact-version"
                    onClick={() => {
                      const selected = referenceSelections.some((selection) =>
                        selection.kind === 'artifact_version' && selection.versionId === version.id);
                      onReferenceSelection(selected
                        ? null
                        : {
                          kind: 'artifact_version',
                          collectionId: collection.id,
                          versionId: version.id,
                        }, version.id);
                    }}
                    className="ml-auto border border-neutral-300 bg-white px-2 py-0.5 text-[10px] font-medium text-neutral-600 hover:border-neutral-900"
                  >
                    {referenceSelections.some((selection) =>
                      selection.kind === 'artifact_version' && selection.versionId === version.id)
                      ? '已引用'
                      : '引用此版'}
                    </button>
                )}
                {version.id === collection.finalVersionId && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800">最终</span>
                )}
                <ReviewStateBadge state={version.reviewState} />
                {canRevise(version) && (
                  <button
                    type="button"
                    data-smoke="project-artifact-revise-version"
                    onClick={() => reviseRequest(version)}
                    className="border border-neutral-300 bg-white px-2 py-0.5 text-[10px] font-medium text-neutral-600 hover:border-neutral-900"
                  >
                    基于此修改
                  </button>
                )}
              </div>
              <VersionSource version={version} />
              <VersionDecisionPanel
                version={version}
                collection={collection}
                canDecide={Boolean(canDecideVersion?.(version))}
                onReview={onReview}
                onFinalize={onFinalize}
              />
            </li>
          ))}
        </ul>
      </details>
      <FinalizationHistory collection={collection} />
    </article>
  );
}

function ReviewStateBadge({ state }: { state: ProjectArtifactVersionDto['reviewState'] }) {
  const label = state === 'pending'
    ? '待审核'
    : state === 'approved'
      ? '已通过'
      : state === 'rejected'
        ? '已拒绝'
        : '需修改';
  const color = state === 'approved'
    ? 'bg-emerald-100 text-emerald-800'
    : state === 'rejected'
      ? 'bg-red-100 text-red-700'
      : state === 'changes_requested'
        ? 'bg-orange-100 text-orange-700'
        : 'bg-neutral-100 text-neutral-600';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${color}`}>{label}</span>;
}

/**
 * 版本审核/最终化面板:审核历史 + 追加审核表单 + 设为最终版。
 * 从 CollectionCard 抽出导出,供文件库新布局(ProjectFilesBoard 行展开区)复用。
 */
export function VersionDecisionPanel({
  version,
  collection,
  canDecide,
  onReview,
  onFinalize,
}: {
  version: ProjectArtifactVersionDto;
  collection: ProjectArtifactCollectionDto;
  canDecide: boolean;
  onReview?: (draft: SubmitArtifactReviewDraft) => Promise<string | null>;
  onFinalize?: (draft: SetArtifactFinalVersionDraft) => Promise<string | null>;
}) {
  const [showReview, setShowReview] = useState(false);
  const [decision, setDecision] = useState<ProjectArtifactReviewDecision>('approved');
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitReview = async (event: FormEvent) => {
    event.preventDefault();
    if (!onReview || !comment.trim()) return;
    setPending(true);
    setError(null);
    try {
      const nextError = await onReview({
        versionId: version.id,
        decision,
        comment: comment.trim(),
        basis: [{ kind: 'artifact', refId: version.artifact.id }],
      });
      if (nextError) setError(nextError);
      else {
        setComment('');
        setShowReview(false);
      }
    } finally {
      setPending(false);
    }
  };

  const finalize = async () => {
    if (!onFinalize) return;
    setPending(true);
    setError(null);
    try {
      const nextError = await onFinalize({
        collectionId: collection.id,
        versionId: version.id,
        expectedCollectionRevision: collection.revision,
        reason: '从项目文件库确认最终版',
      });
      if (nextError) setError(nextError);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-2 border-t border-neutral-100 pt-2">
      {version.reviews.length > 0 && (
        <details className="text-[11px] text-neutral-600">
          <summary className="cursor-pointer">审核历史（{version.reviews.length}）</summary>
          <ul className="mt-1 space-y-1">
            {version.reviews.map((review) => (
              <li key={review.id} className="rounded bg-neutral-50 px-2 py-1">
                <span className="font-medium">{reviewDecisionLabel(review.decision)}</span>
                <span> · {review.comment}</span>
                <span className="ml-1 text-neutral-400">由 {review.reviewedBy}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {canDecide && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onReview && (
            <button
              type="button"
              onClick={() => setShowReview((visible) => !visible)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 hover:text-amber-900"
            >
              <MessageSquare size={11} />
              追加审核
            </button>
          )}
          {onFinalize && version.reviewState === 'approved' && version.id !== collection.finalVersionId && (
            <button
              type="button"
              disabled={pending}
              onClick={() => { void finalize(); }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-900 disabled:opacity-50"
            >
              <CheckCircle2 size={11} />
              设为最终版
            </button>
          )}
        </div>
      )}
      {showReview && (
        <form onSubmit={submitReview} className="mt-2 grid gap-2 rounded bg-amber-50 p-2">
          <label className="text-[11px] text-neutral-600">
            审核决定
            <select
              aria-label={`审核决定 v${version.versionNumber}`}
              value={decision}
              onChange={(event) => setDecision(event.target.value as ProjectArtifactReviewDecision)}
              className={`${inputClass} mt-1`}
            >
              <option value="approved">通过</option>
              <option value="rejected">拒绝</option>
              <option value="changes_requested">要求修改</option>
            </select>
          </label>
          <label className="text-[11px] text-neutral-600">
            审核意见
            <textarea
              aria-label={`审核意见 v${version.versionNumber}`}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              className={`${inputClass} mt-1 min-h-16 py-2`}
            />
          </label>
          <button
            type="submit"
            disabled={pending || !comment.trim()}
            className="h-8 justify-self-start rounded bg-neutral-900 px-3 text-[11px] font-medium text-white disabled:opacity-50"
          >
            {pending ? '提交中...' : '提交审核'}
          </button>
        </form>
      )}
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

/** 最终版切换审计(append-only);导出供文件库新布局复用。 */
export function FinalizationHistory({ collection }: { collection: ProjectArtifactCollectionDto }) {
  if (collection.finalizations.length === 0) return null;
  return (
    <details className="mt-2 border-t border-neutral-100 pt-2 text-[11px] text-neutral-600">
      <summary className="cursor-pointer">最终版切换记录（{collection.finalizations.length}）</summary>
      <ul className="mt-1 space-y-1">
        {collection.finalizations.map((record) => (
          <li key={record.id} className="rounded bg-emerald-50 px-2 py-1">
            {record.previousVersionId ? `${record.previousVersionId} → ` : '首次设置：'}
            {record.versionId}
            <span className="ml-1 text-neutral-400">由 {record.finalizedBy}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function reviewDecisionLabel(decision: ProjectArtifactReviewDecision): string {
  if (decision === 'approved') return '通过';
  if (decision === 'rejected') return '拒绝';
  return '要求修改';
}

function VersionSource({ version }: { version: ProjectArtifactVersionDto }) {
  return (
    <dl className="mt-1.5 grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
      <dt className="text-neutral-400">阶段</dt>
      <dd className="truncate text-neutral-700">{version.source.stageId}</dd>
      <dt className="text-neutral-400">任务</dt>
      <dd className="truncate text-neutral-700">
        {version.source.taskId}（revision {version.source.taskRevision}）
      </dd>
      {version.source.messageId && (
        <>
          <dt className="text-neutral-400">消息</dt>
          <dd className="truncate text-neutral-700">{version.source.messageId}</dd>
        </>
      )}
      {version.source.workspaceRunId && (
        <>
          <dt className="text-neutral-400">运行</dt>
          <dd className="truncate text-neutral-700">{version.source.workspaceRunId}</dd>
        </>
      )}
      {version.source.invocationId && (
        <>
          <dt className="text-neutral-400">Invocation</dt>
          <dd className="truncate text-neutral-700">{version.source.invocationId}</dd>
        </>
      )}
      {version.lineage.length > 0 && (
        <>
          <dt className="text-neutral-400">lineage</dt>
          <dd data-smoke="project-artifact-lineage" className="text-neutral-700">
            <span className="inline-flex items-center gap-1">
              <GitBranch size={11} />
              {version.lineage.map((ref) => `${lineageKindLabel(ref.kind)}:${ref.refId}`).join('、')}
            </span>
          </dd>
        </>
      )}
    </dl>
  );
}

/** 提升为逻辑产物版本表单(project-lead 限定入口);导出供文件库新布局复用。 */
export function PromoteArtifactForm({
  stages,
  promotableArtifacts,
  collections,
  onCancel,
  onPromote,
}: {
  stages: readonly ProjectArtifactStageOption[];
  promotableArtifacts: readonly PromotableArtifactOption[];
  collections: readonly ProjectArtifactCollectionDto[];
  onCancel: () => void;
  onPromote: (draft: PromoteArtifactDraft) => Promise<string | null>;
}) {
  const [artifactId, setArtifactId] = useState(promotableArtifacts[0]?.id ?? '');
  const [stageId, setStageId] = useState(stages[0]?.id ?? '');
  const [collectionId, setCollectionId] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetCollection = collections.find((collection) => collection.id === collectionId);

  useEffect(() => {
    if (!artifactId && promotableArtifacts[0]) setArtifactId(promotableArtifacts[0].id);
  }, [artifactId, promotableArtifacts]);

  useEffect(() => {
    if (!stageId && stages[0]) setStageId(stages[0].id);
  }, [stageId, stages]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!artifactId || !stageId) return;
    if (!targetCollection && (!name.trim() || !kind.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const nextError = await onPromote({
        artifactId,
        stageId,
        ...(targetCollection
          ? {
            collectionId: targetCollection.id,
            expectedCollectionRevision: targetCollection.revision,
            // 追加版本时默认把当前版记入 lineage；Server 只记录客户端显式提交的来源。
            lineage: [{ kind: 'project_version', refId: targetCollection.currentVersionId }],
          }
          : { collection: { name: name.trim(), kind: kind.trim() } }),
      });
      if (nextError) {
        setError(nextError);
        return;
      }
      onCancel();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-3 border border-amber-200 bg-amber-50/60 p-3">
      <div className="mb-3 flex items-center">
        <h3 className="text-sm font-semibold text-neutral-900">提升为逻辑产物版本</h3>
        <button type="button" onClick={onCancel} className="ml-auto text-neutral-400 hover:text-neutral-700" title="取消">
          <X size={15} />
        </button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <PromoteField label="选择文件">
          <select value={artifactId} onChange={(event) => setArtifactId(event.target.value)} className={inputClass}>
            {promotableArtifacts.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>
                {artifact.logicalPath ?? artifact.filename}
              </option>
            ))}
          </select>
        </PromoteField>
        <PromoteField label="所属阶段">
          <select value={stageId} onChange={(event) => setStageId(event.target.value)} className={inputClass}>
            {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
          </select>
        </PromoteField>
        <PromoteField label="目标产物集合">
          <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)} className={inputClass}>
            <option value="">新建逻辑产物</option>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>{collection.name}</option>
            ))}
          </select>
        </PromoteField>
        {!targetCollection && (
          <>
            <PromoteField label="逻辑产物名称">
              <input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} placeholder="例如：分镜脚本" />
            </PromoteField>
            <PromoteField label="逻辑产物类型">
              <input value={kind} onChange={(event) => setKind(event.target.value)} className={inputClass} placeholder="例如：storyboard" />
            </PromoteField>
          </>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={saving}
        className="mt-3 h-8 rounded-md bg-neutral-900 px-3 text-xs font-medium text-white disabled:opacity-50"
      >
        {saving ? '提升中...' : '提升为版本'}
      </button>
    </form>
  );
}

const inputClass = 'h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-500';

function PromoteField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function lineageKindLabel(kind: ProjectArtifactLineageRefDto['kind']): string {
  return kind === 'project_version' ? '版本' : '输入文件';
}
