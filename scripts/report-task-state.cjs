#!/usr/bin/env node
// 只读巡检：只输出指定 Team 的任务、执行与交付索引，不读取凭据或消息正文。
const Database = require('better-sqlite3');

function classifyTask(row, now) {
  const liveClaims = row.claims.filter((claim) => claim.status === 'active' && claim.expiresAt > now
    && claim.taskRevision === row.revision && claim.taskAttempt === row.coordination?.attempt);
  const activeDispatches = row.dispatches.filter((dispatch) => ['queued', 'sent', 'accepted', 'running'].includes(dispatch.status));
  const latest = row.dispatches[0];
  if (row.status === 'in_review') {
    if (row.packages.length) return 'file_review';
    if (row.pendingPublications.length) return 'publication_pending';
    if (row.deliveries.length) return 'delivery_without_package';
    if (row.replyArtifactCount) return 'artifacts_without_package';
    if (row.agentReplyCount) return 'reply_without_package';
    return 'review_without_evidence';
  }
  if (row.status === 'in_progress') {
    if (row.lastStatusChange?.previousStatus === 'done' && row.lastStatusChange.status === 'in_progress'
      && row.lastStatusChange.at === row.updatedAt) {
      return 'manually_reopened';
    }
    if (liveClaims.length || activeDispatches.length) return 'execution_record_active';
    if (row.managementRun) return 'orchestration_requires_inspection';
    return 'progress_without_active_execution';
  }
  if (row.coordination || row.managementRun) return 'allocation_requires_inspection';
  if (!row.sourceMessageIds.length && !row.dispatches.length && !row.packages.length && !row.deliveries.length
    && !row.claims.length && row.relatedDecisions?.length > 0
    && row.relatedDecisions.every((decision) => decision.canonicalTaskId && decision.canonicalTaskId !== row.id)) {
    return 'duplicate_source_task';
  }
  if (activeDispatches.length) return 'dispatch_pending';
  if (latest && ['failed', 'timed_out', 'cancelled'].includes(latest.status)) return 'execution_stopped';
  if (latest?.status === 'succeeded') return 'success_without_task_transition';
  if (!row.sourceMessageIds.length && !row.dispatches.length) return 'no_execution_lineage';
  return 'not_dispatched';
}

const recommendations = {
  file_review: '检查包内文件并验收交付；不自动判定完成',
  publication_pending: '检查发布暂存与补偿记录；不创建空包',
  delivery_without_package: '按交付契约核实是否为合法文字交付',
  artifacts_without_package: '核对旧附件内容及发布来源，再决定是否补交文件包',
  reply_without_package: '查看原始 Agent 回复；需要文件的任务仍须补交',
  review_without_evidence: '未找到可关联的结果回报；检查历史讨论后决定继续、取消或关闭',
  duplicate_source_task: '原消息已有另一条有效 Task，当前任务无执行/交付；建议关闭此重复任务并保留来源记录',
  manually_reopened: '保留历史状态操作；确认是否仍需继续，不自动回滚',
  execution_record_active: '核对最后心跳与时限；active 记录不等于实时执行',
  orchestration_requires_inspection: '核对根任务编排事件及阻塞原因',
  progress_without_active_execution: '无活动执行记录；确认继续、取消或关闭',
  allocation_requires_inspection: '核对依赖、Offer、资格与重试预算',
  dispatch_pending: '核对派发状态与时限',
  execution_stopped: '原执行已停止；确认恢复或取消，不批量重跑',
  success_without_task_transition: '核对后续人工操作及交付投影，不自动覆盖状态',
  no_execution_lineage: '缺少消息/执行来源；疑似孤立任务，确认后关闭',
  not_dispatched: '尚无执行记录；确认是否仍需安排',
};

function readTaskStateReport({ globalDb, teamDb, teamPath, now = Date.now() }) {
  const team = globalDb.prepare('SELECT id, name, path FROM teams WHERE path = ?').get(teamPath);
  if (!team) throw new Error('TEAM_NOT_FOUND');
  // 在同一 SQLite read transaction 内读取全部任务事实，避免跨查询混入新状态。
  return teamDb.transaction(() => {
    const counts = teamDb.prepare(`SELECT status, count(*) AS count FROM tasks
      WHERE team_id = ? AND superseded_by_revision IS NULL GROUP BY status`).all(team.id);
    const tasks = teamDb.prepare(`SELECT id, title, status, revision, channel_id AS channelId,
      created_at AS createdAt, updated_at AS updatedAt FROM tasks
      WHERE team_id = ? AND superseded_by_revision IS NULL
      AND status IN ('todo', 'in_progress', 'in_review') ORDER BY created_at, id`).all(team.id);
    const rows = tasks.map((task) => {
      const scope = [team.id, task.id];
      const coordination = teamDb.prepare(`SELECT node_kind AS nodeKind, management_run_id AS managementRunId,
        task_revision AS taskRevision, attempt FROM task_coordinations WHERE team_id = ? AND task_id = ?`).get(...scope) ?? null;
      const managementRun = teamDb.prepare(`SELECT id, status, updated_at AS updatedAt FROM management_runs
        WHERE team_id = ? AND (root_task_id = ? OR id = ?) ORDER BY created_at DESC LIMIT 1`)
        .get(...scope, coordination?.managementRunId ?? '') ?? null;
      const sourceMessageIds = teamDb.prepare(`SELECT id FROM messages WHERE team_id = ? AND channel_id = ?
        AND sender_kind = 'human' AND json_extract(CASE WHEN json_valid(meta_json) THEN meta_json ELSE '{}' END, '$.taskId') = ?`)
        .all(team.id, task.channelId ?? '', task.id).map((row) => row.id);
      const relatedDecisions = teamDb.prepare(`SELECT c.id, c.message_id AS messageId, canonical.id AS canonicalTaskId
        FROM channel_coordination_decisions c JOIN messages m ON m.id = c.message_id
          AND m.team_id = c.team_id AND m.channel_id = c.channel_id
        LEFT JOIN tasks canonical ON canonical.team_id = c.team_id AND canonical.channel_id = c.channel_id
          AND canonical.superseded_by_revision IS NULL
          AND canonical.id = json_extract(CASE WHEN json_valid(m.meta_json) THEN m.meta_json ELSE '{}' END, '$.taskId')
        WHERE c.team_id = ? AND c.channel_id = ? AND c.linked_task_id = ?`)
        .all(team.id, task.channelId ?? '', task.id);
      const dispatches = teamDb.prepare(`SELECT DISTINCT d.id, d.status, d.created_at AS createdAt,
        d.completed_at AS completedAt, d.last_heartbeat_at AS lastHeartbeatAt, d.updated_at AS updatedAt
        FROM dispatches d JOIN messages m ON m.id = d.message_id AND m.team_id = d.team_id AND m.channel_id = d.channel_id
        LEFT JOIN invocation_dispatch_attempts a ON a.dispatch_id = d.id
        LEFT JOIN agent_invocations i ON i.id = a.invocation_id
        WHERE d.team_id = ? AND d.channel_id = ? AND (
          json_extract(CASE WHEN json_valid(m.meta_json) THEN m.meta_json ELSE '{}' END, '$.taskId') = ?
          OR json_extract(i.intent_json, '$.taskContext.taskId') = ?)
        ORDER BY d.created_at DESC, d.id DESC`).all(team.id, task.channelId ?? '', task.id, task.id);
      const packages = teamDb.prepare(`SELECT package_id AS packageId, member_count AS memberCount,
        task_revision AS taskRevision, task_attempt AS taskAttempt, created_at AS createdAt
        FROM output_packages WHERE team_id = ? AND task_id = ? ORDER BY created_at DESC, package_id DESC`).all(...scope);
      const deliveries = teamDb.prepare(`SELECT id, task_revision AS taskRevision, task_attempt AS taskAttempt,
        created_at AS createdAt FROM subtask_deliveries WHERE team_id = ? AND task_id = ? ORDER BY created_at DESC`).all(...scope);
      const claims = teamDb.prepare(`SELECT id, status, task_revision AS taskRevision, task_attempt AS taskAttempt,
        heartbeat_at AS heartbeatAt, expires_at AS expiresAt FROM task_claim_leases
        WHERE team_id = ? AND task_id = ? ORDER BY acquired_at DESC`).all(...scope);
      const pendingPublications = teamDb.prepare(`SELECT s.publish_id AS publishId, s.status, s.updated_at AS updatedAt
        FROM workspace_publish_stagings s WHERE s.team_id = ? AND s.channel_id = ?
        AND NOT EXISTS (SELECT 1 FROM output_packages p WHERE p.team_id = s.team_id AND p.publish_id = s.publish_id)
        AND json_extract(CASE WHEN json_valid(s.provenance_json) THEN s.provenance_json ELSE '{}' END, '$.taskId') = ?`)
        .all(team.id, task.channelId ?? '', task.id);
      let agentReplyCount = 0;
      let replyArtifactCount = 0;
      for (const dispatch of dispatches) {
        // task-claim-confirmed 等协调消息不是结果；旧版本允许无 fingerprint 的普通 Agent 回复。
        const replies = teamDb.prepare(`SELECT id FROM messages WHERE team_id = ? AND channel_id = ? AND sender_kind = 'agent'
          AND json_extract(CASE WHEN json_valid(meta_json) THEN meta_json ELSE '{}' END, '$.dispatchId') = ?
          AND (json_extract(CASE WHEN json_valid(meta_json) THEN meta_json ELSE '{}' END, '$.dispatchResultFingerprint') IS NOT NULL
            OR (json_extract(CASE WHEN json_valid(meta_json) THEN meta_json ELSE '{}' END, '$.kind') IS NULL AND length(trim(body)) > 0))`)
          .all(team.id, task.channelId ?? '', dispatch.id);
        if (dispatch.status !== 'succeeded') continue;
        agentReplyCount += replies.length;
        for (const reply of replies) {
          replyArtifactCount += teamDb.prepare(`SELECT count(*) AS count FROM artifacts
            WHERE team_id = ? AND message_id = ? AND filename != 'workspace-run.log'`).get(team.id, reply.id).count;
        }
      }
      const lastStatusChange = teamDb.prepare(`SELECT created_at AS at,
        json_extract(meta_json, '$.previousStatus') AS previousStatus, json_extract(meta_json, '$.status') AS status
        FROM messages WHERE team_id = ? AND channel_id = ? AND sender_kind = 'system' AND json_valid(meta_json)
        AND json_extract(meta_json, '$.kind') = 'task-status-updated' AND json_extract(meta_json, '$.taskId') = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(team.id, task.channelId ?? '', task.id) ?? null;
      const row = { ...task, coordination, managementRun, sourceMessageIds, relatedDecisions, dispatches, packages, deliveries,
        claims, pendingPublications, agentReplyCount, replyArtifactCount, lastStatusChange };
      const classification = classifyTask(row, now);
      return { ...row, classification, recommendation: recommendations[classification] };
    });
    const classifications = {};
    for (const row of rows) classifications[row.classification] = (classifications[row.classification] ?? 0) + 1;
    return { schemaVersion: 1, readOnly: true, team, asOf: now, counts, classifications, tasks: rows };
  })();
}

function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--team-path', '--global-db', '--team-db'].includes(args[i]) || !args[i + 1]) {
      throw new Error('Usage: report-task-state.cjs --team-path PATH [--global-db PATH] [--team-db PATH]');
    }
    options[args[i]] = args[i + 1];
  }
  if (!options['--team-path']) throw new Error('--team-path is required');
  const globalDb = new Database(options['--global-db'] ?? '/data/agentbean-next/global.sqlite', { readonly: true, fileMustExist: true });
  const teamDb = new Database(options['--team-db'] ?? '/data/agentbean-next/team.sqlite', { readonly: true, fileMustExist: true });
  try {
    console.log(JSON.stringify(readTaskStateReport({ globalDb, teamDb, teamPath: options['--team-path'] }), null, 2));
  } finally {
    teamDb.close();
    globalDb.close();
  }
}

module.exports = { classifyTask, readTaskStateReport, main };
if (require.main === module) main();
