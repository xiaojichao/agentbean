-- Retain revisions and encrypted credentials for invocations pinned before deletion.
ALTER TABLE pi_provider_cards ADD COLUMN deleted_at INTEGER;
ALTER TABLE pi_provider_cards ADD COLUMN deleted_by TEXT;
