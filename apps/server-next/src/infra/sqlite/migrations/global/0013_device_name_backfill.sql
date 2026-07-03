-- 回填：现有 hostname 值成为用户可见的 name，显示零变化。此后 daemon 重连不再覆盖。
-- 幂等：WHERE name IS NULL 跳过已回填/已改名行。仿 0008 backfill 模式。
UPDATE devices SET name = hostname, name_source = 'hostname'
WHERE name IS NULL AND hostname IS NOT NULL;
