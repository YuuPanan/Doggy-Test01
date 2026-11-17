CREATE TABLE reporting_policies (
  device_id TEXT PRIMARY KEY REFERENCES devices(id), binding_id TEXT NOT NULL REFERENCES device_bindings(id),
  desired_version INTEGER NOT NULL, desired_json TEXT NOT NULL, applied_version INTEGER,
  applied_json TEXT, applied_source TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE device_commands (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), binding_id TEXT NOT NULL REFERENCES device_bindings(id),
  version INTEGER NOT NULL, policy_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL, execution_source TEXT, error TEXT, created_at TEXT NOT NULL, acknowledged_at TEXT,
  UNIQUE(device_id,version)
);
CREATE INDEX device_command_pending ON device_commands(device_id,status,expires_at);
CREATE TABLE lost_mode_sessions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), binding_id TEXT NOT NULL REFERENCES device_bindings(id),
  started_by TEXT NOT NULL REFERENCES users(id), started_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  ended_at TEXT, previous_policy_json TEXT NOT NULL
);
CREATE UNIQUE INDEX active_lost_mode ON lost_mode_sessions(device_id) WHERE ended_at IS NULL;
