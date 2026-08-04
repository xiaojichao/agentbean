-- #1063 将文件包选择冻结为消息 ProjectReferenceSet(父规格 #1059 §3/§6)。
--
-- 在 #826 既有 reference selections/items 上加 package 投影列:
-- - selections 增加 package 语境(整包投影/显式包内选择):package_id + projection policy
--   + 冻结的 member_count;delivered/current/final/specified 四种来源与 bundle 三字段
--   互斥(bundle 与 package 语境不可能同时出现,同一 selection 只能来自一种来源)。
-- - items 增加 collection_revision:仅 current/final 指针解析的 item 携带(解析当刻的
--   collection revision 冻结为发送时 basis);delivered/specified 显式版本语义不携带。
--
-- source_kind CHECK 需扩到新四值;0054 的 CHECK 未含它们,重建 selections 表。
-- 历史库门禁:沿用 0076-0078 同款(只有缺 artifacts 链路的库不重建)。

CREATE TABLE project_reference_selections_new (
  id TEXT PRIMARY KEY,
  reference_set_id TEXT NOT NULL REFERENCES project_reference_sets(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('bundle_all','bundle_subset','document','artifact_version',
                    'package_delivered','package_current','package_final','package_specified')
  ),
  position INTEGER NOT NULL CHECK (position >= 0),
  bundle_id TEXT,
  bundle_name TEXT,
  bundle_member_count INTEGER,
  package_id TEXT,
  package_projection TEXT CHECK (
    package_projection IS NULL OR package_projection IN ('delivered','current','final','specified')
  ),
  
  package_member_count INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (reference_set_id, position),
  CHECK (
    (
      bundle_id IS NULL AND bundle_name IS NULL AND bundle_member_count IS NULL
      AND package_id IS NULL AND package_projection IS NULL
      AND package_member_count IS NULL
    )
    OR
    (
      bundle_id IS NOT NULL AND bundle_name IS NOT NULL AND bundle_member_count IS NOT NULL
      AND package_id IS NULL AND package_projection IS NULL
      AND package_member_count IS NULL
    )
    OR
    (
      bundle_id IS NULL AND bundle_name IS NULL AND bundle_member_count IS NULL
      AND package_id IS NOT NULL AND package_projection IS NOT NULL
      AND package_member_count IS NOT NULL
    )
  )
);
CREATE INDEX project_reference_selections_new_set_idx
  ON project_reference_selections_new(reference_set_id, position);

INSERT INTO project_reference_selections_new (
  id, reference_set_id, source_kind, position,
  bundle_id, bundle_name, bundle_member_count,
  package_id, package_projection, package_member_count,
  created_at
)
SELECT
  id, reference_set_id, source_kind, position,
  bundle_id, bundle_name, bundle_member_count,
  NULL, NULL, NULL,
  created_at
FROM project_reference_selections;

DROP TABLE project_reference_selections;
ALTER TABLE project_reference_selections_new RENAME TO project_reference_selections;

ALTER TABLE project_reference_items ADD COLUMN collection_revision INTEGER;

-- 说明:package 语境对 output_packages 是刻意软引用(不建 FK)——与 0077 成员对
-- versions/collections 软引用同一取舍:reference set 是已成立的发送事实,频道治理
-- 清理 package 行不静默改写历史消息的引用语境。
