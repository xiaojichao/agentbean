/**
 * #825：Markdown 文档包成员资格与来源一致性判定。
 *
 * 这里只做纯判定，不读库、不做 IO。调用方负责把 ChannelDocument 当前 revision、
 * 其正文 Artifact、derivation 来源与可见性结论装配成 candidate 后交由本模块裁决，
 * 保证「哪些文档可以成为 Bundle member」只有一处真相。
 *
 * 关键区分：ChannelDocument 的正文 Artifact 是每次 derive/save 新建的上传件，
 * 它不保留原始 Run 产物的路径与角色 —— 「这份文档来自 Run 里的哪个文件」只存在于
 * derivation 来源中。因此格式类判定（是不是 Markdown）看正文，
 * 来源类判定（是不是运行日志 / 预览派生物 / 同一次 Run）一律看 derivation。
 */

export type ProjectDocumentBundleMemberRejectionCode =
  /** 不是 Markdown（正文或来源的 mime 与扩展名都不满足）。 */
  | 'not_markdown'
  /** 来源是内部运行日志（logs/workspace-run.log）。 */
  | 'run_log'
  /** 来源是预览 derivative，不是频道文件正身。 */
  | 'preview_derivative'
  /** 调用者不可见 / 非公开（例如 handoff 未 deliver_to_root）。 */
  | 'not_visible'
  /** 不属于目标 Team/Channel。 */
  | 'scope_mismatch'
  /** 没有明确来源，或当前 revision 不是声明的那一次 Run 产生的。 */
  | 'source_mismatch'
  /** 同一 documentId 在一次创建中重复出现。 */
  | 'duplicate'
  /** documentId 无法解析为频道内文档。 */
  | 'not_found';

export interface ProjectDocumentBundleScope {
  readonly teamId: string;
  readonly channelId: string;
  readonly workspaceRunId: string;
}

/** 文档当前 revision 的正文 Artifact（由 derive/save 生成）。 */
export interface ProjectDocumentBundleMemberArtifact {
  readonly filename: string;
  readonly mimeType: string;
}

/** 当前 revision 的 derivationSource：这份正文来自哪一次 Run 的哪个文件。 */
export interface ProjectDocumentBundleMemberDerivation {
  readonly workspaceRunId: string;
  readonly relativePath: string;
  readonly normalizedRelativePath: string;
  readonly artifactId: string;
  readonly artifactRole: string;
}

export interface ProjectDocumentBundleMemberCandidate {
  readonly documentId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly filename: string;
  readonly currentRevisionId: string;
  readonly currentRevisionNumber: number;
  readonly artifact: ProjectDocumentBundleMemberArtifact;
  /** 缺失表示当前 revision 是人工上传或纯人工编辑的结果，来源不明确。 */
  readonly derivation?: ProjectDocumentBundleMemberDerivation;
  /** 调用方已复验的公开可见性结论。 */
  readonly visible: boolean;
}

export type ProjectDocumentBundleMemberVerdict =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly code: ProjectDocumentBundleMemberRejectionCode };

export interface ProjectDocumentBundleRejection {
  readonly documentId: string;
  readonly code: ProjectDocumentBundleMemberRejectionCode;
}

export interface ProjectDocumentBundleComposition {
  readonly accepted: readonly ProjectDocumentBundleMemberCandidate[];
  readonly rejections: readonly ProjectDocumentBundleRejection[];
}

const MARKDOWN_FILENAME = /\.(?:md|markdown)$/i;
const PREVIEW_DERIVATIVE_BASENAME = /^preview\.(?:webp|png|jpe?g)$/i;
const WORKSPACE_RUN_LOG_BASENAME = 'workspace-run.log';

function basename(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? '';
}

export function isMarkdownBundleArtifact(
  artifact: ProjectDocumentBundleMemberArtifact,
): boolean {
  const mediaType = artifact.mimeType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'text/markdown' || MARKDOWN_FILENAME.test(artifact.filename);
}

/** 运行日志判定基于来源路径，而不是正文 Artifact —— 正文是 derive 生成的新上传件。 */
export function isWorkspaceRunLogDerivation(
  derivation: Pick<ProjectDocumentBundleMemberDerivation, 'relativePath' | 'normalizedRelativePath'>,
): boolean {
  return basename(derivation.normalizedRelativePath) === WORKSPACE_RUN_LOG_BASENAME
    || basename(derivation.relativePath) === WORKSPACE_RUN_LOG_BASENAME;
}

/**
 * Preview derivative 天然不进 artifacts 表（它由 artifact_preview_jobs 独立托管，
 * 落在服务端 artifact-previews 数据目录，不是任何 Run 的 relativePath），
 * 因此正常路径不可能成为 derivation 来源；保留判定是为了让「不可成为 member」
 * 在契约层可被测试钉死，而不是依赖上游表结构这一隐含前提。
 *
 * 只认 preview derivative 的实际产物文件名，不认目录名：Agent 完全可能把合法
 * Markdown 写进名为 previews 的目录，按目录名判会误杀真实交付物并给出误导性原因码。
 */
export function isPreviewDerivativeDerivation(
  derivation: Pick<ProjectDocumentBundleMemberDerivation, 'normalizedRelativePath'>,
): boolean {
  return PREVIEW_DERIVATIVE_BASENAME.test(basename(derivation.normalizedRelativePath));
}

export function evaluateBundleMemberEligibility(
  candidate: ProjectDocumentBundleMemberCandidate,
  scope: ProjectDocumentBundleScope,
): ProjectDocumentBundleMemberVerdict {
  if (candidate.teamId !== scope.teamId || candidate.channelId !== scope.channelId) {
    return { eligible: false, code: 'scope_mismatch' };
  }
  const { derivation } = candidate;
  // 来源不明确的文档一律不进包：Bundle 的历史含义依赖「这是哪一次输出」这一事实。
  if (!derivation || derivation.workspaceRunId !== scope.workspaceRunId) {
    return { eligible: false, code: 'source_mismatch' };
  }
  if (isWorkspaceRunLogDerivation(derivation)) {
    return { eligible: false, code: 'run_log' };
  }
  if (isPreviewDerivativeDerivation(derivation)) {
    return { eligible: false, code: 'preview_derivative' };
  }
  if (!isMarkdownBundleArtifact(candidate.artifact)
    || !MARKDOWN_FILENAME.test(basename(derivation.normalizedRelativePath))) {
    return { eligible: false, code: 'not_markdown' };
  }
  if (!candidate.visible) {
    return { eligible: false, code: 'not_visible' };
  }
  return { eligible: true };
}

/**
 * 按调用方给定顺序裁决整包成员。任一成员被拒即整体不可创建 —— 调用方据 rejections 反馈原因，
 * 不做「静默丢弃不合格项后照样建包」的降级，避免 Bundle 含义与用户预期分叉。
 */
export function evaluateBundleComposition(
  candidates: readonly ProjectDocumentBundleMemberCandidate[],
  scope: ProjectDocumentBundleScope,
): ProjectDocumentBundleComposition {
  const accepted: ProjectDocumentBundleMemberCandidate[] = [];
  const rejections: ProjectDocumentBundleRejection[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.documentId)) {
      rejections.push({ documentId: candidate.documentId, code: 'duplicate' });
      continue;
    }
    seen.add(candidate.documentId);
    const verdict = evaluateBundleMemberEligibility(candidate, scope);
    if (verdict.eligible) {
      accepted.push(candidate);
    } else {
      rejections.push({ documentId: candidate.documentId, code: verdict.code });
    }
  }
  return { accepted, rejections };
}
