CREATE EXTENSION IF NOT EXISTS postgis;

-- TEXT identity/time/JSON columns keep the SQLite API contract during migration.

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, resource_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE households (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE household_members (
  household_id TEXT NOT NULL REFERENCES households(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','caregiver','viewer')), created_at TEXT NOT NULL,
  PRIMARY KEY(household_id,user_id)
);
CREATE INDEX household_members_user ON household_members(user_id);
CREATE TABLE pets (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), name TEXT NOT NULL,
  species TEXT NOT NULL, breed TEXT, birth_date TEXT, weight_kg DOUBLE PRECISION,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX pets_household ON pets(household_id);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, refresh_expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE household_invitations (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('caregiver','viewer')), token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE auth_attempts (key TEXT PRIMARY KEY, window_started TEXT NOT NULL, attempts BIGINT NOT NULL);

CREATE TABLE devices (
  id TEXT PRIMARY KEY, serial_no TEXT NOT NULL UNIQUE, vendor TEXT NOT NULL, model TEXT NOT NULL,
  hardware_rev TEXT, secret_hash TEXT NOT NULL, claim_hash TEXT, claim_expires_at TEXT,
  claim_attempts BIGINT NOT NULL DEFAULT 0, owner_user_id TEXT REFERENCES users(id), firmware_version TEXT,
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
  battery_pct DOUBLE PRECISION, signal_json TEXT, firmware_version TEXT, last_location_id TEXT,
  connection_status TEXT NOT NULL DEFAULT 'unknown', reported_seq BIGINT, reported_boot_id TEXT
);
CREATE TABLE device_events (
  event_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), pet_id TEXT REFERENCES pets(id), binding_id TEXT,
  type TEXT NOT NULL, device_ts TEXT NOT NULL, received_at TEXT NOT NULL, seq BIGINT NOT NULL, boot_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, envelope_json TEXT NOT NULL, process_status TEXT NOT NULL DEFAULT 'pending',
  attempts BIGINT NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, error TEXT
);
CREATE INDEX event_inbox ON device_events(process_status,next_attempt_at);
CREATE UNIQUE INDEX event_sequence ON device_events(device_id,boot_id,seq);
CREATE TABLE locations (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES device_events(event_id),
  device_id TEXT NOT NULL REFERENCES devices(id), pet_id TEXT NOT NULL REFERENCES pets(id),
  device_ts TEXT NOT NULL, received_at TEXT NOT NULL, lat DOUBLE PRECISION NOT NULL, lon DOUBLE PRECISION NOT NULL,
  accuracy_m DOUBLE PRECISION NOT NULL, source TEXT NOT NULL, seq BIGINT NOT NULL, boot_id TEXT NOT NULL,
  quality_flags_json TEXT NOT NULL
);
CREATE INDEX pet_locations ON locations(pet_id,device_ts DESC,id DESC);
CREATE TABLE geofences (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id), name TEXT NOT NULL,
  geometry_json TEXT NOT NULL, enabled BIGINT NOT NULL DEFAULT 1, buffer_m DOUBLE PRECISION NOT NULL DEFAULT 10,
  accuracy_limit_m DOUBLE PRECISION NOT NULL DEFAULT 100, confirm_points BIGINT NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE geofence_states (
  fence_id TEXT PRIMARY KEY REFERENCES geofences(id), status TEXT NOT NULL DEFAULT 'unknown',
  candidate TEXT, count BIGINT NOT NULL DEFAULT 0, last_ts TEXT, last_location_id TEXT, open_event_id TEXT,
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
  start_at TEXT NOT NULL, end_at TEXT NOT NULL, steps BIGINT, active_seconds DOUBLE PRECISION, distance_m DOUBLE PRECISION,
  sleep_seconds DOUBLE PRECISION, estimated BIGINT NOT NULL, source TEXT NOT NULL, raw_metrics_json TEXT NOT NULL
);
CREATE INDEX pet_activity ON activity_samples(pet_id,start_at,end_at);
CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id), geofence BIGINT NOT NULL DEFAULT 1,
  battery BIGINT NOT NULL DEFAULT 1, offline BIGINT NOT NULL DEFAULT 1, location BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE push_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), platform TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), event_id TEXT NOT NULL REFERENCES safety_events(id),
  status TEXT NOT NULL DEFAULT 'pending', retry_count BIGINT NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  provider_message_id TEXT, error TEXT, sent_at TEXT, read_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(user_id,event_id)
);
CREATE INDEX notification_outbox ON notifications(status,next_attempt_at);

CREATE TABLE care_records (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id),
  type TEXT NOT NULL CHECK(type IN ('weight','feeding','medication','grooming','note')),
  value_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('owner','vet')),
  notes TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX care_pet_time ON care_records(pet_id,recorded_at DESC,id DESC);
CREATE TABLE care_record_revisions (
  id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES care_records(id),
  snapshot_json TEXT NOT NULL, changed_by TEXT NOT NULL REFERENCES users(id), changed_at TEXT NOT NULL
);
CREATE TABLE behavior_feedback (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id),
  feature_date TEXT NOT NULL, assessment TEXT NOT NULL, comment TEXT NOT NULL,
  evidence_json TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);

ALTER TABLE notifications ADD COLUMN lease_until TEXT;

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL, key TEXT NOT NULL,
  request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,scope,key)
);
CREATE TABLE safety_acknowledgements (
  event_id TEXT PRIMARY KEY REFERENCES safety_events(id), user_id TEXT NOT NULL REFERENCES users(id),
  acknowledged_at TEXT NOT NULL, note TEXT NOT NULL
);

ALTER TABLE geofences ADD COLUMN dynamic_buffer BIGINT NOT NULL DEFAULT 0;
ALTER TABLE geofences ADD COLUMN min_buffer_m DOUBLE PRECISION NOT NULL DEFAULT 15;
ALTER TABLE geofences ADD COLUMN min_exit_seconds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE geofences ADD COLUMN min_enter_seconds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE geofences ADD COLUMN rule_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE geofence_states ADD COLUMN candidate_since TEXT;
ALTER TABLE geofence_evaluations ADD COLUMN rule_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE geofence_evaluations ADD COLUMN reason TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE geofence_evaluations ADD COLUMN effective_buffer_m DOUBLE PRECISION;
ALTER TABLE device_events ADD COLUMN processing_started_at TEXT;
ALTER TABLE device_events ADD COLUMN processed_at TEXT;

CREATE TABLE reporting_policies (
  device_id TEXT PRIMARY KEY REFERENCES devices(id), binding_id TEXT NOT NULL REFERENCES device_bindings(id),
  desired_version BIGINT NOT NULL, desired_json TEXT NOT NULL, applied_version BIGINT,
  applied_json TEXT, applied_source TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE device_commands (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), binding_id TEXT NOT NULL REFERENCES device_bindings(id),
  version BIGINT NOT NULL, policy_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
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

CREATE TABLE household_settings (
  household_id TEXT PRIMARY KEY REFERENCES households(id), timezone TEXT NOT NULL
);
CREATE TABLE pet_settings (
  pet_id TEXT PRIMARY KEY REFERENCES pets(id), timezone TEXT
);

CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), pet_id TEXT NOT NULL REFERENCES pets(id),
  binding_id TEXT NOT NULL REFERENCES device_bindings(id), created_by TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  diagnostics_consented_at TEXT, diagnostics_expires_at TEXT, diagnostics_revoked_at TEXT, diagnostics_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX support_ticket_creator ON support_tickets(created_by,created_at DESC,id DESC);
CREATE INDEX support_ticket_status ON support_tickets(status,created_at DESC,id DESC);
CREATE TABLE support_ticket_history (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id), actor_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL, reply TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX support_history_ticket ON support_ticket_history(ticket_id,created_at,id);

CREATE TABLE location_shares (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id), device_id TEXT NOT NULL REFERENCES devices(id),
  binding_id TEXT NOT NULL REFERENCES device_bindings(id), lost_session_id TEXT NOT NULL REFERENCES lost_mode_sessions(id),
  created_by TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX pet_location_shares ON location_shares(pet_id,created_at DESC,id DESC);

CREATE TABLE activity_versions (
  pet_id TEXT PRIMARY KEY REFERENCES pets(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL
);



CREATE TABLE daily_summaries (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL, timezone TEXT NOT NULL, aggregation_version TEXT NOT NULL,
  source_revision BIGINT NOT NULL, generated_at TEXT NOT NULL, summary_json TEXT NOT NULL,
  PRIMARY KEY(pet_id,local_date,timezone)
);
CREATE TABLE activity_observations (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL, timezone TEXT NOT NULL, rule_version TEXT NOT NULL,
  source_signature TEXT NOT NULL, generated_at TEXT NOT NULL, result_json TEXT NOT NULL,
  UNIQUE(pet_id,local_date,timezone,rule_version,source_signature)
);

ALTER TABLE device_events ADD COLUMN __sequence BIGSERIAL UNIQUE;
ALTER TABLE support_ticket_history ADD COLUMN __sequence BIGSERIAL UNIQUE;
ALTER TABLE geofence_evaluations ADD COLUMN __sequence BIGSERIAL UNIQUE;

CREATE FUNCTION doogy_fence_shape(document TEXT) RETURNS geometry
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  item JSONB := document::jsonb;
  coordinates JSONB;
BEGIN
  IF item->>'type'='circle' THEN
    RETURN ST_SetSRID(ST_MakePoint((item->>'lon')::double precision,(item->>'lat')::double precision),4326);
  END IF;
  coordinates := item->'coordinates';
  IF coordinates->0 IS DISTINCT FROM coordinates->(jsonb_array_length(coordinates)-1) THEN
    coordinates := coordinates || jsonb_build_array(coordinates->0);
  END IF;
  RETURN ST_SetSRID(ST_GeomFromGeoJSON(jsonb_build_object('type','Polygon','coordinates',jsonb_build_array(coordinates))),4326);
END;
$$;

ALTER TABLE locations ADD COLUMN __position geography(Point,4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon,lat),4326)::geography) STORED;
ALTER TABLE locations ADD CONSTRAINT location_coordinates CHECK(lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180 AND accuracy_m>=0);
CREATE INDEX locations_position_gist ON locations USING gist(__position);
ALTER TABLE geofences ADD COLUMN __shape geometry(Geometry,4326)
  GENERATED ALWAYS AS (doogy_fence_shape(geometry_json)) STORED;
ALTER TABLE geofences ADD COLUMN __radius_m double precision
  GENERATED ALWAYS AS (CASE WHEN geometry_json::jsonb->>'type'='circle' THEN (geometry_json::jsonb->>'radius_m')::double precision END) STORED;
ALTER TABLE geofences ADD CONSTRAINT fence_valid_geometry CHECK(ST_IsValid(__shape));
CREATE INDEX geofences_shape_gist ON geofences USING gist(__shape);

CREATE FUNCTION doogy_activity_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO activity_versions(pet_id,revision) VALUES(NEW.pet_id,1)
      ON CONFLICT(pet_id) DO UPDATE SET revision=activity_versions.revision+1;
    RETURN NEW;
  END IF;
  INSERT INTO activity_versions(pet_id,revision) VALUES(OLD.pet_id,1)
    ON CONFLICT(pet_id) DO UPDATE SET revision=activity_versions.revision+1;
  IF TG_OP='UPDATE' AND NEW.pet_id<>OLD.pet_id THEN
    INSERT INTO activity_versions(pet_id,revision) VALUES(NEW.pet_id,1)
      ON CONFLICT(pet_id) DO UPDATE SET revision=activity_versions.revision+1;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER activity_insert_version AFTER INSERT ON activity_samples FOR EACH ROW EXECUTE FUNCTION doogy_activity_revision();
CREATE TRIGGER activity_update_version AFTER UPDATE ON activity_samples FOR EACH ROW EXECUTE FUNCTION doogy_activity_revision();
CREATE TRIGGER activity_delete_version AFTER DELETE ON activity_samples FOR EACH ROW EXECUTE FUNCTION doogy_activity_revision();

CREATE FUNCTION doogy_revoke_member_grants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stamp TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  UPDATE location_shares SET revoked_at=COALESCE(revoked_at,stamp)
    WHERE created_by=OLD.user_id AND revoked_at IS NULL
      AND pet_id IN(SELECT id FROM pets WHERE household_id=OLD.household_id);
  IF TG_OP='DELETE' THEN
    UPDATE support_tickets SET diagnostics_revoked_at=COALESCE(diagnostics_revoked_at,stamp),diagnostics_json=NULL,updated_at=stamp
      WHERE created_by=OLD.user_id AND diagnostics_consented_at IS NOT NULL
        AND (diagnostics_json IS NOT NULL OR diagnostics_revoked_at IS NULL)
        AND pet_id IN(SELECT id FROM pets WHERE household_id=OLD.household_id);
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_grants_after_member_removal AFTER DELETE ON household_members
  FOR EACH ROW EXECUTE FUNCTION doogy_revoke_member_grants();
CREATE TRIGGER revoke_shares_after_role_downgrade AFTER UPDATE OF role ON household_members
  FOR EACH ROW WHEN(NEW.role='viewer' AND OLD.role<>'viewer') EXECUTE FUNCTION doogy_revoke_member_grants();

CREATE FUNCTION doogy_revoke_binding_grants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stamp TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  UPDATE location_shares SET revoked_at=COALESCE(revoked_at,stamp) WHERE binding_id=OLD.id AND revoked_at IS NULL;
  UPDATE support_tickets SET diagnostics_revoked_at=COALESCE(diagnostics_revoked_at,stamp),diagnostics_json=NULL,updated_at=stamp
    WHERE binding_id=OLD.id AND diagnostics_consented_at IS NOT NULL
      AND (diagnostics_json IS NOT NULL OR diagnostics_revoked_at IS NULL);
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_grants_after_device_unbind AFTER UPDATE OF unbound_at ON device_bindings
  FOR EACH ROW WHEN(OLD.unbound_at IS NULL AND NEW.unbound_at IS NOT NULL) EXECUTE FUNCTION doogy_revoke_binding_grants();
