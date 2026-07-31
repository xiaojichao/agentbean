import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

/**
 * Agent descriptor 扫描器。
 *
 * 读取 Agent 工作目录的 AGENTS.md（或 CLAUDE.md 兜底），提取结构化自描述：
 * name / description / capabilities。这些信息是 Agent 能力的「事实层」，
 * 作为 Agent Exposure 发布时的候选来源（#710 系列）。
 *
 * 关键约束：AGENTS.md/CLAUDE.md 是 claude-code/codex 等运行时的生态指令文件，
 * 我们【不修改、也不要求用户往里面写任何自定义字段】。capabilities 必须从
 * 文件内容中提取（extract），而非依赖用户声明。
 *
 * 提取策略：
 * - name：frontmatter name 优先（生成工具常写），正文首个一级标题（# xxx）兜底。
 * - description：frontmatter description 优先（产品预填以此为默认），正文首个
 *   非空段落兜底。
 * - capabilities：从正文能力小节提取——识别 `## Capabilities` / `## 能力` /
 *   `## Skills` 等标题，取其下 markdown 列表项（`- xxx`）。无匹配小节 → 空数组。
 *   frontmatter 中的 capabilities 字段【不读取】（非生态标准，避免变相要求改文件）。
 * - 任何解析失败返回 null（与 skill-scanner 的 fail-closed 一致）。
 */

const MAX_DESCRIPTION = 2000;
const MAX_CAPABILITIES = 100;
/** rawContent 截断上限：典型 AGENTS.md 1-5KB，8KB 覆盖绝大多数（LLM 总结输入）。 */
const MAX_RAW_CONTENT = 8000;

export interface AgentDescriptor {
  /** 从 AGENTS.md/CLAUDE.md 提取的 Agent 名称。 */
  name: string | null;
  /** 简介（正文首段，frontmatter 兼容），截断到 MAX_DESCRIPTION。 */
  description: string | null;
  /** 从正文能力小节提取的能力清单（确定性快路径）。小写折叠去重。 */
  capabilities: string[];
  /** LLM 总结结果：daemon 侧恒为空，由 server 异步总结后写回（契约占位）。 */
  capabilitiesSummarized: string[];
  /** AGENTS.md/CLAUDE.md 全文（截断到 MAX_RAW_CONTENT），供 server 异步 LLM 总结。 */
  rawContent: string | null;
  /** sha256(rawContent)，LLM 总结缓存 key（内容未变不重跑）。 */
  contentHash: string | null;
  /** 实际读到的文件路径（AGENTS.md 优先，否则 CLAUDE.md）。 */
  sourcePath: string | null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** 从正文提取一级标题作为 name：首个 `# xxx` 行。 */
function extractTitle(raw: string): string | null {
  const match = raw.match(/^#\s+(.+)$/m);
  if (!match) return null;
  const title = match[1]!.trim();
  return title.length > 0 ? title : null;
}

/** 从正文提取首个非空段落作为 description（跳过 frontmatter/标题/代码块）。 */
function extractFirstParagraph(raw: string): string | null {
  // 先剥离 frontmatter 块（--- 开头到 --- 结尾），避免把 YAML 当成正文段落。
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = body.split(/\r?\n/);
  let paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过空行、标题（#）、列表项（-/*）、代码围栏。
    if (!trimmed || /^#/.test(trimmed) || /^[-*]\s/.test(trimmed) || trimmed.startsWith('```')) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  const text = paragraph.join(' ').trim();
  return text.length > 0 ? truncate(text, MAX_DESCRIPTION) : null;
}

/** 能力小节标题（大小写不敏感匹配）。用户可以用任意一个组织能力清单。 */
const CAPABILITY_SECTION_TITLES = [
  'capabilities',
  '能力',
  '技能',
  'skills',
  '我能做什么',
  'what i can do',
  '职责',
  'responsibilities',
];

/** 从正文能力小节提取列表项作为 capabilities（小写折叠去重，最多 MAX_CAPABILITIES）。 */
function extractCapabilitiesFromBody(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let inSection: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^#{2,4}\s+(.+)$/);
    if (heading) {
      const title = heading[1]!.trim().toLowerCase();
      inSection = CAPABILITY_SECTION_TITLES.some((known) => title.includes(known.toLowerCase()))
        ? title
        : null;
      continue;
    }
    if (!inSection) continue;
    const item = trimmed.match(/^[-*]\s+(.+)$/);
    if (!item) {
      // 小节内非列表内容（说明文字等）跳过；遇到新标题由 heading 分支重置。
      continue;
    }
    const lower = item[1]!.trim().toLowerCase();
    if (lower && !out.includes(lower)) {
      out.push(lower);
      if (out.length >= MAX_CAPABILITIES) break;
    }
  }
  return out;
}

/** frontmatter 兼容读取：仅 name/description（生成工具可能写入，非标准字段不做强依赖）。 */
function readFrontmatterMeta(raw: string): { name?: string; description?: string } | null {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  try {
    const parsed = parseYaml(fmMatch[1]!);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const front = parsed as { name?: unknown; description?: unknown };
    return {
      name: typeof front.name === 'string' && front.name.trim() ? front.name.trim() : undefined,
      description: typeof front.description === 'string'
        ? truncate(front.description.trim(), MAX_DESCRIPTION)
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 读取指定目录下的 AGENTS.md（优先）或 CLAUDE.md（兜底），提取 descriptor。
 * 目录不存在 / 两个文件都不存在 / 解析失败 → null（调用方自行降级为空）。
 */
export function scanAgentDescriptor(cwd: string): AgentDescriptor | null {
  const candidates = ['AGENTS.md', 'CLAUDE.md'];
  for (const candidate of candidates) {
    const path = join(cwd, candidate);
    let raw: string;
    try {
      if (!existsSync(path)) continue;
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    const front = readFrontmatterMeta(raw);
    const rawContent = truncate(raw, MAX_RAW_CONTENT);
    return {
      // name/description：frontmatter 优先（产品预填默认值），正文兜底。
      name: front?.name ?? extractTitle(raw) ?? null,
      description: front?.description ?? extractFirstParagraph(raw) ?? null,
      // capabilities：只从正文能力小节提取，不读 frontmatter（生态文件无此标准字段）。
      capabilities: extractCapabilitiesFromBody(raw),
      // LLM 总结由 server 异步完成，daemon 恒为空数组。
      capabilitiesSummarized: [],
      // 全文供 server 异步 LLM 总结（内容 hash 做缓存 key，未变不重跑）。
      rawContent,
      contentHash: createHash('sha256').update(rawContent, 'utf8').digest('hex'),
      sourcePath: path,
    };
  }
  return null;
}

/** 过滤并截断 capabilities（与 skill-scanner MAX_SKILLS 同风格）。 */
export function sanitizeCapabilities(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const lower = value.trim().toLowerCase();
    if (lower && !out.includes(lower)) out.push(lower);
    if (out.length >= MAX_CAPABILITIES) break;
  }
  return out;
}
