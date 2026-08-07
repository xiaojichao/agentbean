import { createHash } from 'node:crypto';
import { createReadStream, type Dirent, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_ARTIFACT_MAX_BYTES,
  type ArtifactRole,
  type ArtifactSourceRootDto,
  type SkippedArtifactDiagnostic,
} from '../../../packages/contracts/src/index.js';

const OUTPUT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)$/i;
/**
 * Adapter 默认产物根的扩展名白名单：只收集看起来像交付物的文档/图片/归档，
 * 排除 .json/.csv 等最容易承载配置、会话与状态的文件，避免把 AgentOS
 * 数据目录里的内部状态（pairing/sessions/checkpoints 等）上传到频道。
 */
const ADAPTER_OUTPUT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|md|mp4|mov|zip)$/i;
/**
 * Agent 回复中明确报告的交付文件绝对路径。AgentOS oneshot（Hermes/OpenClaw）
 * 会把交付文件写到任意位置并在回复里报告路径；解析这些路径比猜目录更可靠。
 * #1053：只接受明确交付语境（"已生成/已保存/交付/输出"等，或交付标题小节/
 * 交付声明冒号换行等结构化交付声明）中的路径；仅作为引用、来源或参考资料
 * 出现的路径不得进入输出候选。支持带引号且包含空格的 Unix 绝对路径与
 * Windows 绝对交付路径；收集阶段再做 realpath/窗口/大小/敏感名/隐藏段/
 * symlink 安全校验。
 */
const REPORTED_PATH_EXT = '(?:md|txt|pdf|png|jpe?g|gif|webp|svg|mp4|mov|zip)';
/** 引号（含中文弯引号）包裹的绝对路径：允许空格，不允许跨行。 */
const QUOTED_REPORTED_PATH_RE = new RegExp(
  `["'“”‘’]((?:\\/[^"'“”‘’\\n]*?|[A-Za-z]:[\\\\/][^"'“”‘’\\n]*?)\\.${REPORTED_PATH_EXT})(?![A-Za-z0-9])["'“”‘’]`,
  'gi',
);
/** 未加引号的 Unix 绝对路径（不含空格）。 */
const UNIX_REPORTED_PATH_RE = new RegExp(
  `(?<![A-Za-z0-9_./])(\\/[^\\s"'<>|\`]+?\\.${REPORTED_PATH_EXT})(?![A-Za-z0-9])`,
  'gi',
);
/** 未加引号的 Windows 绝对路径（盘符 + 分隔符，不含空格；含空格须加引号）。 */
const WINDOWS_REPORTED_PATH_RE = new RegExp(
  `(?<![A-Za-z0-9_./\\\\:])([A-Za-z]:[\\\\/][^\\s"'<>|\`]+?\\.${REPORTED_PATH_EXT})(?![A-Za-z0-9])`,
  'gi',
);
/**
 * Agent 回复中报告的交付目录绝对路径（尾斜杠）。Agent 常把一批交付物写入一个目录
 * （如 ~/Desktop/项目/）并在回复里报告该目录路径；目录路径几乎必然是交付位置
 * （引用/来源语境指向的几乎总是具体文件，不会是目录），故提取门槛较文件路径放宽：
 * 不要求白名单扩展名，语境门降为「非明确引用语境」。负向前瞻 (?![A-Za-z0-9])
 * 确保不会把文件路径（如 /a/b/c.md）的前缀目录误当目录提取。
 */
const UNIX_REPORTED_DIR_RE = /(?<![A-Za-z0-9_./])(\/[^\s"'<>|`]+\/)(?=\s|["'“”‘’<>|，。；;！!？?,)]|`|$)/gi;
const WINDOWS_REPORTED_DIR_RE = /(?<![A-Za-z0-9_./\\:])([A-Za-z]:[\\/][^\s"'<>|`]+?[\\/])(?=\s|["'“”‘’<>|，。；;！!？?,)]|`|$)/gi;
const QUOTED_REPORTED_DIR_RE = /["'“”‘’]((?:\/[^"'“”‘’\n]*?\/|[A-Za-z]:[\\/][^"'“”‘’\n]*?[\\/]))(?![A-Za-z0-9])["'“”‘’]/gi;

/** reported 路径是否为目录候选（尾斜杠结尾，Unix 或 Windows 分隔符）。 */
function isReportedDirectoryPath(raw: string): boolean {
  return /[\\/]$/.test(raw);
}
/**
 * 交付语境关键词：路径所在分句必须含交付动词/交付名词，或处于交付标题小节、
 * 交付声明冒号的下一行。引用/来源语境优先排除（codex P1：整行级判断会把
 * 「参考 "/tmp/customer data.pdf"，输出已经完成」里的引用路径误当交付物）。
 */
const DELIVERY_CONTEXT_RE = new RegExp(
  [
    '已生成', '已保存', '已写入', '已交付', '已创建', '已整理',
    '保存到', '保存在', '保存于', '写入到', '写出到', '生成到', '生成于',
    '交付', '输出',
    // 「文件路径：/…」是 AgentOS oneshot（Hermes 等）惯用的交付声明标签：
    // 路径与标签同行内联出现，交付动词在上一句（以句号结尾，够不到
    // 「交付声明冒号换行」规则）。引用语境仍由 REFERENCE_CONTEXT_RE 优先排除。
    '文件路径',
    '\\bgenerated\\b', '\\bsaved\\b', '\\bwritten\\b', '\\bwrote\\b', '\\bcreated\\b',
    '\\bdelivered\\b', '\\bexported\\b', '\\bproduced\\b', '\\bdeliverables?\\b', '\\boutputs?\\b',
    '\\bfile path\\b',
  ].join('|'),
  'i',
);
/** 引用/来源语境：与路径同分句出现时优先于交付词排除该路径。 */
const REFERENCE_CONTEXT_RE = /参考|来源|引用|参阅|参见|来自|\bbased on\b|\breference(?:d|s)?\b|\bsource[sd]?\b|\bsee\b/i;
/** 分句边界：中英文逗号、句号、分号、感叹、问号。 */
const CLAUSE_BOUNDARY_RE = /[，,。;；！!？?]/;
/**
 * 显式敏感文件名防线：即使扩展名落在交付物白名单内（credentials.md、id_rsa.txt），
 * 也永远不得作为交付物发布。隐藏目录（.ssh/.gnupg/.aws）由隐藏路径段规则兜底。
 */
const SENSITIVE_REPORTED_BASENAME_RE = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|known_hosts|credentials?|secrets?)(\.|$)/i;
const IGNORED_OUTPUT_DIRS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.turbo', 'node_modules', 'vendor', '.agentbean',
]);
const MAX_OUTPUT_FILES_PER_ROOT = 2000;
export type ArtifactSourceRootKind = Exclude<ArtifactSourceRootDto['kind'], 'legacy_run'>;
export type { ArtifactRole };

export interface ArtifactSourceRoot {
  id: string;
  kind: ArtifactSourceRootKind;
  label: string;
}

/**
 * Agent 回复报告的交付文件来源根：稳定 id 供本机审计；kind=run_output 使报告
 * 文件只进入受管 run output 通道（`outputs/<publishIdentity>` → Server 原子发布），
 * 不会走 legacy upload 直接创建频道 Artifact（#1045）。
 */
export const REPORTED_OUTPUT_SOURCE_ROOT: ArtifactSourceRoot = {
  id: 'agent-reported-outputs',
  kind: 'run_output',
  label: 'Agent 报告的输出',
};

export interface CollectedArtifact {
  absolutePath: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
  sourceRoot: ArtifactSourceRoot;
  role: ArtifactRole;
}

/**
 * Adapter 级默认产物根：只扫声明的目录，配合 mtime > startedAt 过滤。
 * recursive=false 表示只收集该目录顶层文件（不进入子目录），用于安全地
 * 覆盖 AgentOS 数据根目录顶层的交付文件，而不会递归进会话/状态子目录。
 */
export interface AdapterOutputRoot {
  dir: string;
  recursive: boolean;
  /**
   * 共享目录（如用户主目录顶层）：只收集 run 窗口内新建的文件，
   * 避免把其他进程在窗口内修改的既有文件当作产物上传。
   */
  createdInWindow?: boolean;
}

/**
 * 窗口过滤：mtime 必须落在 run 窗口内；当 createdInWindow=true 时，
 * 还要求文件是在窗口内新建的（birthtime > startedAt，允许少量偏差），
 * 平台不提供 birthtime（<=0）时退化为仅按 mtime 判断。
 */
export function shouldCollectWindowedFile(input: {
  mtimeMs: number;
  birthtimeMs: number;
  startedAt: number;
  createdInWindow?: boolean;
  birthtimeSkewMs?: number;
}): boolean {
  if (input.mtimeMs <= input.startedAt) {
    return false;
  }
  if (!input.createdInWindow) {
    return true;
  }
  if (input.birthtimeMs <= 0) {
    return true;
  }
  const skew = input.birthtimeSkewMs ?? 30_000;
  return input.birthtimeMs > input.startedAt - skew;
}

export interface CollectArtifactsInput {
  /** per-run outputs/ directory; all matching files are collected regardless of mtime. */
  outputDir?: string;
  /** customAgent.cwd; fallback scan picks matching files with mtime > startedAt. */
  cwd?: string;
  /** Extra output roots such as Codex-native generated_images; mtime filtered. */
  extraOutputDirs?: string[];
  /**
   * Adapter 默认产物根（如 Hermes/OpenClaw 的数据目录顶层与 output/）。
   * 与 extraOutputDirs 相同地按 mtime 过滤，但只使用交付物扩展名白名单，
   * 且跳过隐藏文件/目录，避免把 AgentOS 内部状态当作产物上传。
   */
  adapterOutputRoots?: AdapterOutputRoot[];
  /**
   * Agent 回复中明确报告的交付文件绝对路径（extractReportedOutputPaths 的输出）。
   * 每条路径经 realpath 解析后校验：交付物扩展名白名单、非隐藏路径段、非
   * .agentbean 内部、不在 reportedOutputExcludedPathPrefixes 内、非敏感文件名、
   * 严格 run 窗口（mtime 与 birthtime 均在窗口内）、大小上限。通过校验的文件
   * 以 REPORTED_OUTPUT_SOURCE_ROOT（kind=run_output）归入受管 run output。
   * 明确声明优先于猜测兜底（#1051）：与 adapter/configured/cwd 扫描结果按绝对
   * 路径或 sha256 撞车时，非受管旧条目被移除，由 reported 版本接替发布。
   */
  reportedOutputPaths?: string[];
  /**
   * 报告路径的拒绝前缀（realpath 后比较）：传入 agentBeanHome 与 run inputDir
   * 等本机投影边界，确保 snapshot、输入附件、日志与内部状态永远不会因为
   * Agent 在回复里报告了路径就进入发布。
   */
  reportedOutputExcludedPathPrefixes?: string[];
  /** Additional roots with safe public labels; absolute paths never leave the daemon. */
  configuredOutputRoots?: Array<{ id?: string; path: string; label: string; envVar?: string; defaultRole?: ArtifactRole; recursive?: boolean }>;
  /** Stable public label for the agent workspace root. */
  workspaceLabel?: string;
  /** command start timestamp (ms); used as mtime threshold for the cwd fallback. */
  startedAt: number;
  /** Maximum artifact bytes to hash/read; defaults to server upload cap. */
  maxBytes?: number;
  /** Reports files that could not be collected without silently omitting them. */
  onSkipped?: (artifact: SkippedArtifactDiagnostic, sourceRoot: ArtifactSourceRoot) => void;
  /** Stable, path-free diagnostics for Run details and logs. */
  onDiagnostic?: (diagnostic: ArtifactCollectionDiagnostic) => void;
}

export interface ArtifactCollectionDiagnostic {
  code: 'SOURCE_ROOT_MISSING' | 'SOURCE_ROOT_INVALID' | 'SOURCE_ROOT_UNREADABLE' | 'ARTIFACT_FILE_UNREADABLE' | 'ARTIFACT_FILE_TOO_LARGE' | 'ARTIFACT_FILE_LIMIT_REACHED' | 'REPORTED_PATH_REJECTED';
  sourceRootId: string;
  sourceRootLabel: string;
  relativePath?: string;
}

/**
 * 从 Agent 回复正文提取明确报告的交付文件绝对路径，去重保序。
 * #1053：候选路径必须通过两道门——
 * 1) 交付语境：与"已生成/已保存/交付/输出"等交付词同行，或在交付标题小节
 *    内，或是交付声明冒号的下一行；仅作为引用、来源或参考资料出现的路径
 *    不进入候选；
 * 2) 结构校验：本机绝对路径（Unix 或 Windows 盘符）、交付物扩展名白名单、
 *    拒绝路径穿越（`..`）与隐藏路径段（`.` 开头段）。
 * 其余安全校验（realpath/时间窗口/大小/敏感文件名/排除前缀/symlink）在收集
 * 阶段对 realpath 进行（见 collectArtifacts 的 reportedOutputPaths 处理）。
 */
export function extractReportedOutputPaths(body: string | undefined): string[] {
  if (!body) return [];
  const lines = body.split('\n');
  const lineStarts: number[] = [];
  {
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
  }
  const lineIndexOf = (position: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid]! <= position) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const seen = new Set<string>();
  const paths: string[] = [];
  const accept = (raw: string | undefined, matchText: string | undefined, position: number | undefined): void => {
    if (!raw || matchText === undefined || position === undefined) return;
    const pathStart = position + matchText.indexOf(raw);
    const lineIndex = lineIndexOf(pathStart);
    const colStart = pathStart - lineStarts[lineIndex]!;
    // 紧接盘符冒号的 / 是 Windows 路径（C:/...）的组成部分，不当 Unix 绝对路径重复提取。
    if (raw.startsWith('/') && pathStart >= 2
      && body[pathStart - 1] === ':' && /[A-Za-z]/.test(body[pathStart - 2] ?? '')
      && (pathStart === 2 || !/[A-Za-z0-9_./\\]/.test(body[pathStart - 3] ?? ''))) {
      return;
    }
    const candidate = raw.trim().replace(/[。，,;；:：)）\]」』》]+$/u, '');
    if (!isPlausibleReportedPath(candidate)) return;
    const colEnd = colStart + raw.length;
    if (isReportedDirectoryPath(candidate)) {
      // 目录候选：仅引用语境才拒绝（目录几乎必为交付位置，不要求交付词）。
      if (isInReferenceContextAt(lines, lineIndex, colStart, colEnd)) return;
    } else if (!isDeliveryContextAt(lines, lineIndex, colStart, colEnd)) {
      return;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      paths.push(candidate);
    }
  };
  for (const match of body.matchAll(QUOTED_REPORTED_PATH_RE)) accept(match[1], match[0], match.index);
  for (const match of body.matchAll(UNIX_REPORTED_PATH_RE)) accept(match[1], match[0], match.index);
  for (const match of body.matchAll(WINDOWS_REPORTED_PATH_RE)) accept(match[1], match[0], match.index);
  for (const match of body.matchAll(QUOTED_REPORTED_DIR_RE)) accept(match[1], match[0], match.index);
  for (const match of body.matchAll(UNIX_REPORTED_DIR_RE)) accept(match[1], match[0], match.index);
  for (const match of body.matchAll(WINDOWS_REPORTED_DIR_RE)) accept(match[1], match[0], match.index);
  return paths;
}

/** 结构化校验：绝对路径（Unix/Windows）、无穿越、无隐藏段、扩展名白名单。 */
function isPlausibleReportedPath(raw: string): boolean {
  if (!raw || raw.startsWith('//') || raw.endsWith('.') || raw.includes('..')) return false;
  const isWindows = /^[A-Za-z]:[\\/]/.test(raw);
  if (!isWindows && !raw.startsWith('/')) return false;
  const segments = raw.split(isWindows ? /[\\/]/ : '/');
  // reported 通道第一关：只放行已知 agent 数据目录段（.hermes/.openclaw），其余 hidden 段
  // （.ssh/.gnupg/.secret/dotfile）拒——信任 agent 声明的生成物位置，防泄漏未知隐藏目录。
  if (segments.some((segment) => segment.startsWith('.') && !AGENT_DATA_DIRS.has(segment))) return false;
  // 目录路径（尾斜杠）跳过扩展名要求；文件路径仍要求白名单扩展名。
  if (/[\\/]$/.test(raw)) return true;
  return ADAPTER_OUTPUT_FILE_EXT_RE.test(raw);
}

/**
 * 交付语境判定（codex P1 修复：绑定到路径所在分句，而非整行）——
 * 1) 路径所在分句（标点切分）含交付词；动词可前置（"已生成 /a.md"）或
 *    后置（"/a.md 已生成"）；同分句出现 参考/来源/引用 等引用词时优先排除；
 * 2) 上方最近非空行以冒号收尾且含交付词（"报告已生成："换行/空行后给路径）；
 *    或路径整行裸写（除路径与收尾标点外无其他文字）——agent 措辞变体
 *    （"已经生成在："/"写到了："）不可枚举，冒号声明行 + 裸路径行本身就是
 *    结构化交付声明；引用语境（"参考："/"来自："）仍优先排除；
 * 3) 最近的 markdown 标题含交付词（交付小节内的列表项）。
 */
function isDeliveryContextAt(lines: readonly string[], index: number, colStart: number, colEnd: number): boolean {
  const line = lines[index] ?? '';
  let clauseStart = 0;
  for (let i = colStart - 1; i >= 0; i -= 1) {
    if (CLAUSE_BOUNDARY_RE.test(line[i]!)) { clauseStart = i + 1; break; }
  }
  let clauseEnd = line.length;
  for (let i = colEnd; i < line.length; i += 1) {
    if (CLAUSE_BOUNDARY_RE.test(line[i]!)) { clauseEnd = i; break; }
  }
  const clauseBefore = line.slice(clauseStart, colStart);
  const clauseAfter = line.slice(colEnd, clauseEnd);
  if (!REFERENCE_CONTEXT_RE.test(clauseBefore)
    && (DELIVERY_CONTEXT_RE.test(clauseBefore) || DELIVERY_CONTEXT_RE.test(clauseAfter))) {
    return true;
  }
  // 裸路径行：整行 trim 后去掉收尾标点即路径本身（允许引号包裹）。
  const bareLine = line.trim().replace(/[。.;；,，]+$/, '');
  const matched = line.slice(colStart, colEnd);
  const isBarePathLine = bareLine === matched
    || bareLine === matched.replace(/^["'“”‘’]|["'“”‘’]$/g, '');
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = lines[i]!.trim();
    if (!previous) continue;
    if (/[:：]$/.test(previous) && !REFERENCE_CONTEXT_RE.test(previous)
      && (DELIVERY_CONTEXT_RE.test(previous) || isBarePathLine)) return true;
    break;
  }
  for (let i = index; i >= 0; i -= 1) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(lines[i]!);
    if (heading) {
      const title = heading[1] ?? '';
      return DELIVERY_CONTEXT_RE.test(title) && !REFERENCE_CONTEXT_RE.test(title);
    }
  }
  return false;
}

/**
 * 引用语境判定（目录路径专用，较 isDeliveryContextAt 放宽）：目录路径几乎必然是
 * 交付位置（引用/来源语境指向的几乎总是具体文件），故只拒绝明确处于引用/来源
 * 语境的目录。检查路径所在分句、上方最近非空行、最近标题是否含引用词。
 */
function isInReferenceContextAt(lines: readonly string[], index: number, colStart: number, colEnd: number): boolean {
  const line = lines[index] ?? '';
  let clauseStart = 0;
  for (let i = colStart - 1; i >= 0; i -= 1) {
    if (CLAUSE_BOUNDARY_RE.test(line[i]!)) { clauseStart = i + 1; break; }
  }
  let clauseEnd = line.length;
  for (let i = colEnd; i < line.length; i += 1) {
    if (CLAUSE_BOUNDARY_RE.test(line[i]!)) { clauseEnd = i; break; }
  }
  if (REFERENCE_CONTEXT_RE.test(line.slice(clauseStart, colStart))) return true;
  if (REFERENCE_CONTEXT_RE.test(line.slice(colEnd, clauseEnd))) return true;
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = lines[i]!.trim();
    if (!previous) continue;
    if (REFERENCE_CONTEXT_RE.test(previous)) return true;
    break;
  }
  for (let i = index; i >= 0; i -= 1) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(lines[i]!);
    if (heading) {
      return REFERENCE_CONTEXT_RE.test(heading[1] ?? '');
    }
  }
  return false;
}

/**
 * Scans outputs/ (always) plus cwd (mtime > startedAt, fallback) for product files,
 * applies extension + ignored-dir filters, and dedupes by sha256 (keeping the more
 * semantic filename). Returns the candidate artifacts to upload.
 */
export async function collectArtifacts(input: CollectArtifactsInput): Promise<CollectedArtifact[]> {
  const byRootPath = new Map<string, CollectedArtifact>();
  const maxBytes = input.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;

  const excludedNestedRoots = new Set([
    ...(input.outputDir ? [input.outputDir] : []),
    ...(input.extraOutputDirs ?? []),
    ...(input.configuredOutputRoots ?? []).map((root) => root.path),
  ]);
  const ingest = async (
    rootAbs: string,
    rootForRelative: string,
    timeFilter: boolean,
    sourceRoot: ArtifactSourceRoot,
    role: ArtifactRole,
    recursive = true,
    reportRootFailure = true,
    fileExtRe: RegExp = OUTPUT_FILE_EXT_RE,
    skipHidden = false,
    createdInWindow = false,
  ): Promise<void> => {
    let visited = 0;
    const stack: string[] = [rootAbs];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        if (reportRootFailure) {
          input.onDiagnostic?.({
            code: 'SOURCE_ROOT_UNREADABLE',
            sourceRootId: sourceRoot.id,
            sourceRootLabel: sourceRoot.label,
          });
        }
        continue;
      }
      for (const entry of entries) {
        const abs = join(current, entry.name);
        if (skipHidden && entry.name.startsWith('.')) {
          continue;
        }
        if (entry.isDirectory()) {
          if (IGNORED_OUTPUT_DIRS.has(entry.name)) {
            continue;
          }
          if (recursive && !(sourceRoot.kind === 'agent_workspace' && excludedNestedRoots.has(abs))) stack.push(abs);
        } else if (entry.isFile() && fileExtRe.test(entry.name)) {
          visited += 1;
          let stat;
          try {
            stat = statSync(abs);
          } catch {
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_UNREADABLE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath: relative(rootForRelative, abs),
            });
            continue;
          }
          if (timeFilter && !shouldCollectWindowedFile({
            mtimeMs: stat.mtimeMs,
            birthtimeMs: stat.birthtimeMs,
            startedAt: input.startedAt,
            createdInWindow,
          })) {
            continue;
          }
          const relativePath = relative(rootForRelative, abs);
          if (stat.size > maxBytes) {
            input.onSkipped?.({
              filename: basename(abs),
              relativePath,
              sizeBytes: stat.size,
              reason: 'FILE_TOO_LARGE',
            }, sourceRoot);
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_TOO_LARGE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath,
            });
            continue;
          }
          if (visited > MAX_OUTPUT_FILES_PER_ROOT) {
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_LIMIT_REACHED',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
            });
            return;
          }
          let hash = createHash('sha256');
          let sizeBytes = 0;
          try {
            for await (const chunk of createReadStream(abs)) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              sizeBytes += buffer.length;
              hash.update(buffer);
              if (sizeBytes > maxBytes) break;
            }
          } catch {
            input.onSkipped?.({
              filename: basename(abs),
              relativePath,
              sizeBytes,
              reason: 'COLLECTION_FAILED',
            }, sourceRoot);
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_UNREADABLE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath,
            });
            continue;
          }
          if (sizeBytes > maxBytes || sizeBytes !== stat.size) {
            input.onSkipped?.({
              filename: basename(abs),
              relativePath,
              sizeBytes,
              reason: sizeBytes > maxBytes ? 'FILE_TOO_LARGE' : 'COLLECTION_FAILED',
            }, sourceRoot);
            input.onDiagnostic?.({
              code: sizeBytes > maxBytes ? 'ARTIFACT_FILE_TOO_LARGE' : 'ARTIFACT_FILE_UNREADABLE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath,
            });
            continue;
          }
          const sha256 = hash.digest('hex');
          const candidate: CollectedArtifact = {
            absolutePath: abs,
            relativePath,
            sha256,
            sizeBytes,
            filename: basename(abs),
            sourceRoot,
            role,
          };
          const key = `${sourceRoot.id}:${candidate.relativePath}`;
          const existing = byRootPath.get(key);
          if (!existing || fileNamePreference(candidate.filename) < fileNamePreference(existing.filename)) {
            byRootPath.set(key, candidate);
          }
        }
      }
    }
  };

  if (input.outputDir) {
    await ingest(input.outputDir, input.outputDir, false, makeSourceRoot('run_output', '默认运行输出', input.outputDir), 'run_output');
  }
  for (const dir of input.extraOutputDirs ?? []) {
    await ingest(dir, dir, true, makeSourceRoot('adapter_generated', '适配器生成目录', dir), 'run_output', true, false);
  }
  for (const root of input.configuredOutputRoots ?? []) {
    const sourceRoot = root.id
      ? { id: root.id, kind: 'configured_output' as const, label: root.label }
      : makeSourceRoot('configured_output', root.label, root.path);
    await ingest(root.path, root.path, true, sourceRoot, root.defaultRole ?? 'run_output', root.recursive ?? true);
  }
  for (const adapterRoot of input.adapterOutputRoots ?? []) {
    await ingest(
      adapterRoot.dir,
      adapterRoot.dir,
      true,
      makeSourceRoot('adapter_generated', 'Agent 默认输出目录', adapterRoot.dir),
      'run_output',
      adapterRoot.recursive,
      false,
      ADAPTER_OUTPUT_FILE_EXT_RE,
      true,
      adapterRoot.createdInWindow,
    );
  }
  if (input.cwd) {
    await ingest(input.cwd, input.cwd, true, makeSourceRoot('agent_workspace', input.workspaceLabel ?? 'Agent 工作目录', input.cwd), 'run_output');
  }
  await collectReportedOutputs(input, byRootPath, maxBytes);
  return [...byRootPath.values()];
}

/** 分隔符无关的 basename：Windows realpath 返回反斜杠路径时安全校验仍然生效。 */
function reportedPathBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** realpath 后仍须通过全部安全校验，symlink 逃逸目标因此无法借别名混入。 */
/**
 * reported 路径基础安全校验（文件与目录通用）：隐藏路径段、敏感文件名、排除前缀。
 * 不含扩展名检查——目录本身与目录递归收集的子文件都走这条；扩展名仅对单文件
 * reported 路径生效（见 isCollectableReportedPath）。
 */
// AgentOS agent 数据目录段：reported 通道放行（agent CLI 声明的生成物落在自己的数据根，
// 如 Hermes ~/.hermes、OpenClaw ~/.openclaw）。其余 hidden 段（.ssh/.gnupg/.config/.secret/
// dotfile 文件名等）在 reported 通道仍拒——只信任已知 agent 数据目录，防泄漏未知隐藏目录。
const AGENT_DATA_DIRS = new Set(['.hermes', '.openclaw']);

function isCollectableReportedBase(realPath: string, excludedPrefixes: readonly string[], trustReported = false): boolean {
  const base = reportedPathBasename(realPath);
  // scan 通道（trustReported=false）：所有 hidden 段拒——防 daemon 主动扫数据目录泄漏 sessions。
  // reported 通道（trustReported=true）：只放行已知 agent 数据目录段（.hermes/.openclaw），
  //   其余 hidden 段（.ssh/.gnupg/.secret/dotfile）仍拒。
  // Windows 路径段以反斜杠分隔，统一按两种分隔符切分保证防线不失效。
  const segments = realPath.split(/[\\/]/);
  if (segments.some((segment) => segment.startsWith('.') && (!trustReported || !AGENT_DATA_DIRS.has(segment)))) return false;
  if (SENSITIVE_REPORTED_BASENAME_RE.test(base)) return false;
  const normalizedPath = realPath.replaceAll('\\', '/');
  for (const prefix of excludedPrefixes) {
    const normalizedPrefix = prefix.replaceAll('\\', '/');
    if (normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`)) return false;
  }
  return true;
}

/** realpath 后仍须通过全部安全校验，symlink 逃逸目标因此无法借别名混入。 */
function isCollectableReportedPath(realPath: string, excludedPrefixes: readonly string[]): boolean {
  if (!isCollectableReportedBase(realPath, excludedPrefixes, true)) return false;
  return ADAPTER_OUTPUT_FILE_EXT_RE.test(reportedPathBasename(realPath));
}

async function hashFileWithLimit(abs: string, maxBytes: number): Promise<{ sha256: string; sizeBytes: number } | null> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    for await (const chunk of createReadStream(abs)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.length;
      hash.update(buffer);
      if (sizeBytes > maxBytes) return null;
    }
  } catch {
    return null;
  }
  return sizeBytes > maxBytes ? null : { sha256: hash.digest('hex'), sizeBytes };
}

/**
 * 把 Agent 回复报告的交付文件归入受管 run output 候选。
 * 安全拒绝（穿越/隐藏段/内部前缀/敏感名/symlink 逃逸）只记路径无关诊断；
 * 窗口外、不存在与重复属于正常噪音，静默跳过；超限走 onSkipped 用户可见。
 *
 * 判同语义（#1051 通道升级）：reported 是 Agent 的明确声明，优先于
 * adapter/configured/cwd 扫描的猜测兜底。按绝对路径或 sha256 命中既有条目时——
 * 受管 run_output 已收录：reported 跳过（只发布一次），且非受管的同内容副本
 * 一并移除，避免 legacy + revision 双发；
 * 仅非受管来源命中：旧条目在 reported 通过全部安全校验后被移除，由 reported
 * 版本接替进入 outputs/<publishIdentity>。安全校验未通过时旧条目保留，
 * 交付通道不因升级逻辑回退。
 */
async function collectReportedOutputs(
  input: CollectArtifactsInput,
  byRootPath: Map<string, CollectedArtifact>,
  maxBytes: number,
): Promise<void> {
  if (!input.reportedOutputPaths || input.reportedOutputPaths.length === 0) return;
  const excludedPrefixes = (input.reportedOutputExcludedPathPrefixes ?? []).map((prefix) => {
    try {
      return realpathSync(prefix);
    } catch {
      return resolve(prefix);
    }
  });
  // 「受管 run_output」是本函数的核心判谓：跳过守卫与删除守卫共用同一语义。
  type DuplicateEntry = [string, CollectedArtifact];
  const isManagedRunOutput = (artifact: CollectedArtifact): boolean =>
    artifact.sourceRoot.kind === 'run_output';
  const runOutputRelativePaths = new Set(
    [...byRootPath.values()]
      .filter(isManagedRunOutput)
      .map((artifact) => artifact.relativePath),
  );
  const findDuplicates = (match: (artifact: CollectedArtifact) => boolean): DuplicateEntry[] =>
    [...byRootPath.entries()].filter(([, artifact]) => match(artifact));
  const hasManagedRunOutput = (entries: DuplicateEntry[]): boolean =>
    entries.some(([, artifact]) => isManagedRunOutput(artifact));
  const reject = (filename: string) => {
    input.onDiagnostic?.({
      code: 'REPORTED_PATH_REJECTED',
      sourceRootId: REPORTED_OUTPUT_SOURCE_ROOT.id,
      sourceRootLabel: REPORTED_OUTPUT_SOURCE_ROOT.label,
      // 只暴露 basename：诊断行会随 run 回报上 Server，不得泄露本机目录结构。
      relativePath: filename,
    });
  };
  for (const reportedPath of input.reportedOutputPaths) {
    let realPath: string;
    try {
      realPath = realpathSync(reportedPath);
    } catch {
      continue; // 不存在或不可达：Agent 报告了未落盘的路径，正常噪音。
    }
    const absDuplicates = findDuplicates(
      (artifact) => artifact.absolutePath === reportedPath || artifact.absolutePath === realPath,
    );
    // 受管通道已收录同一路径（含前一条 reported 条目）：只发布一次，静默跳过。
    // 顺带清理：受管已有此文件时，非受管的同内容副本（如 Agent 同时把交付
    // 拷进 adapter 默认根）只会 legacy + revision 双发，按 sha256 判同移除（#1051）。
    // 清理只删既有条目、不新增发布内容，故无需经过下方安全校验；超限读不出
    // hash 时保守不动。
    if (hasManagedRunOutput(absDuplicates)) {
      const hashed = await hashFileWithLimit(realPath, maxBytes);
      if (hashed) {
        for (const [key, artifact] of findDuplicates((artifact) => artifact.sha256 === hashed.sha256)) {
          if (!isManagedRunOutput(artifact)) byRootPath.delete(key);
        }
      }
      continue;
    }
    if (!isCollectableReportedBase(realPath, excludedPrefixes, true)) {
      reject(basename(reportedPath));
      continue;
    }
    let stat;
    try {
      stat = statSync(realPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      await collectReportedDirectory(input, realPath, byRootPath, runOutputRelativePaths, excludedPrefixes, maxBytes);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!ADAPTER_OUTPUT_FILE_EXT_RE.test(reportedPathBasename(realPath))) {
      reject(basename(reportedPath));
      continue;
    }
    if (!shouldCollectWindowedFile({
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      startedAt: input.startedAt,
      createdInWindow: true,
    })) {
      continue;
    }
    const filename = basename(realPath);
    if (stat.size > maxBytes) {
      input.onSkipped?.({ filename, relativePath: filename, sizeBytes: stat.size, reason: 'FILE_TOO_LARGE' }, REPORTED_OUTPUT_SOURCE_ROOT);
      input.onDiagnostic?.({
        code: 'ARTIFACT_FILE_TOO_LARGE',
        sourceRootId: REPORTED_OUTPUT_SOURCE_ROOT.id,
        sourceRootLabel: REPORTED_OUTPUT_SOURCE_ROOT.label,
        relativePath: filename,
      });
      continue;
    }
    const hashed = await hashFileWithLimit(realPath, maxBytes);
    if (!hashed || hashed.sizeBytes !== stat.size) {
      input.onDiagnostic?.({
        code: 'ARTIFACT_FILE_UNREADABLE',
        sourceRootId: REPORTED_OUTPUT_SOURCE_ROOT.id,
        sourceRootLabel: REPORTED_OUTPUT_SOURCE_ROOT.label,
        relativePath: filename,
      });
      continue;
    }
    // 全部校验通过，现在才允许触碰既有条目：移除非受管的重复（绝对路径重复的
    // 旧内容版本 + 同 sha256 的猜测兜底副本），保证同一内容只发布一次（#1051）。
    const shaDuplicates = findDuplicates((artifact) => artifact.sha256 === hashed.sha256);
    for (const [key, artifact] of new Map([...absDuplicates, ...shaDuplicates])) {
      if (!isManagedRunOutput(artifact)) byRootPath.delete(key);
    }
    // AC4：受管通道已有同内容——reported 不重复收录，上一步已清掉非受管双发副本。
    if (hasManagedRunOutput(shaDuplicates)) continue;
    // 同名不同内容与受管 run output 冲突时隔离到 reported/ 前缀，避免
    // stageRunOutputsToPublishOutput 因 relativePath 重复而整批失败。
    let relativePath = filename;
    if (runOutputRelativePaths.has(relativePath)) relativePath = `reported/${filename}`;
    if (runOutputRelativePaths.has(relativePath)) relativePath = `reported/${hashed.sha256.slice(0, 8)}-${filename}`;
    runOutputRelativePaths.add(relativePath);
    byRootPath.set(`reported:${realPath}`, {
      absolutePath: realPath,
      relativePath,
      sha256: hashed.sha256,
      sizeBytes: hashed.sizeBytes,
      filename,
      sourceRoot: REPORTED_OUTPUT_SOURCE_ROOT,
      role: 'run_output',
    });
  }
}

/**
 * 递归收集 reported 目录下的交付文件。复用 reported 通道的安全校验链
 * （隐藏段/敏感名/excludedPrefixes/symlink realpath/时间窗口/大小），但放宽
 * 扩展名白名单——agent 交付目录里的文件类型多样（.md/.py/.html/.xlsx…），
 * 靠 isCollectableReportedBase + IGNORED_OUTPUT_DIRS + 文件数上限兜底。
 * relativePath 保留相对目录结构（如 大纲/总纲.md），便于 stage 时区分。
 */
async function collectReportedDirectory(
  input: CollectArtifactsInput,
  realDir: string,
  byRootPath: Map<string, CollectedArtifact>,
  runOutputRelativePaths: Set<string>,
  excludedPrefixes: readonly string[],
  maxBytes: number,
): Promise<void> {
  let visited = 0;
  const stack: string[] = [realDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited > MAX_OUTPUT_FILES_PER_ROOT) {
        input.onDiagnostic?.({
          code: 'ARTIFACT_FILE_LIMIT_REACHED',
          sourceRootId: REPORTED_OUTPUT_SOURCE_ROOT.id,
          sourceRootLabel: REPORTED_OUTPUT_SOURCE_ROOT.label,
        });
        return;
      }
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        // 跳过隐藏目录与 IGNORED_OUTPUT_DIRS（node_modules/.git 等）。
        if (entry.name.startsWith('.') || IGNORED_OUTPUT_DIRS.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let realAbs: string;
      try {
        realAbs = realpathSync(abs);
      } catch {
        continue;
      }
      // reported 安全校验：symlink 经 realpath 解析后落入排除前缀/隐藏段即拒。
      if (!isCollectableReportedBase(realAbs, excludedPrefixes, true)) continue;
      let stat;
      try {
        stat = statSync(realAbs);
      } catch {
        continue;
      }
      if (!shouldCollectWindowedFile({
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs,
        startedAt: input.startedAt,
        createdInWindow: true,
      })) {
        continue;
      }
      const relPath = relative(realDir, realAbs).split(sep).join('/');
      const filename = basename(realAbs);
      if (stat.size > maxBytes) {
        input.onSkipped?.({ filename, relativePath: relPath, sizeBytes: stat.size, reason: 'FILE_TOO_LARGE' }, REPORTED_OUTPUT_SOURCE_ROOT);
        input.onDiagnostic?.({
          code: 'ARTIFACT_FILE_TOO_LARGE',
          sourceRootId: REPORTED_OUTPUT_SOURCE_ROOT.id,
          sourceRootLabel: REPORTED_OUTPUT_SOURCE_ROOT.label,
          relativePath: relPath,
        });
        continue;
      }
      const hashed = await hashFileWithLimit(realAbs, maxBytes);
      if (!hashed || hashed.sizeBytes !== stat.size) {
        input.onDiagnostic?.({
          code: 'ARTIFACT_FILE_UNREADABLE',
          sourceRootId: REPORTED_OUTPUT_SOURCE_ROOT.id,
          sourceRootLabel: REPORTED_OUTPUT_SOURCE_ROOT.label,
          relativePath: relPath,
        });
        continue;
      }
      visited += 1;
      // sha256 去重：受管通道已有同内容则不重复收录。
      let managedDuplicate = false;
      for (const [, artifact] of byRootPath) {
        if (artifact.sha256 === hashed.sha256 && artifact.sourceRoot.kind === 'run_output') {
          managedDuplicate = true;
          break;
        }
      }
      if (managedDuplicate) continue;
      // relativePath 冲突隔离（同目录下同名或与受管 run output 撞名）。
      let relativePath = relPath;
      if (runOutputRelativePaths.has(relativePath)) relativePath = `reported/${relPath}`;
      if (runOutputRelativePaths.has(relativePath)) relativePath = `reported/${hashed.sha256.slice(0, 8)}-${relPath}`;
      runOutputRelativePaths.add(relativePath);
      byRootPath.set(`reported:${realAbs}`, {
        absolutePath: realAbs,
        relativePath,
        sha256: hashed.sha256,
        sizeBytes: hashed.sizeBytes,
        filename,
        sourceRoot: REPORTED_OUTPUT_SOURCE_ROOT,
        role: 'run_output',
      });
    }
  }
}

function makeSourceRoot(kind: ArtifactSourceRootKind, label: string, localIdentity: string): ArtifactSourceRoot {
  const id = createHash('sha256').update(`agentbean:artifact-source-root:${kind}:${localIdentity}`).digest('hex').slice(0, 24);
  return { id, kind, label };
}

function fileNamePreference(name: string): number {
  const lower = name.toLowerCase();
  if (/^ig_[a-f0-9]{32,}\.(png|jpe?g|gif|webp)$/i.test(lower)) {
    return 0;
  }
  if (/^(image|output|generated)[._-]?\d*\.(png|jpe?g|gif|webp)$/i.test(lower)) {
    return 1;
  }
  return 2;
}
