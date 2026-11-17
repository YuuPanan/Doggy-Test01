CREATE TABLE activity_versions (
  pet_id TEXT PRIMARY KEY REFERENCES pets(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL
);
CREATE TRIGGER activity_insert_version AFTER INSERT ON activity_samples BEGIN
  INSERT INTO activity_versions(pet_id,revision) VALUES (NEW.pet_id,1)
    ON CONFLICT(pet_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER activity_update_version AFTER UPDATE ON activity_samples BEGIN
  INSERT INTO activity_versions(pet_id,revision) VALUES (OLD.pet_id,1)
    ON CONFLICT(pet_id) DO UPDATE SET revision=revision+1;
  INSERT INTO activity_versions(pet_id,revision) SELECT NEW.pet_id,1 WHERE NEW.pet_id<>OLD.pet_id
    ON CONFLICT(pet_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER activity_delete_version AFTER DELETE ON activity_samples BEGIN
  INSERT INTO activity_versions(pet_id,revision) VALUES (OLD.pet_id,1)
    ON CONFLICT(pet_id) DO UPDATE SET revision=revision+1;
END;
CREATE TABLE daily_summaries (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL, timezone TEXT NOT NULL, aggregation_version TEXT NOT NULL,
  source_revision INTEGER NOT NULL, generated_at TEXT NOT NULL, summary_json TEXT NOT NULL,
  PRIMARY KEY(pet_id,local_date,timezone)
);
CREATE TABLE activity_observations (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL, timezone TEXT NOT NULL, rule_version TEXT NOT NULL,
  source_signature TEXT NOT NULL, generated_at TEXT NOT NULL, result_json TEXT NOT NULL,
  UNIQUE(pet_id,local_date,timezone,rule_version,source_signature)
);
