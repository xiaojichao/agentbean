import type { ChannelArchivePreflightItemDto } from '@agentbean/contracts';

/**
 * #1066 AC3/AC6：归档预检清单 item 的文本化（AC11「current/final/... 都有文本标签」同款，
 * 不只依赖颜色/图标）。新增 work kind 必须在此补映射，否则静默不展示。
 */
export function archivePreflightItemLabel(item: ChannelArchivePreflightItemDto): string {
  switch (item.kind) {
    case 'task':
      return `任务: ${item.title ?? item.id} (${item.status})`;
    case 'offer':
      return '待响应 Offer';
    case 'claim':
      return '活跃 Claim';
    case 'lease':
      return '活跃 Lease';
    case 'invocation':
      return '进行中的调用';
    case 'pending_review':
      return `待审核: ${item.title ?? item.id}`;
    case 'pending_review_delivery':
      return `待审核交付: ${item.title ?? item.id}`;
    case 'pending_delivery':
      return `交付处理中: ${item.title ?? item.id}`;
    default:
      return `未归类工作: ${item.id}`;
  }
}
