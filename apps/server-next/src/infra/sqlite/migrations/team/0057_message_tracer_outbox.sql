-- #921 切片 C：Message tracer 的持久 outbox（ADR-0062/0067：send-message 单事务原子提交 outbox）。
-- server 侧此前无 outbox（仅 daemon 内存缓冲 management-durable-outbox.ts）；本表是 tracer 专用的持久投递队列。
-- 与 Message + InboxItem + receipt + tombstone 在同一 channel coordination UoW 事务写入（teamDb），满足原子合同；
-- 投递（socket emit / daemon wake）是 post-commit 关注，由 worker 拉 pending 行处理（C-wire 接真实投递，C-send 先入队）。

CREATE TABLE message_tracer_outbox (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('send-message', 'check-inbox', 'ack-read-candidate')),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('message-delivered')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('channel-mainline', 'thread', 'dm', 'dm-thread')),
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  -- 受众快照（recipient id 数组，脱敏无 body）；投递时按受众唤醒，不回传正文。
  audience_recipient_ids_json TEXT NOT NULL,
  -- 投递载荷（messageId/targetSeq/senderKind/senderId 等定位与摘要，不含全文）。
  payload_json TEXT NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL
);

-- 幂等入队：同一 receipt 的同一 event_kind 恰好一行（command replay 不重复入队）。
CREATE UNIQUE INDEX message_tracer_outbox_receipt_event_idx
  ON message_tracer_outbox(receipt_id, event_kind);
-- worker 拉 pending：未投递（delivered_at IS NULL）按创建序。
CREATE INDEX message_tracer_outbox_pending_idx
  ON message_tracer_outbox(delivered_at, created_at);
