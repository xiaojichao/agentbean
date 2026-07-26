import type {
  ProjectStageAggregateStatus,
  ProjectStageBlockingReasonDto,
  TaskStatus,
} from '@agentbean/contracts';

export interface ProjectStageTaskProjection {
  aggregateStatus: ProjectStageAggregateStatus;
  blockingReasons: ProjectStageBlockingReasonDto[];
}

export function projectStageTaskProjection(input: {
  taskId: string;
  taskStatus: TaskStatus;
  dependencies?: readonly { taskId: string; status: TaskStatus }[];
  reviewDecision?: 'accepted' | 'rejected' | 'needs_human' | null;
}): ProjectStageTaskProjection {
  let aggregateStatus: ProjectStageAggregateStatus;
  const blockingReasons: ProjectStageBlockingReasonDto[] = [];
  const addBlockingReason = (reason: ProjectStageBlockingReasonDto) => {
    blockingReasons.push(reason);
  };
  switch (input.taskStatus) {
    case 'todo':
      aggregateStatus = 'pending';
      addBlockingReason({ code: 'task_not_started', taskId: input.taskId });
      break;
    case 'in_progress':
      aggregateStatus = 'active';
      break;
    case 'in_review':
      aggregateStatus = 'in_review';
      break;
    case 'done':
    case 'closed':
      aggregateStatus = 'complete';
      break;
  }
  const incompleteDependencies = (input.dependencies ?? [])
    .filter((dependency) => dependency.status !== 'done' && dependency.status !== 'closed');
  for (const dependency of incompleteDependencies) {
    addBlockingReason({
      code: 'dependency_incomplete',
      taskId: input.taskId,
      dependencyTaskId: dependency.taskId,
    });
  }
  if (incompleteDependencies.length > 0) {
    aggregateStatus = input.taskStatus === 'todo' ? 'pending' : 'active';
  }
  if ((input.taskStatus === 'in_review' && input.reviewDecision !== 'accepted')
    || input.reviewDecision === 'rejected'
    || input.reviewDecision === 'needs_human') {
    aggregateStatus = 'in_review';
    addBlockingReason({
      code: input.reviewDecision === 'rejected'
        ? 'review_rejected'
        : input.reviewDecision === 'needs_human'
          ? 'review_needs_human'
          : 'review_pending',
      taskId: input.taskId,
    });
  }
  return { aggregateStatus, blockingReasons };
}
