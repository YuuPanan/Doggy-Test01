ALTER TABLE care_records ADD COLUMN withdrawn_at TEXT;
ALTER TABLE care_records ADD COLUMN withdrawn_by TEXT REFERENCES users(id);
ALTER TABLE care_records ADD COLUMN withdrawal_reason TEXT;
