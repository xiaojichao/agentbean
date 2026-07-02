CREATE TABLE device_revocations (
  teamId      TEXT NOT NULL,
  machineId   TEXT NOT NULL,
  profileId   TEXT,
  deviceId    TEXT,
  deletedAt   INTEGER NOT NULL,
  PRIMARY KEY (teamId, machineId, profileId)
);
CREATE INDEX idx_revocations_machine ON device_revocations(teamId, machineId);
