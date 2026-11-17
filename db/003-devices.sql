CREATE TABLE devices (
  id TEXT PRIMARY KEY, serial_no TEXT NOT NULL UNIQUE, vendor TEXT NOT NULL, model TEXT NOT NULL,
  hardware_rev TEXT, secret_hash TEXT NOT NULL, claim_hash TEXT, claim_expires_at TEXT,
  claim_attempts INTEGER NOT NULL DEFAULT 0, owner_user_id TEXT REFERENCES users(id), firmware_version TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE device_bindings (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), pet_id TEXT NOT NULL REFERENCES pets(id),
  bound_by TEXT NOT NULL REFERENCES users(id), bound_at TEXT NOT NULL, unbound_at TEXT
);
CREATE UNIQUE INDEX current_device_binding ON device_bindings(device_id) WHERE unbound_at IS NULL;
CREATE UNIQUE INDEX current_pet_device ON device_bindings(pet_id) WHERE unbound_at IS NULL;
CREATE TABLE device_state (
  device_id TEXT PRIMARY KEY REFERENCES devices(id), last_seen_at TEXT, reported_at TEXT,
  battery_pct REAL, signal_json TEXT, firmware_version TEXT, last_location_id TEXT,
  connection_status TEXT NOT NULL DEFAULT 'unknown', reported_seq INTEGER, reported_boot_id TEXT
);
CREATE TABLE device_events (
  event_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), pet_id TEXT REFERENCES pets(id), binding_id TEXT,
  type TEXT NOT NULL, device_ts TEXT NOT NULL, received_at TEXT NOT NULL, seq INTEGER NOT NULL, boot_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, envelope_json TEXT NOT NULL, process_status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, error TEXT
);
CREATE INDEX event_inbox ON device_events(process_status,next_attempt_at);
CREATE UNIQUE INDEX event_sequence ON device_events(device_id,boot_id,seq);
CREATE TABLE locations (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES device_events(event_id),
  device_id TEXT NOT NULL REFERENCES devices(id), pet_id TEXT NOT NULL REFERENCES pets(id),
  device_ts TEXT NOT NULL, received_at TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  accuracy_m REAL NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL, boot_id TEXT NOT NULL,
  quality_flags_json TEXT NOT NULL
);
CREATE INDEX pet_locations ON locations(pet_id,device_ts DESC,id DESC);
CREATE TABLE geofences (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id), name TEXT NOT NULL,
  geometry_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, buffer_m REAL NOT NULL DEFAULT 10,
  accuracy_limit_m REAL NOT NULL DEFAULT 100, confirm_points INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE geofence_states (
  fence_id TEXT PRIMARY KEY REFERENCES geofences(id), status TEXT NOT NULL DEFAULT 'unknown',
  candidate TEXT, count INTEGER NOT NULL DEFAULT 0, last_ts TEXT, last_location_id TEXT, open_event_id TEXT,
  last_judgment TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE geofence_evaluations (
  id TEXT PRIMARY KEY, fence_id TEXT NOT NULL REFERENCES geofences(id), location_id TEXT NOT NULL REFERENCES locations(id),
  judgment TEXT NOT NULL, state_json TEXT NOT NULL, evaluated_at TEXT NOT NULL
);
CREATE TABLE safety_events (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id), device_id TEXT NOT NULL REFERENCES devices(id),
  fence_id TEXT REFERENCES geofences(id), type TEXT NOT NULL, occurred_at TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id), details_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  closed_at TEXT, related_event_id TEXT
);
CREATE INDEX pet_safety ON safety_events(pet_id,occurred_at DESC,id DESC);
CREATE TABLE activity_samples (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES device_events(event_id),
  device_id TEXT NOT NULL REFERENCES devices(id), pet_id TEXT NOT NULL REFERENCES pets(id),
  start_at TEXT NOT NULL, end_at TEXT NOT NULL, steps INTEGER, active_seconds REAL, distance_m REAL,
  sleep_seconds REAL, estimated INTEGER NOT NULL, source TEXT NOT NULL, raw_metrics_json TEXT NOT NULL
);
CREATE INDEX pet_activity ON activity_samples(pet_id,start_at,end_at);
CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id), geofence INTEGER NOT NULL DEFAULT 1,
  battery INTEGER NOT NULL DEFAULT 1, offline INTEGER NOT NULL DEFAULT 1, location INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE push_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), platform TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), event_id TEXT NOT NULL REFERENCES safety_events(id),
  status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  provider_message_id TEXT, error TEXT, sent_at TEXT, read_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(user_id,event_id)
);
CREATE INDEX notification_outbox ON notifications(status,next_attempt_at);
