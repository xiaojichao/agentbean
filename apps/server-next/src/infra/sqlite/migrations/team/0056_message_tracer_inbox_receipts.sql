-- #921 切片 B：Message tracer 的 Inbox 投影、权威 Read boundary、Command receipt 与幂等 tombstone。
-- 合同：#893（Message delivery/read/freshness）/ #900（Server API/幂等/receipt）/ ADR-0062 / ADR-0067 / ADR-0069。
--
-- target（频道主线 / thread / DM / DM-thread）由 channel_id + thread_id(可空) + target_kind 定位。
-- SQLite 中 NULL 在 UNIQUE 约束里互异，无法用含 thread_id 的复合约束防重，故为每张表增加生成列
-- thread_key = COALESCE(thread_id, '')：mainline/dm 为 ''、thread/dm-thread 为 root 消息 id，
-- 使 (recipient_id, channel_id, thread_key[, seq]) 复合唯一能正确覆盖四类 target（#893 §3 两维组合）。

-- 1. Inbox 投影：每条投递给某 recipient 的消息恰好一行（自身消息由 handler 不入自身 inbox）。
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  thread_key TEXT GENERATED ALWAYS AS (COALESCE(thread_id, '')) STORED,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('channel-mainline', 'thread', 'dm', 'dm-thread')),
  target_seq INTEGER NOT NULL CHECK (target_seq >= 0),
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human', 'agent', 'system')),
  sender_id TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 一条消息投递给一个 recipient 只出现一次（仿 saved_messages 的 UNIQUE(message_id, user_id)）。
CREATE UNIQUE INDEX inbox_items_message_recipient_idx ON inbox_items(message_id, recipient_id);
-- recipient × target 内位置唯一（防重复 target_seq）。target_kind 不进唯一键：它由 channel.kind（不可变）
-- 与 thread_id 是否为空函数决定，对固定 (channel_id, thread_key) 是常量，加入不增加约束力。
CREATE UNIQUE INDEX inbox_items_recipient_target_seq_idx
  ON inbox_items(recipient_id, channel_id, thread_key, target_seq);
-- check-inbox 连续前缀查询：按 recipient × target 的 seq 升序。
CREATE INDEX inbox_items_recipient_target_seq_lookup_idx
  ON inbox_items(recipient_id, channel_id, thread_key, target_seq);

-- 2. 权威 Read boundary：ack-read-candidate 单调推进的位置。每 recipient × target 至多一行。
CREATE TABLE inbox_read_boundaries (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  thread_key TEXT GENERATED ALWAYS AS (COALESCE(thread_id, '')) STORED,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('channel-mainline', 'thread', 'dm', 'dm-thread')),
  read_seq INTEGER NOT NULL DEFAULT 0 CHECK (read_seq >= 0),
  advanced_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX inbox_read_boundaries_recipient_target_idx
  ON inbox_read_boundaries(recipient_id, channel_id, thread_key);

-- 3. Command receipt：一个 command 恰好一个持久 receipt（#900 §6）。
--    committed_revisions_json / event_refs_json 存 MessageTracerRevisionRefV1[] / MessageTracerEventRefV1[]。
--    result_json 存成功结果；result_available=0 表示结果已按治理压缩（#900 §1.5），仅留 tombstone 判定。
CREATE TABLE command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('send-message', 'check-inbox', 'ack-read-candidate')),
  command_schema_version INTEGER NOT NULL CHECK (command_schema_version >= 1),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  committed_revisions_json TEXT NOT NULL,
  event_refs_json TEXT NOT NULL,
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  result_json TEXT,
  commit_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 同 idempotency key（team 库内）唯一：replay/conflict 查重入口（#900 §1.3）。
CREATE UNIQUE INDEX command_receipts_idempotency_key_idx ON command_receipts(idempotency_key);

-- 4. Idempotency tombstone：result 被治理压缩后仍保留的去重锚（#900 §1.5）。
--    即使 receipt.result_json 被 NULL 化、result_available=0，tombstone 仍足以判定 replay/conflict。
CREATE TABLE idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('send-message', 'check-inbox', 'ack-read-candidate')),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idempotency_tombstones_idempotency_key_idx ON idempotency_tombstones(idempotency_key);
CREATE INDEX idempotency_tombstones_receipt_idx ON idempotency_tombstones(receipt_id);
