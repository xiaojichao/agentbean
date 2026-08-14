-- #1199：扩展 PackageReview command registry，允许批量逐文件审核 receipt/tombstone。
ALTER TABLE package_review_command_receipts RENAME TO package_review_command_receipts_old;

CREATE TABLE package_review_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'submit-package-artifact-review',
    'submit-package-artifact-reviews',
    'submit-package-review-and-finalize',
    'submit-package-review-and-reject-delivery'
  )),
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
INSERT INTO package_review_command_receipts SELECT * FROM package_review_command_receipts_old;
DROP TABLE package_review_command_receipts_old;
CREATE UNIQUE INDEX package_review_command_receipts_idempotency_idx
  ON package_review_command_receipts(team_id, idempotency_key);

ALTER TABLE package_review_idempotency_tombstones RENAME TO package_review_idempotency_tombstones_old;

CREATE TABLE package_review_idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'submit-package-artifact-review',
    'submit-package-artifact-reviews',
    'submit-package-review-and-finalize',
    'submit-package-review-and-reject-delivery'
  )),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  created_at INTEGER NOT NULL
);
INSERT INTO package_review_idempotency_tombstones SELECT * FROM package_review_idempotency_tombstones_old;
DROP TABLE package_review_idempotency_tombstones_old;
CREATE UNIQUE INDEX package_review_idempotency_tombstones_idempotency_idx
  ON package_review_idempotency_tombstones(team_id, idempotency_key);
CREATE INDEX package_review_idempotency_tombstones_receipt_idx
  ON package_review_idempotency_tombstones(receipt_id);
