ALTER TABLE users ADD COLUMN closed_at TEXT;
CREATE TABLE household_retention (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  telemetry_days INTEGER NOT NULL DEFAULT 90 CHECK(telemetry_days BETWEEN 1 AND 3650),
  activity_days INTEGER NOT NULL DEFAULT 365 CHECK(activity_days BETWEEN 1 AND 3650),
  safety_days INTEGER NOT NULL DEFAULT 365 CHECK(safety_days BETWEEN 1 AND 3650),
  updated_at TEXT NOT NULL, last_run_at TEXT
);
CREATE TABLE privacy_deletions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX privacy_deletion_time ON privacy_deletions(deleted_at,id);
