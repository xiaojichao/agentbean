import {
  evaluateBundleBackfillGrouping,
  evaluateBundleComposition,
  isProjectDocumentBundleMemberRejectionCode,
  type ProjectDocumentBundleBackfillReasonCode,
  type ProjectDocumentBundleMemberCandidate,
} from '../../../../packages/domain/src/index.js';
import type {
  ProjectDocumentBundleBackfillMode,
  ProjectDocumentBundleBackfillReportDto,
  ProjectDocumentBundleFailureDetailsDto,
} from '../../../../packages/contracts/src/index.js';
import type {
  ProjectDocumentBundleBackfillCandidateRunRecord,
  ProjectDocumentBundleBackfillCursor,
  ProjectDocumentBundleBackfillOutcomeKind,
} from './project-repositories.js';
import type { ServerNextRepositories } from './repositories.js';
import {
  isPublicWorkspaceRun,
  loadProjectDocumentBundleCandidate,
  resolveProjectDocumentBundleSource,
  type ServerNextUseCases,
} from './usecases.js';

/**
 * #830：历史 Markdown 输出的保守回填。
 *
 * 三条不可让步的原则：
 * 1. **回填不是第二条建包路径**。apply 模式一律调用 createProjectDocumentBundle 写入，
 *    因此归档、来源公开性、Invocation fence、成员资格、幂等都由既有用例复验一次。
 * 2. **dry-run 的裁决必须等于 apply 的裁决**。两种模式跑同一段预检（且预检调用的是
 *    用例内部使用的同一批只读判定函数），dry-run 只是在最后一步不写库。
 * 3. **证明不了就不分组**。任何来源歧义都让这次 Run 保持未分组并留下原因码，
 *    绝不「丢掉存疑的那份、把剩下的凑成一个包」。
 *
 * 报告只含 ID、原因码与计数，不含正文、文件名、相对路径或设备绝对路径。
 */

export const PROJECT_DOCUMENT_BUNDLE_BACKFILL_ID = 'project-document-bundles-v1';

const DEFAULT_BATCH_SIZE = 25;

/** 幂等键与包名都只由 runId 推导，保证任何一次重试的请求指纹完全一致。 */
function backfillIdempotencyKey(runId: string): string {
  return `${PROJECT_DOCUMENT_BUNDLE_BACKFILL_ID}:${runId}`;
}

/**
 * 包名来自 Run 身份，不来自成员文件名 —— 从文件名取名等于让命名反向决定包的含义，
 * 正是本 Issue 明令禁止的推断。
 */
function backfillBundleName(runId: string): string {
  return `历史运行输出 ${runId.slice(0, 8)}`;
}

interface BackfillDecision {
  outcome: ProjectDocumentBundleBackfillOutcomeKind;
  reasonCode?: ProjectDocumentBundleBackfillReasonCode;
  memberCount: number;
  bundleId?: string;
}

/** 分组层原因码到报告桶的归属：只有「来源事实不可证」才算歧义。 */
const AMBIGUOUS_REASON_CODES = new Set<ProjectDocumentBundleBackfillReasonCode>([
  'member_drifted',
  'cross_channel_member',
]);

export interface ProjectDocumentBundleBackfillBatchResult {
  processed: number;
  completed: boolean;
  report: ProjectDocumentBundleBackfillReportDto;
}

export interface CreateProjectDocumentBundleBackfillInput {
  repositories: ServerNextRepositories;
  app: Pick<ServerNextUseCases, 'createProjectDocumentBundle'>;
  clock: { now(): number };
  mode: ProjectDocumentBundleBackfillMode;
  batchSize?: number;
  backfillId?: string;
}

export function createProjectDocumentBundleBackfill(
  input: CreateProjectDocumentBundleBackfillInput,
) {
  const { repositories, app, clock, mode } = input;
  const backfillId = input.backfillId ?? PROJECT_DOCUMENT_BUNDLE_BACKFILL_ID;
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? DEFAULT_BATCH_SIZE));
  const backfill = repositories.projectDocumentBundleBackfill;

  async function report(completed: boolean): Promise<ProjectDocumentBundleBackfillReportDto> {
    const summary = await backfill.summarize({ backfillId, mode });
    const { outcomes, reasons } = summary;
    return {
      mode,
      completed,
      candidates: Object.values(outcomes).reduce((total, count) => total + count, 0),
      backfillable: outcomes.created + outcomes.would_create,
      created: outcomes.created,
      existing: outcomes.existing,
      ambiguous: outcomes.ambiguous,
      skipped: outcomes.skipped,
      failed: outcomes.failed,
      reasons,
    };
  }

  /**
   * 回填没有自己的身份，只借用一个在该频道本就有权建包的既有身份 —— 因此回填永远
   * 建不出真人建不出的包，也不需要为它开任何权限豁免路径。
   *
   * 顺序即「与这次输出关系最近」的顺序：频道创建者 → 项目负责人 → Team owner。
   * 每一个都必须仍是 Team 成员，否则继续往下找；全都不可用时保持未分组。
   */
  async function resolveBackfillActor(
    teamId: string,
    channelId: string,
    channelCreatedBy: string | undefined,
    channelVisibility: 'public' | 'private',
    channelHumanMemberIds: readonly string[],
  ): Promise<string | undefined> {
    const profile = await repositories.channelProjects.getProfile({ teamId, channelId });
    const team = await repositories.teams.getById(teamId);
    for (const candidate of [channelCreatedBy, profile?.projectLeadId, team?.ownerId]) {
      if (candidate
        && await repositories.teams.isMember(teamId, candidate)
        && (channelVisibility === 'public' || channelHumanMemberIds.includes(candidate))) {
        return candidate;
      }
    }
    return undefined;
  }

  async function decide(
    run: ProjectDocumentBundleBackfillCandidateRunRecord,
  ): Promise<BackfillDecision> {
    // 已有 Bundle（人工建的或上一轮回填建的）一律不碰：这既是幂等，也是「不改变人工
    // 创建的 Bundle」的落点。
    const existingBundleId = await backfill.findBundleIdForRun({
      teamId: run.teamId,
      channelId: run.channelId,
      workspaceRunId: run.runId,
    });
    if (existingBundleId) {
      return { outcome: 'existing', memberCount: 0, bundleId: existingBundleId };
    }

    const channel = await repositories.channels.getById(run.channelId);
    if (!channel || channel.teamId !== run.teamId) {
      return { outcome: 'skipped', reasonCode: 'channel_unavailable', memberCount: 0 };
    }
    if (channel.archivedAt != null) {
      // 归档频道只读。归档后再补建包是「归档后的不安全候选」，保持未分组。
      return { outcome: 'skipped', reasonCode: 'channel_archived', memberCount: 0 };
    }

    const runRecord = await repositories.workspaceRuns.getForTeam({
      teamId: run.teamId,
      runId: run.runId,
    });
    if (!runRecord || runRecord.channelId !== run.channelId) {
      return { outcome: 'skipped', reasonCode: 'run_unavailable', memberCount: 0 };
    }
    if (!(await isPublicWorkspaceRun(repositories, runRecord))) {
      // handoff 未 deliver_to_root：这是内部 Invocation 的产出，不构成频道公开交付物。
      return { outcome: 'skipped', reasonCode: 'run_not_public', memberCount: 0 };
    }

    const facts = await backfill.listRunDocumentFacts({
      teamId: run.teamId,
      workspaceRunId: run.runId,
    });
    const grouping = evaluateBundleBackfillGrouping(facts, { channelId: run.channelId });
    if (!grouping.groupable) {
      return {
        outcome: AMBIGUOUS_REASON_CODES.has(grouping.code) ? 'ambiguous' : 'skipped',
        reasonCode: grouping.code,
        memberCount: 0,
      };
    }

    const actorId = await resolveBackfillActor(
      run.teamId,
      run.channelId,
      channel.createdBy,
      channel.visibility,
      channel.humanMemberIds,
    );
    if (!actorId) {
      return { outcome: 'skipped', reasonCode: 'actor_unavailable', memberCount: 0 };
    }

    const source = await resolveProjectDocumentBundleSource(repositories, runRecord);
    if (!source.ok) {
      return {
        outcome: 'skipped',
        reasonCode: bundleFailureReasonCode(source.details),
        memberCount: 0,
      };
    }

    const candidates: ProjectDocumentBundleMemberCandidate[] = [];
    for (const documentId of grouping.documentIds) {
      const candidate = await loadProjectDocumentBundleCandidate(repositories, {
        teamId: run.teamId,
        channelId: run.channelId,
        documentId,
      });
      if (!candidate) {
        return { outcome: 'skipped', reasonCode: 'not_found', memberCount: 0 };
      }
      candidates.push(candidate);
    }
    const composition = evaluateBundleComposition(candidates, {
      teamId: run.teamId,
      channelId: run.channelId,
      workspaceRunId: run.runId,
    });
    if (composition.rejections.length > 0) {
      // 任一成员不合格即整体不分组（含「不可见文档」），与 #825 的建包语义一致。
      return {
        outcome: 'skipped',
        reasonCode: composition.rejections[0]!.code,
        memberCount: 0,
      };
    }

    if (mode === 'dry_run') {
      return { outcome: 'would_create', memberCount: composition.accepted.length };
    }

    const created = await app.createProjectDocumentBundle({
      userId: actorId,
      teamId: run.teamId,
      channelId: run.channelId,
      idempotencyKey: backfillIdempotencyKey(run.runId),
      name: backfillBundleName(run.runId),
      workspaceRunId: run.runId,
      documentIds: grouping.documentIds,
    });
    if (!created.ok) {
      // 预检与写入之间状态可能改变（并发编辑、归档、Task revision 推进）。
      // 用例的 details.reason 是权威归因，不去解析 message 反推。
      const reasonCode = bundleFailureReasonCode(created.details);
      return {
        // 写冲突是可恢复失败，不能把它当成最终 skipped 后推进游标。
        outcome: reasonCode === 'write_conflict' ? 'failed' : 'skipped',
        reasonCode,
        memberCount: 0,
      };
    }
    return {
      outcome: 'created',
      memberCount: created.bundle.memberCount,
      bundleId: created.bundle.id,
    };
  }

  async function runBatch(): Promise<ProjectDocumentBundleBackfillBatchResult> {
    const progress = await backfill.getProgress({ backfillId, mode });
    if (progress?.completedAt != null) {
      return { processed: 0, completed: true, report: await report(true) };
    }
    const runs = await backfill.listCandidateRuns({
      ...(progress?.cursor ? { cursor: progress.cursor } : {}),
      limit: batchSize + 1,
    });
    const batch = runs.slice(0, batchSize);
    let exhausted = runs.length <= batchSize;

    // 游标只推进到「连续成功」的最后一个候选：中途抛错就地停批，下一轮从出错的那一个
    // 重新开始。裁决本身幂等（已有 Bundle 直接短路 + 幂等键兜底），重跑是安全的。
    let cursor: ProjectDocumentBundleBackfillCursor | undefined = progress?.cursor;
    let processed = 0;
    for (const run of batch) {
      let decision: BackfillDecision;
      try {
        decision = await decide(run);
      } catch {
        await backfill.recordOutcome({
          backfillId,
          mode,
          teamId: run.teamId,
          channelId: run.channelId,
          workspaceRunId: run.runId,
          outcome: 'failed',
          reasonCode: 'unexpected_error',
          memberCount: 0,
          decidedAt: clock.now(),
        });
        exhausted = false;
        break;
      }
      await backfill.recordOutcome({
        backfillId,
        mode,
        teamId: run.teamId,
        channelId: run.channelId,
        workspaceRunId: run.runId,
        outcome: decision.outcome,
        ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
        memberCount: decision.memberCount,
        ...(decision.bundleId ? { bundleId: decision.bundleId } : {}),
        decidedAt: clock.now(),
      });
      if (decision.outcome === 'failed') {
        // 可恢复失败留在当前游标之后，下一批覆盖 failed 为最终裁决。
        exhausted = false;
        break;
      }
      cursor = { runCreatedAt: run.createdAt, runId: run.runId };
      processed += 1;
    }

    const completed = exhausted;
    await backfill.saveProgress({
      backfillId,
      mode,
      ...(cursor ? { cursor } : {}),
      ...(completed ? { completedAt: clock.now() } : {}),
      updatedAt: clock.now(),
    });
    return { processed, completed, report: await report(completed) };
  }

  return {
    mode,
    backfillId,
    runBatch,
    /** 供运维指标端点读取当前累计报告，不推进任何游标。 */
    async snapshot(): Promise<ProjectDocumentBundleBackfillReportDto> {
      const progress = await backfill.getProgress({ backfillId, mode });
      return report(progress?.completedAt != null);
    },
  };
}

/**
 * 把建包用例的结构化失败原因转成回填原因码。未携带 details 的失败（例如频道可见性
 * 检查这类共享前置）归到 unexpected_error，而不是猜一个更具体的码。
 */
function bundleFailureReasonCode(
  details: Record<string, unknown> | undefined,
): ProjectDocumentBundleBackfillReasonCode {
  const reason = (details as ProjectDocumentBundleFailureDetailsDto | undefined)?.reason;
  switch (reason) {
    case 'channel_archived': return 'channel_archived';
    case 'run_unavailable': return 'run_unavailable';
    case 'run_not_public': return 'run_not_public';
    case 'invocation_stale': return 'invocation_stale';
    case 'invocation_task_unavailable': return 'invocation_stale';
    case 'actor_not_authorized': return 'actor_unavailable';
    case 'members_unavailable': return 'not_found';
    case 'members_ineligible': return firstMemberRejectionCode(details);
    case 'member_scope_conflict':
    case 'idempotency_conflict': return 'write_conflict';
    default: return 'unexpected_error';
  }
}

function firstMemberRejectionCode(
  details: Record<string, unknown> | undefined,
): ProjectDocumentBundleBackfillReasonCode {
  const code = (details as ProjectDocumentBundleFailureDetailsDto | undefined)?.rejections?.[0]?.code;
  // 合同层的 code 是不透明字符串；只有 domain 认得的成员原因码才允许原样进报告。
  return isProjectDocumentBundleMemberRejectionCode(code) ? code : 'unexpected_error';
}
