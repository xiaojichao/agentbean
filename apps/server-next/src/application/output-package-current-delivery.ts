import type {
  OutputPackageRecord,
  OutputPackageRepository,
} from './output-package-repositories.js';

/**
 * 分页查找当前受管 delivery 的 OutputPackage，避免固定窗口把旧包误判成“无文件交付”。
 * `hasManagedHistory` 用于区分从未进入文件包流程的兼容旧任务与当前包投影缺失。
 */
export async function findCurrentManagedOutputPackage(
  repository: OutputPackageRepository,
  input: {
    teamId: string;
    channelId: string;
    taskId: string;
    taskRevision: number;
    taskAttempt: number;
  },
): Promise<{ record: OutputPackageRecord | null; hasManagedHistory: boolean }> {
  const limit = 50;
  let cursor: { createdAt: number; packageId: string } | undefined;
  let hasManagedHistory = false;
  while (true) {
    const page = await repository.listPackagesByChannel({
      teamId: input.teamId,
      channelId: input.channelId,
      taskId: input.taskId,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    for (const record of page) {
      if (record.taskBinding !== 'managed') continue;
      hasManagedHistory = true;
      if (record.taskRevision === input.taskRevision
        && record.taskAttempt === input.taskAttempt) {
        return { record, hasManagedHistory };
      }
    }
    if (page.length < limit) return { record: null, hasManagedHistory };
    const last = page[page.length - 1]!;
    cursor = { createdAt: last.createdAt, packageId: last.packageId };
  }
}
