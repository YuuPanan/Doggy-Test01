CREATE TEMP TABLE care_record_revisions_backup AS SELECT * FROM care_record_revisions;
DROP TABLE care_record_revisions;

CREATE TABLE care_records_new (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id),
  type TEXT NOT NULL CHECK(type IN ('weight','feeding','medication','grooming','note','toileting','custom')),
  value_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('owner','vet')),
  notes TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  withdrawn_at TEXT, withdrawn_by TEXT REFERENCES users(id), withdrawal_reason TEXT,
  custom_type TEXT,
  CHECK((type='custom' AND custom_type IS NOT NULL) OR (type<>'custom' AND custom_type IS NULL))
);
INSERT INTO care_records_new (
  id,pet_id,type,value_json,recorded_at,source,notes,created_by,created_at,updated_at,
  withdrawn_at,withdrawn_by,withdrawal_reason,custom_type
)
SELECT id,pet_id,type,value_json,recorded_at,source,notes,created_by,created_at,updated_at,
  withdrawn_at,withdrawn_by,withdrawal_reason,NULL FROM care_records;
DROP TABLE care_records;
ALTER TABLE care_records_new RENAME TO care_records;
CREATE INDEX care_pet_time ON care_records(pet_id,recorded_at DESC,id DESC);

CREATE TABLE care_record_revisions (
  id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES care_records(id),
  snapshot_json TEXT NOT NULL, changed_by TEXT NOT NULL REFERENCES users(id), changed_at TEXT NOT NULL
);
INSERT INTO care_record_revisions(id,record_id,snapshot_json,changed_by,changed_at)
SELECT id,record_id,snapshot_json,changed_by,changed_at FROM care_record_revisions_backup;
DROP TABLE temp.care_record_revisions_backup;
