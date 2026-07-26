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
 * - 显式指派（coordination.claimPolicy==='targeted' + task.assigneeId）→ 直接 targeted，不查候选
 * - 否则 broker.resolveCandidates → 合格候选 → decideOfferAllocationPolicy
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

  // 显式指派 = PI 在 create_subtasks 时声明 claimPolicy:'targeted' + targetAgentId
  // （已落库为 coordination.claimPolicy + task.assigneeId）。
  //
  // 此路径**不查候选**，直接返回 targeted，有两层理由：
  // 1) 语义：ADR 0018 / #711 AC#6 —— 显式 @Agent 永不静默改派。无论目标当前是否合格，
  //    结论都是 targeted，查候选不会改变结果（decideOfferAllocationPolicy 规则 1 亦然）。
  // 2) 健壮性：executor 侧以 `.catch(() => null)` 调用本服务，而 null 在 kernel 中等价于
  //    「不传 allocation」→ 触发强转 open 并清空 assigneeId。若此路径依赖 broker 的多次仓储
  //    IO，任何抖动（如 SQLITE_BUSY）都会让本次修复的缺陷原样复发且外部不可见。
  //    早退使显式指派只依赖两次已完成的读，不引入新的失败面。
  //
  // 已知局限（不在本切片修）：offer 只在发布瞬间扇出一次（dev-server 的 taskClaimEmitter →
  // realtime.offerTaskClaims → prepareOffers 是全仓唯一触发点，设备重连不重发）。因此目标
  // 若在发布时刻不合格，本次发布产生 0 个 offer 且**没有自动重试**，Task 停在 todo。
  // 恢复手段是 PI 显式操作：tasks.assign 改派 / tasks.retry / tasks.report_blocked。
  // 按 AC#6 应向用户请求确认（needs_confirmation），该 UX 属后续切片。
  if (coordination.claimPolicy === 'targeted' && task.assigneeId) {
    return { claimPolicy: 'targeted', targetAgentId: task.assigneeId };
  }

  const resolution = await input.broker.resolveCandidates(input.taskId);
  // 命名刻意不叫 ranked*：这是 resolveCandidates 的确定性序（agentId 字典序），**不是**排序结果。
  // rankQualifiedCandidates（#714）尚未接线，reliability/load 也无持久化。
  const unrankedEligibleAgentIds = resolution.candidates.filter((c) => c.eligible).map((c) => c.agentId);

  return mapDecision(decideOfferAllocationPolicy({
    rankedQualifiedAgentIds: unrankedEligibleAgentIds,
    topCandidatesTied: false,
    // 如实标记「负载数据缺失」——这不是保守取值，是事实：reliability/load 无任何持久化。
    // 后果：≥2 候选时策略函数恒返回 open，保持既有 fan-out 不变，候选顺序不参与决策，
    // 因此上面传入未排序列表是安全的。
    // ⚠️ 接入 #714 真实排序把本值翻为 false 之前，必须先把 rankedQualifiedAgentIds 换成
    // rankQualifiedCandidates 的输出；只翻这一个开关会让任务恒定向派给字典序第一的 agent。
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
