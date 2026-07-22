import type { FormalMemoryScopeType, TeamMemberRole } from '@agentbean/contracts';

/**
 * Formal Memory 权限纯策略（issue #716）。
 *
 * 与底层 `server-memory-permissions`（按 scope 可见性，不区分角色）正交：本层叠加
 * Team 角色门控——只有 Owner/Admin 可直接管理 Formal Memory（AC#3），任何成员可读
 * Team scope / 本频道 Channel scope（AC#5），任何成员可提交纠错（AC#6）。
 */

/** Owner/Admin 可创建、修订、停用、删除、supersede Formal Memory（AC#3）。 */
export function canManageFormalMemory(role: TeamMemberRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

/** 任何 Team 成员可提交纠错或删除申请（AC#6）；非成员不可。 */
export function canProposeFormalCorrection(role: TeamMemberRole | null): boolean {
  return role !== null;
}

/**
 * 成员可见性（AC#5）：Team Memory 对任何 Team 成员可见；
 * Channel Memory 只对当前频道成员可见。Owner/Admin 因需管理 Team（含 Channel scope）
 * 的 Formal Memory，隐式可读所有频道，避免「可写不可读」的操作不一致。
 */
export function canReadFormalMemory(
  role: TeamMemberRole | null,
  scopeType: FormalMemoryScopeType,
  isChannelMember: boolean,
): boolean {
  if (role === null) return false;
  if (role === 'owner' || role === 'admin') return true;
  return scopeType === 'team' ? true : isChannelMember;
}
