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
