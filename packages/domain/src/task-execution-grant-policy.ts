/**
 * #925 ADR-0064 execution context grant policy（纯函数）。
 *
 * Agent 明确接受有效 Offer 并原子建立 claim 后，Server 才签发绑定 Agent、task revision、
 * attempt 与 claim 的 execution context grant（输入访问凭证）。Offer 不授予输入访问。
 * grant 随 task revision 变化、claim 释放或过期而失效；root Task 永不签发（ADR-0063）。
 *
 * 本模块供 server claim-broker 在 claim 成功同事务签发，并在失效触发点（reviseTask /
 * invalidateClaim / expireClaims）撤销。membership/manifest 变化失效属后续切片。
 */

export type ExecutionGrantState = 'active' | 'revoked';

/**
 * grant 失效归因。ADR-0064：membership/manifest/revision 变化使旧 grant 失效；
 * 本次覆盖 task-revision 变化与 claim 生命周期结束；membership/manifest 失效留 follow-up。
 */
export type ExecutionGrantRevocationReason =
  | 'task-revised'
  | 'claim-released'
  | 'claim-expired';

export interface TaskExecutionGrantRecord {
  readonly teamId: string;
  readonly managementRunId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly agentId: string;
  readonly state: ExecutionGrantState;
  readonly grantedAt: number;
  readonly revokedAt?: number;
  readonly revocationReason?: ExecutionGrantRevocationReason;
}

/** 签发输入：来自 claim 成功同事务的 lease 与 task/coordination 事实。 */
export interface EvaluateExecutionGrantIssuanceInput {
  readonly teamId: string;
  readonly managementRunId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly agentId: string;
  /** ADR-0063：root Task 不持有 Agent execution claim，永不签发 grant。 */
  readonly nodeKind: 'root' | 'subtask';
  readonly grantedAt: number;
}

export type ExecutionGrantIssuanceDecision =
  | { readonly kind: 'issued'; readonly grant: TaskExecutionGrantRecord }
  | { readonly kind: 'refused'; readonly reason: 'root-not-executable' };

/**
 * 签发决策：subtask claim 成功 → active grant；root → refused（defense in depth，
 * claim 决策层已拒绝 root，此处兜底确保调用方误传 root 也不产出 grant）。
 */
export function evaluateExecutionGrantIssuance(
  input: EvaluateExecutionGrantIssuanceInput,
): ExecutionGrantIssuanceDecision {
  if (input.nodeKind === 'root') {
    return { kind: 'refused', reason: 'root-not-executable' };
  }
  return {
    kind: 'issued',
    grant: {
      teamId: input.teamId,
      managementRunId: input.managementRunId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      taskAttempt: input.taskAttempt,
      claimLeaseId: input.claimLeaseId,
      agentId: input.agentId,
      state: 'active',
      grantedAt: input.grantedAt,
    },
  };
}

export interface EvaluateExecutionGrantRevocationInput {
  readonly grant: TaskExecutionGrantRecord;
  readonly cause: ExecutionGrantRevocationReason;
  /** task-revised 归因时传入当前 task revision；与 grant 绑定 revision 不同才撤销。 */
  readonly currentTaskRevision?: number;
  readonly now: number;
}

export type ExecutionGrantRevocationDecision =
  | {
      readonly kind: 'revoke';
      readonly reason: ExecutionGrantRevocationReason;
      readonly revokedAt: number;
    }
  | { readonly kind: 'keep' };

/**
 * 撤销决策：已撤销 grant 保持终态（幂等）；task-revised 仅当绑定 revision 与当前不同时撤销
 * （同 revision 不触及 grant）；claim-released / claim-expired 一律撤销。
 */
export function evaluateExecutionGrantRevocation(
  input: EvaluateExecutionGrantRevocationInput,
): ExecutionGrantRevocationDecision {
  if (input.grant.state === 'revoked') return { kind: 'keep' };
  if (
    input.cause === 'task-revised'
    && input.currentTaskRevision !== undefined
    && input.grant.taskRevision === input.currentTaskRevision
  ) {
    return { kind: 'keep' };
  }
  return { kind: 'revoke', reason: input.cause, revokedAt: input.now };
}
