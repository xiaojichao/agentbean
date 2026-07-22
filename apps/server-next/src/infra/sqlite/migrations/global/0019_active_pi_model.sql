-- 全局 Active PI Model 与审计切换历史（#704）

CREATE TABLE IF NOT EXISTS pi_active_model (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  card_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  FOREIGN KEY (card_id) REFERENCES pi_provider_cards(id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id) REFERENCES pi_provider_card_revisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pi_active_model_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  FOREIGN KEY (card_id) REFERENCES pi_provider_cards(id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id) REFERENCES pi_provider_card_revisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pi_active_model_history_changed_at
  ON pi_active_model_history(changed_at DESC, id DESC);
