-- 设备别名回填：0007 已加 canonical_device_id 列（NULL 表示自身为 canonical）。
-- 本迁移把升级前已存在的重复别名记录统一指向组内代表（MIN(id)）。
-- 分组键 = (team_id, owner_id, LOWER(TRIM(hostname)))，复刻 normalizeDeviceKey 的归一化。
-- 仅处理缺 machineId 或 profileId 的别名记录；有 machineId/profileId 的真实设备跳过。
-- 代表记录（MIN(id)）的 canonical 保持 NULL；非代表记录指向代表。
-- 幂等：再次运行时 WHERE devices.id <> grouped.canonical_id 排除已是代表的记录，
--       且已被指向的记录其 canonical 与 grouped.canonical_id 相同，UPDATE 为空操作。
UPDATE devices
SET canonical_device_id = grouped.canonical_id
FROM (
  SELECT
    id,
    MIN(id) OVER (
      PARTITION BY team_id, owner_id, LOWER(TRIM(hostname))
    ) AS canonical_id
  FROM devices
  WHERE hostname IS NOT NULL
    AND hostname <> ''
    AND (machine_id IS NULL OR profile_id IS NULL)
) AS grouped
WHERE devices.id = grouped.id
  AND devices.id <> grouped.canonical_id;
