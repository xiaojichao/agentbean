-- 设备自报能力元数据（JSON）：fsBrowse 等。随 device.hello 刷新，旧设备为 NULL。
-- web 端据此判断目录浏览等能力；缺失字段 fail-closed 视为不支持。
ALTER TABLE devices ADD COLUMN capabilities TEXT;
