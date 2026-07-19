-- PI Provider 模型候选、生产同路径测试记录（#703）

ALTER TABLE pi_provider_cards ADD COLUMN model_candidates_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pi_provider_cards ADD COLUMN model_candidates_updated_at INTEGER;

CREATE TABLE IF NOT EXISTS pi_provider_revision_tests (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  draft_revision_id TEXT NOT NULL,
  config_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  text_ok INTEGER NOT NULL,
  tool_call_ok INTEGER NOT NULL,
  response_model TEXT,
  finish_reason_text TEXT,
  finish_reason_tool TEXT,
  usage_input_tokens INTEGER,
  usage_output_tokens INTEGER,
  duration_ms INTEGER NOT NULL,
  diagnostic_code TEXT,
  tested_by TEXT NOT NULL,
  tested_at INTEGER NOT NULL,
  FOREIGN KEY (card_id) REFERENCES pi_provider_cards(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_revision_id) REFERENCES pi_provider_card_revisions(id) ON DELETE CASCADE,
  FOREIGN KEY (tested_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pi_provider_revision_tests_card
  ON pi_provider_revision_tests(card_id, tested_at DESC);

CREATE INDEX IF NOT EXISTS idx_pi_provider_revision_tests_summary
  ON pi_provider_revision_tests(card_id, config_summary, status);
