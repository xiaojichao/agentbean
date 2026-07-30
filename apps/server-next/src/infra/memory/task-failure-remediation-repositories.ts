import type {
  TaskActionRequiredRecord,
  TaskActionRequiredRepository,
  TaskAttemptFenceRecord,
  TaskAttemptFenceRepository,
  TaskExecutionStartRecord,
  TaskExecutionStartRepository,
  TaskFailureClassificationRecord,
  TaskFailureClassificationRepository,
  TaskFailureRemediationRepositories,
  TaskProgressChallengeRecord,
  TaskProgressChallengeRepository,
  TaskRemediationCommandReceiptRecord,
  TaskRemediationIdempotencyTombstoneRecord,
  TaskRemediationReceiptRepository,
  TaskRemediationStateRecord,
  TaskRemediationStateRepository,
  TaskRetryBudgetRecord,
  TaskRetryBudgetRepository,
} from '../../application/task-failure-remediation-repositories.js';

export interface TaskFailureRemediationMemoryState {
  classifications: Map<string, TaskFailureClassificationRecord>;
  remediations: Map<string, TaskRemediationStateRecord>;
  challenges: Map<string, TaskProgressChallengeRecord>;
  actionRequired: Map<string, TaskActionRequiredRecord>;
  fences: Map<string, TaskAttemptFenceRecord>;
  executionStarts: Map<string, TaskExecutionStartRecord>;
  budgets: Map<string, TaskRetryBudgetRecord>;
  receipts: Map<string, TaskRemediationCommandReceiptRecord>;
  tombstones: Map<string, TaskRemediationIdempotencyTombstoneRecord>;
}

export function createTaskFailureRemediationMemoryState(): TaskFailureRemediationMemoryState {
  return {
    classifications: new Map(),
    remediations: new Map(),
    challenges: new Map(),
    actionRequired: new Map(),
    fences: new Map(),
    executionStarts: new Map(),
    budgets: new Map(),
    receipts: new Map(),
    tombstones: new Map(),
  };
}

export function cloneTaskFailureRemediationMemoryState(
  state: TaskFailureRemediationMemoryState,
): TaskFailureRemediationMemoryState {
  return {
    classifications: new Map(state.classifications),
    remediations: new Map(state.remediations),
    challenges: new Map(state.challenges),
    actionRequired: new Map(state.actionRequired),
    fences: new Map(state.fences),
    executionStarts: new Map(state.executionStarts),
    budgets: new Map(state.budgets),
    receipts: new Map(state.receipts),
    tombstones: new Map(state.tombstones),
  };
}

export function restoreTaskFailureRemediationMemoryState(
  target: TaskFailureRemediationMemoryState,
  source: TaskFailureRemediationMemoryState,
): void {
  target.classifications = new Map(source.classifications);
  target.remediations = new Map(source.remediations);
  target.challenges = new Map(source.challenges);
  target.actionRequired = new Map(source.actionRequired);
  target.fences = new Map(source.fences);
  target.executionStarts = new Map(source.executionStarts);
  target.budgets = new Map(source.budgets);
  target.receipts = new Map(source.receipts);
  target.tombstones = new Map(source.tombstones);
}

function fenceKey(taskId: string, attempt: number): string {
  return `${taskId}:${attempt}`;
}

export function createInMemoryTaskFailureRemediationRepositories(
  state: TaskFailureRemediationMemoryState = createTaskFailureRemediationMemoryState(),
): TaskFailureRemediationRepositories {
  const classifications: TaskFailureClassificationRepository = {
    async create(record) {
      state.classifications.set(record.id, record);
      return record;
    },
    async getById(id) {
      return state.classifications.get(id) ?? null;
    },
    async getByTaskAttempt({ taskId, taskAttempt }) {
      for (const row of state.classifications.values()) {
        if (row.taskId === taskId && row.taskAttempt === taskAttempt) return row;
      }
      return null;
    },
  };

  const remediations: TaskRemediationStateRepository = {
    async create(record) {
      state.remediations.set(record.id, record);
      return record;
    },
    async update(record) {
      state.remediations.set(record.id, record);
    },
    async getById(id) {
      return state.remediations.get(id) ?? null;
    },
    async getOpenByTaskId(taskId) {
      for (const row of state.remediations.values()) {
        if (row.taskId === taskId && row.state !== 'resolved') return row;
      }
      return null;
    },
    async listDue({ now, limit }) {
      return [...state.remediations.values()]
        .filter((row) => row.state === 'retry_pending'
          && (row.nextWakeAt === null || row.nextWakeAt <= now)
          && (row.notBefore === null || row.notBefore <= now))
        .slice(0, limit);
    },
  };

  const challenges: TaskProgressChallengeRepository = {
    async create(record) {
      state.challenges.set(record.id, record);
      return record;
    },
    async update(record) {
      state.challenges.set(record.id, record);
    },
    async getById(id) {
      return state.challenges.get(id) ?? null;
    },
    async getOpenByTaskId(taskId) {
      for (const row of state.challenges.values()) {
        if (row.taskId === taskId && row.resolvedAt === null) return row;
      }
      return null;
    },
    async listGraceExpired({ now, limit }) {
      return [...state.challenges.values()]
        .filter((row) => row.resolvedAt === null && row.graceDeadlineAt <= now)
        .slice(0, limit);
    },
  };

  const actionRequired: TaskActionRequiredRepository = {
    async create(record) {
      state.actionRequired.set(record.id, record);
      return record;
    },
    async update(record) {
      state.actionRequired.set(record.id, record);
    },
    async getById(id) {
      return state.actionRequired.get(id) ?? null;
    },
    async getOpenByEscalationKey(escalationKey) {
      for (const row of state.actionRequired.values()) {
        if (row.escalationKey === escalationKey && row.status === 'open') return row;
      }
      return null;
    },
  };

  const fences: TaskAttemptFenceRepository = {
    async create(record) {
      state.fences.set(fenceKey(record.taskId, record.taskAttempt), record);
      return record;
    },
    async get({ taskId, taskAttempt }) {
      return state.fences.get(fenceKey(taskId, taskAttempt)) ?? null;
    },
    async getLatest(taskId) {
      let best: TaskAttemptFenceRecord | null = null;
      for (const row of state.fences.values()) {
        if (row.taskId !== taskId) continue;
        if (!best || row.fencingToken > best.fencingToken) best = row;
      }
      return best;
    },
  };

  const executionStarts: TaskExecutionStartRepository = {
    async create(record) {
      state.executionStarts.set(fenceKey(record.taskId, record.taskAttempt), record);
      return record;
    },
    async get({ taskId, taskAttempt }) {
      return state.executionStarts.get(fenceKey(taskId, taskAttempt)) ?? null;
    },
  };

  const budgets: TaskRetryBudgetRepository = {
    async get(taskId) {
      return state.budgets.get(taskId) ?? null;
    },
    async upsert(record) {
      state.budgets.set(record.taskId, record);
    },
  };

  const receipts: TaskRemediationReceiptRepository = {
    async create(record) {
      state.receipts.set(record.receiptId, record);
      return record;
    },
    async getByIdempotencyKey(idempotencyKey) {
      for (const row of state.receipts.values()) {
        if (row.idempotencyKey === idempotencyKey) return row;
      }
      return null;
    },
    async createTombstone(record) {
      state.tombstones.set(record.idempotencyKey, record);
    },
    async getTombstone(idempotencyKey) {
      return state.tombstones.get(idempotencyKey) ?? null;
    },
  };

  return {
    classifications,
    remediations,
    challenges,
    actionRequired,
    fences,
    executionStarts,
    budgets,
    receipts,
  };
}
