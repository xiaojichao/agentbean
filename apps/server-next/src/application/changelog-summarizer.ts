/**
 * 每日更新日志 LLM 兜底总结器（内置 PI Manager / Active PI Model）。
 *
 * 背景：PR body 未写 `## 用户向更新` 小节时，由本模块对 PR 信息做单轮 LLM
 * 总结，产出用户向条目（新功能/改进/修复），供每日 changelog 流水线写入。
 *
 * 设计要点：
 * - 复用 capability-summarizer 的 resolveActiveTarget 通道：credential 由
 *   Server 管理，CI 与仓库不接触模型密钥。
 * - fail-open：模型不可用/超时/输出非法 → 该 PR 空条目，绝不阻断每日流水线。
 * - 无缓存：每日只跑一次、PR 量小，不引入缓存复杂度。
 * - 输出契约：LLM 直接输出 JSON（与 capability-summarizer 一致），Server 侧
 *   解析后才返回 CI，CI 不接触模型原始输出。
 */

import {
  createOpenAiCompatibleManagementModelAdapter,
  ManagementModelAdapterError,
  type ManagementModelRequest,
  type ManagementModelResponse,
} from '@agentbean/pi-management-runtime';

export type ChangelogEntryType = '新功能' | '改进' | '修复';
export interface ChangelogEntry {
  type: ChangelogEntryType;
  text: string;
}

export interface ChangelogPullInput {
  number: number;
  title: string;
  body: string;
}

export interface ChangelogSummarizeResult {
  number: number;
  entries: ChangelogEntry[];
}

export interface ChangelogSummarizerModelTarget {
  readonly kind: 'available';
  readonly config: { baseUrl: string; modelId: string; timeoutMs: number; maxOutputTokens: number };
  readonly apiKey: string;
}

export interface ChangelogSummarizerDependencies {
  /** 解析当前 Active PI Model 为可调用目标（unavailable → 全部空条目）。 */
  resolveActiveTarget(): Promise<ChangelogSummarizerModelTarget | { kind: 'unavailable'; diagnosticCode: string }>;
  fetch?: typeof fetch;
}

export interface ChangelogSummarizer {
  summarize(pulls: ChangelogPullInput[]): Promise<ChangelogSummarizeResult[]>;
}

const SUMMARIZE_SYSTEM_PROMPT = [
  'You are the release-notes author of the AgentBean product.',
  'For each pull request described below, decide whether the change has a visible impact on end users.',
  'Rules:',
  '- If the change has NO user-visible impact (internal refactor, infrastructure, docs, tests), return an empty entries array for that PR.',
  '- Otherwise write 1-3 concise user-facing entries. NEVER invent features that are not supported by the PR.',
  '- Entry types must be exactly one of: 新功能 (new feature), 改进 (improvement, incl. performance), 修复 (bug fix).',
  '- The text must be user-facing Chinese, free of commit messages, issue numbers, or internal slice/ADR terms.',
  '- Return EXACTLY one JSON object on a single line, no markdown fences, no prose:',
  '{"number": <pr number>, "entries": [{"type": "新功能", "text": "<one sentence>"}]}',
].join('\n');

/** 解析模型输出：finishReason=stop + 单文本 JSON → entries。失败返回 []（fail-open）。 */
function parseSummarizeResponse(response: ManagementModelResponse): ChangelogEntry[] {
  if (response.finishReason !== 'stop') return [];
  const texts = response.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text);
  if (texts.length !== 1) return [];
  const raw = texts[0]!.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const list = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(list)) return [];
  const out: ChangelogEntry[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const type = (item as { type?: unknown }).type;
    const text = (item as { text?: unknown }).text;
    if ((type === '新功能' || type === '改进' || type === '修复') && typeof text === 'string' && text.trim()) {
      out.push({ type, text: text.trim() });
    }
  }
  return out;
}

export function createChangelogSummarizer(deps: ChangelogSummarizerDependencies): ChangelogSummarizer {
  async function summarize(pulls: ChangelogPullInput[]): Promise<ChangelogSummarizeResult[]> {
    const target = await deps.resolveActiveTarget();
    if (target.kind === 'unavailable') {
      return pulls.map((pull) => ({ number: pull.number, entries: [] }));
    }

    const results: ChangelogSummarizeResult[] = [];
    for (const pull of pulls) {
      let response: ManagementModelResponse;
      try {
        const adapter = createOpenAiCompatibleManagementModelAdapter({
          id: `changelog-summarizer:${pull.number}`,
          apiKey: target.apiKey,
          baseUrl: target.config.baseUrl,
          modelId: target.config.modelId,
          timeoutMs: target.config.timeoutMs,
          maxOutputTokens: target.config.maxOutputTokens,
          fetch: deps.fetch,
        });
        // Adapter 仅做单次无状态 respond；sessionContext 不被读取，仅满足类型
        // （与 capability-summarizer 的 as never 同模式）。
        const request: ManagementModelRequest = {
          systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
          sessionContext: {
            schemaVersion: 1 as const,
            scope: {
              kind: 'managed' as const,
              managementRunId: 'changelog-summarizer',
              teamId: 'system',
              channelId: 'system',
              rootMessageId: 'summarizer',
            },
            frozenTarget: { agentId: 'changelog', kind: 'custom' as const },
            visibleThread: { revision: 0, messages: [] },
          } as never,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `PR #${pull.number}: ${pull.title}\n\n${(pull.body ?? '').slice(0, 3000)}`,
                },
              ],
            },
          ],
          tools: [],
        };
        response = await adapter.respond(request, { callCount: 1 });
      } catch (error) {
        // 模型失败（auth/timeout/5xx/网络）→ 空条目，不阻断（fail-open）。
        if (error instanceof ManagementModelAdapterError) {
          console.warn(`changelog summarizer skipped (${error.code}): PR #${pull.number}`);
        } else {
          console.warn(`changelog summarizer skipped: PR #${pull.number} ${error instanceof Error ? error.message : String(error)}`);
        }
        results.push({ number: pull.number, entries: [] });
        continue;
      }
      results.push({ number: pull.number, entries: parseSummarizeResponse(response) });
    }
    return results;
  }

  return { summarize };
}
