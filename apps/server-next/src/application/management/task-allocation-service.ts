/**
 * #807 AC#2 allocation 服务：把 broker candidate → domain decideOfferAllocationPolicy 串联为
 * publish_for_claim 的 allocation 输入，替换 kernel 的「强转 open」兜底补丁。
 *
 * #807 正文把 publishForClaim 里的强转 open 明确称为「补丁」并要求去掉：PR#810 只落地了
 * kernel 的 `allocation?` 参数与 executor 的 `allocationService?` 槽位，本服务补上 AC#2
 * 「executor handler 调 broker + decideOfferAllocationPolicy，传 allocation 到 kernel」。
 * 未接线时 allocation 恒 undefined → kernel 走兜底：把 targeted 强转 open 并清空 assigneeId，
 * 使 PI 显式指派的子 Task 在发布瞬间丢失指派目标。
 *
 * 关键映射：
 * - broker.resolveCandidates → candidates[{agentId, eligible}]，取 eligible 者为合格候选
 * - 显式指派（coordination.claimPolicy==='targeted' + task.assigneeId）→ hardSpecifiedAgentId
 * - decideOfferAllocationPolicy → targeted | open | not_decidable
 * - targeted → {claimPolicy:'targeted', targetAgentId}；open → {claimPolicy:'open'}
 * - not_decidable（无合格候选）→ null：不覆写，交回 kernel 既有路径，不在本服务擅自升级
 *
 * 调在 executor handler（事务外 IO），结果传入 kernel。
 */

import { decideOfferAllocationPolicy } from '../../../../../packages/domain/src/index.js';
import type { TaskClaimBroker } from './task-claim-broker.js';
import type { ServerNextRepositories } from '../repositories.js';

export interface ResolveTaskAllocationInput {
  readonly taskId: string;
  readonly broker: Pick<TaskClaimBroker, 'resolveCandidates'>;
  readonly repositories: Pick<ServerNextRepositories, 'tasks' | 'taskCoordination'>;
}

export type TaskAllocation = { readonly claimPolicy: 'targeted' | 'open'; readonly targetAgentId?: string };

export async function resolveTaskAllocation(
  input: ResolveTaskAllocationInput,
): Promise<TaskAllocation | null> {
  const task = await input.repositories.tasks.getById(input.taskId);
  if (!task) return null;
  const coordination = await input.repositories.taskCoordination.coordinations.getByTaskId(input.taskId);
  if (!coordination) return null;

  // 显式指派 = PI 在 create_subtasks 时声明 claimPolicy:'targeted' + targetAgentId（已落库为
  // coordination.claimPolicy + task.assigneeId）。ADR 0018 / #711 AC#6：显式 @Agent 永不静默改派。
  const hardSpecifiedAgentId = coordination.claimPolicy === 'targeted' && task.assigneeId
    ? task.assigneeId
    : undefined;

  const resolution = await input.broker.resolveCandidates(input.taskId);
  const eligibleAgentIds = resolution.candidates.filter((c) => c.eligible).map((c) => c.agentId);

  if (hardSpecifiedAgentId !== undefined) {
    // decideOfferAllocationPolicy 的 hardSpecifiedAgentId 前置条件是「调用方已确认 eligible」。
    // 目标当前不合格时不满足该前置条件，故不调策略函数，直接保留 targeted：回落 open 会清空
    // assigneeId，正是 #711 AC#6 禁止的静默改派。任务改为等待目标恢复合格（#811 fan-out
    // 在 targeted 下只向该 agent 发 offer，不合格则本轮不发）。向用户请求确认的 UX 属后续切片。
    if (!eligibleAgentIds.includes(hardSpecifiedAgentId)) {
      return { claimPolicy: 'targeted', targetAgentId: hardSpecifiedAgentId };
    }
    return mapDecision(decideOfferAllocationPolicy({
      hardSpecifiedAgentId,
      rankedQualifiedAgentIds: eligibleAgentIds,
      topCandidatesTied: false,
      loadUncertain: true,
    }));
  }

  return mapDecision(decideOfferAllocationPolicy({
    // 无显式指派：候选顺序沿用 resolveCandidates 的确定性序（agentId 字典序），**不是**真实排序。
    // rankQualifiedCandidates（#714）尚未接线、reliability/load 也无持久化，故 loadUncertain=true
    // 如实标记「负载数据缺失」——多候选时策略函数据此返回 open，保持既有 fan-out 不变，
    // 候选顺序不参与决策，不会把任务定向派给「字典序第一」的 agent。接入真实排序后方可翻为 false。
    rankedQualifiedAgentIds: eligibleAgentIds,
    topCandidatesTied: false,
    loadUncertain: true,
  }));
}

function mapDecision(
  decision: ReturnType<typeof decideOfferAllocationPolicy>,
): TaskAllocation | null {
  if (decision.kind === 'targeted') {
    return { claimPolicy: 'targeted', targetAgentId: decision.targetAgentId };
  }
  if (decision.kind === 'open') return { claimPolicy: 'open' };
  // not_decidable（无合格候选）：不覆写，保留 kernel 既有行为，升级交上游 gate（AC#4）。
  return null;
}
