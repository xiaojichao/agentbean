-- 为 channels 表增加 revision 列，用于 Archive Gate 的确认 token 校验。
ALTER TABLE channels ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
