CREATE TABLE location_shares (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id), device_id TEXT NOT NULL REFERENCES devices(id),
  binding_id TEXT NOT NULL REFERENCES device_bindings(id), lost_session_id TEXT NOT NULL REFERENCES lost_mode_sessions(id),
  created_by TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX pet_location_shares ON location_shares(pet_id,created_at DESC,id DESC);
