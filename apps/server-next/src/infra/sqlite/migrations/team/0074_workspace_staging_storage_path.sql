-- #1005：staging 文件字节迁磁盘路径；metadata 保留 size/sha/received。
-- content BLOB 列保留以兼容旧行，新写入可为 NULL。

ALTER TABLE workspace_publish_staging_files
  ADD COLUMN storage_path TEXT;
