/**
 * ADR-0064 #948-G output slot 解析与 input binding 可解析性 —— 纯规则。
 *
 * 职责：把 ADR-0064「上游 delivery 合法验收后，具名 output slot 解析为不可变 snapshot；
 * 下游通过显式 input binding 使用该 snapshot」收敛为两个可单测的纯决策：
 * - `resolveOutputSlots`：把声明的 output slot 映射为指向已验收 delivery 证据的 EvidenceRef 集合。
 *   evidenceKind 过滤决定哪些已冻结 evidence_snapshots 构成该 slot 的不可变值。
 * - `evaluateInputBindingResolvability`：判定下游声明的 input binding 是否都能解析到上游的
 *   output snapshot。snapshot 缺失（resolver 返回 null）= 上游尚未合法验收 → 下游不可 runnable。
 *
 * 关键不变量：
 * - 不可变性不在本模块实现——它由持久化层保证：output snapshot 存的是 EvidenceRef（含
 *   snapshotHash），而 evidence_snapshots 在 delivery 时已冻结且 hash 绑定 (revision, attempt)。
 *   本模块只决定「该 slot 解析为哪些 ref」「binding 是否解析得到 ref」，不持有/复制 snapshot 数据。
 * - delivery 无证据时 slot 仍 resolved（空 EvidenceRef 集合），**不**判 rejected——合法验收但无证据
 *   是合法输出（例如纯信息性 Task）；rejected 只用于结构性错误（重名）。
 * - resolver 返回 null（缺失）≠ 返回空数组：null 表示上游 snapshot 根本不存在（未验收/无此 slot），
 *   空数组表示 snapshot 存在但无证据（已解析）。
 *
 * 无 server 依赖、无 IO。接线层（kernel）负责预取上游 snapshot 后传入同步 resolver。
 */
import type { EvidenceRefDto, InputBindingDeclarationDto, OutputSlotDeclarationDto } from '@agentbean/contracts';

// ── output slot 解析 ──

export interface ResolveOutputSlotsInput {
  readonly declaredSlots: readonly OutputSlotDeclarationDto[];
  /** 已验收 delivery 的全部 EvidenceRef（来自 SubtaskDeliveryV1.evidenceRefs）。 */
  readonly deliveryEvidenceRefs: readonly EvidenceRefDto[];
}

export interface ResolvedOutputSlot {
  readonly name: string;
  readonly evidenceRefs: readonly EvidenceRefDto[];
}

export type OutputSlotResolutionDecision =
  | { readonly kind: 'resolved'; readonly slots: readonly ResolvedOutputSlot[] }
  | { readonly kind: 'rejected'; readonly reason: 'duplicate-slot-name'; readonly slotName: string };

/**
 * 把声明的 output slot 解析为 EvidenceRef 集合。
 * - 重名 slot → rejected（结构性错误，接线层应 conflict）。
 * - evidenceKind===undefined → 该 slot 解析为 delivery 全部证据（兜底）。
 * - 否则仅保留 kind 匹配的证据。delivery 无证据时解析为空数组（仍 resolved）。
 */
export function resolveOutputSlots(input: ResolveOutputSlotsInput): OutputSlotResolutionDecision {
  const seen = new Set<string>();
  for (const slot of input.declaredSlots) {
    if (seen.has(slot.name)) {
      return { kind: 'rejected', reason: 'duplicate-slot-name', slotName: slot.name };
    }
    seen.add(slot.name);
  }
  const slots: ResolvedOutputSlot[] = input.declaredSlots.map((slot) => ({
    name: slot.name,
    evidenceRefs: slot.evidenceKind === undefined
      ? [...input.deliveryEvidenceRefs]
      : input.deliveryEvidenceRefs.filter((ref) => ref.kind === slot.evidenceKind),
  }));
  return { kind: 'resolved', slots };
}

// ── input binding 可解析性 ──

export interface EvaluateInputBindingResolvabilityInput {
  readonly declaredBindings: readonly InputBindingDeclarationDto[];
  /**
   * 同步解析回调：返回上游 (upstreamTaskId, slotName) 的 output snapshot EvidenceRef 集合，
   * 或 null 表示该 snapshot 不存在（上游未合法验收 / 无此 slot）。调用方（kernel）须先预取
   * 所有上游 snapshot 到内存，再用闭包提供此同步视图——本模块为纯函数，不做 IO。
   */
  readonly resolver: (binding: InputBindingDeclarationDto) => readonly EvidenceRefDto[] | null;
}

export interface InputBindingUnresolved {
  readonly binding: InputBindingDeclarationDto;
  readonly reason: 'upstream-snapshot-missing';
}

export type InputBindingResolvabilityDecision =
  | { readonly kind: 'resolvable' }
  | { readonly kind: 'unresolved'; readonly bindings: readonly InputBindingUnresolved[] }
  | { readonly kind: 'rejected'; readonly reason: 'duplicate-binding-name'; readonly bindingName: string };

/**
 * 判定下游全部 input binding 是否都能解析到上游 output snapshot。
 * - 重名 binding → rejected（结构性错误）。
 * - 任一 binding 的 resolver 返回 null → unresolved，列出全部缺失项（接线层据此 conflict）。
 * - 全部解析（含空证据集）→ resolvable。
 */
export function evaluateInputBindingResolvability(
  input: EvaluateInputBindingResolvabilityInput,
): InputBindingResolvabilityDecision {
  const seen = new Set<string>();
  for (const binding of input.declaredBindings) {
    if (seen.has(binding.name)) {
      return { kind: 'rejected', reason: 'duplicate-binding-name', bindingName: binding.name };
    }
    seen.add(binding.name);
  }
  const unresolved: InputBindingUnresolved[] = [];
  for (const binding of input.declaredBindings) {
    if (input.resolver(binding) === null) {
      unresolved.push({ binding, reason: 'upstream-snapshot-missing' });
    }
  }
  if (unresolved.length > 0) return { kind: 'unresolved', bindings: unresolved };
  return { kind: 'resolvable' };
}
