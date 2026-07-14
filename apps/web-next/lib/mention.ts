import type { MessageMentionDto } from '@agentbean/contracts';

/** 提及候选成员（频道/团队可见成员，含稳定 id）。 */
export interface MentionMember {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

/** body 里的 @token 正则（与 renderInlineMarkdown 的提及匹配保持一致）。 */
const MENTION_RE = /@[\p{L}\p{N}_-]+/gu;

function normalizeMentionName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 发送时扫描 body，对每个 @token 按 name 匹配当前可见成员，**锁定稳定 id + 偏移**。
 * body 仍存 @name 文本（给 LLM/人读 + 向后兼容）；此处只把「name → id」的解析在发送时固化，
 * 使后续渲染/改名后仍能经 id 找到当前 name。未匹配成员的 @token 不记录（保留为纯文本）。
 */
export function extractMentions(body: string, members: MentionMember[]): MessageMentionDto[] {
  const byName = new Map<string, MentionMember>();
  for (const m of members) {
    // 同名取首个（成员列表已去重；同名歧义 inherent，不在此解决）
    const normalizedName = normalizeMentionName(m.name);
    if (!byName.has(normalizedName)) byName.set(normalizedName, m);
  }
  const out: MessageMentionDto[] = [];
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(body)) !== null) {
    const name = match[0].slice(1);
    const member = byName.get(normalizeMentionName(name));
    if (member) {
      out.push({
        id: member.id,
        kind: member.kind,
        name,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return out;
}

function currentAgentName(
  id: string,
  agents: Record<string, { name?: string }>,
): string | undefined {
  const name = agents[id]?.name;
  return name && name.trim() ? name : undefined;
}

/**
 * 渲染：body 里的 @name（可能是改名前的旧名）经 meta.mentions 锁定的 id 解析为**当前** name。
 * 返回 null 表示该 name 不在 mentions（旧消息/未匹配 → 调用方走 body name 兜底，维持现状）。
 */
export function resolveMentionByName(
  name: string,
  mentions: MessageMentionDto[] | undefined,
  agents: Record<string, { name?: string }>,
): { id: string; kind: 'human' | 'agent'; displayName: string } | null {
  const normalizedName = normalizeMentionName(name);
  const mention = mentions?.find((m) => normalizeMentionName(m.name) === normalizedName);
  if (!mention) return null;
  const displayName = mention.kind === 'agent'
    ? (currentAgentName(mention.id, agents) ?? mention.name)
    : mention.name;
  return { id: mention.id, kind: mention.kind, displayName };
}
