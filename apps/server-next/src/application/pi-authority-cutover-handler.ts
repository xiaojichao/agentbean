import { createHash, randomBytes } from 'node:crypto';
import type { ID, UnixMs } from '../../../../packages/contracts/src/common.js';
import type {
  CompatibilityRetirementMetricsV1,
  CutoverReadinessSnapshotV1,
  LegacyDrainLineageV1,
  LegacyDrainResultProvenanceV1,
  MessageAuthorityEpochBindingV1,
  PiAuthorityCutoverCommandEnvelopeV1,
  PiAuthorityCutoverCommandInputMapV1,
  PiAuthorityCutoverCommandName,
  PiAuthorityCutoverCommandOutputUnionV1,
  PiAuthorityCutoverCommandResponseV1,
  PiAuthorityCutoverQueryName,
  PiAuthorityCutoverQueryResponseV1,
  TeamPiAuthorityMigrationV1,
} from '../../../../packages/contracts/src/pi-authority-cutover.js';
import {
  LEGACY_COORDINATION_RETIRED_CODE,
  PI_AUTHORITY_CUTOVER_COMMAND_SCHEMA_VERSION,
  buildLegacyCoordinationRetiredError,
  canonicalizePiAuthorityCutoverCommand,
  parsePiAuthorityCutoverCommandEnvelopeV1,
  parsePiAuthorityCutoverCommandInputV1,
  parsePiAuthorityCutoverQueryInputV1,
} from '../../../../packages/contracts/src/pi-authority-cutover.js';
import {
  authorizeTeamCutoverOperator,
  buildRetirementMetrics,
  disposeLegacyJobAtCutover,
  emergencyStopEffects,
  evaluateCommandPathAvailability,
  evaluateCutoverReadiness,
  evaluateCutoverTokenAcceptance,
  evaluateLegacyDrainResult,
  evaluateMessageEpochBinding,
  evaluateMigrationTransition,
  evaluateRetirementGate,
  initialTeamMigration,
  negotiateDaemonPiCapabilities,
  type TeamAdminRole,
} from '../../../../packages/domain/src/pi-authority-cutover-policy.js';
import type {
  LegacyDrainLineageRecord,
  MessageAuthorityEpochBindingRecord,
  PiAuthorityCutoverCommandReceiptRecord,
  PiAuthorityCutoverRepositories,
  TeamPiAuthorityMigrationRecord,
} from './pi-authority-cutover-repositories.js';
import type { PiAuthorityCutoverUnitOfWork } from './pi-authority-cutover-unit-of-work.js';

/**
 * #930 Team PI authority cutover handler。
 *
 * envelope → canonical hash → 幂等 → domain policy → 原子提交
 * （epoch 推进 + legacy fencing + audit/outbox）。
 */

export interface PiAuthorityCutoverHandlerDeps {
  readonly unitOfWork: PiAuthorityCutoverUnitOfWork;
  readonly ids: { nextId(): ID };
  readonly clock: { now(): UnixMs };
  readonly teamId: ID;
  /** Server 推导的操作者（不在 envelope）。 */
  readonly operatorId: ID;
  readonly operatorRole: TeamAdminRole;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function computeCommandHash(
  commandName: PiAuthorityCutoverCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return `sha256:${sha256Hex(canonicalizePiAuthorityCutoverCommand(commandName, commandSchemaVersion, input))}`;
}

function hashToken(plain: string): string {
  return `sha256:${sha256Hex(plain)}`;
}

function mintTokenPlain(): string {
  return randomBytes(24).toString('base64url');
}

function parseEnvelope(
  raw: unknown,
  expected: PiAuthorityCutoverCommandName,
): PiAuthorityCutoverCommandEnvelopeV1 {
  const envelope = parsePiAuthorityCutoverCommandEnvelopeV1(raw);
  if (envelope.commandName !== expected) {
    throw new Error(`PI_AUTHORITY_CUTOVER_COMMAND_MISMATCH: expected ${expected}, got ${envelope.commandName}`);
  }
  return envelope;
}

function buildResponse(
  commandName: PiAuthorityCutoverCommandName,
  outcome: PiAuthorityCutoverCommandResponseV1['outcome'],
  stableCode: string,
  retryDirective: PiAuthorityCutoverCommandResponseV1['retryDirective'],
  extra: Partial<PiAuthorityCutoverCommandResponseV1> = {},
): PiAuthorityCutoverCommandResponseV1 {
  return {
    schemaVersion: 1,
    commandName,
    outcome,
    retryDirective,
    stableCode,
    ...extra,
  };
}

function toReceiptV1(record: PiAuthorityCutoverCommandReceiptRecord) {
  return {
    schemaVersion: 1 as const,
    receiptId: record.receiptId,
    commandName: record.commandName,
    commandSchemaVersion: record.commandSchemaVersion,
    idempotencyKey: record.idempotencyKey,
    commandHash: record.commandHash,
    outcome: record.outcome,
    committedRevisions: record.committedRevisions,
    eventRefs: record.eventRefs,
    commitTime: record.commitTime,
    resultAvailable: record.resultAvailable,
  };
}

function migrationToV1(row: TeamPiAuthorityMigrationRecord): TeamPiAuthorityMigrationV1 {
  return {
    schemaVersion: 1,
    teamId: row.teamId,
    authorityEpoch: row.authorityEpoch,
    migrationRevision: row.migrationRevision,
    state: row.state,
    legacyWriterFenced: row.legacyWriterFenced,
    emergencyStop: row.emergencyStop,
    cutoverVersion: row.cutoverVersion,
    cutoverAt: row.cutoverAt,
    cutoverBy: row.cutoverBy,
    drainDeadlineAt: row.drainDeadlineAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function drainToV1(row: LegacyDrainLineageRecord): LegacyDrainLineageV1 {
  return {
    schemaVersion: 1,
    drainId: row.drainId,
    teamId: row.teamId,
    lineageKey: row.lineageKey,
    jobId: row.jobId,
    cutoverVersion: row.cutoverVersion,
    fencingToken: row.fencingToken,
    drainLeaseId: row.drainLeaseId,
    state: row.state,
    deadlineAt: row.deadlineAt,
    resultMessageId: row.resultMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function bindingToV1(row: MessageAuthorityEpochBindingRecord): MessageAuthorityEpochBindingV1 {
  return {
    schemaVersion: 1,
    teamId: row.teamId,
    messageId: row.messageId,
    sourceLineageKey: row.sourceLineageKey,
    authorityEpoch: row.authorityEpoch,
    migrationRevision: row.migrationRevision,
    boundAt: row.boundAt,
    ...(row.clientMessageId ? { clientMessageId: row.clientMessageId } : {}),
  };
}

async function ensureMigration(
  repos: PiAuthorityCutoverRepositories,
  teamId: ID,
  now: UnixMs,
): Promise<TeamPiAuthorityMigrationRecord> {
  const existing = await repos.migrations.get(teamId);
  if (existing) return existing;
  const initial = initialTeamMigration({ teamId, now });
  return repos.migrations.upsert({
    teamId: initial.teamId,
    authorityEpoch: initial.authorityEpoch,
    migrationRevision: initial.migrationRevision,
    state: initial.state,
    legacyWriterFenced: initial.legacyWriterFenced,
    emergencyStop: initial.emergencyStop,
    cutoverVersion: initial.cutoverVersion,
    cutoverAt: initial.cutoverAt,
    cutoverBy: initial.cutoverBy,
    drainDeadlineAt: initial.drainDeadlineAt,
    createdAt: initial.createdAt,
    updatedAt: initial.updatedAt,
  });
}

async function commitReceipt(
  repos: PiAuthorityCutoverRepositories,
  input: {
    commandName: PiAuthorityCutoverCommandName;
    commandSchemaVersion: number;
    idempotencyKey: string;
    commandHash: string;
    outcome: 'applied' | 'no_op';
    result: PiAuthorityCutoverCommandOutputUnionV1 | null;
    committedRevisions: readonly { streamKind: string; streamId: ID; revision: number }[];
    eventRefs: readonly { streamKind: string; streamId: ID; sequence: number }[];
    now: UnixMs;
    receiptId: ID;
  },
): Promise<PiAuthorityCutoverCommandReceiptRecord> {
  const receipt: PiAuthorityCutoverCommandReceiptRecord = {
    receiptId: input.receiptId,
    commandName: input.commandName,
    commandSchemaVersion: input.commandSchemaVersion,
    idempotencyKey: input.idempotencyKey,
    commandHash: input.commandHash,
    outcome: input.outcome,
    committedRevisions: input.committedRevisions,
    eventRefs: input.eventRefs,
    commitTime: input.now,
    resultAvailable: input.result !== null,
    resultJson: input.result ? JSON.stringify(input.result) : null,
  };
  await repos.receipts.create(receipt);
  await repos.receipts.createTombstone({
    idempotencyKey: input.idempotencyKey,
    commandHash: input.commandHash,
    receiptId: input.receiptId,
    createdAt: input.now,
  });
  return receipt;
}

async function replayIfPresent(
  repos: PiAuthorityCutoverRepositories,
  commandName: PiAuthorityCutoverCommandName,
  idempotencyKey: string,
  commandHash: string,
): Promise<PiAuthorityCutoverCommandResponseV1 | null> {
  const tombstone = await repos.receipts.getTombstone(idempotencyKey);
  if (!tombstone) return null;
  if (tombstone.commandHash !== commandHash) {
    return buildResponse(commandName, 'conflict', 'PI_AUTHORITY_IDEMPOTENCY_CONFLICT', 'user_action', {
      conflictReason: 'idempotency_key_payload_mismatch',
    });
  }
  const receipt = await repos.receipts.getByIdempotencyKey(idempotencyKey);
  if (!receipt) {
    return buildResponse(commandName, 'outcome_unknown', 'PI_AUTHORITY_RECEIPT_MISSING', 'same_key');
  }
  const result = receipt.resultJson
    ? JSON.parse(receipt.resultJson) as PiAuthorityCutoverCommandOutputUnionV1
    : undefined;
  return buildResponse(commandName, 'replayed', 'PI_AUTHORITY_REPLAYED', 'none', {
    receipt: toReceiptV1(receipt),
    result,
  });
}

async function appendAuditAndOutbox(
  repos: PiAuthorityCutoverRepositories,
  input: {
    teamId: ID;
    eventKind: string;
    payload: unknown;
    now: UnixMs;
    ids: { nextId(): ID };
  },
): Promise<void> {
  const payloadJson = JSON.stringify(input.payload);
  await repos.audits.append({
    id: input.ids.nextId(),
    teamId: input.teamId,
    eventKind: input.eventKind,
    payloadJson,
    createdAt: input.now,
  });
  await repos.outbox.enqueue({
    id: input.ids.nextId(),
    teamId: input.teamId,
    eventKind: input.eventKind,
    payloadJson,
    createdAt: input.now,
    publishedAt: null,
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function handleEvaluateCutoverReadiness(
  deps: PiAuthorityCutoverHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<PiAuthorityCutoverCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'evaluate-cutover-readiness');
  const input = parsePiAuthorityCutoverCommandInputV1('evaluate-cutover-readiness', rawInput);
  const commandHash = computeCommandHash(envelope.commandName, envelope.commandSchemaVersion, input);

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayIfPresent(repos, envelope.commandName, envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const auth = authorizeTeamCutoverOperator(deps.operatorRole);
    if (!auth.allowed) {
      return buildResponse(envelope.commandName, 'rejected', 'PI_AUTHORITY_FORBIDDEN', 'user_action', {
        rejectReason: auth.reason,
      });
    }

    const now = deps.clock.now();
    const migration = await ensureMigration(repos, deps.teamId, now);
    if (migration.migrationRevision !== input.expectedMigrationRevision) {
      return buildResponse(envelope.commandName, 'conflict', 'PI_AUTHORITY_REVISION_CONFLICT', 'reread_then_new_command', {
        conflictReason: 'migration_revision_conflict',
      });
    }

    const readiness = evaluateCutoverReadiness(input.readinessChecks);
    const snapshotId = deps.ids.nextId();
    const expiresAt = now + input.tokenTtlMs;
    const snapshot: CutoverReadinessSnapshotV1 = {
      schemaVersion: 1,
      teamId: deps.teamId,
      migrationRevision: migration.migrationRevision,
      currentEpoch: migration.authorityEpoch,
      targetEpoch: migration.authorityEpoch + 1,
      currentState: migration.state,
      targetState: 'new_authority',
      checks: input.readinessChecks,
      allPassed: readiness.kind === 'ready',
      issuedAt: now,
      expiresAt,
    };

    await repos.readinessSnapshots.create({
      snapshotId,
      teamId: deps.teamId,
      migrationRevision: snapshot.migrationRevision,
      currentEpoch: snapshot.currentEpoch,
      targetEpoch: snapshot.targetEpoch,
      currentState: snapshot.currentState,
      checksJson: JSON.stringify(snapshot.checks),
      allPassed: snapshot.allPassed,
      issuedAt: now,
      expiresAt,
    });

    let readinessToken: string | undefined;
    let tokenId: ID | undefined;
    if (readiness.kind === 'ready') {
      readinessToken = mintTokenPlain();
      tokenId = deps.ids.nextId();
      await repos.readinessTokens.create({
        tokenId,
        teamId: deps.teamId,
        tokenHash: hashToken(readinessToken),
        targetEpoch: snapshot.targetEpoch,
        migrationRevision: snapshot.migrationRevision,
        readinessSnapshotId: snapshotId,
        issuedTo: deps.operatorId,
        issuedAt: now,
        expiresAt,
        consumedAt: null,
      });

      // 进入 cutover_pending（若仍在更早状态）
      if (migration.state === 'legacy' || migration.state === 'shadow') {
        const next = evaluateMigrationTransition({ from: migration.state, to: 'cutover_pending' });
        if (next.kind === 'allow') {
          await repos.migrations.upsert({
            ...migration,
            state: 'cutover_pending',
            updatedAt: now,
          });
        }
      }
    }

    const result: PiAuthorityCutoverCommandOutputUnionV1 = {
      commandName: 'evaluate-cutover-readiness',
      snapshot,
      readinessSnapshotId: snapshotId,
      ...(readinessToken ? { readinessToken, tokenId, expiresAt } : {}),
    };

    await appendAuditAndOutbox(repos, {
      teamId: deps.teamId,
      eventKind: 'cutover_readiness_evaluated',
      payload: { snapshotId, allPassed: snapshot.allPassed, operatorId: deps.operatorId },
      now,
      ids: deps.ids,
    });

    const receipt = await commitReceipt(repos, {
      commandName: envelope.commandName,
      commandSchemaVersion: envelope.commandSchemaVersion,
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      outcome: 'applied',
      result,
      committedRevisions: [{
        streamKind: 'pi_authority_migration',
        streamId: deps.teamId,
        revision: migration.migrationRevision,
      }],
      eventRefs: [],
      now,
      receiptId: deps.ids.nextId(),
    });

    return buildResponse(
      envelope.commandName,
      'applied',
      snapshot.allPassed ? 'PI_AUTHORITY_READINESS_READY' : 'PI_AUTHORITY_READINESS_NOT_READY',
      'none',
      { receipt: toReceiptV1(receipt), result },
    );
  });
}

export async function handleExecutePiAuthorityCutover(
  deps: PiAuthorityCutoverHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<PiAuthorityCutoverCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'execute-pi-authority-cutover');
  const input = parsePiAuthorityCutoverCommandInputV1('execute-pi-authority-cutover', rawInput);
  const commandHash = computeCommandHash(envelope.commandName, envelope.commandSchemaVersion, input);

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayIfPresent(repos, envelope.commandName, envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const now = deps.clock.now();
    const migration = await ensureMigration(repos, deps.teamId, now);

    // 幂等：已 cutover 到目标 epoch 时返回同一结果
    if (
      migration.legacyWriterFenced
      && migration.authorityEpoch === input.expectedTargetEpoch
      && migration.state === 'new_authority'
    ) {
      const openDrains = await repos.drainLineages.listOpen(deps.teamId);
      const result: PiAuthorityCutoverCommandOutputUnionV1 = {
        commandName: 'execute-pi-authority-cutover',
        migration: migrationToV1(migration),
        cancelledJobIds: input.pendingLegacyJobIds,
        drainLineages: openDrains.map(drainToV1),
        cutoverVersion: migration.cutoverVersion ?? migration.authorityEpoch,
      };
      const receipt = await commitReceipt(repos, {
        commandName: envelope.commandName,
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome: 'no_op',
        result,
        committedRevisions: [{
          streamKind: 'pi_authority_migration',
          streamId: deps.teamId,
          revision: migration.migrationRevision,
        }],
        eventRefs: [],
        now,
        receiptId: deps.ids.nextId(),
      });
      return buildResponse(envelope.commandName, 'replayed', 'PI_AUTHORITY_CUTOVER_REPLAYED', 'none', {
        receipt: toReceiptV1(receipt),
        result,
      });
    }

    const tokenRow = await repos.readinessTokens.getByHash(hashToken(input.readinessToken));
    const acceptance = evaluateCutoverTokenAcceptance({
      migration: migrationToV1(migration),
      role: deps.operatorRole,
      tokenExpired: !tokenRow || tokenRow.expiresAt < now,
      tokenConsumed: Boolean(tokenRow?.consumedAt),
      tokenTeamId: tokenRow?.teamId ?? '',
      tokenTargetEpoch: tokenRow?.targetEpoch ?? -1,
      tokenMigrationRevision: tokenRow?.migrationRevision ?? -1,
      expectedMigrationRevision: input.expectedMigrationRevision,
      expectedTargetEpoch: input.expectedTargetEpoch,
      tokenHashMatches: Boolean(tokenRow),
    });

    if (acceptance.kind === 'reject') {
      const code = acceptance.reason === 'migration_revision_conflict'
        ? 'PI_AUTHORITY_REVISION_CONFLICT'
        : acceptance.reason === 'requires_team_owner_or_admin'
          ? 'PI_AUTHORITY_FORBIDDEN'
          : 'PI_AUTHORITY_CUTOVER_REJECTED';
      const outcome = acceptance.reason === 'migration_revision_conflict' ? 'conflict' as const : 'rejected' as const;
      return buildResponse(envelope.commandName, outcome, code,
        outcome === 'conflict' ? 'reread_then_new_command' : 'user_action', {
          ...(outcome === 'conflict'
            ? { conflictReason: acceptance.reason }
            : { rejectReason: acceptance.reason }),
        });
    }

    // 取消未开始 job；登记 drain
    const cancelledJobIds = [...input.pendingLegacyJobIds];
    for (const jobId of input.pendingLegacyJobIds) {
      const disp = disposeLegacyJobAtCutover({
        status: 'pending',
        now,
        drainDeadlineMs: input.drainDeadlineMs,
      });
      if (disp.kind !== 'cancel') {
        // 理论不应发生；防御
      }
      await appendAuditAndOutbox(repos, {
        teamId: deps.teamId,
        eventKind: 'legacy_job_cancelled_at_cutover',
        payload: { jobId },
        now,
        ids: deps.ids,
      });
    }

    const drainDeadlineAt = now + input.drainDeadlineMs;
    const drainLineages: LegacyDrainLineageRecord[] = [];
    let fencingSeq = 1;
    for (const job of input.runningLegacyJobs) {
      const disp = disposeLegacyJobAtCutover({
        status: 'running',
        now,
        drainDeadlineMs: input.drainDeadlineMs,
      });
      if (disp.kind !== 'drain') continue;
      const record: LegacyDrainLineageRecord = {
        drainId: deps.ids.nextId(),
        teamId: deps.teamId,
        lineageKey: job.lineageKey,
        jobId: job.jobId,
        cutoverVersion: acceptance.nextEpoch,
        fencingToken: fencingSeq,
        drainLeaseId: deps.ids.nextId(),
        state: 'draining',
        deadlineAt: disp.deadlineAt,
        resultMessageId: null,
        resultPayloadJson: null,
        createdAt: now,
        updatedAt: now,
      };
      fencingSeq += 1;
      await repos.drainLineages.create(record);
      drainLineages.push(record);
    }

    const nextMigration: TeamPiAuthorityMigrationRecord = {
      ...migration,
      authorityEpoch: acceptance.nextEpoch,
      migrationRevision: acceptance.nextRevision,
      state: 'new_authority',
      legacyWriterFenced: true,
      emergencyStop: migration.emergencyStop,
      cutoverVersion: acceptance.nextEpoch,
      cutoverAt: now,
      cutoverBy: deps.operatorId,
      drainDeadlineAt,
      updatedAt: now,
    };
    await repos.migrations.upsert(nextMigration);
    if (tokenRow) {
      await repos.readinessTokens.markConsumed(tokenRow.tokenId, now);
    }

    // 初始化退役观察窗口计数
    const counters = await repos.retirementCounters.get(deps.teamId);
    await repos.retirementCounters.upsert({
      teamId: deps.teamId,
      legacyWriterCallCount: counters?.legacyWriterCallCount ?? 0,
      legacyClientCallCount: counters?.legacyClientCallCount ?? 0,
      observationWindowStartedAt: now,
      observationWindowEndsAt: now + 7 * 24 * 60 * 60 * 1000,
      emergencyStopDrillPassed: counters?.emergencyStopDrillPassed ?? false,
      forwardRecoveryDrillPassed: counters?.forwardRecoveryDrillPassed ?? false,
      historicalProvenanceExportVerified: counters?.historicalProvenanceExportVerified ?? false,
      replacementQueryPathReady: counters?.replacementQueryPathReady ?? false,
      updatedAt: now,
    });

    await appendAuditAndOutbox(repos, {
      teamId: deps.teamId,
      eventKind: 'pi_authority_cutover_applied',
      payload: {
        authorityEpoch: nextMigration.authorityEpoch,
        migrationRevision: nextMigration.migrationRevision,
        cutoverVersion: nextMigration.cutoverVersion,
        cancelledJobIds,
        drainCount: drainLineages.length,
        operatorId: deps.operatorId,
      },
      now,
      ids: deps.ids,
    });

    const result: PiAuthorityCutoverCommandOutputUnionV1 = {
      commandName: 'execute-pi-authority-cutover',
      migration: migrationToV1(nextMigration),
      cancelledJobIds,
      drainLineages: drainLineages.map(drainToV1),
      cutoverVersion: nextMigration.cutoverVersion!,
    };

    const receipt = await commitReceipt(repos, {
      commandName: envelope.commandName,
      commandSchemaVersion: envelope.commandSchemaVersion,
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      outcome: 'applied',
      result,
      committedRevisions: [{
        streamKind: 'pi_authority_migration',
        streamId: deps.teamId,
        revision: nextMigration.migrationRevision,
      }],
      eventRefs: [{
        streamKind: 'pi_authority_migration',
        streamId: deps.teamId,
        sequence: nextMigration.migrationRevision,
      }],
      now,
      receiptId: deps.ids.nextId(),
    });

    return buildResponse(envelope.commandName, 'applied', 'PI_AUTHORITY_CUTOVER_APPLIED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleSubmitLegacyDrainResult(
  deps: PiAuthorityCutoverHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<PiAuthorityCutoverCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'submit-legacy-drain-result');
  const input = parsePiAuthorityCutoverCommandInputV1('submit-legacy-drain-result', rawInput);
  // drain 业务幂等键优先用 payload 内 idempotencyKey（与 envelope 可相同）
  const commandHash = computeCommandHash(envelope.commandName, envelope.commandSchemaVersion, input);

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayIfPresent(repos, envelope.commandName, envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const now = deps.clock.now();
    const migration = await ensureMigration(repos, deps.teamId, now);
    const path = evaluateCommandPathAvailability({
      migration: migrationToV1(migration),
      path: 'drain_bridge',
    });
    if (!path.allowed) {
      return buildResponse(envelope.commandName, 'rejected', 'PI_AUTHORITY_DRAIN_REJECTED', 'user_action', {
        rejectReason: path.reason,
      });
    }

    const drain = await repos.drainLineages.getById(input.drainId);
    if (!drain || drain.teamId !== deps.teamId) {
      return buildResponse(envelope.commandName, 'rejected', 'PI_AUTHORITY_DRAIN_NOT_FOUND', 'user_action', {
        rejectReason: 'drain_not_found',
      });
    }

    const decision = evaluateLegacyDrainResult({
      drainState: drain.state,
      now,
      deadlineAt: drain.deadlineAt,
      expectedFencingToken: drain.fencingToken,
      providedFencingToken: input.fencingToken,
      expectedLeaseId: drain.drainLeaseId,
      providedLeaseId: input.drainLeaseId,
      expectedLineageKey: drain.lineageKey,
      providedLineageKey: input.lineageKey,
      existingResultMessageId: drain.resultMessageId,
    });

    if (decision.kind === 'reject') {
      return buildResponse(envelope.commandName, 'rejected', 'PI_AUTHORITY_DRAIN_REJECTED', 'user_action', {
        rejectReason: decision.reason,
      });
    }

    if (decision.kind === 'replay') {
      const provenance: LegacyDrainResultProvenanceV1 = {
        schemaVersion: 1,
        drainId: drain.drainId,
        lineageKey: drain.lineageKey,
        cutoverVersion: drain.cutoverVersion,
        fencingToken: drain.fencingToken,
        drainLeaseId: drain.drainLeaseId,
        sourceJobId: drain.jobId,
        submittedAt: drain.updatedAt,
      };
      const result: PiAuthorityCutoverCommandOutputUnionV1 = {
        commandName: 'submit-legacy-drain-result',
        drainId: drain.drainId,
        state: 'completed',
        resultMessageId: decision.existingMessageId,
        provenance,
        disposition: 'replayed',
      };
      const receipt = await commitReceipt(repos, {
        commandName: envelope.commandName,
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome: 'no_op',
        result,
        committedRevisions: [],
        eventRefs: [],
        now,
        receiptId: deps.ids.nextId(),
      });
      return buildResponse(envelope.commandName, 'replayed', 'PI_AUTHORITY_DRAIN_REPLAYED', 'none', {
        receipt: toReceiptV1(receipt),
        result,
      });
    }

    if (decision.kind === 'expire' || decision.kind === 'recovery_pending') {
      // 过期与无法安全解释均进入 recovery_pending（ADR-0068），等待合法人工恢复。
      const updated: LegacyDrainLineageRecord = {
        ...drain,
        state: 'recovery_pending',
        updatedAt: now,
      };
      await repos.drainLineages.update(updated);
      await appendAuditAndOutbox(repos, {
        teamId: deps.teamId,
        eventKind: 'legacy_drain_recovery_pending',
        payload: { drainId: drain.drainId, reason: decision.kind },
        now,
        ids: deps.ids,
      });
      const result: PiAuthorityCutoverCommandOutputUnionV1 = {
        commandName: 'submit-legacy-drain-result',
        drainId: drain.drainId,
        state: 'recovery_pending',
        disposition: decision.kind === 'expire' ? 'expired' : 'recovery_pending',
      };
      const receipt = await commitReceipt(repos, {
        commandName: envelope.commandName,
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome: 'applied',
        result,
        committedRevisions: [],
        eventRefs: [],
        now,
        receiptId: deps.ids.nextId(),
      });
      return buildResponse(envelope.commandName, 'applied', 'PI_AUTHORITY_DRAIN_RECOVERY_PENDING', 'user_action', {
        receipt: toReceiptV1(receipt),
        result,
      });
    }

    // accept：以带 provenance 的 Message 事实提交（本切片用 resultMessageId 代表 Message+Inbox 事务提交）
    const resultMessageId = deps.ids.nextId();
    const provenance: LegacyDrainResultProvenanceV1 = {
      schemaVersion: 1,
      drainId: drain.drainId,
      lineageKey: drain.lineageKey,
      cutoverVersion: drain.cutoverVersion,
      fencingToken: drain.fencingToken,
      drainLeaseId: drain.drainLeaseId,
      sourceJobId: drain.jobId,
      submittedAt: now,
    };
    const updated: LegacyDrainLineageRecord = {
      ...drain,
      state: 'completed',
      resultMessageId,
      resultPayloadJson: JSON.stringify({
        payload: input.resultPayload,
        provenance,
        // 明确：不得自动 promotion / root Task / coordination job
        autoPromotion: false,
        createsRootTask: false,
        createsCoordinationJob: false,
      }),
      updatedAt: now,
    };
    await repos.drainLineages.update(updated);

    // 结果消息也绑定 cutover 后 epoch（当前 epoch，带 legacy provenance）
    await repos.epochBindings.create({
      messageId: resultMessageId,
      teamId: deps.teamId,
      sourceLineageKey: `legacy-drain:${drain.lineageKey}`,
      authorityEpoch: migration.authorityEpoch,
      migrationRevision: migration.migrationRevision,
      boundAt: now,
      clientMessageId: null,
    });

    await appendAuditAndOutbox(repos, {
      teamId: deps.teamId,
      eventKind: 'legacy_drain_result_accepted',
      payload: { drainId: drain.drainId, resultMessageId, provenance },
      now,
      ids: deps.ids,
    });

    const result: PiAuthorityCutoverCommandOutputUnionV1 = {
      commandName: 'submit-legacy-drain-result',
      drainId: drain.drainId,
      state: 'completed',
      resultMessageId,
      provenance,
      disposition: 'accepted',
    };
    const receipt = await commitReceipt(repos, {
      commandName: envelope.commandName,
      commandSchemaVersion: envelope.commandSchemaVersion,
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      outcome: 'applied',
      result,
      committedRevisions: [{
        streamKind: 'legacy_drain',
        streamId: drain.drainId,
        revision: 1,
      }],
      eventRefs: [],
      now,
      receiptId: deps.ids.nextId(),
    });
    return buildResponse(envelope.commandName, 'applied', 'PI_AUTHORITY_DRAIN_ACCEPTED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleEmergencyStopPi(
  deps: PiAuthorityCutoverHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<PiAuthorityCutoverCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'emergency-stop-pi');
  const input = parsePiAuthorityCutoverCommandInputV1('emergency-stop-pi', rawInput);
  const commandHash = computeCommandHash(envelope.commandName, envelope.commandSchemaVersion, input);

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayIfPresent(repos, envelope.commandName, envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const now = deps.clock.now();
    const migration = await ensureMigration(repos, deps.teamId, now);
    if (migration.migrationRevision !== input.expectedMigrationRevision) {
      return buildResponse(envelope.commandName, 'conflict', 'PI_AUTHORITY_REVISION_CONFLICT', 'reread_then_new_command', {
        conflictReason: 'migration_revision_conflict',
      });
    }

    const next: TeamPiAuthorityMigrationRecord = {
      ...migration,
      emergencyStop: true,
      // 明确不重开 legacy writer
      legacyWriterFenced: migration.legacyWriterFenced || migration.state !== 'legacy',
      migrationRevision: migration.migrationRevision + 1,
      updatedAt: now,
    };
    // 若已 fenced，保持 fenced；未 cutover 的 emergency-stop 也不启用 dual path
    await repos.migrations.upsert(next);
    const effects = emergencyStopEffects();

    await appendAuditAndOutbox(repos, {
      teamId: deps.teamId,
      eventKind: 'pi_emergency_stop',
      payload: { reason: input.reason, operatorId: deps.operatorId, effects },
      now,
      ids: deps.ids,
    });

    const result: PiAuthorityCutoverCommandOutputUnionV1 = {
      commandName: 'emergency-stop-pi',
      migration: migrationToV1(next),
      ...effects,
    };
    const receipt = await commitReceipt(repos, {
      commandName: envelope.commandName,
      commandSchemaVersion: envelope.commandSchemaVersion,
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      outcome: 'applied',
      result,
      committedRevisions: [{
        streamKind: 'pi_authority_migration',
        streamId: deps.teamId,
        revision: next.migrationRevision,
      }],
      eventRefs: [],
      now,
      receiptId: deps.ids.nextId(),
    });
    return buildResponse(envelope.commandName, 'applied', 'PI_AUTHORITY_EMERGENCY_STOP', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleClearEmergencyStop(
  deps: PiAuthorityCutoverHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<PiAuthorityCutoverCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'clear-emergency-stop');
  const input = parsePiAuthorityCutoverCommandInputV1('clear-emergency-stop', rawInput);
  const commandHash = computeCommandHash(envelope.commandName, envelope.commandSchemaVersion, input);

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayIfPresent(repos, envelope.commandName, envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const now = deps.clock.now();
    const migration = await ensureMigration(repos, deps.teamId, now);
    if (migration.migrationRevision !== input.expectedMigrationRevision) {
      return buildResponse(envelope.commandName, 'conflict', 'PI_AUTHORITY_REVISION_CONFLICT', 'reread_then_new_command', {
        conflictReason: 'migration_revision_conflict',
      });
    }
    if (!input.recoveryFromNewFactsOnly) {
      return buildResponse(envelope.commandName, 'rejected', 'PI_AUTHORITY_RECOVERY_REJECTED', 'user_action', {
        rejectReason: 'must_recover_from_new_facts_only',
      });
    }

    const next: TeamPiAuthorityMigrationRecord = {
      ...migration,
      emergencyStop: false,
      // 恢复不得重开 legacy writer
      legacyWriterFenced: migration.legacyWriterFenced,
      migrationRevision: migration.migrationRevision + 1,
      updatedAt: now,
    };
    await repos.migrations.upsert(next);

    const counters = await repos.retirementCounters.get(deps.teamId);
    if (counters) {
      await repos.retirementCounters.upsert({
        ...counters,
        emergencyStopDrillPassed: true,
        forwardRecoveryDrillPassed: true,
        updatedAt: now,
      });
    }

    await appendAuditAndOutbox(repos, {
      teamId: deps.teamId,
      eventKind: 'pi_emergency_stop_cleared',
      payload: {
        operatorId: deps.operatorId,
        recoveredFromNewFactsOnly: true,
        legacyWriterReenabled: false,
      },
      now,
      ids: deps.ids,
    });

    const result: PiAuthorityCutoverCommandOutputUnionV1 = {
      commandName: 'clear-emergency-stop',
      migration: migrationToV1(next),
      recoveredFromNewFactsOnly: true,
      legacyWriterReenabled: false,
    };
    const receipt = await commitReceipt(repos, {
      commandName: envelope.commandName,
      commandSchemaVersion: envelope.commandSchemaVersion,
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      outcome: 'applied',
      result,
      committedRevisions: [{
        streamKind: 'pi_authority_migration',
        streamId: deps.teamId,
        revision: next.migrationRevision,
      }],
      eventRefs: [],
      now,
      receiptId: deps.ids.nextId(),
    });
    return buildResponse(envelope.commandName, 'applied', 'PI_AUTHORITY_EMERGENCY_STOP_CLEARED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleAdvanceMigrationState(
  deps: PiAuthorityCutoverHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<PiAuthorityCutoverCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'advance-migration-state');
  const input = parsePiAuthorityCutoverCommandInputV1('advance-migration-state', rawInput);
  const commandHash = computeCommandHash(envelope.commandName, envelope.commandSchemaVersion, input);

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayIfPresent(repos, envelope.commandName, envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const auth = authorizeTeamCutoverOperator(deps.operatorRole);
    if (!auth.allowed) {
      return buildResponse(envelope.commandName, 'rejected', 'PI_AUTHORITY_FORBIDDEN', 'user_action', {
        rejectReason: auth.reason,
      });
    }

    const now = deps.clock.now();
    const migration = await ensureMigration(repos, deps.teamId, now);
    if (migration.migrationRevision !== input.expectedMigrationRevision) {
      return buildResponse(envelope.commandName, 'conflict', 'PI_AUTHORITY_REVISION_CONFLICT', 'reread_then_new_command', {
        conflictReason: 'migration_revision_conflict',
      });
    }

    const gate = evaluateRetirementGate(input.metricsGate, input.targetState);
    if (gate.kind === 'block') {
      return buildResponse(envelope.commandName, 'rejected', 'PI_AUTHORITY_RETIREMENT_BLOCKED', 'user_action', {
        rejectReason: gate.reasons.join(','),
      });
    }

    const transition = evaluateMigrationTransition({
      from: migration.state,
      to: input.targetState,
    });
    if (transition.kind === 'reject') {
      return buildResponse(envelope.commandName, 'rejected', 'PI_AUTHORITY_STATE_REJECTED', 'user_action', {
        rejectReason: transition.reason,
      });
    }

    const next: TeamPiAuthorityMigrationRecord = {
      ...migration,
      state: input.targetState,
      legacyWriterFenced: true,
      migrationRevision: migration.migrationRevision + 1,
      updatedAt: now,
    };
    await repos.migrations.upsert(next);
    await appendAuditAndOutbox(repos, {
      teamId: deps.teamId,
      eventKind: 'pi_migration_state_advanced',
      payload: { from: migration.state, to: input.targetState, operatorId: deps.operatorId },
      now,
      ids: deps.ids,
    });

    const result: PiAuthorityCutoverCommandOutputUnionV1 = {
      commandName: 'advance-migration-state',
      migration: migrationToV1(next),
    };
    const receipt = await commitReceipt(repos, {
      commandName: envelope.commandName,
      commandSchemaVersion: envelope.commandSchemaVersion,
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      outcome: 'applied',
      result,
      committedRevisions: [{
        streamKind: 'pi_authority_migration',
        streamId: deps.teamId,
        revision: next.migrationRevision,
      }],
      eventRefs: [],
      now,
      receiptId: deps.ids.nextId(),
    });
    return buildResponse(envelope.commandName, 'applied', 'PI_AUTHORITY_STATE_ADVANCED', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleBindMessageAuthorityEpoch(
  deps: PiAuthorityCutoverHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<PiAuthorityCutoverCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'bind-message-authority-epoch');
  const input = parsePiAuthorityCutoverCommandInputV1('bind-message-authority-epoch', rawInput);
  const commandHash = computeCommandHash(envelope.commandName, envelope.commandSchemaVersion, input);

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayIfPresent(repos, envelope.commandName, envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const now = deps.clock.now();
    const migration = await ensureMigration(repos, deps.teamId, now);

    const existingByMessage = await repos.epochBindings.getByMessageId(input.messageId);
    const existingByLineage = await repos.epochBindings.getBySourceLineageKey(input.sourceLineageKey);
    const existingByClient = input.clientMessageId
      ? await repos.epochBindings.getByClientMessageId(input.clientMessageId)
      : null;
    const existing = existingByMessage ?? existingByClient ?? existingByLineage;

    const decision = evaluateMessageEpochBinding({
      current: migrationToV1(migration),
      existingBinding: existing
        ? {
            authorityEpoch: existing.authorityEpoch,
            migrationRevision: existing.migrationRevision,
            sourceLineageKey: existing.sourceLineageKey,
          }
        : undefined,
      sourceLineageKey: input.sourceLineageKey,
      expectedMigrationRevision: input.expectedMigrationRevision,
    });

    if (decision.kind === 'reject') {
      return buildResponse(
        envelope.commandName,
        decision.reason === 'migration_revision_conflict' ? 'conflict' : 'rejected',
        decision.reason === 'migration_revision_conflict'
          ? 'PI_AUTHORITY_REVISION_CONFLICT'
          : 'PI_AUTHORITY_BIND_REJECTED',
        decision.reason === 'migration_revision_conflict' ? 'reread_then_new_command' : 'user_action',
        decision.reason === 'migration_revision_conflict'
          ? { conflictReason: decision.reason }
          : { rejectReason: decision.reason },
      );
    }

    if (decision.kind === 'replay' && existing) {
      const result: PiAuthorityCutoverCommandOutputUnionV1 = {
        commandName: 'bind-message-authority-epoch',
        binding: bindingToV1(existing),
      };
      const receipt = await commitReceipt(repos, {
        commandName: envelope.commandName,
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome: 'no_op',
        result,
        committedRevisions: [],
        eventRefs: [],
        now,
        receiptId: deps.ids.nextId(),
      });
      return buildResponse(envelope.commandName, 'replayed', 'PI_AUTHORITY_EPOCH_REPLAYED', 'none', {
        receipt: toReceiptV1(receipt),
        result,
      });
    }

    // 与 cutover 线性化：绑定后递增 migration revision，保证并发消息/cutover 可排序
    // （同一事务内消息提交占用 revision 槽位）
    const nextRevision = migration.migrationRevision + 1;
    const binding: MessageAuthorityEpochBindingRecord = {
      messageId: input.messageId,
      teamId: deps.teamId,
      sourceLineageKey: input.sourceLineageKey,
      authorityEpoch: decision.authorityEpoch,
      migrationRevision: migration.migrationRevision,
      boundAt: now,
      clientMessageId: input.clientMessageId ?? null,
    };
    await repos.epochBindings.create(binding);
    await repos.migrations.upsert({
      ...migration,
      migrationRevision: nextRevision,
      updatedAt: now,
    });

    const result: PiAuthorityCutoverCommandOutputUnionV1 = {
      commandName: 'bind-message-authority-epoch',
      binding: bindingToV1(binding),
    };
    const receipt = await commitReceipt(repos, {
      commandName: envelope.commandName,
      commandSchemaVersion: envelope.commandSchemaVersion,
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      outcome: 'applied',
      result,
      committedRevisions: [{
        streamKind: 'pi_authority_migration',
        streamId: deps.teamId,
        revision: nextRevision,
      }],
      eventRefs: [],
      now,
      receiptId: deps.ids.nextId(),
    });
    return buildResponse(envelope.commandName, 'applied', 'PI_AUTHORITY_EPOCH_BOUND', 'none', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

export async function handleRecordLegacyWriteAttempt(
  deps: PiAuthorityCutoverHandlerDeps,
  rawEnvelope: unknown,
  rawInput: unknown,
): Promise<PiAuthorityCutoverCommandResponseV1> {
  const envelope = parseEnvelope(rawEnvelope, 'record-legacy-write-attempt');
  const input = parsePiAuthorityCutoverCommandInputV1('record-legacy-write-attempt', rawInput);
  const commandHash = computeCommandHash(envelope.commandName, envelope.commandSchemaVersion, input);

  return deps.unitOfWork.runInTransaction(async (repos) => {
    const replay = await replayIfPresent(repos, envelope.commandName, envelope.idempotencyKey, commandHash);
    if (replay) return replay;

    const now = deps.clock.now();
    const migration = await ensureMigration(repos, deps.teamId, now);
    const path = evaluateCommandPathAvailability({
      migration: migrationToV1(migration),
      path: 'legacy_write',
    });

    const correlationId = input.clientCorrelationId ?? deps.ids.nextId();

    if (path.allowed) {
      // 尚未 fenced：仍允许写，但记审计（shadow 可观察）
      await repos.legacyWriteAudits.create({
        id: deps.ids.nextId(),
        teamId: deps.teamId,
        writeKind: input.writeKind,
        correlationId,
        createdAt: now,
      });
      const counters = await repos.retirementCounters.get(deps.teamId);
      await repos.retirementCounters.upsert({
        teamId: deps.teamId,
        legacyWriterCallCount: (counters?.legacyWriterCallCount ?? 0) + 1,
        legacyClientCallCount: (counters?.legacyClientCallCount ?? 0) + 1,
        observationWindowStartedAt: counters?.observationWindowStartedAt ?? null,
        observationWindowEndsAt: counters?.observationWindowEndsAt ?? null,
        emergencyStopDrillPassed: counters?.emergencyStopDrillPassed ?? false,
        forwardRecoveryDrillPassed: counters?.forwardRecoveryDrillPassed ?? false,
        historicalProvenanceExportVerified: counters?.historicalProvenanceExportVerified ?? false,
        replacementQueryPathReady: counters?.replacementQueryPathReady ?? false,
        updatedAt: now,
      });
      // 返回 allowed 语义：仍用 stable code 表示未退役
      const retired = buildLegacyCoordinationRetiredError({
        cutoverVersion: migration.cutoverVersion,
        authorityEpoch: migration.authorityEpoch,
        migrationRevision: migration.migrationRevision,
        correlationId,
      });
      // 实际未退役：用不同 result 形态 — 仍返回 retired 结构会误导。改为 applied + 允许。
      const result: PiAuthorityCutoverCommandOutputUnionV1 = {
        commandName: 'record-legacy-write-attempt',
        retired: {
          ...retired,
          code: LEGACY_COORDINATION_RETIRED_CODE,
          message: 'Legacy coordination write still allowed (not yet fenced).',
        },
      };
      // 覆盖 message 以标明仍允许
      const receipt = await commitReceipt(repos, {
        commandName: envelope.commandName,
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash,
        outcome: 'applied',
        result,
        committedRevisions: [],
        eventRefs: [],
        now,
        receiptId: deps.ids.nextId(),
      });
      return buildResponse(envelope.commandName, 'applied', 'LEGACY_COORDINATION_STILL_ACTIVE', 'none', {
        receipt: toReceiptV1(receipt),
        result,
      });
    }

    // fenced：明确返回 LEGACY_COORDINATION_RETIRED，不静默转译
    const retired = buildLegacyCoordinationRetiredError({
      cutoverVersion: migration.cutoverVersion,
      authorityEpoch: migration.authorityEpoch,
      migrationRevision: migration.migrationRevision,
      correlationId,
    });
    await repos.legacyWriteAudits.create({
      id: deps.ids.nextId(),
      teamId: deps.teamId,
      writeKind: input.writeKind,
      correlationId,
      createdAt: now,
    });
    const counters = await repos.retirementCounters.get(deps.teamId);
    await repos.retirementCounters.upsert({
      teamId: deps.teamId,
      legacyWriterCallCount: (counters?.legacyWriterCallCount ?? 0) + 1,
      legacyClientCallCount: (counters?.legacyClientCallCount ?? 0) + 1,
      observationWindowStartedAt: counters?.observationWindowStartedAt ?? null,
      observationWindowEndsAt: counters?.observationWindowEndsAt ?? null,
      emergencyStopDrillPassed: counters?.emergencyStopDrillPassed ?? false,
      forwardRecoveryDrillPassed: counters?.forwardRecoveryDrillPassed ?? false,
      historicalProvenanceExportVerified: counters?.historicalProvenanceExportVerified ?? false,
      replacementQueryPathReady: counters?.replacementQueryPathReady ?? false,
      updatedAt: now,
    });
    await appendAuditAndOutbox(repos, {
      teamId: deps.teamId,
      eventKind: 'legacy_write_retired',
      payload: { writeKind: input.writeKind, correlationId },
      now,
      ids: deps.ids,
    });

    const result: PiAuthorityCutoverCommandOutputUnionV1 = {
      commandName: 'record-legacy-write-attempt',
      retired,
    };
    const receipt = await commitReceipt(repos, {
      commandName: envelope.commandName,
      commandSchemaVersion: envelope.commandSchemaVersion,
      idempotencyKey: envelope.idempotencyKey,
      commandHash,
      outcome: 'applied',
      result,
      committedRevisions: [],
      eventRefs: [],
      now,
      receiptId: deps.ids.nextId(),
    });
    return buildResponse(envelope.commandName, 'applied', LEGACY_COORDINATION_RETIRED_CODE, 'user_action', {
      receipt: toReceiptV1(receipt),
      result,
    });
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function handlePiAuthorityCutoverQuery(
  deps: PiAuthorityCutoverHandlerDeps,
  queryName: PiAuthorityCutoverQueryName,
  rawInput: unknown,
): Promise<PiAuthorityCutoverQueryResponseV1> {
  const input = parsePiAuthorityCutoverQueryInputV1(queryName, rawInput);
  return deps.unitOfWork.runInTransaction(async (repos) => {
    const now = deps.clock.now();
    if (queryName === 'query-migration-state') {
      const migration = await ensureMigration(repos, input.teamId, now);
      return {
        schemaVersion: 1,
        queryName,
        outcome: 'ready',
        stableCode: 'PI_AUTHORITY_MIGRATION_STATE',
        result: {
          queryName: 'query-migration-state',
          migration: migrationToV1(migration),
        },
      };
    }

    if (queryName === 'query-retirement-metrics') {
      const migration = await ensureMigration(repos, input.teamId, now);
      const counters = await repos.retirementCounters.get(input.teamId);
      const openDrain = await repos.drainLineages.listOpen(input.teamId);
      const recoveryPending = await repos.drainLineages.countByState(input.teamId, 'recovery_pending');
      const metrics = buildRetirementMetrics({
        teamId: input.teamId,
        migration: migrationToV1(migration),
        legacyWriterCallCount: counters?.legacyWriterCallCount ?? 0,
        legacyClientCallCount: counters?.legacyClientCallCount ?? 0,
        openDrainLineageCount: openDrain.filter((d) => d.state === 'draining').length,
        recoveryPendingCount: recoveryPending,
        observationWindowStartedAt: counters?.observationWindowStartedAt ?? null,
        observationWindowEndsAt: counters?.observationWindowEndsAt ?? null,
        now,
        emergencyStopDrillPassed: counters?.emergencyStopDrillPassed,
        forwardRecoveryDrillPassed: counters?.forwardRecoveryDrillPassed,
        historicalProvenanceExportVerified: counters?.historicalProvenanceExportVerified,
        replacementQueryPathReady: counters?.replacementQueryPathReady,
      });
      return {
        schemaVersion: 1,
        queryName,
        outcome: 'ready',
        stableCode: 'PI_AUTHORITY_RETIREMENT_METRICS',
        result: { queryName: 'query-retirement-metrics', metrics },
      };
    }

    // query-legacy-compatibility-projection
    if (queryName !== 'query-legacy-compatibility-projection') {
      return {
        schemaVersion: 1,
        queryName,
        outcome: 'rejected',
        stableCode: 'PI_AUTHORITY_QUERY_UNKNOWN',
        rejectReason: 'unknown_query',
      };
    }
    const projectionInput = input as {
      readonly teamId: ID;
      readonly projectionKind: 'coordination_job' | 'coordination_decision' | 'management_run_legacy';
      readonly sourceId: ID;
    };
    const migration = await ensureMigration(repos, projectionInput.teamId, now);
    const path = evaluateCommandPathAvailability({
      migration: migrationToV1(migration),
      path: 'legacy_read',
    });
    if (!path.allowed) {
      return {
        schemaVersion: 1,
        queryName,
        outcome: 'rejected',
        stableCode: 'LEGACY_PROJECTION_RETIRED',
        rejectReason: path.reason,
      };
    }
    const row = await repos.compatibilityProjections.get({
      sourceId: projectionInput.sourceId,
      projectionKind: projectionInput.projectionKind,
    });
    return {
      schemaVersion: 1,
      queryName,
      outcome: 'ready',
      stableCode: 'LEGACY_COMPATIBILITY_PROJECTION',
      result: {
        queryName: 'query-legacy-compatibility-projection',
        projection: row
          ? {
              schemaVersion: 1,
              teamId: row.teamId,
              projectionKind: row.projectionKind,
              sourceId: row.sourceId,
              cutoverVersion: migration.cutoverVersion,
              authorityEpoch: migration.authorityEpoch,
              immutable: true as const,
              payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
              projectedAt: row.projectedAt,
            }
          : null,
        writable: false,
      },
    };
  });
}

/** 导出协商供 daemon 兼容层 / 测试使用。 */
export { negotiateDaemonPiCapabilities, PI_AUTHORITY_CUTOVER_COMMAND_SCHEMA_VERSION };
