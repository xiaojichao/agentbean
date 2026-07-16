CREATE TABLE manager_leases_v2 (
  management_run_id TEXT PRIMARY KEY REFERENCES management_runs(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  device_id TEXT,
  profile_id TEXT NOT NULL,
  host_kind TEXT NOT NULL DEFAULT 'device' CHECK (host_kind IN ('device', 'server')),
  worker_pool_id TEXT,
  lease_token_hash TEXT NOT NULL,
  lease_fingerprint TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  CHECK (
    (host_kind = 'device' AND device_id IS NOT NULL AND length(device_id) > 0 AND worker_pool_id IS NULL)
    OR (host_kind = 'server' AND device_id IS NULL AND worker_pool_id IS NOT NULL AND length(worker_pool_id) > 0)
  )
);

INSERT INTO manager_leases_v2
  (management_run_id, worker_id, device_id, profile_id, host_kind, worker_pool_id,
   lease_token_hash, lease_fingerprint, fencing_token, acquired_at, heartbeat_at, expires_at, released_at)
SELECT management_run_id, worker_id, device_id, profile_id, 'device', NULL,
  lease_token_hash, lease_fingerprint, fencing_token, acquired_at, heartbeat_at, expires_at, released_at
FROM manager_leases;

DROP TABLE manager_leases;
ALTER TABLE manager_leases_v2 RENAME TO manager_leases;
