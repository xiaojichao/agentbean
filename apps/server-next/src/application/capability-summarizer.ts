/**
 * Agent capability LLM 总结器（混合提取的慢路径）。
 *
 * 背景：capabilities 的确定性提取（能力小节列表项）覆盖不了散文描述的场景。
 * 本模块在机械提取之后，用当前 Active PI Model 对 AGENTS.md/CLAUDE.md 全文做
 * 一次单轮 LLM 总结，产出 capabilitiesSummarized（AI 总结候选，UI 标注
 * 「AI 总结」，用户确认后才随 Exposure 发布——机器幻觉不自动流入）。
 *
 * 设计要点：
 * - 内容 hash 缓存：同一 rawContent（sha256）1h 内不重跑，daemon 5 分钟
 *   rescan 不产生重复调用。
 * - fail-open：模型不可用/超时/输出非法 → 静默跳过（保持 extracted 结果），
 *   绝不影响 Agent 注册主路径。
 * - 无 job/持久化：fire-and-forget，重启丢缓存（下一次 daemon 上报时若 hash
 *   未变则缓存失效会重跑一次，可接受）。
 */

import {
  createOpenAiCompatibleManagementModelAdapter,
  ManagementModelAdapterError,
  type ManagementModelRequest,
  type ManagementModelResponse,
} from '@agentbean/pi-management-runtime';

const SUMMARY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export interface CapabilitySummarizerModelTarget {
  readonly kind: 'available';
  readonly config: { baseUrl: string; modelId: string; timeoutMs: number; maxOutputTokens: number };
  readonly apiKey: string;
}

export interface CapabilitySummarizerDependencies {
  /** 解析当前 Active PI Model 为可调用目标（unavailable → 跳过总结）。 */
  resolveActiveTarget(): Promise<CapabilitySummarizerModelTarget | { kind: 'unavailable'; diagnosticCode: string }>;
  /** 写回 agent 的 summarized 能力。 */
  updateSummarized(
    input: { agentId: string; capabilitiesSummarized: string[]; timestamp: number },
  ): Promise<unknown>;
  clock: { now(): number };
  fetch?: typeof fetch;
}

export interface CapabilitySummarizer {
  summarize(input: {
    agentId: string;
    rawContent: string;
    contentHash: string;
  }): Promise<void>;
}

/** 总结系统提示词：只提取文件中有证据的能力，禁止臆造，输出 JSON。 */
const SUMMARY_SYSTEM_PROMPT = [
  'You are extracting the capabilities of a coding agent from its instruction file (AGENTS.md or CLAUDE.md).',
  'Read the file content. Identify what the agent can do: tools, skills, responsibilities, workflows.',
  'Rules:',
  '- Only include capabilities supported by evidence in the file. NEVER invent or infer capabilities that are not mentioned.',
  '- Prefer concise concrete capability names (2-8 words each), e.g. "code review", "unit test writing", "database schema design".',
  '- Return EXACTLY one JSON object on a single line, no markdown fences, no prose:',
  '{"capabilities": ["...", "..."]}',
  '- 3-12 capabilities. If the file describes no capabilities, return {"capabilities": []}.',
].join('\n');

/** 解析模型输出：finishReason=stop + 单文本 JSON → capabilities。失败返回 null（fail-open）。 */
function parseSummarizedCapabilities(response: ManagementModelResponse): string[] | null {
  if (response.finishReason !== 'stop') return null;
  const texts = response.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text);
  if (texts.length !== 1) return null;
  const raw = texts[0]!.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const list = (parsed as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim();
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= 50) break;
  }
  return out;
}

export function createCapabilitySummarizer(deps: CapabilitySummarizerDependencies): CapabilitySummarizer {
  // 内容 hash → { capabilities, at } 内存缓存。
  const cache = new Map<string, { capabilities: string[]; at: number }>();

  async function summarize(input: { agentId: string; rawContent: string; contentHash: string }): Promise<void> {
    const now = deps.clock.now();
    const cached = cache.get(input.contentHash);
    if (cached && now - cached.at < SUMMARY_CACHE_TTL_MS) {
      // 缓存命中：hash 相同 → 内容未变，直接沿用（不重复调模型）。
      if (cached.capabilities.length > 0) {
        await deps.updateSummarized({ agentId: input.agentId, capabilitiesSummarized: cached.capabilities, timestamp: now });
      }
      return;
    }

    const target = await deps.resolveActiveTarget();
    if (target.kind === 'unavailable') {
      return; // 未配置 Active PI Model → 跳过总结（fail-open）。
    }

    let response: ManagementModelResponse;
    try {
      const adapter = createOpenAiCompatibleManagementModelAdapter({
        id: `capability-summarizer:${input.agentId}`,
        apiKey: target.apiKey,
        baseUrl: target.config.baseUrl,
        modelId: target.config.modelId,
        timeoutMs: target.config.timeoutMs,
        maxOutputTokens: target.config.maxOutputTokens,
        fetch: deps.fetch,
      });
      // Adapter 仅做单次无状态 respond；sessionContext 不被读取，仅满足类型
      // （与 channel-coordination-coordinator 的 EMPTY_SESSION_CONTEXT as never 同模式）。
      const request: ManagementModelRequest = {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        sessionContext: {
          schemaVersion: 1 as const,
          scope: {
            kind: 'managed' as const,
            managementRunId: 'capability-summarizer',
            teamId: 'system',
            channelId: 'system',
            rootMessageId: 'summarizer',
          },
          frozenTarget: { agentId: input.agentId, kind: 'custom' as const },
          visibleThread: { revision: 0, messages: [] },
        } as never,
        messages: [{ role: 'user', content: [{ type: 'text', text: input.rawContent }] }],
        tools: [],
      };
      response = await adapter.respond(request, { callCount: 1 });
    } catch (error) {
      // 模型失败（auth/timeout/5xx/网络）→ 静默跳过，不阻断（fail-open）。
      if (error instanceof ManagementModelAdapterError) {
        console.warn(`capability summarizer skipped (${error.code}): ${input.agentId}`);
      } else {
        console.warn(`capability summarizer skipped: ${input.agentId} ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const capabilities = parseSummarizedCapabilities(response) ?? [];
    cache.set(input.contentHash, { capabilities, at: now });
    if (capabilities.length > 0) {
      await deps.updateSummarized({ agentId: input.agentId, capabilitiesSummarized: capabilities, timestamp: now });
    }
  }

  return { summarize };
}
