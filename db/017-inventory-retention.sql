ALTER TABLE device_state ADD COLUMN signal_event_id TEXT;
CREATE INDEX inventory_event_retention ON device_events(received_at)
  WHERE pet_id IS NULL AND (payload_json<>'{}' OR envelope_json<>'{}' OR process_status IN ('pending','retry'));
CREATE TABLE inventory_retention (
  id TEXT PRIMARY KEY CHECK(id='unassigned_telemetry'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  telemetry_days INTEGER NOT NULL DEFAULT 7 CHECK(telemetry_days BETWEEN 1 AND 3650),
  updated_at TEXT NOT NULL, last_run_at TEXT
);
