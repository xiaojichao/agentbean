import type {
  ChannelProjectOverviewDto,
  ChannelTaskWorkspaceV1,
  ProjectArtifactLibraryDto,
  ProjectDocumentBundleDto,
} from '@agentbean/contracts';

export type ChannelProjectTask = ChannelTaskWorkspaceV1['entries'][number]['task'];

export type ChannelProjectWorkspaceProjectionEvent =
  | { readonly kind: 'task-updated'; readonly task: ChannelProjectTask }
  | { readonly kind: 'project-updated'; readonly overview: ChannelProjectOverviewDto | null }
  | { readonly kind: 'artifacts-updated'; readonly library: ProjectArtifactLibraryDto | null }
  | { readonly kind: 'document-bundles-updated'; readonly bundles: readonly ProjectDocumentBundleDto[] };

export type ChannelProjectWorkspaceProjectionApply =
  | { readonly kind: 'task'; readonly task: ChannelProjectTask }
  | { readonly kind: 'overview'; readonly overview: ChannelProjectOverviewDto | null }
  | { readonly kind: 'artifact-library'; readonly library: ProjectArtifactLibraryDto | null }
  | { readonly kind: 'document-bundles'; readonly bundles: readonly ProjectDocumentBundleDto[] };

export type ChannelProjectWorkspaceRefreshTarget =
  | 'tasks'
  | 'project-facts'
  | 'output-packages';

export type ChannelProjectWorkspaceRequestFence =
  | 'artifact-library'
  | 'document-bundles';

export interface ChannelProjectWorkspaceProjectionTransition {
  readonly apply: readonly ChannelProjectWorkspaceProjectionApply[];
  readonly invalidateRequests: readonly ChannelProjectWorkspaceRequestFence[];
  readonly refresh: readonly ChannelProjectWorkspaceRefreshTarget[];
}

const EMPTY_TRANSITION: ChannelProjectWorkspaceProjectionTransition = {
  apply: [],
  invalidateRequests: [],
  refresh: [],
};

/**
 * 把 Server projection event 归约为本地应用、request fence 与跨 surface refresh。
 * 该函数不读取 React/Socket 状态，调用方只负责执行返回的确定性 transition。
 */
export function reduceChannelProjectWorkspaceProjection(
  event: ChannelProjectWorkspaceProjectionEvent,
  context: {
    readonly channelId: string;
    readonly projectFactsActive: boolean;
    readonly fileFactsActive: boolean;
  },
): ChannelProjectWorkspaceProjectionTransition {
  switch (event.kind) {
    case 'task-updated':
      if (event.task.channelId !== context.channelId) return EMPTY_TRANSITION;
      return {
        apply: [{ kind: 'task', task: event.task }],
        invalidateRequests: [],
        refresh: [
          'tasks',
          ...(context.projectFactsActive ? ['project-facts'] as const : []),
          ...(context.fileFactsActive ? ['output-packages'] as const : []),
        ],
      };
    case 'project-updated':
      return {
        apply: [{ kind: 'overview', overview: event.overview }],
        invalidateRequests: [],
        refresh: ['tasks'],
      };
    case 'artifacts-updated':
      return {
        apply: [{ kind: 'artifact-library', library: event.library }],
        invalidateRequests: ['artifact-library'],
        refresh: [
          ...(context.fileFactsActive ? ['output-packages'] as const : []),
          'tasks',
        ],
      };
    case 'document-bundles-updated':
      return {
        apply: [{ kind: 'document-bundles', bundles: event.bundles }],
        invalidateRequests: ['document-bundles'],
        refresh: [],
      };
  }
}
