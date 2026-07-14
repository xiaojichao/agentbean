import type { MessageMentionDto, MessageMetaDto } from '../../../../packages/contracts/src/index.js';
import type { MessageRecord } from './repositories.js';

/** body 里的 @token 正则（与 web extractMentions / renderInlineMarkdown 保持一致）。 */
const MENTION_RE = /@[\p{L}\p{N}_-]+/gu;

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export interface MentionMigration {
  messageId: string;
  /** 补 mentions 后的完整 meta（调用方据此 messages.updateMeta 持久化）。 */
  meta: MessageMetaDto;
}

/**
 * 改名时迁移：给 body 含 @oldName 的消息补 meta.mentions（锁定稳定 agentId），
 * 使旧消息 @提及能跟随改名——渲染用 id 查当前 name（PR#553 路径）。
 *
 * 在 updateAgentConfig 改名那一刻调用：oldName（改名前的 name）→ agentId 是确定的，
 * 不靠 name 反查 id（避免歧义）。已有同偏移 mentions 跳过（幂等，改名二次不翻倍）。
 *
 * 本函数是纯 planner：只产出「哪些消息要补什么 mentions」，不碰 DB。
 * 调用方负责扫描可见频道的消息 + messages.updateMeta 持久化。
 */
export function planMentionMigration(
  messages: readonly MessageRecord[],
  oldName: string,
  agentId: string,
): MentionMigration[] {
  const target = normalizeName(oldName);
  if (!target) return [];
  const out: MentionMigration[] = [];
  for (const msg of messages) {
    const meta = (msg.meta ?? {}) as MessageMetaDto;
    const mentions: MessageMentionDto[] = Array.isArray(meta.mentions) ? [...meta.mentions] : [];
    let changed = false;
    MENTION_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MENTION_RE.exec(msg.body)) !== null) {
      const name = match[0].slice(1);
      if (normalizeName(name) !== target) continue;
      const start = match.index;
      if (mentions.some((m) => m.start === start)) continue; // 幂等：该偏移已补
      mentions.push({ id: agentId, kind: 'agent', name, start, end: start + match[0].length });
      changed = true;
    }
    if (changed) {
      out.push({ messageId: msg.id, meta: { ...meta, mentions } });
    }
  }
  return out;
}
