CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL, key TEXT NOT NULL,
  request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,scope,key)
);
CREATE TABLE safety_acknowledgements (
  event_id TEXT PRIMARY KEY REFERENCES safety_events(id), user_id TEXT NOT NULL REFERENCES users(id),
  acknowledged_at TEXT NOT NULL, note TEXT NOT NULL
);
