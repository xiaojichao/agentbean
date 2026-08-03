import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
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
 * 只接受本机绝对路径 + 交付物扩展名白名单，收集阶段再做存在性/窗口/安全校验。
 */
const REPORTED_OUTPUT_PATH_RE = /(?<![A-Za-z0-9_./])(\/[^\s"'<>|`]+\.(?:md|txt|pdf|png|jpe?g|gif|webp|svg|mp4|mov|zip))/gi;
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
 * 仅返回本机绝对路径 + 交付物扩展名白名单的候选；路径穿越（`..`）与隐藏
 * 路径段（`/.`）在提取时直接拒绝，其余安全校验在收集阶段对 realpath 进行
 * （见 collectArtifacts 的 reportedOutputPaths 处理）。
 */
export function extractReportedOutputPaths(body: string | undefined): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of body.matchAll(REPORTED_OUTPUT_PATH_RE)) {
    const raw = (match[1] ?? '').trim().replace(/[。，,;；:：)）\]」』》]+$/u, '');
    if (!raw.startsWith('//')
      && !raw.endsWith('.')
      && !raw.includes('/.')
      && !raw.includes('..')
      && ADAPTER_OUTPUT_FILE_EXT_RE.test(raw)) {
      if (!seen.has(raw)) {
        seen.add(raw);
        paths.push(raw);
      }
    }
  }
  return paths;
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

/** realpath 后仍须通过全部安全校验，symlink 逃逸目标因此无法借别名混入。 */
function isCollectableReportedPath(realPath: string, excludedPrefixes: readonly string[]): boolean {
  if (!ADAPTER_OUTPUT_FILE_EXT_RE.test(basename(realPath))) return false;
  const segments = realPath.split('/');
  // 隐藏路径段（.ssh/.gnupg/.config 等）与 .agentbean 内部永不发布。
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  if (SENSITIVE_REPORTED_BASENAME_RE.test(basename(realPath))) return false;
  for (const prefix of excludedPrefixes) {
    if (realPath === prefix || realPath.startsWith(`${prefix}/`)) return false;
  }
  return true;
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
    if (!isCollectableReportedPath(realPath, excludedPrefixes)) {
      reject(basename(reportedPath));
      continue;
    }
    let stat;
    try {
      stat = statSync(realPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
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
