ALTER TABLE devices ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN credential_status TEXT NOT NULL DEFAULT 'active' CHECK(credential_status IN ('active','revoked'));
ALTER TABLE devices ADD COLUMN credential_changed_at TEXT;
UPDATE devices SET credential_changed_at=created_at;
