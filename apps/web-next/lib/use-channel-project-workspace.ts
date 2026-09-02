'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChannelProjectOverviewDto,
  ChannelTaskWorkspaceV1,
  OutputPackagePendingDeliveryDto,
  OutputPackageSummaryDto,
  ProjectArtifactLibraryDto,
  ProjectDocumentBundleDto,
} from '@agentbean/contracts';
import { acceptChannelProjectOverview } from './channel-project-overview';
import {
  reduceChannelProjectWorkspaceProjection,
  type ChannelProjectTask,
  type ChannelProjectWorkspaceProjectionEvent,
} from './channel-project-workspace-projection';
import { createChannelProjectWorkspaceRequestFence } from './channel-project-workspace-request-fence';
import { getWebSocket, projectEvents, taskEvents } from './socket';

export interface ChannelProjectWorkspaceLoadError {
  readonly kind: 'not_ready' | 'no_permission' | 'error';
  readonly message: string;
}

export type { ChannelProjectTask } from './channel-project-workspace-projection';

export interface ChannelProjectWorkspace {
  readonly overview: ChannelProjectOverviewDto | null | undefined;
  readonly overviewError: ChannelProjectWorkspaceLoadError | null;
  readonly artifactLibrary: ProjectArtifactLibraryDto | null;
  readonly documentBundles: readonly ProjectDocumentBundleDto[];
  readonly outputPackages: readonly OutputPackageSummaryDto[];
  readonly outputPackagePendings: readonly OutputPackagePendingDeliveryDto[];
  readonly filesReady: boolean;
  readonly dataRevision: number;
  readonly tasks: readonly ChannelProjectTask[];
  readonly taskWorkspace: ChannelTaskWorkspaceV1 | null;
  readonly tasksLoading: boolean;
  readonly tasksLoadError: ChannelProjectWorkspaceLoadError | null;
  applyTask(task: ChannelProjectTask): void;
  applyOverview(overview: ChannelProjectOverviewDto | null): void;
  applyArtifactLibrary(library: ProjectArtifactLibraryDto | null): void;
  refreshProjectFacts(): Promise<void>;
  refreshArtifactLibrary(): Promise<void>;
  refreshOutputPackages(): Promise<void>;
  refreshTasks(): Promise<void>;
}

/**
 * Chat / Tasks / Files 共用的 Channel Project Workspace 只读投影。
 *
 * 该 module 负责频道切换防串台、首轮 loading、Server event 失效和同源投影刷新；
 * 阶段、审核与文件 mutation 仍调用既有具名 Server command，并把返回投影交给 applyOverview。
 */
export function useChannelProjectWorkspace(input: {
  readonly channelId: string | null;
  readonly connected: boolean;
  readonly projectFactsActive: boolean;
  readonly fileFactsActive: boolean;
}): ChannelProjectWorkspace {
  const { channelId, connected, projectFactsActive, fileFactsActive } = input;
  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const requestFenceRef = useRef<ReturnType<typeof createChannelProjectWorkspaceRequestFence> | null>(null);
  requestFenceRef.current ??= createChannelProjectWorkspaceRequestFence();
  const requestFence = requestFenceRef.current;

  const [overview, setOverview] = useState<ChannelProjectOverviewDto | null>();
  const [overviewError, setOverviewError] = useState<ChannelProjectWorkspaceLoadError | null>(null);
  const [artifactLibrary, setArtifactLibrary] = useState<ProjectArtifactLibraryDto | null>(null);
  const [documentBundles, setDocumentBundles] = useState<ProjectDocumentBundleDto[]>([]);
  const [outputPackages, setOutputPackages] = useState<OutputPackageSummaryDto[]>([]);
  const [outputPackagePendings, setOutputPackagePendings] = useState<OutputPackagePendingDeliveryDto[]>([]);
  const [filesReady, setFilesReady] = useState(false);
  const [dataRevision, setDataRevision] = useState(0);
  const [tasks, setTasks] = useState<ChannelProjectTask[]>([]);
  const [taskWorkspace, setTaskWorkspace] = useState<ChannelTaskWorkspaceV1 | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksLoadError, setTasksLoadError] = useState<ChannelProjectWorkspaceLoadError | null>(null);

  const applyOverview = useCallback((incoming: ChannelProjectOverviewDto | null) => {
    setOverview((current) => acceptChannelProjectOverview(current ?? null, incoming));
    setOverviewError(null);
  }, []);

  const applyTask = useCallback((incoming: ChannelProjectTask) => {
    setTasks((current) => current.some((task) => task.id === incoming.id)
      ? current.map((task) => task.id === incoming.id ? { ...task, ...incoming } : task)
      : [...current, incoming]);
  }, []);

  const applyArtifactLibrary = useCallback((incoming: ProjectArtifactLibraryDto | null) => {
    requestFence.invalidate('artifact-library');
    setArtifactLibrary(incoming);
  }, [requestFence]);

  const refreshOutputPackages = useCallback(async () => {
    if (!channelId || !connected) return;
    const ticket = requestFence.begin('output-packages', channelId);
    const result = await projectEvents().listOutputPackages({ channelId }).catch(() => null);
    if (!requestFence.isCurrent(ticket, channelRef.current)
      || !result?.ok) return;
    setOutputPackages(result.packages ?? []);
    setOutputPackagePendings(result.pendingDeliveries ?? []);
    setDataRevision((revision) => revision + 1);
  }, [channelId, connected, requestFence]);

  const refreshArtifactLibrary = useCallback(async () => {
    if (!channelId || !connected) return;
    const ticket = requestFence.begin('artifact-library', channelId);
    const result = await projectEvents().artifactCollections(channelId).catch(() => null);
    if (!requestFence.isCurrent(ticket, channelRef.current)
      || !result?.ok) return;
    setArtifactLibrary(result.library ?? null);
  }, [channelId, connected, requestFence]);

  const refreshProjectFacts = useCallback(async () => {
    if (!channelId || !connected) return;
    const projectTicket = requestFence.begin('project-facts', channelId);
    const artifactTicket = requestFence.begin('artifact-library', channelId);
    try {
      const [overviewResult, artifactResult] = await Promise.all([
        projectEvents().overview(channelId),
        projectEvents().artifactCollections(channelId),
      ]);
      if (!requestFence.isCurrent(projectTicket, channelRef.current)) return;
      if (overviewResult.ok) {
        applyOverview(overviewResult.overview ?? null);
      } else {
        setOverviewError(projectLoadError(overviewResult, '项目推进加载失败，请稍后重试'));
      }
      if (requestFence.isCurrent(artifactTicket, channelRef.current) && artifactResult.ok) {
        setArtifactLibrary(artifactResult.library ?? null);
      }
    } catch {
      if (!requestFence.isCurrent(projectTicket, channelRef.current)) return;
      setOverviewError({ kind: 'error', message: '项目推进加载失败，请稍后重试' });
    }
  }, [applyOverview, channelId, connected, requestFence]);

  const refreshTasks = useCallback(async () => {
    if (!channelId || !connected) return;
    const ticket = requestFence.begin('tasks', channelId);
    setTasksLoading(true);
    setTasksLoadError(null);
    try {
      const result = await taskEvents().channelWorkspace(channelId);
      if (!requestFence.isCurrent(ticket, channelRef.current)) return;
      if (result.ok && result.workspace) {
        setTaskWorkspace(result.workspace);
        setTasks(result.workspace.entries.map((entry) => entry.task));
      } else if (result.ok) {
        setTaskWorkspace(null);
        setTasks([]);
        setTasksLoadError({ kind: 'not_ready', message: '频道任务事实尚未就绪' });
      } else {
        setTaskWorkspace(null);
        setTasks([]);
        setTasksLoadError(projectLoadError(result, '频道任务加载失败，请稍后重试'));
      }
    } catch {
      if (!requestFence.isCurrent(ticket, channelRef.current)) return;
      setTaskWorkspace(null);
      setTasks([]);
      setTasksLoadError({ kind: 'error', message: '频道任务加载失败，请稍后重试' });
    } finally {
      if (requestFence.isCurrent(ticket, channelRef.current)) {
        setTasksLoading(false);
      }
    }
  }, [channelId, connected, requestFence]);

  const applyProjectionEvent = useCallback((event: ChannelProjectWorkspaceProjectionEvent) => {
    if (!channelId) return;
    const transition = reduceChannelProjectWorkspaceProjection(event, {
      channelId,
      projectFactsActive,
      fileFactsActive,
    });

    for (const fence of transition.invalidateRequests) {
      requestFence.invalidate(fence);
    }
    for (const projection of transition.apply) {
      switch (projection.kind) {
        case 'task':
          applyTask(projection.task);
          break;
        case 'overview':
          applyOverview(projection.overview);
          break;
        case 'artifact-library':
          setArtifactLibrary(projection.library);
          break;
        case 'document-bundles':
          setDocumentBundles([...projection.bundles]);
          break;
      }
    }
    for (const target of transition.refresh) {
      if (target === 'tasks') void refreshTasks();
      if (target === 'project-facts') void refreshProjectFacts();
      if (target === 'output-packages') void refreshOutputPackages();
    }
  }, [
    applyOverview,
    applyTask,
    channelId,
    fileFactsActive,
    projectFactsActive,
    refreshOutputPackages,
    refreshProjectFacts,
    refreshTasks,
    requestFence,
  ]);

  useEffect(() => {
    requestFence.reset(channelId);
    requestFence.invalidate('project-facts');
    requestFence.invalidate('artifact-library');
    requestFence.invalidate('document-bundles');
    requestFence.invalidate('output-packages');
    setOverview(undefined);
    setOverviewError(null);
    setArtifactLibrary(null);
    setDocumentBundles([]);
    setOutputPackages([]);
    setOutputPackagePendings([]);
    setFilesReady(false);
    setDataRevision(0);
    if (!channelId || !connected || !projectFactsActive) return;

    let active = true;
    const projectFacts = refreshProjectFacts();
    const fileFacts = fileFactsActive
      ? (() => {
          const documentBundleTicket = requestFence.begin('document-bundles', channelId);
          return Promise.all([
            projectEvents().documentBundles(channelId).then((result) => {
              if (active
                && requestFence.isCurrent(documentBundleTicket, channelRef.current)) {
                setDocumentBundles(result.ok ? result.bundles ?? [] : []);
              }
            }).catch(() => {
              if (active
                && requestFence.isCurrent(documentBundleTicket, channelRef.current)) {
                setDocumentBundles([]);
              }
            }),
            refreshOutputPackages(),
          ]);
        })()
      : Promise.resolve();
    void Promise.all([projectFacts, fileFacts]).finally(() => {
      if (active && channelRef.current === channelId && fileFactsActive) setFilesReady(true);
    });
    return () => { active = false; };
  }, [channelId, connected, fileFactsActive, projectFactsActive, refreshOutputPackages, refreshProjectFacts, requestFence]);

  useEffect(() => {
    requestFence.reset(channelId);
    requestFence.invalidate('tasks');
    setTasks([]);
    setTaskWorkspace(null);
    setTasksLoadError(null);
    setTasksLoading(false);
    if (!channelId || !connected) return;
    void refreshTasks();
  }, [channelId, connected, refreshTasks, requestFence]);

  useEffect(() => {
    if (!channelId || !connected) return;
    const socket = getWebSocket();
    const onTaskUpdated = (task: ChannelProjectTask) => {
      applyProjectionEvent({ kind: 'task-updated', task });
    };
    socket.on('task:updated', onTaskUpdated);
    return () => { socket.off('task:updated', onTaskUpdated); };
  }, [applyProjectionEvent, channelId, connected]);

  useEffect(() => {
    if (!channelId || !connected || !projectFactsActive) return;
    const stopProject = projectEvents().onUpdated(channelId, (nextOverview) => {
      applyProjectionEvent({ kind: 'project-updated', overview: nextOverview });
    });
    const stopArtifacts = projectEvents().onArtifactsUpdated(channelId, (library) => {
      applyProjectionEvent({ kind: 'artifacts-updated', library });
    });
    const stopBundles = fileFactsActive
      ? projectEvents().onDocumentBundlesUpdated(channelId, (bundles) => {
          applyProjectionEvent({ kind: 'document-bundles-updated', bundles });
        })
      : () => undefined;
    return () => {
      stopProject();
      stopArtifacts();
      stopBundles();
    };
  }, [applyProjectionEvent, channelId, connected, fileFactsActive, projectFactsActive]);

  return {
    overview,
    overviewError,
    artifactLibrary,
    documentBundles,
    outputPackages,
    outputPackagePendings,
    filesReady,
    dataRevision,
    tasks,
    taskWorkspace,
    tasksLoading,
    tasksLoadError,
    applyTask,
    applyOverview,
    applyArtifactLibrary,
    refreshProjectFacts,
    refreshArtifactLibrary,
    refreshOutputPackages,
    refreshTasks,
  };
}

function projectLoadError(
  result: { readonly error?: string; readonly message?: string },
  fallback: string,
): ChannelProjectWorkspaceLoadError {
  const code = result.error ?? '';
  return {
    kind: code === 'FORBIDDEN' || code === 'UNAUTHORIZED' ? 'no_permission' : 'error',
    message: result.message ?? result.error ?? fallback,
  };
}
