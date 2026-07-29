-- #921 切片 C-wire：inbox_items 增加 mentions_recipient，支持频道主线 freshness relevance 过滤（#893 §4）。
-- 频道主线仅在被 @提及（或命中 basis Message / 关联 Task）的相关新增消息时 freshness_hold；
-- 普通无关聊天保持 unread 但不阻塞。DM/DM-thread/Thread 仍按「同 target 所有新非本人消息 relevant」。
-- 列由 send-message handler 在投递时按 recipient 计算（消息 mentions 是否含该 recipient）。

ALTER TABLE inbox_items ADD COLUMN mentions_recipient INTEGER NOT NULL DEFAULT 0 CHECK (mentions_recipient IN (0, 1));

-- 支撑 hasUnreadMention 查询（recipient × target 内、自某 seq 起、提及该 recipient 的未读项）。
CREATE INDEX inbox_items_recipient_target_mention_idx
  ON inbox_items(recipient_id, channel_id, thread_key, mentions_recipient, target_seq);
