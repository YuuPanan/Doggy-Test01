CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, resource_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
);
