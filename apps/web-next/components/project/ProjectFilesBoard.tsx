'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckSquare, Clock, Layers, Search, Square } from 'lucide-react';
import { projectEvents } from '@/lib/socket';
import {
  buildFileGroupCards,
  filterFileGroupCards,
  packageProjectionSummaryLines,
  withAgentNames,
  withPackageFinalStates,
  type FileGroupCardModel,
  type FileGroupFilterKind,
  type FileGroupStageInput,
} from '@/lib/file-group-model';
import {
  buildPackageMembersSelection,
  buildPackageProjectionSelection,
  loadPackageProjection,
  type PackageProjectionBlocker,
  type PackageProjectionPolicy,
} from '@/lib/output-package-reference';
import { reviewStateLabel } from '@/lib/delivery-labels';
import {
  FinalizationHistory,
  PromoteArtifactForm,
  VersionDecisionPanel,
  type PromotableArtifactOption,
  type PromoteArtifactDraft,
  type SetArtifactFinalVersionDraft,
  type SubmitArtifactReviewDraft,
} from '@/components/ProjectArtifactLibrary';
import type { ReviseVersionRequest } from '@/components/OutputPackageCard';
import type { OutputPackageMeta } from '@/lib/output-package';
import type {
  ArtifactDto,
  OutputPackageDto,
  OutputPackagePendingDeliveryDto,
  OutputPackageSummaryDto,
  PackageMemberAvailableActionsDto,
  ProjectArtifactLibraryDto,
  ProjectReferenceSelectionRequestDto,
  ProjectArtifactVersionDto,
  OutputPackageProjectionResultV1,
} from '@agentbean/contracts';

/**
 * 文件库「逻辑产物」视图(原型对齐,design.md 组件结构)。
 *
 * 左栏 FileGroupRail:输出包/文件集合/等待上游三类卡片混排(FileGroupCardModel,
 * 最近活跃倒序,等待上游排尾);右栏 FileVersionTable:七列文件表(§8.7)。
 * 工具栏:搜索 + 筛选 chip + 整包引用三入口(引用当前包/引用最终版包/多选引用)。
 *
 * 数据原则:
 * - 卡片模型来自 lib/file-group-model(纯函数);包短编号摘要与「有 final」来自
 *   getOutputPackage projection current 懒加载(Map 缓存,dataRevision 失效);
 * - 整包引用走 lib/output-package-reference(与讨论串卡片同一实现):ready →
 *   package_projection 选择(带 expectedMemberRevisions fence);not_ready → blockers;
 * - 引用全部经 onAddReference 进主 composer,发送时冻结 ProjectReferenceSet。
 *
 * 行内动作(本组件已接入):
 * - 审核/设最终版:集合版本行「详情」展开区复用 ProjectArtifactLibrary 的
 *   VersionDecisionPanel + FinalizationHistory(canDecideVersion/onReview/onFinalize);
 * - 预览/编辑:Markdown 集合行 → onOpenRevisionEditor(saveArtifactVersionRevision
 *   冲突流,basis 只传 sourceVersionId,遵循 #1131);包成员行 → onOpenPackagePreview;
 *   非 Markdown 集合行 → onOpenReadOnlyArtifact(ArtifactViewer 只读);
 * - 基于此修改:被拒/需修改行 → onOpenRevisionEditor,包行 basisReviewId 来自
 *   availableActions.latestReviewId,集合行来自最新审核记录(#1062,不从历史猜);
 * - 提升为逻辑产物版本:工具栏按钮(canPromote=project-lead)复用 PromoteArtifactForm。
 */

const FILTER_OPTIONS: { value: FileGroupFilterKind; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending_review', label: '待审核' },
  { value: 'has_final', label: '有 final' },
  { value: 'agent_output', label: 'Agent 输出' },
];

/** 包详情缓存:getOutputPackage(projection current) 一次调用取 package+availableActions+projection。 */
interface PackageDetailCache {
  package?: OutputPackageDto;
  availableActions: PackageMemberAvailableActionsDto[];
  projection: OutputPackageProjectionResultV1 | null;
}

export interface ProjectFilesBoardProps {
  channelId: string;
  packages: readonly OutputPackageSummaryDto[];
  pendingDeliveries: readonly OutputPackagePendingDeliveryDto[];
  library: ProjectArtifactLibraryDto | null;
  stages: readonly FileGroupStageInput[];
  /** agentId → 显示名(来源列与搜索)。 */
  agentNames: ReadonlyMap<string, string>;
  /** 缓存失效令牌:onArtifactsUpdated / packages 刷新时由调用方 +1。 */
  dataRevision: number;
  /** 引用加入主 composer(发送时冻结 ProjectReferenceSet;去重语义由调用方决定)。 */
  onAddReference: (selection: ProjectReferenceSelectionRequestDto) => void;
  /**
   * 集合版本行「预览/编辑」(Markdown)与「基于此修改」→ page.tsx 的
   * openArtifactRevisionEditor 流(带 expectedCollectionRevision fence;不复制逻辑)。
   * 未提供时不渲染对应入口。
   */
  onOpenRevisionEditor?: (request: ReviseVersionRequest) => void;
  /** 包成员行「预览/编辑」→ OutputPackagePreviewModal 浮窗(内部含 Markdown 冲突流与图片只读)。 */
  onOpenPackagePreview?: (packageMeta: OutputPackageMeta, versionId?: string) => void;
  /** 集合非 Markdown 版本行「查看」→ ArtifactViewer 只读。 */
  onOpenReadOnlyArtifact?: (artifact: ArtifactDto) => void;
  /** 版本审核/最终化权限判定(与旧 ProjectArtifactLibrary 同一回调)。 */
  canDecideVersion?: (version: ProjectArtifactVersionDto) => boolean;
  onReview?: (draft: SubmitArtifactReviewDraft) => Promise<string | null>;
  onFinalize?: (draft: SetArtifactFinalVersionDraft) => Promise<string | null>;
  /** 提升为逻辑产物版本(project-lead 限定;复用 PromoteArtifactForm)。 */
  canPromote: boolean;
  promotableArtifacts: readonly PromotableArtifactOption[];
  onPromote: (draft: PromoteArtifactDraft) => Promise<string | null>;
}

interface FileTableRow {
  rowId: string;
  versionId: string;
  filename: string;
  collectionId: string;
  collectionName: string;
  collectionKind: string;
  stageName: string;
  sourcePrimary: string;
  sourceSub: string;
  currentLabel: string;
  currentSub: string;
  finalLabel: string;
  isFinal: boolean;
  reviewLabel: string;
  reviewState: string;
  isCurrent: boolean;
  /** 集合当前 revision(修订编辑器 fence;包成员行取投影解析值)。 */
  collectionRevision: number;
  isMarkdown: boolean;
  /** 被拒绝/需修改且有审核记录 → 可「基于此修改」。 */
  canRevise: boolean;
  /** 基于此修改的审核依据(latestReviewId:包行来自 availableActions,集合行来自最新审核记录)。 */
  basisReviewId?: string;
  /** 包行:交付 identity(修订 provenance 冻结)。 */
  deliveryId?: string;
  /** 集合行:只读预览用。 */
  artifact?: ArtifactDto;
}

export function ProjectFilesBoard({
  channelId,
  packages,
  pendingDeliveries,
  library,
  stages,
  agentNames,
  dataRevision,
  onAddReference,
  onOpenRevisionEditor,
  onOpenPackagePreview,
  onOpenReadOnlyArtifact,
  canDecideVersion,
  onReview,
  onFinalize,
  canPromote,
  promotableArtifacts,
  onPromote,
}: ProjectFilesBoardProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FileGroupFilterKind>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedVersionIds, setSelectedVersionIds] = useState<Set<string>>(new Set());
  const [refBusy, setRefBusy] = useState(false);
  const [blockers, setBlockers] = useState<PackageProjectionBlocker[]>([]);
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null);
  const [showPromote, setShowPromote] = useState(false);
  const [packageDetailCache, setPackageDetailCache] = useState<ReadonlyMap<string, PackageDetailCache>>(new Map());
  const [packageFinalReadyCache, setPackageFinalReadyCache] = useState<ReadonlyMap<string, boolean>>(new Map());
  const archived = library?.archived ?? false;

  const stageNameById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage.name])), [stages]);

  // 懒加载每包 detail(projection current):短编号摘要 + 右侧表格数据源。
  // packages 引用变化 / dataRevision 递增(onArtifactsUpdated)时整缓存失效重建。
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    setPackageDetailCache(new Map());
    setPackageFinalReadyCache(new Map());
    for (const pkg of packages) {
      void projectEvents()
        .getOutputPackage({ channelId, packageId: pkg.packageId, projection: { policy: 'current' } })
        .then((result) => {
          if (cancelled) return;
          setPackageDetailCache((current) => {
            const next = new Map(current);
            // 失败也写缓存(空条目):让 packageLoading 收敛,避免投影失败时右栏永远转圈。
            if (result.ok) {
              next.set(pkg.packageId, {
                package: result.package,
                availableActions: result.availableActions ?? [],
                projection: result.projection ?? null,
              });
            } else {
              next.set(pkg.packageId, { availableActions: [], projection: null });
            }
            return next;
          });
        });
    }
    return () => { cancelled = true; };
  }, [channelId, packages, dataRevision]);

  // 「有 final」必须按 final projection 是否 ready 判断。current 成员即使不等于 final，
  // 或 current 因审核态不可作为正式输入，已经冻结的 final projection 仍可能完整可用。
  useEffect(() => {
    if (!channelId || filter !== 'has_final') return;
    let cancelled = false;
    setPackageFinalReadyCache(new Map());
    for (const pkg of packages) {
      void projectEvents()
        .getOutputPackage({ channelId, packageId: pkg.packageId, projection: { policy: 'final' } })
        .then((result) => {
          if (cancelled || !result.ok || !result.projection) return;
          setPackageFinalReadyCache((current) => {
            const next = new Map(current);
            next.set(pkg.packageId, result.projection!.status === 'ready');
            return next;
          });
        });
    }
    return () => { cancelled = true; };
  }, [channelId, packages, dataRevision, filter]);

  // 卡片模型:聚合 → Agent 名入搜索池 → 「有 final」(final projection ready)→
  // 短编号版本摘要(来自缓存投影)→ 筛选/搜索。
  const displayCards = useMemo(() => {
    let cards = buildFileGroupCards({ packages, pendingDeliveries, library, stages });
    cards = withAgentNames(cards, agentNames);
    cards = withPackageFinalStates(cards, packageFinalReadyCache);
    return cards.map((card) => {
      if (card.kind === 'package' && card.payload.kind === 'package') {
        const detail = packageDetailCache.get(card.payload.package.packageId);
        if (detail?.projection?.status === 'ready') {
          return { ...card, summaryLines: packageProjectionSummaryLines(detail.projection.members) };
        }
      }
      return card;
    });
  }, [packages, pendingDeliveries, library, stages, agentNames, packageDetailCache, packageFinalReadyCache]);

  const filteredCards = useMemo(
    () => filterFileGroupCards(displayCards, filter, search),
    [displayCards, filter, search],
  );

  // 选中卡:显式选中优先;未选中/被筛选掉时回落列表首卡(首帧即有右侧内容)。
  const selectedCard = filteredCards.find((card) => card.id === selectedId) ?? filteredCards[0] ?? null;
  const selectedPackageId = selectedCard?.kind === 'package' && selectedCard.payload.kind === 'package'
    ? selectedCard.payload.package.packageId
    : null;

  const currentRows = useMemo((): FileTableRow[] => {
    if (!selectedCard) return [];
    if (selectedCard.kind === 'package' && selectedCard.payload.kind === 'package') {
      const detail = packageDetailCache.get(selectedCard.payload.package.packageId);
      if (!detail?.projection) return [];
      return packageProjectionRows(detail, library, stageNameById, agentNames);
    }
    if (selectedCard.kind === 'collection' && selectedCard.payload.kind === 'collection') {
      return collectionVersionRows(selectedCard.payload.collection, stageNameById);
    }
    return [];
  }, [selectedCard, packageDetailCache, library, stageNameById, agentNames]);

  const packageLoading = selectedCard?.kind === 'package'
    && selectedCard.payload.kind === 'package'
    && packageDetailCache.get(selectedCard.payload.package.packageId) === undefined;
  const packageProjectionBlocked = selectedCard?.kind === 'package'
    && selectedCard.payload.kind === 'package'
    && packageDetailCache.get(selectedCard.payload.package.packageId)?.projection?.status === 'not_ready';

  // 整包引用:预览 ready → 选择;not_ready → 阻断清单(与 OutputPackageCard 同实现)。
  const addProjectionReference = useCallback(async (policy: PackageProjectionPolicy) => {
    if (!channelId || !selectedPackageId) return;
    setRefBusy(true);
    setBlockers([]);
    try {
      const projection = await loadPackageProjection(channelId, selectedPackageId, policy);
      if (!projection) return;
      const built = buildPackageProjectionSelection(selectedPackageId, policy, projection);
      if (built.selection) onAddReference(built.selection);
      else setBlockers(built.blockers);
    } finally {
      setRefBusy(false);
    }
  }, [channelId, selectedPackageId, onAddReference]);

  const toggleMultiSelect = useCallback(() => {
    setBlockers([]);
    setSelectedVersionIds(new Set());
    setMultiSelect((current) => !current);
  }, []);

  const toggleRowSelection = useCallback((versionId: string) => {
    setSelectedVersionIds((current) => {
      const next = new Set(current);
      if (next.has(versionId)) next.delete(versionId);
      else next.add(versionId);
      return next;
    });
  }, []);

  const confirmMultiSelect = useCallback(() => {
    if (!selectedPackageId || multiSelect === false) return;
    const members = currentRows
      .filter((row) => selectedVersionIds.has(row.rowId))
      .map((row) => ({ collectionId: row.collectionId, versionId: row.versionId }));
    const selection = buildPackageMembersSelection(selectedPackageId, members);
    if (!selection) return;
    onAddReference(selection);
    setSelectedVersionIds(new Set());
    setMultiSelect(false);
  }, [selectedPackageId, multiSelect, currentRows, selectedVersionIds, onAddReference]);

  const addRowReference = useCallback((row: FileTableRow) => {
    if (!selectedCard) return;
    if (selectedCard.kind === 'package' && selectedCard.payload.kind === 'package') {
      const selection = buildPackageMembersSelection(
        selectedCard.payload.package.packageId,
        [{ collectionId: row.collectionId, versionId: row.versionId }],
      );
      if (selection) onAddReference(selection);
    } else if (selectedCard.kind === 'collection' && selectedCard.payload.kind === 'collection') {
      onAddReference({ kind: 'artifact_version', collectionId: row.collectionId, versionId: row.versionId });
    }
  }, [selectedCard, onAddReference]);

  const selectedWaitingStage = selectedCard?.kind === 'waiting' && selectedCard.payload.kind === 'waiting'
    ? selectedCard.payload.stage
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-smoke="project-files-board">
      {/* 工具栏:搜索 + 筛选 chip + 整包引用三入口(多选态切换为多选提交条)。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="按文件名、文件组、Agent 或版本搜索"
            className="h-8 w-full rounded-md border border-neutral-300 bg-white pl-7 pr-2 text-xs text-neutral-700 outline-none focus:border-neutral-500"
            data-smoke="files-toolbar-search"
          />
        </div>
        <div className="flex items-center gap-1" data-smoke="files-filter-chips">
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              className={`h-7 rounded-md px-2.5 text-xs font-medium ${filter === option.value
                ? 'bg-neutral-900 text-white'
                : 'border border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-100'}`}
              data-smoke="files-filter-chip"
              data-filter={option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
        {multiSelect && selectedPackageId ? (
          <div className="flex items-center gap-1.5" data-smoke="files-multi-select-bar">
            <span className="text-xs text-neutral-600">已选 {selectedVersionIds.size} 个文件</span>
            <button
              type="button"
              disabled={refBusy || selectedVersionIds.size === 0}
              onClick={() => { void confirmMultiSelect(); }}
              className="h-7 rounded-md border border-sky-300 bg-sky-50 px-2.5 text-xs font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50"
              data-smoke="files-multi-confirm"
            >
              引用所选
            </button>
            <button
              type="button"
              onClick={toggleMultiSelect}
              className="h-7 rounded-md border border-neutral-300 bg-white px-2.5 text-xs text-neutral-600 hover:bg-neutral-100"
              data-smoke="files-multi-cancel"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!selectedPackageId || refBusy}
              onClick={() => { void addProjectionReference('current'); }}
              className="h-7 rounded-md border border-sky-300 bg-white px-2.5 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50"
              data-smoke="files-ref-current"
            >
              引用当前包
            </button>
            <button
              type="button"
              disabled={!selectedPackageId || refBusy}
              onClick={() => { void addProjectionReference('final'); }}
              className="h-7 rounded-md border border-sky-300 bg-white px-2.5 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50"
              data-smoke="files-ref-final"
            >
              引用最终版包
            </button>
            <button
              type="button"
              disabled={!selectedPackageId}
              onClick={toggleMultiSelect}
              className="h-7 rounded-md border border-neutral-300 bg-white px-2.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
              data-smoke="files-ref-multi"
            >
              多选引用
            </button>
          </div>
        )}
        {/* 提升为逻辑产物版本(project-lead 限定;复用 PromoteArtifactForm)。 */}
        {canPromote && !archived && stages.length > 0 ? (
          promotableArtifacts.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowPromote((current) => !current)}
              className="h-7 rounded-md border border-amber-300 bg-amber-50 px-2.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
              data-smoke="files-promote-open"
            >
              提升为逻辑产物版本
            </button>
          ) : (
            <span className="text-[11px] text-neutral-400">先在文件视图中打开目标文件所在目录,再回到这里提升</span>
          )
        ) : null}
      </div>
      {showPromote && canPromote && !archived ? (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50/40 px-3 py-2" data-smoke="files-promote-form">
          <PromoteArtifactForm
            stages={stages}
            promotableArtifacts={promotableArtifacts}
            collections={library?.collections ?? []}
            onCancel={() => setShowPromote(false)}
            onPromote={onPromote}
          />
        </div>
      ) : null}
      {/* 整包引用阻断清单(final 缺失/被拒 current;与卡片同文案)。 */}
      {blockers.length > 0 ? (
        <ul
          className="shrink-0 space-y-1 border-b border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
          data-smoke="files-ref-blockers"
        >
          {blockers.map((blocker, index) => (
            <li key={`${blocker.shortLabel}-${index}`}>
              {blocker.shortLabel} {blocker.filename}:{blocker.code === 'missing_final' ? '尚未设置最终版'
                : blocker.code === 'current_not_formal' ? '当前版被拒绝/需修改,不能作为整包默认输入'
                  : blocker.code === 'collection_unavailable' ? '成员集合不可用'
                    : blocker.code === 'version_not_in_package' ? '版本不属于该文件包'
                      : '整包引用不可用'}
            </li>
          ))}
          <li className="text-amber-700">请为缺失项设置最终版,或改为显式选择具体版本。</li>
        </ul>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {/* 左栏:文件组卡片混排。 */}
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-2.5" data-smoke="file-group-rail">
          {filteredCards.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-neutral-400">无匹配文件组</p>
          ) : null}
          {filteredCards.map((card) => (
            <FileGroupCard
              key={card.id}
              card={card}
              active={selectedCard?.id === card.id}
              onSelect={() => {
                setSelectedId(card.id);
                setBlockers([]);
                setMultiSelect(false);
                setSelectedVersionIds(new Set());
                setExpandedVersionId(null);
                setShowPromote(false);
              }}
            />
          ))}
        </aside>
        {/* 右栏:七列文件表 / 等待上游占位。 */}
        <div className="min-w-0 flex-1 overflow-auto p-4" data-smoke="file-version-table">
          {selectedWaitingStage ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-neutral-400" data-smoke="files-waiting-placeholder">
              <Layers size={28} strokeWidth={1.5} className="text-neutral-300" aria-hidden="true" />
              <div className="font-medium text-neutral-700">{selectedWaitingStage.name}</div>
              <p className="max-w-md text-xs leading-relaxed">
                {selectedWaitingStage.goal || '等待上游阶段交付最终版或已通过产物后开始。'}
              </p>
              <span className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500">等待上游 · 暂无产物</span>
            </div>
          ) : packageLoading ? (
            <p className="text-sm text-neutral-400">加载包成员…</p>
          ) : currentRows.length === 0 ? (
            <p className="text-sm text-neutral-400">暂无文件行</p>
          ) : (
            <>
              {packageProjectionBlocked ? (
                <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-smoke="files-package-projection-blocked">
                  当前包不能作为整包正式输入；仍可查看成员，并显式引用或修订具体版本。
                </p>
              ) : null}
              <table className="w-full min-w-[880px] text-xs">
              <thead>
                <tr className="h-9 border-b border-neutral-200 text-left text-neutral-500">
                  {multiSelect ? <th className="w-8" aria-label="选择" /> : null}
                  <th className="font-semibold">名称</th>
                  <th className="font-semibold">类型 / 阶段</th>
                  <th className="font-semibold">来源</th>
                  <th className="font-semibold">当前版</th>
                  <th className="font-semibold">最终版</th>
                  <th className="font-semibold">审核</th>
                  <th className="font-semibold">动作</th>
                </tr>
              </thead>
              <tbody>
                {currentRows.map((row) => {
                  const selected = selectedVersionIds.has(row.rowId);
                  return (
                    <tr key={row.rowId} className="border-b border-neutral-100 align-middle" data-smoke="file-version-row" data-version-id={row.versionId}>
                      {multiSelect ? (
                        <td>
                          <button
                            type="button"
                            aria-pressed={selected}
                            aria-label={`选择 ${row.filename}`}
                            onClick={() => toggleRowSelection(row.rowId)}
                            className="text-neutral-500 hover:text-neutral-800"
                            data-smoke="files-row-select"
                            data-version-id={row.versionId}
                          >
                            {selected ? <CheckSquare size={15} /> : <Square size={15} />}
                          </button>
                        </td>
                      ) : null}
                      <td className="py-2 pr-3">
                        <div className="font-medium text-neutral-900">{row.filename}</div>
                        <div className="text-[11px] text-neutral-400" data-smoke="file-row-collection-id">
                          collection: {row.collectionName || row.collectionId}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        {row.collectionKind ? (
                          <span className="inline-flex rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                            {row.collectionKind}
                          </span>
                        ) : null}
                        {row.stageName ? (
                          <div className="mt-0.5 text-[11px] text-neutral-400">{row.stageName}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="text-neutral-800">{row.sourcePrimary}</div>
                        {row.sourceSub ? (
                          <div className="text-[11px] text-neutral-400">{row.sourceSub}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${row.isCurrent
                          ? 'border-amber-200 bg-amber-50 text-amber-800'
                          : 'border-neutral-200 bg-neutral-50 text-neutral-600'}`}>
                          {row.currentLabel}
                        </span>
                        {row.currentSub ? (
                          <div className="mt-0.5 text-[11px] text-neutral-400">{row.currentSub}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        {row.isFinal ? (
                          <span className="inline-flex rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                            {row.finalLabel}
                          </span>
                        ) : (
                          <span className="inline-flex rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[10px] text-neutral-500">未设置</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${reviewStateChipClass(row.reviewState)}`}
                          data-smoke="file-row-review-state"
                          data-review-state={row.reviewState}
                        >
                          {row.reviewLabel}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() => addRowReference(row)}
                            className="rounded-md border border-sky-300 bg-white px-2 py-0.5 text-[11px] text-sky-700 hover:bg-sky-50"
                            data-smoke="files-row-ref"
                            data-version-id={row.versionId}
                          >
                            引用
                          </button>
                          {!archived && selectedPackageId && onOpenPackagePreview ? (
                            <button
                              type="button"
                              onClick={() => {
                                const pkg = packageDetailCache.get(selectedPackageId)?.package;
                                if (!pkg) return;
                                const frozenMemberVersionId = pkg.members.find(
                                  (member) => member.collectionId === row.collectionId,
                                )?.artifactVersionId;
                                onOpenPackagePreview(packageMetaFromDetail(pkg), frozenMemberVersionId);
                              }}
                              className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
                              data-smoke="files-row-preview-edit"
                              data-version-id={row.versionId}
                            >
                              预览/编辑
                            </button>
                          ) : null}
                          {selectedCard?.kind === 'collection' && selectedCard.payload.kind === 'collection' ? (
                            <>
                              {!archived && row.isMarkdown && onOpenRevisionEditor ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenRevisionEditor({
                                    collectionId: row.collectionId,
                                    collectionName: row.collectionName,
                                    filename: row.filename,
                                    baseVersionId: row.versionId,
                                    sourceVersionId: row.versionId,
                                    collectionRevision: row.collectionRevision,
                                  })}
                                  className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
                                  data-smoke="files-row-preview-edit"
                                  data-version-id={row.versionId}
                                >
                                  预览/编辑
                                </button>
                              ) : onOpenReadOnlyArtifact && row.artifact ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenReadOnlyArtifact(row.artifact!)}
                                  className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
                                  data-smoke="files-row-view"
                                  data-version-id={row.versionId}
                                >
                                  查看
                                </button>
                              ) : null}
                              {!archived && row.canRevise && onOpenRevisionEditor ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenRevisionEditor({
                                    collectionId: row.collectionId,
                                    collectionName: row.collectionName,
                                    filename: row.filename,
                                    baseVersionId: row.versionId,
                                    sourceVersionId: row.versionId,
                                    ...(row.basisReviewId ? { basisReviewId: row.basisReviewId } : {}),
                                    collectionRevision: row.collectionRevision,
                                  })}
                                  className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100"
                                  data-smoke="files-row-revise"
                                  data-version-id={row.versionId}
                                >
                                  基于此修改
                                </button>
                              ) : null}
                              {onReview || onFinalize ? (
                                <button
                                  type="button"
                                  onClick={() => setExpandedVersionId((current) => current === row.versionId ? null : row.versionId)}
                                  className={`rounded-md border px-2 py-0.5 text-[11px] ${expandedVersionId === row.versionId
                                    ? 'border-neutral-900 bg-neutral-900 text-white'
                                    : 'border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-100'}`}
                                  data-smoke="files-row-detail"
                                  data-version-id={row.versionId}
                                >
                                  {expandedVersionId === row.versionId ? '收起' : '详情'}
                                </button>
                              ) : null}
                            </>
                          ) : null}
                          {!archived && selectedPackageId && row.canRevise && onOpenRevisionEditor ? (
                            <button
                              type="button"
                              onClick={() => onOpenRevisionEditor({
                                collectionId: row.collectionId,
                                collectionName: row.collectionName,
                                filename: row.filename,
                                baseVersionId: row.versionId,
                                sourceVersionId: row.versionId,
                                ...(row.basisReviewId ? { basisReviewId: row.basisReviewId } : {}),
                                packageId: selectedPackageId,
                                ...(row.deliveryId ? { deliveryId: row.deliveryId } : {}),
                                collectionRevision: row.collectionRevision,
                              })}
                              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100"
                              data-smoke="files-row-revise"
                              data-version-id={row.versionId}
                            >
                              基于此修改
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </>
          )}
          {/* 集合版本行展开区:审核历史/追加审核/设为最终版(复用 VersionDecisionPanel)。 */}
          {selectedCard?.kind === 'collection' && selectedCard.payload.kind === 'collection' && expandedVersionId ? (
            <CollectionVersionDetail
              collection={selectedCard.payload.collection}
              expandedVersionId={expandedVersionId}
              canDecideVersion={archived ? undefined : canDecideVersion}
              onReview={archived ? undefined : onReview}
              onFinalize={archived ? undefined : onFinalize}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CollectionVersionDetail({
  collection,
  expandedVersionId,
  canDecideVersion,
  onReview,
  onFinalize,
}: {
  collection: ProjectArtifactLibraryDto['collections'][number];
  expandedVersionId: string;
  canDecideVersion?: (version: ProjectArtifactVersionDto) => boolean;
  onReview?: (draft: SubmitArtifactReviewDraft) => Promise<string | null>;
  onFinalize?: (draft: SetArtifactFinalVersionDraft) => Promise<string | null>;
}) {
  const version = collection.versions.find((v) => v.id === expandedVersionId);
  if (!version) return null;
  return (
    <div className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3" data-smoke="files-version-detail" data-version-id={version.id}>
      <div className="mb-2 text-xs font-medium text-neutral-700">
        {version.artifact.filename} · v{version.versionNumber}
      </div>
      <VersionDecisionPanel
        version={version}
        collection={collection}
        canDecide={Boolean(canDecideVersion?.(version))}
        onReview={onReview}
        onFinalize={onFinalize}
      />
      <FinalizationHistory collection={collection} />
    </div>
  );
}

function FileGroupCard({
  card,
  active,
  onSelect,
}: {
  card: FileGroupCardModel;
  active: boolean;
  onSelect: () => void;
}) {
  const kindLabel = card.kind === 'package' ? '输出包' : card.kind === 'collection' ? '文件集合' : '等待上游';
  const kindChipClass = card.kind === 'package'
    ? 'border-violet-200 bg-violet-50 text-violet-700'
    : card.kind === 'collection'
      ? 'border-blue-200 bg-blue-50 text-blue-700'
      : 'border-neutral-300 bg-neutral-100 text-neutral-600';
  const smoke = card.kind === 'package'
    ? card.payload.kind === 'pending-delivery' ? 'output-package-pending' : 'output-package-item'
    : card.kind === 'collection' ? 'project-artifact-collection' : 'file-group-waiting';
  return (
    <button
      type="button"
      onClick={onSelect}
      data-smoke={smoke}
      data-package-id={card.payload.kind === 'package' ? card.payload.package.packageId : undefined}
      data-collection-id={card.payload.kind === 'collection' ? card.payload.collection.id : undefined}
      data-stage-id={card.payload.kind === 'waiting' ? card.payload.stage.id : undefined}
      className={`mb-2 block w-full rounded-lg border p-2.5 text-left ${active
        ? 'border-sky-300 bg-white shadow-sm'
        : 'border-neutral-200 bg-white hover:border-neutral-300'}`}
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${kindChipClass}`}>{kindLabel}</span>
        {card.chips.map((chip, index) => (
          <span
            key={`${chip}-${index}`}
            className="inline-flex rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[10px] text-neutral-600"
            {...(card.kind === 'package' && card.payload.kind === 'package' && index === 1
              ? { 'data-smoke': 'output-package-review-state' }
              : {})}
          >
            {chip}
          </span>
        ))}
      </div>
      <div className="mt-1.5 truncate text-[13px] font-semibold text-neutral-900">{card.title}</div>
      {card.summaryLines.length > 0 ? (
        <div className="mt-0.5 space-y-0.5 text-[11px] text-neutral-500">
          {card.summaryLines.map((line) => (
            <div key={line} className="truncate">{line}</div>
          ))}
        </div>
      ) : null}
      {card.kind === 'package' && card.payload.kind === 'pending-delivery' ? (
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-neutral-500">
          <Clock className="h-3 w-3" aria-hidden="true" />
          Workspace revision 已提交,package 形成中
        </div>
      ) : null}
      {card.kind === 'package' && card.payload.kind === 'package' ? (
        <div className="mt-0.5 truncate text-[11px] text-neutral-400">{card.payload.package.packageId}</div>
      ) : null}
    </button>
  );
}

function reviewStateChipClass(state: string): string {
  if (state === 'approved') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (state === 'rejected') return 'border-red-200 bg-red-50 text-red-700';
  if (state === 'changes_requested') return 'border-orange-200 bg-orange-50 text-orange-700';
  return 'border-amber-200 bg-amber-50 text-amber-800';
}

/** 输出包成员行(current projection 解析结果;数据来自 Server 的 getOutputPackage)。 */
function packageProjectionRows(
  detail: PackageDetailCache,
  library: ProjectArtifactLibraryDto | null,
  stageNameById: ReadonlyMap<string, string>,
  agentNames: ReadonlyMap<string, string>,
): FileTableRow[] {
  const projection = detail.projection;
  if (!projection) return [];
  const pkg = detail.package;
  const agentName = pkg?.agentId ? agentNames.get(pkg.agentId) : undefined;
  const sourcePathById = new Map((pkg?.members ?? []).map((member) => [member.artifactVersionId, member.sourcePath]));
  const collectionById = new Map((library?.collections ?? []).map((collection) => [collection.id, collection]));
  const actionByVersionId = new Map(detail.availableActions.map((entry) => [entry.versionId, entry]));
  return projection.members.map((member) => {
    const collection = collectionById.get(member.collectionId);
    const version = collection?.versions.find((v) => v.id === member.versionId);
    const stageId = version?.source.stageId;
    // #1062:可修订性由 Server 的 availableActions 给出;basis 冻结 latestReviewId,不从历史猜。
    const actions = actionByVersionId.get(member.versionId);
    const canRevise = actions?.actions.includes('revise-version') ?? false;
    return {
      rowId: member.versionId,
      versionId: member.versionId,
      filename: member.filename,
      collectionId: member.collectionId,
      collectionName: collection?.name ?? '',
      collectionKind: collection?.kind ?? '',
      stageName: stageId ? (stageNameById.get(stageId) ?? stageId) : '',
      sourcePrimary: agentName ? `@${agentName}` : 'Agent 交付',
      sourceSub: sourcePathById.get(member.versionId) ?? '',
      currentLabel: `v${member.versionNumber} current`,
      currentSub: `server revision r${member.collectionRevision}`,
      finalLabel: member.isFinalVersion ? `v${member.versionNumber} final` : '未设置',
      isFinal: member.isFinalVersion,
      reviewLabel: reviewStateLabel(member.reviewState),
      reviewState: member.reviewState,
      isCurrent: true,
      collectionRevision: member.collectionRevision,
      isMarkdown: isMarkdownFilename(member.filename),
      canRevise,
      ...(actions?.latestReviewId ? { basisReviewId: actions.latestReviewId } : {}),
      ...(pkg?.deliveryId ? { deliveryId: pkg.deliveryId } : {}),
    };
  });
}

/** 集合版本行(collection.versions 按版本号倒序;七列语义见 §8.7)。 */
function collectionVersionRows(
  collection: ProjectArtifactLibraryDto['collections'][number],
  stageNameById: ReadonlyMap<string, string>,
): FileTableRow[] {
  return [...collection.versions]
    .sort((left, right) => right.versionNumber - left.versionNumber)
    .map((version) => {
      const stageId = version.source.stageId;
      const sourcePrimary = version.revisionBasis
        ? '人工修改'
        : (version.packageMemberships?.length ?? 0) > 0
          ? 'Agent 交付'
          : '任务提升';
      const sourceSub = version.source.workspaceRunId
        ?? version.source.messageId
        ?? `task ${version.source.taskId}`;
      // #1062:可修订性沿用 ProjectArtifactLibrary 既有判定;basisReviewId 取最新审核记录。
      const latestReview = version.reviews.at(-1);
      const blockedReview = latestReview?.decision === 'rejected' || latestReview?.decision === 'changes_requested';
      return {
        rowId: version.id,
        versionId: version.id,
        filename: version.artifact.filename,
        collectionId: collection.id,
        collectionName: collection.name,
        collectionKind: collection.kind,
        stageName: stageId ? (stageNameById.get(stageId) ?? stageId) : '',
        sourcePrimary,
        sourceSub,
        currentLabel: version.id === collection.currentVersionId
          ? `v${version.versionNumber} current`
          : `v${version.versionNumber}`,
        currentSub: '',
        finalLabel: version.id === collection.finalVersionId
          ? `v${version.versionNumber} final`
          : '未设置',
        isFinal: version.id === collection.finalVersionId,
        reviewLabel: reviewStateLabel(version.reviewState),
        reviewState: version.reviewState,
        isCurrent: version.id === collection.currentVersionId,
        collectionRevision: collection.revision,
        isMarkdown: isMarkdownFilename(version.artifact.filename),
        canRevise: Boolean(blockedReview) && isMarkdownFilename(version.artifact.filename),
        ...(blockedReview && latestReview ? { basisReviewId: latestReview.id } : {}),
        artifact: version.artifact,
      };
    });
}

function isMarkdownFilename(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

/** 包成员「预览/编辑」→ OutputPackagePreviewModal 需要的 meta(与消息卡同构,Server 详情构建)。 */
function packageMetaFromDetail(pkg: OutputPackageDto): OutputPackageMeta {
  return {
    kind: 'output-package',
    packageId: pkg.packageId,
    ...(pkg.taskId ? { taskId: pkg.taskId } : {}),
    ...(pkg.agentId ? { agentId: pkg.agentId } : {}),
    memberCount: pkg.memberCount,
    members: pkg.members.map((member) => ({
      shortLabel: member.shortLabel,
      filename: member.filename,
      artifactVersionId: member.artifactVersionId,
      collectionId: member.collectionId,
    })),
    workspaceRevisionId: pkg.workspaceRevisionId,
    publishId: pkg.publishId,
    ...(pkg.createdAt ? { createdAt: pkg.createdAt } : {}),
  };
}
