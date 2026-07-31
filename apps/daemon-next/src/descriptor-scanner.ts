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
 * 格式策略：
 * - frontmatter 优先：`---` 包裹的 YAML，字段 name/description/capabilities(string[])。
 * - 正文兜底（生态大量 AGENTS.md 是纯正文，如仓库根）：一级标题（# xxx）取 name，
 *   首个非空段落取 description。无 capabilities 时返回空数组。
 * - 任何解析失败返回 null（与 skill-scanner 的 fail-closed 一致）。
 */

const MAX_DESCRIPTION = 2000;
const MAX_CAPABILITIES = 100;

export interface AgentDescriptor {
  /** 从 AGENTS.md/CLAUDE.md 提取的 Agent 名称。 */
  name: string | null;
  /** 简介（frontmatter description 或首个段落），截断到 MAX_DESCRIPTION。 */
  description: string | null;
  /** 声明的能力清单（frontmatter capabilities 或空）。小写折叠去重。 */
  capabilities: string[];
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

/** 从正文提取首个非空段落作为 description（跳过标题与代码块，最多 3 段探测）。 */
function extractFirstParagraph(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  const text = paragraph.join(' ').trim();
  return text.length > 0 ? truncate(text, MAX_DESCRIPTION) : null;
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

    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      let front: { name?: unknown; description?: unknown; capabilities?: unknown } | null = null;
      try {
        const parsed = parseYaml(fmMatch[1]!);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          front = parsed as { name?: unknown; description?: unknown; capabilities?: unknown };
        }
      } catch {
        front = null;
      }
      if (front) {
        const name = typeof front.name === 'string' ? front.name.trim() : null;
        const description = typeof front.description === 'string'
          ? truncate(front.description.trim(), MAX_DESCRIPTION)
          : null;
        const rawCaps = Array.isArray(front.capabilities) ? front.capabilities : [];
        const capabilities: string[] = [];
        for (const cap of rawCaps) {
          if (typeof cap !== 'string') continue;
          const lower = cap.trim().toLowerCase();
          if (lower && !capabilities.includes(lower)) capabilities.push(lower);
        }
        return {
          name: name && name.length > 0 ? name : extractTitle(raw),
          description,
          capabilities,
          sourcePath: path,
        };
      }
    }

    // 无 frontmatter（或 frontmatter 非法）：正文兜底。
    return {
      name: extractTitle(raw),
      description: extractFirstParagraph(raw),
      capabilities: [],
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
