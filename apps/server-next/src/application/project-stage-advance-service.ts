import type {
  ProjectStageStableInputDto,
  ProjectStageRequiredInputRuleDto,
} from '@agentbean/contracts';
import type {
  ProjectArtifactVersionRecord,
  ProjectStageRecord,
  ProjectStageEdgeRecord,
} from './project-repositories.js';
import type { ServerNextRepositories, TaskRecord } from './repositories.js';

export interface ProjectStageStableInputResolution {
  readonly requiredRuleCount: number;
  readonly satisfiedRuleKeys: readonly string[];
  readonly inputs: readonly ProjectStageStableInputDto[];
}

/**
 * 从显式绑定的集合/文档包解析 Server 权威稳定输入。
 *
 * 不带 source 的旧规则保持可读，但不会满足自动推进；名称、label、路径和文件名均不参与匹配。
 */
export async function resolveProjectStageStableInputs(
  repositories: ServerNextRepositories,
  downstreamTask: TaskRecord,
): Promise<ProjectStageStableInputResolution> {
  if (!downstreamTask.channelId) return emptyResolution();
  const scope = { teamId: downstreamTask.teamId, channelId: downstreamTask.channelId };
  const stages = await repositories.channelProjects.listStages(scope);
  const downstreamStage = stages.find((stage) => stage.taskId === downstreamTask.id);
  if (!downstreamStage) return emptyResolution();
  const edges = (await repositories.channelProjects.listEdges(scope))
    .filter((edge) => edge.downstreamStageId === downstreamStage.id);
  const inputs: ProjectStageStableInputDto[] = [];
  const satisfiedRuleKeys: string[] = [];
  let requiredRuleCount = 0;
  for (const edge of edges) {
    const upstreamStage = stages.find((stage) => stage.id === edge.upstreamStageId);
    const upstreamTask = upstreamStage
      ? await repositories.tasks.getById(upstreamStage.taskId)
      : null;
    if (!upstreamStage || !upstreamTask
      || upstreamTask.revision !== upstreamStage.taskRevision
      || (upstreamTask.status !== 'done' && upstreamTask.status !== 'closed')) {
      requiredRuleCount += edge.requiredInputs.length;
      continue;
    }
    for (const rule of edge.requiredInputs) {
      requiredRuleCount += 1;
      const resolved = await resolveRule(repositories, scope, edge, upstreamStage, rule);
      if (!resolved) continue;
      satisfiedRuleKeys.push(rule.key);
      inputs.push(...resolved);
    }
  }
  return { requiredRuleCount, satisfiedRuleKeys, inputs };
}

async function resolveRule(
  repositories: ServerNextRepositories,
  scope: { teamId: string; channelId: string },
  edge: ProjectStageEdgeRecord,
  upstreamStage: ProjectStageRecord,
  rule: ProjectStageRequiredInputRuleDto,
): Promise<ProjectStageStableInputDto[] | null> {
  if (!rule.source) return null;
  if (rule.kind === 'artifact') {
    if (rule.source.kind !== 'artifact_collection') return null;
    const collection = await repositories.channelProjects.getArtifactCollection({
      ...scope,
      collectionId: rule.source.collectionId,
    });
    if (!collection) return null;
    const versions = (await repositories.channelProjects.listArtifactVersions(scope))
      .filter((version) => version.collectionId === collection.id
        && version.stageId === upstreamStage.id
        && version.taskId === upstreamStage.taskId
        && version.taskRevision === upstreamStage.taskRevision);
    const reviews = await repositories.channelProjects.listArtifactReviews(scope);
    const version = selectArtifactVersion(collection.finalVersionId, rule.source.versionPolicy,
      versions, reviews);
    if (!version) return null;
    const artifact = await repositories.artifacts.getForTeam({
      teamId: scope.teamId,
      artifactId: version.artifactId,
    });
    if (!artifact || artifact.channelId !== scope.channelId) return null;
    return [{
      key: rule.key,
      kind: 'artifact_version',
      edgeId: edge.id,
      upstreamStageId: upstreamStage.id,
      collectionId: collection.id,
      versionId: version.id,
      artifactId: version.artifactId,
      taskRevision: version.taskRevision,
    }];
  }
  if (rule.source.kind !== 'document_bundle') return null;
  const bundle = await repositories.projectDocumentBundles.getById({
    ...scope,
    bundleId: rule.source.bundleId,
  });
  if (!bundle || bundle.source.taskId !== upstreamStage.taskId || !bundle.source.invocationId) {
    return null;
  }
  const invocation = await repositories.management.invocations.getById(bundle.source.invocationId);
  if (!invocation
    || invocation.intent.teamId !== scope.teamId
    || invocation.intent.channelId !== scope.channelId
    || invocation.intent.taskContext?.taskId !== upstreamStage.taskId
    || invocation.intent.taskContext.taskRevision !== upstreamStage.taskRevision) {
    return null;
  }
  const members = await repositories.projectDocumentBundles.listMembers({ bundleId: bundle.id });
  if (members.length === 0) return null;
  const resolved: ProjectStageStableInputDto[] = [];
  for (const member of members.sort((left, right) => left.position - right.position)) {
    const document = await repositories.channelDocuments.getForTeam({
      ...scope,
      documentId: member.documentId,
    });
    if (!document) return null;
    const revision = await repositories.channelDocuments.getRevision({
      documentId: document.id,
      revisionId: document.currentRevisionId,
    });
    if (!revision || revision.artifact.teamId !== scope.teamId
      || revision.artifact.channelId !== scope.channelId) return null;
    resolved.push({
      key: rule.key,
      kind: 'document_revision',
      edgeId: edge.id,
      upstreamStageId: upstreamStage.id,
      bundleId: bundle.id,
      documentId: document.id,
      revisionId: revision.id,
      revisionNumber: revision.revision,
      artifactId: revision.artifact.id,
      taskRevision: upstreamStage.taskRevision,
    });
  }
  return resolved;
}

function selectArtifactVersion(
  finalVersionId: string | undefined,
  policy: 'final' | 'approved',
  versions: readonly ProjectArtifactVersionRecord[],
  reviews: readonly {
    versionId: string;
    decision: 'approved' | 'rejected' | 'changes_requested';
    createdAt: number;
  }[],
): ProjectArtifactVersionRecord | null {
  const approved = (version: ProjectArtifactVersionRecord): boolean => {
    const latest = reviews.filter((review) => review.versionId === version.id)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    return latest?.decision === 'approved';
  };
  if (finalVersionId) {
    const final = versions.find((version) => version.id === finalVersionId);
    if (final && approved(final)) return final;
  }
  if (policy === 'final') return null;
  return [...versions]
    .sort((left, right) => right.versionNumber - left.versionNumber)
    .find(approved) ?? null;
}

function emptyResolution(): ProjectStageStableInputResolution {
  return { requiredRuleCount: 0, satisfiedRuleKeys: [], inputs: [] };
}
