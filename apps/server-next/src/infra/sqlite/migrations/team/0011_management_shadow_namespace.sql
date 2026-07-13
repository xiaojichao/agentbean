ALTER TABLE management_shadow_decisions RENAME TO management_shadow_decisions_legacy;

CREATE TABLE management_shadow_decisions (
  id TEXT PRIMARY KEY,
  shadow_request_key TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  objective_hash TEXT NOT NULL,
  argument_hash TEXT NOT NULL,
  target_json TEXT NOT NULL,
  tool_sequence_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO management_shadow_decisions (
  id, shadow_request_key, input_hash, objective_hash, argument_hash,
  target_json, tool_sequence_json, diagnostics_json, created_at
)
SELECT
  id, 'shadow:legacy:' || id, input_hash, objective_hash, argument_hash,
  target_json, tool_sequence_json, diagnostics_json, created_at
FROM management_shadow_decisions_legacy;

DROP TABLE management_shadow_decisions_legacy;

CREATE INDEX management_shadow_decisions_created_idx
  ON management_shadow_decisions(created_at, id);
