-- PI Provider Supply (system-admin scope). Credential ciphertext never leaves the store via DTO.

CREATE TABLE IF NOT EXISTS pi_provider_credentials (
  id TEXT PRIMARY KEY,
  key_version INTEGER NOT NULL,
  encrypted_payload TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pi_provider_cards (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  preset TEXT NOT NULL,
  notes TEXT,
  console_url TEXT,
  credential_ref TEXT NOT NULL,
  draft_revision_id TEXT,
  published_revision_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (credential_ref) REFERENCES pi_provider_credentials(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pi_provider_card_revisions (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  endpoint_mode TEXT NOT NULL,
  model_id TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  compatibility_params_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (card_id) REFERENCES pi_provider_cards(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pi_provider_card_revisions_card
  ON pi_provider_card_revisions(card_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pi_provider_cards_updated
  ON pi_provider_cards(updated_at DESC);
