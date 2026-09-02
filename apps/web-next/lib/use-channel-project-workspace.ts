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
import { getWebSocket, projectEvents, taskEvents } from './socket';

export interface ChannelProjectWorkspaceLoadError {
  readonly kind: 'not_ready' | 'no_permission' | 'error';
  readonly message: string;
}

export type ChannelProjectTask = ChannelTaskWorkspaceV1['entries'][number]['task'];

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
  const projectRequestRef = useRef(0);
  const artifactRequestRef = useRef(0);
  const documentBundleRequestRef = useRef(0);
  const outputPackageRequestRef = useRef(0);
  const taskRequestRef = useRef(0);

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
    artifactRequestRef.current += 1;
    setArtifactLibrary(incoming);
  }, []);

  const refreshOutputPackages = useCallback(async () => {
    if (!channelId || !connected) return;
    const requestId = ++outputPackageRequestRef.current;
    const result = await projectEvents().listOutputPackages({ channelId }).catch(() => null);
    if (requestId !== outputPackageRequestRef.current
      || channelRef.current !== channelId
      || !result?.ok) return;
    setOutputPackages(result.packages ?? []);
    setOutputPackagePendings(result.pendingDeliveries ?? []);
    setDataRevision((revision) => revision + 1);
  }, [channelId, connected]);

  const refreshArtifactLibrary = useCallback(async () => {
    if (!channelId || !connected) return;
    const requestId = ++artifactRequestRef.current;
    const result = await projectEvents().artifactCollections(channelId).catch(() => null);
    if (requestId !== artifactRequestRef.current
      || channelRef.current !== channelId
      || !result?.ok) return;
    setArtifactLibrary(result.library ?? null);
  }, [channelId, connected]);

  const refreshProjectFacts = useCallback(async () => {
    if (!channelId || !connected) return;
    const requestId = ++projectRequestRef.current;
    const artifactRequestId = ++artifactRequestRef.current;
    try {
      const [overviewResult, artifactResult] = await Promise.all([
        projectEvents().overview(channelId),
        projectEvents().artifactCollections(channelId),
      ]);
      if (requestId !== projectRequestRef.current || channelRef.current !== channelId) return;
      if (overviewResult.ok) {
        applyOverview(overviewResult.overview ?? null);
      } else {
        setOverviewError(projectLoadError(overviewResult, '项目推进加载失败，请稍后重试'));
      }
      if (artifactRequestId === artifactRequestRef.current && artifactResult.ok) {
        setArtifactLibrary(artifactResult.library ?? null);
      }
    } catch {
      if (requestId !== projectRequestRef.current || channelRef.current !== channelId) return;
      setOverviewError({ kind: 'error', message: '项目推进加载失败，请稍后重试' });
    }
  }, [applyOverview, channelId, connected]);

  const refreshTasks = useCallback(async () => {
    if (!channelId || !connected) return;
    const requestId = ++taskRequestRef.current;
    setTasksLoading(true);
    setTasksLoadError(null);
    try {
      const result = await taskEvents().channelWorkspace(channelId);
      if (requestId !== taskRequestRef.current || channelRef.current !== channelId) return;
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
      if (requestId !== taskRequestRef.current || channelRef.current !== channelId) return;
      setTaskWorkspace(null);
      setTasks([]);
      setTasksLoadError({ kind: 'error', message: '频道任务加载失败，请稍后重试' });
    } finally {
      if (requestId === taskRequestRef.current && channelRef.current === channelId) {
        setTasksLoading(false);
      }
    }
  }, [channelId, connected]);

  useEffect(() => {
    projectRequestRef.current += 1;
    artifactRequestRef.current += 1;
    documentBundleRequestRef.current += 1;
    outputPackageRequestRef.current += 1;
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
          const documentBundleRequestId = ++documentBundleRequestRef.current;
          return Promise.all([
            projectEvents().documentBundles(channelId).then((result) => {
              if (active
                && documentBundleRequestId === documentBundleRequestRef.current
                && channelRef.current === channelId) {
                setDocumentBundles(result.ok ? result.bundles ?? [] : []);
              }
            }).catch(() => {
              if (active
                && documentBundleRequestId === documentBundleRequestRef.current
                && channelRef.current === channelId) {
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
  }, [channelId, connected, fileFactsActive, projectFactsActive, refreshOutputPackages, refreshProjectFacts]);

  useEffect(() => {
    taskRequestRef.current += 1;
    setTasks([]);
    setTaskWorkspace(null);
    setTasksLoadError(null);
    setTasksLoading(false);
    if (!channelId || !connected) return;
    void refreshTasks();
  }, [channelId, connected, refreshTasks]);

  useEffect(() => {
    if (!channelId || !connected) return;
    const socket = getWebSocket();
    const onTaskUpdated = (task: ChannelProjectTask) => {
      if (task.channelId !== channelId) return;
      applyTask(task);
      void refreshTasks();
      if (projectFactsActive) void refreshProjectFacts();
      if (fileFactsActive) void refreshOutputPackages();
    };
    socket.on('task:updated', onTaskUpdated);
    return () => { socket.off('task:updated', onTaskUpdated); };
  }, [applyTask, channelId, connected, fileFactsActive, projectFactsActive, refreshOutputPackages, refreshProjectFacts, refreshTasks]);

  useEffect(() => {
    if (!channelId || !connected || !projectFactsActive) return;
    const stopProject = projectEvents().onUpdated(channelId, (nextOverview) => {
      applyOverview(nextOverview);
      void refreshTasks();
    });
    const stopArtifacts = projectEvents().onArtifactsUpdated(channelId, (library) => {
      applyArtifactLibrary(library);
      if (fileFactsActive) void refreshOutputPackages();
      void refreshTasks();
    });
    const stopBundles = fileFactsActive
      ? projectEvents().onDocumentBundlesUpdated(channelId, (bundles) => {
          documentBundleRequestRef.current += 1;
          setDocumentBundles(bundles);
        })
      : () => undefined;
    return () => {
      stopProject();
      stopArtifacts();
      stopBundles();
    };
  }, [applyArtifactLibrary, applyOverview, channelId, connected, fileFactsActive, projectFactsActive, refreshOutputPackages, refreshTasks]);

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
