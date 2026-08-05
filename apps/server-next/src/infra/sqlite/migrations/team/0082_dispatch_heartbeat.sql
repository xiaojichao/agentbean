-- dispatch 心跳保活与失联诊断：记录最后一次 dispatch:progress 心跳时间。
--
-- 配合 server 看门狗从「绝对 5min 超时」改为「心跳超时」判定 daemon 失联：
-- daemon 执行期周期发 dispatch:progress，server 更新 last_heartbeat_at；
-- 看门狗用 COALESCE(last_heartbeat_at, updated_at) 判定失联。
-- 可空列：历史 dispatch 或尚未 accepted 的行 last_heartbeat_at IS NULL，
-- 回退到 updated_at（与改造前等价，向后兼容）。

ALTER TABLE dispatches ADD COLUMN last_heartbeat_at INTEGER;

CREATE INDEX idx_dispatches_heartbeat ON dispatches(status, last_heartbeat_at);
