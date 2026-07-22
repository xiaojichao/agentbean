import type { ID } from '@agentbean/contracts';
import { assessCoordinationRisk } from './pi-coordination-policy.js';

/**
 * PI MVP 09 (#709) Task follow-up 证据关联解析——纯函数，无 IO，可单测。
 *
 * 给定一条 task_followup 消息的上下文，判定它应如何关联到现有 Task：
 * - strong（AC1）：强绑定证据（Task 讨论串 / 回复 Task 系统消息 / 明确 Task 引用）→ 直接关联。
 * - suggested（AC2）：唯一明显匹配且不改变任务本质的小补充 → 建议关联，可撤销。
 * - needs_confirmation（AC3）：多候选 / 范围扩大 / 成本增加 / 交付改变 / 验收冲突 → 请求用户确认。
 * - none：无可关联候选。
 *
 * 设计要点：
 * - 强绑定的统一信号是「线程内能解析到 taskId」（meta.taskId 或 coordination 系统消息的
 *   meta.coordination.taskId），由 coordinator 收集后传入；本函数不读消息、无 IO。
 * - 「重大变化」复用 assessCoordinationRisk 的高风险词表（#707）：objective 命中范围扩大/敏感/
 *   扩作用域等即视为需确认，不另造词表。
 * - 输出由 coordinator 映射到 evaluateCoordinationGate 四态：strong→applied、suggested→suggested、
 *   needs_confirmation→blocked。
 */

export interface TaskFollowupBindingInput {
  /** 线程内可解析到的 Task id（meta.taskId + meta.coordination.taskId 去重），按消息时序最早在前。 */
  readonly threadTaskIds: readonly ID[];
  /** 当前频道活跃（非终态）的候选 Task，供弱建议 / 需确认使用。 */
  readonly channelActiveTasks: readonly { readonly taskId: ID; readonly objective: string }[];
  /** task_followup 的 objective 文本，用于重大变化判定。 */
  readonly followupObjective: string;
}

export const TASK_FOLLOWUP_BINDING_REASON = {
  STRONG_THREAD_TASK: 'STRONG_THREAD_TASK',
  SUGGESTED_UNIQUE_MATCH: 'SUGGESTED_UNIQUE_MATCH',
  NEEDS_CONFIRMATION_MULTIPLE_CANDIDATES: 'NEEDS_CONFIRMATION_MULTIPLE_CANDIDATES',
  NEEDS_CONFIRMATION_MAJOR_CHANGE: 'NEEDS_CONFIRMATION_MAJOR_CHANGE',
  NO_CANDIDATES: 'NO_CANDIDATES',
} as const;

export type TaskFollowupBinding =
  | { readonly kind: 'strong'; readonly taskId: ID; readonly reasonCode: string }
  | { readonly kind: 'suggested'; readonly taskId: ID; readonly reasonCode: string }
  | { readonly kind: 'needs_confirmation'; readonly candidates: readonly ID[]; readonly reasonCode: string }
  | { readonly kind: 'none'; readonly reasonCode: string };

/**
 * 解析 task_followup 消息的关联裁决。判定优先级（前者压倒后者）：
 * 1. 强绑定（线程 taskId）→ strong：取最近一个，即用户最可能回复的对象（AC1）。
 * 2. 重大变化（objective 命中高风险词表）→ needs_confirmation，无论候选数（AC3）。
 * 3. 多候选 → needs_confirmation（AC3）。
 * 4. 唯一候选 + 非重大变化 → suggested（AC2）。
 * 5. 无候选 → none。
 */
export function resolveTaskFollowupBinding(input: TaskFollowupBindingInput): TaskFollowupBinding {
  // AC1 强绑定：线程内有 Task 引用（讨论串 / 回复系统消息 / 明确引用）。优先级最高，压倒重大变化。
  if (input.threadTaskIds.length > 0) {
    const taskId = input.threadTaskIds[input.threadTaskIds.length - 1]!;
    return { kind: 'strong', taskId, reasonCode: TASK_FOLLOWUP_BINDING_REASON.STRONG_THREAD_TASK };
  }

  // AC3 重大变化：范围扩大 / 成本增加 / 交付改变 / 验收冲突（复用 #707 高风险词表）。
  const majorChange =
    assessCoordinationRisk({ modelRisk: 'low', objective: input.followupObjective }) === 'high';
  if (majorChange) {
    return {
      kind: 'needs_confirmation',
      candidates: input.channelActiveTasks.map((task) => task.taskId),
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.NEEDS_CONFIRMATION_MAJOR_CHANGE,
    };
  }

  // AC3 多候选：无法确定唯一目标，必须请求用户确认。
  if (input.channelActiveTasks.length > 1) {
    return {
      kind: 'needs_confirmation',
      candidates: input.channelActiveTasks.map((task) => task.taskId),
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.NEEDS_CONFIRMATION_MULTIPLE_CANDIDATES,
    };
  }

  // AC2 唯一明显匹配 + 不改变任务本质的小补充：建议关联，可撤销。
  if (input.channelActiveTasks.length === 1) {
    return {
      kind: 'suggested',
      taskId: input.channelActiveTasks[0]!.taskId,
      reasonCode: TASK_FOLLOWUP_BINDING_REASON.SUGGESTED_UNIQUE_MATCH,
    };
  }

  // 无可关联候选。
  return { kind: 'none', reasonCode: TASK_FOLLOWUP_BINDING_REASON.NO_CANDIDATES };
}
