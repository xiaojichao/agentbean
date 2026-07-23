import type { UserRole } from '@agentbean/contracts';

/**
 * System Knowledge 与 User Memory 权限纯策略（issue #717）。
 *
 * 与 Team Formal Memory（#716，按 Team 角色 owner/admin）正交：
 * - System Knowledge 只认系统管理员（`UserRole='admin'`，全局 `users.role`）。
 * - User Memory 只认用户本人（`ownerUserId`），**系统管理员也不豁免**（AC#6：不因
 *   系统管理员身份把 User/Team 内容混入全局知识）。
 *
 * 这是 fail-closed 策略：未知角色 / 不匹配 / 缺参一律拒绝，宁可拒绝合法请求也不
 * 越权放行。
 */

/**
 * System Knowledge 仅系统管理员可创建、修订、停用、删除（AC#1）。
 * 普通用户、未知角色一律 fail-closed。
 */
export function canManageSystemKnowledge(role: UserRole | null | undefined): boolean {
  return role === 'admin';
}

/** System Knowledge 是全局产品知识，对系统管理员可读；普通用户当前不开放读取入口。 */
export function canReadSystemKnowledge(role: UserRole | null | undefined): boolean {
  return role === 'admin';
}

/**
 * User Memory 仅用户本人可管理（AC#3）。**系统管理员不豁免**：admin 不能管理他人
 * 的 User Memory（AC#6 fail-closed，防止个人偏好被混入全局知识通路）。
 */
export function canManageUserMemory(
  actorUserId: string | null | undefined,
  ownerUserId: string | null | undefined,
): boolean {
  if (!actorUserId || !ownerUserId) return false;
  return actorUserId === ownerUserId;
}

/** User Memory 读取同样仅限本人（AC#6：跨 scope 读取 fail-closed）。 */
export function canReadUserMemory(
  actorUserId: string | null | undefined,
  ownerUserId: string | null | undefined,
): boolean {
  return canManageUserMemory(actorUserId, ownerUserId);
}
