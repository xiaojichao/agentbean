import {
  evaluateProjectStageExecutionGate,
  type ProjectStageExecutionBlock,
  type ProjectStageUpstreamEdgeFacts,
} from '../../../../packages/domain/src/index.js';
import type { ProjectStageEdgeRecord, ProjectStageRecord } from './project-repositories.js';
import type { ServerNextRepositories, TaskRecord } from './repositories.js';
import { resolveProjectStageStableInputs } from './project-stage-advance-service.js';
import type { ProjectStageStableInputDto } from '@agentbean/contracts';

export interface ProjectStageFacts {
  record: ProjectStageRecord;
  task: TaskRecord;
  reviewDecision: 'accepted' | 'rejected' | 'needs_human' | undefined;
}

/** 从 canonical delivery/acceptance 事实解析阶段绑定 Task 的审核结论。 */
export async function resolveProjectStageReviewDecision(
  repositories: ServerNextRepositories,
  task: TaskRecord,
): Promise<'accepted' | 'rejected' | 'needs_human' | undefined> {
  const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
  const deliveries = await repositories.taskCoordination.deliveries.listByTask(task.id);
  const latestDelivery = [...deliveries].reverse().find((delivery) =>
    delivery.taskRevision === task.revision
    && (coordination === null || delivery.taskAttempt === coordination.attempt));
  if (!latestDelivery) return undefined;
  const acceptance = await repositories.taskCoordination.acceptances
    .getCanonicalByDelivery(latestDelivery.id);
  return acceptance?.decision;
}

/**
 * #822 必需输入的满足证据。
 *
 * 本切片只有阶段级证据可用：上游阶段已交付且未被否决时，其声明的必需输入视为就绪。
 * 逐版本产物证据由后续切片（#823 产物集合 / #825 文档包）细化，
 * 届时只需替换这里的证据解析，门禁与投影无需改动。
 */
export function resolveSatisfiedRequiredInputKeys(
  edge: ProjectStageEdgeRecord,
  upstream: ProjectStageFacts | undefined,
  stableInputs: readonly ProjectStageStableInputDto[] = [],
): string[] {
  if (!upstream) return [];
  const complete = upstream.task.status === 'done' || upstream.task.status === 'closed';
  if (!complete || upstream.reviewDecision !== 'accepted') return [];
  return edge.requiredInputs
    .filter((rule) => rule.source
      && stableInputs.some((input) => input.edgeId === edge.id && input.key === rule.key))
    .map((rule) => rule.key);
}

export async function buildProjectStageUpstreamEdgeFacts(
  repositories: ServerNextRepositories,
  inboundEdges: readonly ProjectStageEdgeRecord[],
  resolveUpstream: (stageId: string) => Promise<ProjectStageFacts | undefined>,
  stableInputs: readonly ProjectStageStableInputDto[] = [],
): Promise<ProjectStageUpstreamEdgeFacts[]> {
  const facts: ProjectStageUpstreamEdgeFacts[] = [];
  for (const edge of inboundEdges) {
    const upstream = await resolveUpstream(edge.upstreamStageId);
    if (!upstream) {
      throw new Error(`Project Stage edge ${edge.id} references an unavailable upstream Stage`);
    }
    facts.push({
      edgeId: edge.id,
      upstreamStageId: edge.upstreamStageId,
      upstreamTaskId: upstream.task.id,
      semantics: edge.semantics,
      upstreamTaskStatus: upstream.task.status,
      ...(upstream.reviewDecision === undefined
        ? {}
        : { upstreamReviewDecision: upstream.reviewDecision }),
      requiredInputs: edge.requiredInputs,
      satisfiedRequiredInputKeys: resolveSatisfiedRequiredInputKeys(edge, upstream, stableInputs),
    });
  }
  return facts;
}

export interface ProjectStageExecutionGateResult {
  /** 该 Task 是否绑定了项目阶段。未绑定的 Task 不受本门禁约束。 */
  readonly boundStageId: string | null;
  /** Stage 创建时冻结的 Task revision；启动边界用它拒绝陈旧绑定。 */
  readonly boundStageTaskRevision: number | null;
  readonly blocked: boolean;
  readonly blocks: readonly ProjectStageExecutionBlock[];
}

/**
 * #822 AC#5：Server 权威执行门禁。
 *
 * 在创建新的 claim 或 Invocation 之前复算：若该 Task 绑定的项目阶段仍有
 * 未满足的 `blocks_start` 依赖或缺失的必需输入，则不得启动执行。
 * 门禁是纯投影，依赖满足后自动放行，不保存需要人工修复的阻塞状态。
 */
export async function resolveProjectStageExecutionGate(
  repositories: ServerNextRepositories,
  task: TaskRecord,
): Promise<ProjectStageExecutionGateResult> {
  const allowed: ProjectStageExecutionGateResult = {
    boundStageId: null,
    boundStageTaskRevision: null,
    blocked: false,
    blocks: [],
  };
  if (!task.channelId) return allowed;
  const scope = { teamId: task.teamId, channelId: task.channelId };
  const stages = await repositories.channelProjects.listStages(scope);
  const stage = stages.find((candidate) => candidate.taskId === task.id);
  if (!stage) return allowed;
  const edges = await repositories.channelProjects.listEdges(scope);
  const inboundEdges = edges.filter((edge) => edge.downstreamStageId === stage.id);
  if (inboundEdges.length === 0) {
    return {
      ...allowed,
      boundStageId: stage.id,
      boundStageTaskRevision: stage.taskRevision,
    };
  }
  const upstreamFactsCache = new Map<string, ProjectStageFacts | undefined>();
  const resolveUpstream = async (stageId: string): Promise<ProjectStageFacts | undefined> => {
    if (upstreamFactsCache.has(stageId)) return upstreamFactsCache.get(stageId);
    const record = stages.find((candidate) => candidate.id === stageId);
    const upstreamTask = record ? await repositories.tasks.getById(record.taskId) : null;
    const facts = record && upstreamTask
      ? {
        record,
        task: upstreamTask,
        reviewDecision: await resolveProjectStageReviewDecision(repositories, upstreamTask),
      }
      : undefined;
    upstreamFactsCache.set(stageId, facts);
    return facts;
  };
  const upstreamEdges = await buildProjectStageUpstreamEdgeFacts(
    repositories,
    inboundEdges,
    resolveUpstream,
    (await resolveProjectStageStableInputs(repositories, task)).inputs,
  );
  const gate = evaluateProjectStageExecutionGate({ upstreamEdges });
  return {
    boundStageId: stage.id,
    boundStageTaskRevision: stage.taskRevision,
    blocked: gate.kind === 'blocked',
    blocks: gate.kind === 'blocked' ? gate.blocks : [],
  };
}
