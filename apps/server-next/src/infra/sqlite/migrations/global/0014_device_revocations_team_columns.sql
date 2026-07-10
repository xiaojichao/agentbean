BEGIN IMMEDIATE;

ALTER TABLE device_revocations RENAME TO device_revocations_legacy;

CREATE TABLE device_revocations (
  team_id     TEXT NOT NULL,
  machine_id  TEXT NOT NULL,
  profile_id  TEXT,
  profile_key TEXT NOT NULL,
  device_id   TEXT,
  deleted_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, machine_id, profile_key)
);

INSERT INTO device_revocations (
  team_id,
  machine_id,
  profile_id,
  profile_key,
  device_id,
  deleted_at
)
SELECT
  teamId,
  machineId,
  profileId,
  profileKey,
  deviceId,
  deletedAt
FROM device_revocations_legacy;

DROP TABLE device_revocations_legacy;

CREATE INDEX idx_revocations_machine
  ON device_revocations(team_id, machine_id);

COMMIT;
