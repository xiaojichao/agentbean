ALTER TABLE team_management_policies
  ADD COLUMN max_management_phase INTEGER NOT NULL DEFAULT 1
  CHECK (max_management_phase IN (1, 2));

ALTER TABLE management_runs
  ADD COLUMN management_phase INTEGER NOT NULL DEFAULT 1
  CHECK (management_phase IN (1, 2));
